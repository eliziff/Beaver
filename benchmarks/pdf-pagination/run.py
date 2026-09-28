"""Public-corpus visual checks. No private PDFs, detector predictions, or gold reach Codex."""
import argparse, concurrent.futures, hashlib, json, random, shutil, subprocess, threading, time
from collections import defaultdict
from pathlib import Path
import fitz
from sampling import sample_pages

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = ROOT / 'tmp/pdf-pagination'
render_lock = threading.Lock()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def prepare():
    OUT.mkdir(parents=True, exist_ok=True)
    groups = defaultdict(list)
    for line in (ROOT/'experiments/legal_pdf_corpus/ledger.jsonl').read_text(encoding='utf-8').splitlines():
        row = json.loads(line)
        path = ROOT/'experiments/legal_pdf_corpus'/(row.get('relative_path') or '')
        if row.get('status') == 'accepted' and row.get('kind') in ('judgment', 'law_report') and 3 <= row.get('page_count',0) <= 150 and path.is_file():
            groups[(row['jurisdiction'],row['source'],row['generation'])].append(dict(row,path=str(path),category='case'))
    rng = random.Random(20260927)
    for group in groups.values(): rng.shuffle(group)
    cases = []
    while len(cases) < 300 and any(groups.values()):
        for key in sorted(groups):
            if groups[key] and len(cases)<300: cases.append(groups[key].pop())
    unique={row['sha256']:row for row in cases}
    selected=sorted(unique.values(),key=lambda row:row['sha256'])
    # Group by public source URL before splitting; byte duplicates have already been removed.
    for row in selected:
        row['split']='development' if int(digest(row['url'].encode())[:8],16)%5==0 else 'held-out'
    (OUT/'manifest.json').write_text(json.dumps(selected,indent=2),encoding='utf-8')
    print(json.dumps({'documents':len(selected),'cases':sum(r['category']=='case' for r in selected),'judgment_only':True}),flush=True)

def saved_readings(row):
    path = OUT / (row['sha256'] + '.visual.json')
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else {'pages': []}


def pending_pages(row):
    done = {page['pdf_page'] for page in saved_readings(row)['pages']
            if page['status'] != 'needs_review'}
    return [page for page in sample_pages(row['sha256'], row['page_count']) if page not in done]


def check(batch):
    batch=[row for row in batch if pending_pages(row)]
    if not batch:return {'cached_batch':True}
    batch_id=digest(','.join(row['sha256'] for row in batch).encode())
    folder=OUT/'images'/('batch-'+batch_id);folder.mkdir(parents=True,exist_ok=True)
    result=folder/'response.json'
    images=[];identities=[]
    for row in batch:
        with render_lock, fitz.open(row['path']) as document:
            if digest(Path(row['path']).read_bytes()) != row['sha256']:
                raise ValueError('Source PDF hash mismatch')
            pages=pending_pages(row)
            for number in pages:
                image=folder/f'{len(images)+1}.png'
                document[number-1].get_pixmap(matrix=fitz.Matrix(1.6,1.6)).save(image)
                images.append(image);identities.append((row['sha256'],number))
    if not images:return {'prediction_errors':len(batch)}
    (OUT/(batch_id+'.image-map.json')).write_text(json.dumps(identities),encoding='utf-8')
    # Isolated working directory has only page images, never predictions or source metadata.
    cmd=[shutil.which('codex'),'exec','--ephemeral','--skip-git-repo-check','--sandbox','read-only',
        '-C',str(folder),'-m','gpt-6-luna','-c','model_reasoning_effort="max"',
        '--output-schema',str(HERE/'check.schema.json'),'--json','-o',str(result)]
    for image in images:cmd+=['-i',str(image)]
    cmd+=['-']
    prompt=(HERE/'prompt.txt').read_text()+ '\nThese images come from multiple documents. '
    prompt+='Use the supplied opaque image identifier as pdf_page; do not infer relationships between images.\n'
    prompt+=json.dumps(list(range(1,len(images)+1)))
    start=time.monotonic()
    for attempt in range(2):
        try:
            done=subprocess.run(cmd,input=prompt,text=True,encoding='utf-8',capture_output=True,timeout=300)
            (folder/'events.jsonl').write_text(done.stdout,encoding='utf-8')
            if done.returncode==0 and result.exists():
                response=json.loads(result.read_text(encoding='utf-8'))
                if sorted(p['pdf_page'] for p in response['pages'])!=list(range(1,len(images)+1)):raise ValueError('Page identity mismatch')
                grouped=defaultdict(list)
                for page in response['pages']:
                    sha,number=identities[page['pdf_page']-1]
                    grouped[sha].append(dict(page,pdf_page=number))
                for sha,readings in grouped.items():
                    prior=saved_readings({'sha256':sha})
                    merged={page['pdf_page']:page for page in prior['pages']}
                    merged.update({page['pdf_page']:dict(page, reader='gpt-6-luna-max') for page in readings})
                    (OUT/(sha+'.visual.json')).write_text(json.dumps({'pages':sorted(merged.values(), key=lambda page:page['pdf_page']),
                        'batch':batch_id,'prior_reader':prior.get('batch')}),encoding='utf-8')
                return {'documents':len(grouped),'seconds':round(time.monotonic()-start,2),'images':len(images)}
            error=done.stderr[-1500:]
        except Exception as exc:error=str(exc)
    (folder/'error.txt').write_text(error,encoding='utf-8')
    return {'batch':batch_id,'error':error}

def score(rows):
    counts=defaultdict(int);disagreements=[];groups={}
    for row in rows:
        pred=OUT/args.prediction_dir/(row['sha256']+'.prediction.json'); visual=OUT/(row['sha256']+'.visual.json')
        if not pred.exists() or not visual.exists():continue
        p=json.loads(pred.read_text(encoding='utf-8'));v=json.loads(visual.read_text(encoding='utf-8'))
        if 'bindings' not in p:continue
        group=groups.setdefault(row.get('origin',row['category']),defaultdict(int))
        counts['documents']+=1;group['documents']+=1
        counts['anchored_documents']+=bool(p['anchor']);group['anchored_documents']+=bool(p['anchor'])
        sampled=set(sample_pages(row['sha256'], row['page_count']))
        for page in v['pages']:
            if page['pdf_page'] not in sampled:continue
            expected=[x['text'] for x in page['labels']]
            binding=p['bindings'][page['pdf_page']-1];label=binding['label']
            counts['sampled_pages']+=1;group['sampled_pages']+=1
            if page['status']!='readable':
                counts[page['status']]+=1;group[page['status']]+=1
                if label is not None:
                    counts['labelled_without_readable_folio']+=1;group['labelled_without_readable_folio']+=1
                continue
            if label is None:counts['abstained_readable']+=1;group['abstained_readable']+=1
            elif label in expected:counts['agreed']+=1;group['agreed']+=1
            else:
                counts['disagreed']+=1;group['disagreed']+=1
                disagreements.append({'id':row['sha256'],'pdf_page':page['pdf_page'],'predicted':label,'visual':expected,'split':row['split']})
    result={'attempted_documents':len(rows),'counts':dict(counts),'groups':groups,'disagreements':disagreements,'note':'Exact-text model comparisons, not adjudicated gold. Abstentions and labels on non-readable pages are reported separately.'}
    (OUT/(Path(args.manifest).stem+('-'+Path(args.prediction_dir).name if args.prediction_dir!='.' else '')+'-scores.json')).write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['prepare','check','score']);parser.add_argument('--limit',type=int,default=500)
    parser.add_argument('--manifest',default='manifest.json')
    parser.add_argument('--prediction-dir',default='.')
    parser.add_argument('--workers',type=int,choices=range(1,5),default=1)
    parser.add_argument('--batch-size',type=int,choices=range(1,6),default=1)
    parser.add_argument('--max-batches',type=int)
    args=parser.parse_args()
    if args.action=='prepare':prepare()
    else:
        rows=[row for row in json.loads((OUT/args.manifest).read_text(encoding='utf-8')) if row.get('category') != 'journal'][:args.limit]
        if args.action=='check':
            pending=[row for row in rows if pending_pages(row)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                batches=[pending[i:i+args.batch_size] for i in range(0,len(pending),args.batch_size)]
                for result in pool.map(check,batches[:args.max_batches]):print(json.dumps(result),flush=True)
            print(json.dumps({'documents':len(rows),'documents_with_pending_samples':sum(bool(pending_pages(row)) for row in rows)}),flush=True)
        else:score(rows)
