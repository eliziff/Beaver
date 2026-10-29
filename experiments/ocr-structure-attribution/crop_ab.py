"""Fixed-resolution crop A/B using retained page images, proposals and the native recognizer."""
import argparse
from collections import Counter, defaultdict
import os
from pathlib import Path
import time

from analyze import ROOT, DEFAULT_OUT, digest, read, write, marks, measure_detail, text_near, folded
from rapidfuzz.distance import Levenshtein
from run import invoke, wait_for_cargo


UNKNOWN = {'unaligned', 'unobserved', 'unresolved'}


def compare(before, after):
    result = Counter(total=len(before), baseline_intact=before.count('intact'), candidate_intact=after.count('intact'))
    for a, b in zip(before, after, strict=True):
        if a in UNKNOWN or b in UNKNOWN:
            result['unresolved_either_arm'] += 1
            result['lost_alignment'] += a not in UNKNOWN and b in UNKNOWN
            result['gained_alignment'] += a in UNKNOWN and b not in UNKNOWN
            result['intact_to_unresolved'] += a == 'intact' and b in UNKNOWN
            continue
        result['comparable'] += 1
        result['rescued'] += a != 'intact' and b == 'intact'
        result['regressed'] += a == 'intact' and b != 'intact'
    return dict(result)


def source_files():
    paths = [Path(__file__), Path(__file__).with_name('analyze.py'),
             Path(__file__).parent/'src/bin/crop-ab.rs', Path(__file__).with_name('Cargo.toml'),
             ROOT/'Cargo.toml', ROOT/'Cargo.lock', ROOT/'.cargo/config.toml']
    for name in ['legal-pdf-ocr', 'legal-pdf-core']:
        paths.extend((ROOT/'legal-pdf-parser'/name/'src').rglob('*.rs'))
        paths.append(ROOT/'legal-pdf-parser'/name/'Cargo.toml')
    return {p.relative_to(ROOT).as_posix():digest(p) for p in sorted(paths)}


def summarize(parent, output, jobs):
    rows = []; totals = Counter(); groups = defaultdict(lambda: ([], [])); glyphs = defaultdict(Counter)
    old_jobs = {j['sha256']:j for j in read(parent/'jobs.json')['documents']}
    for job in jobs:
        original = read(Path(job['trace'])); result = read(Path(job['output'])/'readings.json')
        sha = job['source_sha256']; gold = read(Path(old_jobs[sha]['gold']))
        if digest(Path(old_jobs[sha]['gold'])) != old_jobs[sha]['gold_sha256']:
            raise ValueError('The cached gold revision changed')
        totals['lines'] += len(result['lines'])
        for line in result['lines']:
            totals['matched_core_boxes'] += line['core_matched']
            totals['changed_bounds'] += line['bounds_changed']
            totals['changed_normalized_inputs'] += line['pixels_changed']
            totals['baseline_pixel_checks'] += line['baseline_hash_checked']
            totals['changed_readings'] += line['baseline']['text'] != line['candidate']['text']
        traces = {}
        for arm in ['baseline', 'candidate']:
            traces[arm] = {**original, 'lines':[{**line, **observed[arm]}
                for line, observed in zip(original['lines'], result['lines'], strict=True)]}
        for mark in marks(gold):
            if len(mark['pieces']) != 1 or mark['pieces'][0]['page'] != job['page']: continue
            piece = mark['pieces'][0]
            detail = {arm:measure_detail(piece,text_near(piece, trace)) for arm,trace in traces.items()}
            observed = {arm:value['status'] for arm,value in detail.items()}
            if all(s not in UNKNOWN for s in observed.values()):
                wanted = ''.join(folded(piece['corrected'][piece['start']:piece['end']]).split())
                count = glyphs[mark['kind']];count['gold_characters'] += len(wanted);count['compared_marks'] += 1
                for arm,value in detail.items():
                    actual = ''.join(value['observed'].split())
                    operations = Counter(op.tag for op in Levenshtein.editops(wanted,actual))
                    count[arm+'_errors'] += sum(operations.values())
                    for tag in ['delete','insert','replace']:count[arm+'_'+tag] += operations[tag]
            groups[mark['kind']][0].append(observed['baseline'])
            groups[mark['kind']][1].append(observed['candidate'])
            rows.append({'source_sha256':sha, 'page':job['page'], 'line_id':piece['line_id'],
                         'kind':mark['kind'], 'label':mark['label'], **observed,
                         'glyph_readings':{a:v.get('observed') for a,v in detail.items()}})
    result = {'schema':'ocr-crop-ab.report.v1', 'pages':len(jobs), 'totals':dict(totals),
              'groups':{k:{**compare(*v), 'glyphs':dict(glyphs[k]), 'baseline_statuses':dict(Counter(v[0])),
                           'candidate_statuses':dict(Counter(v[1]))} for k,v in groups.items()},
              'all_marks':compare([r['baseline'] for r in rows],[r['candidate'] for r in rows]), 'marks':rows,
              'limits':['Existing diagnostic pages, not a held-out population estimate.',
                        'Detector recall, trained weights and linking are not evaluated.',
                        'Original proposal coordinates anchor both arms; unresolved alignment is reported, not counted as success.']}
    write(output/'report.json', result)
    print({k:result[k] for k in ['pages','totals','groups','all_marks']},flush=True)


def margin_jobs(parent, output):
    control = parent/'crop-ab'
    prior = read(control/'run.json')
    if digest(control/'jobs.json') != prior['jobs_sha256']: raise ValueError('Control crop jobs changed')
    jobs = []
    for job in read(control/'jobs.json'):
        trace = read(Path(job['trace'])); observed_path = Path(job['output'])/'readings.json'
        observed = read(observed_path)
        if digest(Path(job['trace'])) != job['trace_sha256'] or digest(Path(job['image'])) != job['image_sha256']:
            raise ValueError('Control page inputs changed')
        for line,row in zip(trace['lines'],observed['lines'],strict=True):
            line['input_bbox'] = row['candidate_bbox']
            line.update(row['candidate'])
            line['reading'] = {'normalized_sha256':row['candidate_sha256']}
        destination = output/job['source_sha256']/f"page-{job['page']}"
        frozen = destination/'control-trace.json';write(frozen,trace)
        jobs.append({**job,'trace':str(frozen),'trace_sha256':digest(frozen),'output':str(destination),
                     'control_readings_sha256':digest(observed_path)})
    return jobs, digest(control/'run.json')


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--data',type=Path,default=DEFAULT_OUT)
    parser.add_argument('--skip-build',action='store_true')
    parser.add_argument('--margin',action='store_true',help='Freeze the completed crop candidate; compare 20% and 10% white margins')
    args = parser.parse_args(); parent = args.data; output = parent/('margin-ab' if args.margin else 'crop-ab'); output.mkdir(exist_ok=True)
    old_run = read(parent/'run.json'); pack = ROOT/'legal-pdf-parser/runtime/indra'; runtime = ROOT/'legal-pdf-parser/runtime/onnxruntime.dll'
    if digest(pack/'manifest.json') != old_run['model_manifest_sha256'] or digest(runtime) != old_run['runtime_sha256']:
        raise ValueError('Cached experiment uses different weights or ONNX runtime')
    control_run_sha256 = None
    if args.margin:
        jobs, control_run_sha256 = margin_jobs(parent,output)
        control_run = read(parent/'crop-ab/run.json')
        if any(control_run[k] != old_run[k] for k in ['model_manifest_sha256','runtime_sha256']):
            raise ValueError('Margin control has different weights or runtime')
    else:
        jobs = []
        for document in read(parent/'jobs.json')['documents']:
            folder = parent/'native'/document['sha256']; receipt = folder/'receipt.json'
            if not receipt.is_file() or read(receipt).get('run_identity') != old_run: continue
            for page in document['pages']:
                trace = folder/f'page-{page}-144/trace.json'; image = trace.with_name('page.png')
                jobs.append({'source_sha256':document['sha256'], 'page':page, 'image':str(image), 'trace':str(trace),
                             'output':str(output/document['sha256']/f'page-{page}'),
                             'image_sha256':digest(image), 'trace_sha256':digest(trace)})
    if not jobs: raise ValueError('No completed retained native pages')
    write(output/'jobs.json',jobs)
    env = dict(os.environ);env['CARGO_BUILD_JOBS']='1';env['RAYON_NUM_THREADS']='1';env['RUST_TEST_THREADS']='1'
    home = Path.home()
    env['CARGO_ENCODED_RUSTFLAGS']='\x1f'.join(f'--remap-path-prefix={source}={target}' for source,target in [
        (home,'/home'),(os.environ.get('RUSTUP_HOME',home/'.rustup'),'/rustup'),
        (os.environ.get('CARGO_HOME',home/'.cargo'),'/cargo'),(ROOT,'/workspace')])
    binary = ROOT/'native/legal-structure-node/target/debug/crop-ab.exe'
    wait_for_cargo()
    if not args.skip_build:
        before = source_files()
        print('Linking the cached-image crop probe once.',flush=True)
        invoke(['node','scripts/cargo.mjs','build','--offline','--locked','-j','1','--manifest-path',
                'experiments/ocr-structure-attribution/Cargo.toml','--bin','crop-ab'],output/'build.log',env)
        after = source_files()
        write(output/'build.json',{'binary_sha256':digest(binary),'source_files':after,'source_unchanged':before==after})
        if before!=after: raise RuntimeError('Crop experiment sources changed during the build')
    write(output/'run.json',{'binary_sha256':digest(binary),'jobs_sha256':digest(output/'jobs.json'),
        'model_manifest_sha256':digest(pack/'manifest.json'),'runtime_sha256':digest(runtime),'frozen_run':old_run,
        'experiment':'white_margin_20_vs_10' if args.margin else 'neighbour_padding',
        'control_run_sha256':control_run_sha256})
    began = time.perf_counter()
    invoke([str(binary),str(output/'jobs.json'),str(pack),str(runtime)]+(['margin'] if args.margin else []),output/'native.log',env)
    summarize(parent,output,jobs)
    write(output/'timing.json',{'recognition_and_analysis_seconds':time.perf_counter()-began})


if __name__=='__main__': main()
