"""Export all authored split supervision, preserving within-page line anchors.

Extra gold is prepared locally; the full dataset is assembled on the desktop.
No gold is inferred from document inventory or model predictions.
"""
import argparse
from collections import defaultdict
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

from PIL import Image
import pymupdf


def read(path):
    return json.loads(path.read_bytes())


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream,'sha256').hexdigest()


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,indent=2)+'\n',encoding='utf-8')


def exported_lines(value):
    document=value.get('document',value)
    pages=document.get('extraction',document).get('pages',[])
    return {line['id']:(p+1,page,line) for p,page in enumerate(pages) for line in page.get('lines',[])}


def line_boxes(frame, caches, pdf_path):
    """Only exact source-frame ID/text joins, or unique exact PDF text matches."""
    expected={line['id']:line for line in frame['lines']}
    best={}
    for path in caches:
        raw=gzip.decompress(path.read_bytes()) if path.suffix=='.gz' else path.read_bytes()
        try:
            candidate=exported_lines(json.loads(raw))
        except (ValueError,KeyError,TypeError,AttributeError):
            continue
        matched={key:item for key,item in candidate.items() if key in expected
            and item[0]==expected[key]['page'] and item[2].get('text')==expected[key]['text']}
        if len(matched)>len(best): best=matched
    result={}
    for key,(page,meta,line) in best.items():
        box=line.get('bbox')
        width,height=meta.get('width',0),meta.get('height',0)
        if box and width>0 and height>0 and box[2]>box[0] and box[3]>box[1]:
            result[key]=[box[0]/width,box[1]/height,box[2]/width,box[3]/height]
    missing=defaultdict(list)
    for key,line in expected.items():
        if key not in result: missing[line['page']].append(line)
    if missing:
        with pymupdf.open(pdf_path) as pdf:
            for p,lines in missing.items():
                page=pdf[p-1]
                text_boxes=defaultdict(list)
                for block in page.get_text('dict')['blocks']:
                    for line in block.get('lines',[]):
                        text=''.join(span['text'] for span in line['spans']).strip()
                        text_boxes[text].append(line['bbox'])
                for line in lines:
                    hits=text_boxes.get(line['text'].strip(),[])
                    if len(hits)==1:
                        x0,y0,x1,y1=hits[0]
                        result[line['id']]=[x0/page.rect.width,y0/page.rect.height,x1/page.rect.width,y1/page.rect.height]
    return result


def internal_pages(part, frame, boxes, reviewed_pages):
    positives={s['line_id']:s for s in part['document_starts'] if isinstance(s,dict)}
    frames={line['id']:line for line in frame['lines']}
    for key,start in positives.items():
        if key not in frames or frames[key]['page']!=start['page'] or frames[key]['text']!=start['text'] or key not in boxes:
            raise ValueError('An internal positive lacks an exact source-frame/box alignment')
    pages=defaultdict(list)
    for line in frame['lines']:
        pages[line['page']].append(line)
    output=[]
    for page in sorted(reviewed_pages):
        candidates=[]
        for index,line in enumerate(pages.get(page,[])):
            if index==0 or line['id'] not in boxes:
                continue
            box=boxes[line['id']]
            box=[max(0.,min(1.,float(v))) for v in box]
            if box[2]<=box[0] or box[3]<=box[1]:
                if line['id'] in positives: raise ValueError('Internal positive has an invalid box')
                continue
            candidates.append(dict(line_id=line['id'],bbox=box,label=int(line['id'] in positives)))
        if candidates:
            output.append(dict(page=page,candidates=candidates))
    if sum(c['label'] for p in output for c in p['candidates'])!=len(positives):
        raise ValueError('Internal positives were lost or rounded during export')
    return output


def extra(source_root,out):
    inventory=read(source_root/'doc-split-v1/gold-inventory.json')
    home=Path(os.environ['LOCALAPPDATA'])/'OpenLegalData'
    labels={}
    for record in inventory['records']:
        for page,label in record['targets'].items():
            key=record['sha256'],int(page)
            if key in labels and labels[key]!=label:
                raise ValueError('Conflicting extra gold requires explicit adjudication')
            labels[key]=label
    sources={record['sha256'] for record in inventory['records']}
    with sqlite3.connect((home/'corpus/corpus.sqlite').as_uri()+'?mode=ro',uri=True) as db:
        paths={sha:home/db.execute('select path from files where sha256=?',(sha,)).fetchone()[0] for sha in sources}
    assets={}
    out.mkdir(parents=True,exist_ok=True)
    (out/'images').mkdir(exist_ok=True)
    def asset(sha,page,pdf):
        key=sha,page
        if key not in assets:
            candidates=list((source_root/'annotations'/sha/'pages').glob(f'page-{page:06d}-*.png'))
            if candidates:
                with Image.open(candidates[0]) as image: image=image.convert('RGB').resize((512,512))
            else:
                pix=pdf[page-1].get_pixmap(matrix=pymupdf.Matrix(1.5,1.5),alpha=False)
                image=Image.frombytes('RGB',(pix.width,pix.height),pix.samples).resize((512,512))
            # PNG encoding is deterministic; paths are by the actual derived image hash.
            import io
            buffer=io.BytesIO(); image.save(buffer,format='PNG'); data=buffer.getvalue()
            sha_image=hashlib.sha256(data).hexdigest(); path=out/'images'/(sha_image+'.png')
            if not path.exists(): path.write_bytes(data)
            assets[key]=dict(page=page,path='images/'+path.name,sha256=sha_image)
        return assets[key]
    cases=[]
    internals=[]
    for sha in sorted(sources):
        if digest(paths[sha])!=sha: raise ValueError('Extra gold PDF differs')
        with pymupdf.open(paths[sha]) as pdf:
            for (source,page),label in sorted(labels.items()):
                if source!=sha: continue
                images=[asset(sha,p,pdf) for p in range(max(1,page-2),min(len(pdf),page+1)+1)]
                cases.append(dict(case_id=sha+'-extra-'+str(page),sha256=sha,targets={str(page):label},images=images))
            for path in (source_root/'within-page-check/annotations'/sha).glob('gold.json'):
                gold=read(path)
                for part in gold['sources']:
                    starts=[s for s in part['document_starts'] if isinstance(s,dict)]
                    if not starts: continue
                    frame_path=path.parent/'packet-extraction.json'; frame=read(frame_path)
                    caches=list((path.parent/'parsed').rglob('*.json*'))
                    boxes=line_boxes(frame,caches,paths[sha])
                    for page in internal_pages(part,frame,boxes,{s['page'] for s in starts}):
                        internals.append(dict(sha256=sha,frame_sha256=digest(frame_path),
                            image=asset(sha,page['page'],pdf),**page))
    write(out/'additional-gold.json',dict(origin='machine_test',run_id='additional-authored-split-gold',
        inventory_sha256=digest(source_root/'doc-split-v1/gold-inventory.json'),edge_cases=cases,internal_pages=internals))
    print(json.dumps(dict(edge_seams=len(cases),page_starts=sum(labels.values()),sources=len(sources),
        images=len({a['sha256'] for a in assets.values()}),internal_starts=sum(c['label'] for p in internals for c in p['candidates']))))


def partitions(current,test,family):
    parent={}
    def find(key):
        parent.setdefault(key,key)
        if parent[key]!=key: parent[key]=find(parent[key])
        return parent[key]
    def link(a,b):
        a,b=find(a),find(b); parent[max(a,b)]=min(a,b)
    for a,b in family.items(): link(a,b)
    for case in current['cases']+test['cases']: link(case['sha256'],case['family_id'])
    held={find(c['sha256']) for c in test['cases']}
    splits={find(c['sha256']):c['split'] for c in current['cases']+test['cases']}
    def split(sha):
        key=find(sha)
        if key in held: return 'test'
        return splits.get(key,'development' if int(hashlib.sha256(('cpu-full-gold:'+key).encode()).hexdigest(),16)%5==0 else 'train')
    return find,split


def full(root,legal_root):
    sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'legal_pdf_corpus'))
    import gold_store
    base=root/'teacher-data'
    current=read(base/'training.json'); test=read(base/'test.json')
    family=read(base/'family-map.json')
    # Batch 7's split annotations, as the gold store holds them.
    final={'sources':[split for _,split,_,_ in gold_store.split_sources('b7-splitter')]}
    documents={d['sha256']:d for d in read(legal_root/'authoring-manifest-all.json')['documents']}
    addition=read(base/'additional-gold.json')
    find,split=partitions(current,test,family)
    cases=[]; internal=[]; labels={}; source_artifacts={}; superseded=[]
    def add(case):
        sha=case['sha256']; partition=split(sha)
        if partition=='test': return
        targets={}
        for page,label in case['targets'].items():
            key=sha,page
            if key in labels:
                if labels[key]!=label:
                    if case['gold_panel']!='additional-authored-and-reviewed-reference-gold':
                        raise ValueError('Conflicting accepted gold requires explicit adjudication')
                    superseded.append(dict(sha256=sha,page=int(page),historical_label=label,authoritative_label=labels[key]))
            else:
                targets[page]=label; labels[key]=label
        if targets:
            cases.append({**case,'targets':targets,'family_id':find(sha),'split':partition})
    for source in final['sources']:
        sha=source['sha256']; doc=documents[sha]; count=doc['pages']
        if split(sha)=='test': continue
        scope=set(source.get('pages',range(1,count+1)))
        starts={s for s in source['document_starts'] if type(s) is int}
        images=[]
        for page in range(1,count+1):
            matches=list((legal_root/'annotations'/sha/'pages').glob(f'page-{page:06d}-*.png'))
            if len(matches)!=1: raise ValueError('Original teacher page missing or ambiguous')
            with Image.open(matches[0]) as image:
                import io
                buffer=io.BytesIO(); image.convert('RGB').resize((512,512)).save(buffer,format='PNG'); data=buffer.getvalue()
            image_sha=hashlib.sha256(data).hexdigest(); path=base/'images'/(image_sha+'.png')
            if not path.exists(): path.write_bytes(data)
            images.append(dict(page=page,path='images/'+path.name,sha256=image_sha))
        add(dict(case_id=sha+'-full-page-gold',sha256=sha,
            targets={str(p):int(p in starts) for p in scope if p>1 and p-1 in scope},images=images,
            gold_panel='full-legal-split-gold'))
        frame_path=legal_root/'annotations'/sha/'packet-extraction.json'; frame=read(frame_path)
        caches=list((legal_root.parent/'inputs').glob(sha+'.json.gz'))
        boxes=line_boxes(frame,caches,Path(doc['path']))
        for page in internal_pages(source,frame,boxes,scope):
            internal.append(dict(sha256=sha,family_id=find(sha),split=split(sha),frame_sha256=digest(frame_path),
                image=images[page['page']-1],**page))
    examples={}
    for case in read(base/'teacher-training.json')['cases']:
        examples[case['sha256'],case['right_page']]=case
    for case in addition['edge_cases']:
        for page in case['targets']: examples.setdefault((case['sha256'],int(page)),case)
    for sha,_,folder,_ in gold_store.split_sources('reference'):
        if split(sha)=='test': continue
        path=folder/'split'/'reference.json'; gold=read(path)
        for page,label in gold['page_boundaries'].items():
            example=examples[sha,int(page)]
            add(dict(case_id=sha+'-registered-reference-'+page,sha256=sha,targets={page:label},
                images=example['images'],gold_panel='registered-sparse-split-reference'))
        source_artifacts['gold/'+sha+'/split/reference.json']=digest(path)
    existing={(p['sha256'],p['page']) for p in internal}
    for page in addition['internal_pages']:
        if split(page['sha256'])=='test' or (page['sha256'],page['page']) in existing: continue
        internal.append({**page,'family_id':find(page['sha256']),'split':split(page['sha256'])})
    for path in (legal_root/'authoring-splits.json',base/'teacher-training.json',base/'additional-gold.json'):
        source_artifacts[str(path)]=digest(path)
    write(base/'full-training.json',dict(schema_version='doc-split-teacher.v2',origin='machine_test',
        run_id='cpu-full-page-and-line-gold',source_artifacts=source_artifacts,cases=cases,
        report=dict(partition_status='Existing families retain partitions; new families assigned by stable hash; final holdout relatives excluded.')))
    write(base/'internal-training.json',dict(schema_version='doc-split-internal.v1',origin='machine_test',
        run_id='cpu-full-page-and-line-gold',source_artifacts=source_artifacts,pages=internal))
    summary={}
    for partition in ('train','development'):
        selected=[c for c in cases if c['split']==partition]; pages=[p for p in internal if p['split']==partition]
        summary[partition]=dict(page_edges=sum(len(c['targets']) for c in selected),
            page_starts=sum(sum(c['targets'].values()) for c in selected),
            line_candidates=sum(len(p['candidates']) for p in pages),
            internal_starts=sum(c['label'] for p in pages for c in p['candidates']),
            families=len({c['family_id'] for c in selected}))
    write(base/'full-gold-summary.json',dict(origin='machine_test',run_id='cpu-full-page-and-line-gold',
        splits=summary,full_sources=len(final['sources']),additional_edge_records=len(addition['edge_cases']),
        superseded_historical_references=superseded,
        final_holdout_opened=False,preparer_sha256=digest(Path(__file__))))
    print(json.dumps(summary,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('extra','full'))
    parser.add_argument('--source-root',type=Path)
    parser.add_argument('--out',type=Path)
    parser.add_argument('--root',type=Path)
    parser.add_argument('--legal-split-root',type=Path)
    args=parser.parse_args()
    extra(args.source_root,args.out) if args.command=='extra' else full(args.root,args.legal_split_root)
