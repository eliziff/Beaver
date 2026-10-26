"""Replay only unambiguously matched crop readings through cached native extraction."""
import os
from collections import Counter, defaultdict
from pathlib import Path

from analyze import ROOT, DEFAULT_OUT, digest, read, write
from run import invoke, wait_for_cargo, source_identity


def main():
    parent=DEFAULT_OUT;output=parent/'crop-ab';pages=read(output/'jobs.json')
    documents={j['sha256']:j for j in read(parent/'jobs.json')['documents']};jobs=[]
    for sha in sorted({p['source_sha256'] for p in pages}):
        document=documents[sha];extraction=parent/'native'/sha/'extraction.json.gz'
        jobs.append({'sha256':sha,'gold':document['gold'],'gold_sha256':document['gold_sha256'],
            'extraction':str(extraction),'extraction_sha256':digest(extraction),
            'pages':[{'number':p['page'],'readings':str(Path(p['output'])/'readings.json'),
                      'readings_sha256':digest(Path(p['output'])/'readings.json')} for p in pages if p['source_sha256']==sha]})
    write(output/'structure-jobs.json',jobs)
    env=dict(os.environ);env.update(CARGO_BUILD_JOBS='1',RAYON_NUM_THREADS='1',RUST_TEST_THREADS='1');home=Path.home()
    env['CARGO_ENCODED_RUSTFLAGS']='\x1f'.join(f'--remap-path-prefix={source}={target}' for source,target in [
        (home,'/home'),(os.environ.get('RUSTUP_HOME',home/'.rustup'),'/rustup'),
        (os.environ.get('CARGO_HOME',home/'.cargo'),'/cargo'),(ROOT,'/workspace')])
    def sources():
        return {**source_identity(),**{p.relative_to(ROOT).as_posix():digest(p)
            for p in (ROOT/'experiments/ocr-structure-attribution/src/bin').glob('*.rs')}}
    wait_for_cargo();before=sources()
    invoke(['cargo','build','--offline','--locked','-j','1','--manifest-path',
        'experiments/ocr-structure-attribution/Cargo.toml','--bin','crop-structure'],output/'structure-build.log',env)
    after=sources();binary=ROOT/'native/legal-structure-node/target/debug/crop-structure.exe'
    write(output/'structure-build.json',{'source_files':after,'source_unchanged':before==after,'binary_sha256':digest(binary)})
    if before!=after:raise RuntimeError('Structure sources changed during the build')
    write(output/'structure-run.json',{'binary_sha256':digest(binary),
        'jobs_sha256':digest(output/'structure-jobs.json'),'crop_run_sha256':digest(output/'run.json'),
        'script_sha256':digest(Path(__file__))})
    invoke([str(binary),str(output/'structure-jobs.json'),str(output/'structure-partial.json')],output/'structure.log',env)
    result=read(output/'structure-partial.json');pool=defaultdict(lambda:defaultdict(Counter))
    for d in result['documents']:
        for arm in ['baseline','candidate_partial']:
            for name,metric in d[arm].items():pool[arm][name].update(metric)
    summary={'scope':result['scope'],'changed_readings':sum(d['changed_readings'] for d in result['documents']),
        'matched_lines':sum(d['matched_lines'] for d in result['documents']),
        'metrics':{a:{k:{**v,'f1':2*v['correct']/max(1,v['expected']+v['predicted'])}
                       for k,v in metrics.items()} for a,metrics in pool.items()}}
    write(output/'structure-summary.json',summary)
    print({'matched_lines':summary['matched_lines'],'changed_readings':summary['changed_readings'],
        'metrics':{a:{k:round(m['f1'],4) for k,m in v.items() if k in ['note_references','note','markers_text','markers_list_item']}
                   for a,v in summary['metrics'].items()}},flush=True)


if __name__=='__main__':main()
