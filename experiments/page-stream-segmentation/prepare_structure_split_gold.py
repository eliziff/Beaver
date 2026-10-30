"""Add the structure gold's own document starts as split gold, for the sources whose split
annotation is their structure gold's (gold store origin structure-gold), preserving source-owned labels."""
import argparse
import io
import json
from pathlib import Path
import sys

from PIL import Image
import pymupdf

from prepare_cpu_full_gold import digest,internal_pages,partitions,read,write

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'legal_pdf_corpus'))
import gold_store


def unit_starts(gold):
    """The line ids that open the gold's documents after its first."""
    first=next(i for i,u in enumerate(gold['units']) if 'document_type' in u)
    return {next(span['line_id'] for k in unit['lines'] for span in gold['typed'][k]['spans'])
        for i,unit in enumerate(gold['units']) if i>first and unit['starts_document']}


def augment(root):
    base=root/'teacher-data'; data=read(base/'full-training.json'); internal=read(base/'internal-training.json')
    find,split=partitions(read(base/'family-map.json'),read(base/'teacher-training.json'),read(base/'teacher-test.json'))
    data['cases']=[c for c in data['cases'] if c.get('gold_panel')!='registered-structure-unit-starts']
    internal['pages']=[p for p in internal['pages'] if p.get('gold_panel')!='registered-structure-unit-starts']
    labels={(c['sha256'],int(p)):v for c in data['cases'] for p,v in c['targets'].items()}
    existing_internal={(p['sha256'],p['page']) for p in internal['pages']}
    sources=[(sha,path) for sha,_,_,path in gold_store.split_sources('structure-gold')]
    ambiguous=[]; conflicts=[]; additions=[]; new_internal=[]
    for number,(sha,gold_path) in enumerate(sources,1):
        if split(sha)=='test': continue
        gold=gold_store.read(gold_path)
        pdf_path=gold_store.pdf(sha)
        if digest(pdf_path)!=sha: raise ValueError('Registered structure PDF identity mismatch')
        lines=gold['lines']; by_id={l['id']:l for l in lines}; first={}
        for line in lines: first.setdefault(line['page'],line['id'])
        own={'furniture','page_label','line_label'}
        body={span['line_id'] for typed in gold['typed'] if typed['region'] not in own for span in typed['spans']}
        starts=unit_starts(gold); edges=set(); inside=set(); uncertain=set()
        for key in starts:
            line=by_id[key]; page=line['page']
            if first[page]==key: edges.add(page)
            else:
                before=[]
                for previous in lines:
                    if previous['id']==key: break
                    if previous['page']==page: before.append(previous['id'])
                if any(k in body for k in before): inside.add(key)
                else:
                    uncertain.add(key); ambiguous.append(dict(sha256=sha,page=page,line_id=key,
                        reason='Unit start follows only page furniture; physical cut is not explicitly labelled.'))
        uncertain_pages={by_id[k]['page'] for k in uncertain}
        images=[]; boxes={}
        with pymupdf.open(pdf_path) as pdf:
            assert len(pdf)==gold['page_count']
            for page_number,page in enumerate(pdf,1):
                pix=page.get_pixmap(matrix=pymupdf.Matrix(1.5,1.5),alpha=False)
                image=Image.frombytes('RGB',(pix.width,pix.height),pix.samples).resize((512,512))
                buffer=io.BytesIO(); image.save(buffer,format='PNG'); raw=buffer.getvalue()
                import hashlib
                image_sha=hashlib.sha256(raw).hexdigest(); path=base/'images'/(image_sha+'.png')
                if not path.exists(): path.write_bytes(raw)
                images.append(dict(page=page_number,path='images/'+path.name,sha256=image_sha))
                for line in lines:
                    if line['page']==page_number and line.get('bbox'):
                        x0,y0,x1,y1=line['bbox']
                        if x1>x0 and y1>y0:
                            boxes[line['id']]=[x0/page.rect.width,y0/page.rect.height,x1/page.rect.width,y1/page.rect.height]
        targets={}
        conflict_pages=set()
        for page in range(2,gold['page_count']+1):
            if page in uncertain_pages: continue
            label=int(page in edges); key=sha,page
            if key in labels:
                if labels[key]!=label:
                    conflicts.append(dict(sha256=sha,page=page,existing_page_gold=labels[key],structure_label=label))
                    conflict_pages.add(page)
            else: targets[str(page)]=label
        if targets:
            additions.append(dict(case_id=sha+'-registered-structure',sha256=sha,family_id=find(sha),split=split(sha),
                targets=targets,images=images,gold_panel='registered-structure-unit-starts'))
            labels.update({(sha,int(p)):v for p,v in targets.items()})
        # Keep explicit page-stream reviews when both annotation systems cover a page.
        part=dict(document_starts=[dict(page=by_id[k]['page'],line_id=k,text=by_id[k]['text']) for k in inside])
        frame=dict(lines=[dict(id=l['id'],page=l['page'],text=l['text']) for l in lines])
        for page in internal_pages(part,frame,boxes,set(range(1,gold['page_count']+1))):
            if (sha,page['page']) in existing_internal or page['page'] in conflict_pages or page['page']+1 in conflict_pages: continue
            page['candidates']=[c for c in page['candidates'] if c['line_id'] not in uncertain]
            if not page['candidates']: continue
            new_internal.append(dict(sha256=sha,family_id=find(sha),split=split(sha),
                frame_sha256=digest(gold_path),image=images[page['page']-1],
                gold_panel='registered-structure-unit-starts',**page))
        if number%20==0: print(json.dumps(dict(processed_sources=number,total_sources=len(sources))),flush=True)
    data['cases'].extend(additions); internal['pages'].extend(new_internal)
    import hashlib
    data['source_artifacts']['registered_structure_catalogue']=hashlib.sha256(json.dumps(
        [(sha,digest(path)) for sha,path in sources],sort_keys=True).encode()).hexdigest()
    write(base/'full-training.json',data); write(base/'internal-training.json',internal)
    summary={}
    for name in ('train','development'):
        cases=[c for c in data['cases'] if c['split']==name]; pages=[p for p in internal['pages'] if p['split']==name]
        summary[name]=dict(page_edges=sum(len(c['targets']) for c in cases),page_starts=sum(sum(c['targets'].values()) for c in cases),
            internal_starts=sum(c['label'] for p in pages for c in p['candidates']),line_candidates=sum(len(p['candidates']) for p in pages),
            families=len({c['family_id'] for c in cases}))
    write(base/'structure-gold-augmentation.json',dict(origin='machine_test',run_id='registered-structure-split-export',
        registered_sources=len(sources),ambiguous_unit_starts=ambiguous,conflicting_page_labels=conflicts,splits=summary))
    print(json.dumps(dict(splits=summary,ambiguous_unit_starts=len(ambiguous),conflicting_page_labels=len(conflicts))))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    args=parser.parse_args(); augment(args.root)
