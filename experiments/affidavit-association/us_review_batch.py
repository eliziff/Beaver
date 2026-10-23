"""One fresh independent review call for explicitly partitioned compact records."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import fitz

import us_author as u


def additional_pages(rid,parts,target,directory):
    config=u.OUT/'record-review-pages.json'
    selected=json.loads(config.read_text(encoding='utf8')).get(rid,{}) if config.exists() else {}
    images=[]
    views=[]
    locations=[('original',str(p['attachment']),Path(p['path']),selected.get('original',{}).get(str(p['attachment']),[])) for p in parts]
    for name,pages in selected.get('stripped',{}).items():
        path=(target/'files'/name).resolve()
        if path.parent!=(target/'files').resolve():
            raise ValueError('Extra review output must be in the owning record files directory')
        locations.append(('stripped',name,path,pages))
    for kind,key,path,pages in locations:
        if not pages:
            continue
        with fitz.open(path) as document:
            for number in sorted(set(pages)):
                page=document[number-1]
                image=directory/f'extra-{kind}-{key}-page-{number}.png'
                page.get_pixmap(matrix=fitz.Matrix(1200/page.rect.width,1200/page.rect.width),alpha=False).save(image)
                images.append(image)
                views.append({'kind':kind,'source_or_file':key,'page':number,'image':str(image.relative_to(u.OUT)),
                              'pdf_sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    return images,views


def main(ids):
    if not ids or len(ids)!=len(set(ids)):
        raise ValueError('Supply distinct explicit record IDs')
    attempted=sum(len(json.loads(p.read_text(encoding='utf8'))['attempts']) for p in u.OUT.glob('work/*/*/*/receipt.json'))
    if attempted>=110:
        raise ValueError('US 110-attempt authorization exhausted')
    running=[p for p in u.OUT.glob('work/*/*/*/receipt.json') if any(a['status']=='running' for a in json.loads(p.read_text(encoding='utf8'))['attempts'])]
    if running:
        raise ValueError('Drain and stop the ordinary worker before a separately budgeted batch')
    u.configure_transport()
    items={x['case']['record']+'-entry-'+str(x['entry']):x for x in u.sources()}
    text=[]
    images=[]
    prepared={}
    views=[]
    for rid in ids:
        d=u.OUT/'work'/rid
        if (u.OUT/'records'/rid/'gold.json').exists():
            raise ValueError('Already accepted: '+rid)
        parts,prompt,originals=u.packet(items[rid],d)
        author=u.recover_author(parts,d)
        if not author or not author['accept']:
            raise ValueError('No existing source-authored accepted proposal: '+rid)
        prompt=u.source_prompt(items[rid],d,parts,{m['attachment'] for m in author['mapping']})
        target=u.build(rid,items[rid],parts,author,None,d)
        materialized,outputs=u.materialized_packet(target,d)
        extras,extra_views=additional_pages(rid,parts,target,d)
        record_images=originals+outputs+extras
        start=len(images)+1
        images.extend(record_images)
        text.append('\nBEGIN DISTINCT RECORD '+rid+'\nIMAGE ORDINALS '+str(start)+' through '+str(len(images))+'\n'+prompt+materialized+
          '\nADDITIONAL INTERIOR PAGE IMAGES (after boundary images)\n'+json.dumps(extra_views)+
          '\nPROPOSED GOLD\n'+author['gold_json']+'\nPROPOSED SOURCE RANGES\n'+json.dumps(author['mapping'])+'\nEND DISTINCT RECORD '+rid+'\n')
        prepared[rid]=(parts,author,d)
        views.append({'record_id':rid,'image_ordinal_first':start,'image_ordinal_last':len(images),
          'unselected_native_preview_chars':800,
          'additional_interior_views':extra_views,
          'sources':[{key:part[key] for key in ['attachment','sha256','url','pages']} for part in parts],
          'split_sha256':hashlib.sha256((target/'split.json').read_bytes()).hexdigest(),
          'images':[{'path':str(p.relative_to(u.OUT)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in record_images],
          'complete_stripped_exhibits':[{'file':p.name,'pdf_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
            'text_sha256':hashlib.sha256(p.with_suffix('.txt').read_bytes()).hexdigest()} for p in sorted((target/'files').glob('*.pdf'))]})
    prompt='Each BEGIN/END DISTINCT RECORD is a separate target. Independently review each against only its own sources and stripped outputs. Never transfer dates, quotations, labels, or mapping between targets. Return exactly one result per requested record ID. A shared call does not merge the records. Reject an uncertain record individually; do not waive physical defects. All selected output text is supplied in full.\n'+u.REVIEW+'\nREQUESTED IDS '+json.dumps(ids)+'\n'+''.join(text)
    if len(prompt)>650000 or len(images)>110:
        raise ValueError('Batch exceeds full-selected-source bounds; use fewer records')
    batch='review-'+hashlib.sha256(prompt.encode()).hexdigest()[:16]
    directory=u.OUT/'batches'/batch
    directory.mkdir(parents=True,exist_ok=True)
    u.dump(directory/'source-views.json',views)
    properties={'record_id':{'type':'string'},**u.REVIEW_FIELDS}
    item={'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}
    schema=directory/'schema.json'
    u.dump(schema,{'type':'object','properties':{'records':{'type':'array','items':item}},'required':['records'],'additionalProperties':False})
    def shape(value):
        if len(value['records'])!=len(ids) or {r['record_id'] for r in value['records']}!=set(ids):
            raise ValueError('Missing, duplicate or unexpected result ID')
        return value
    calls=u.OUT/'work/_review_batches'/batch
    result=u.call(prompt,schema,images,calls,u.ARGS,shape,dispatch=u.invoke,policy=u.POLICY)
    receipt=next(calls.glob('*/receipt.json'))
    response=receipt.parent/'response.json'
    summary={'accepted':[],'rejected':[],'shared_review_receipt':str(receipt.relative_to(u.OUT))}
    for reviewed in result['records']:
        rid=reviewed['record_id']
        parts,author,d=prepared[rid]
        reviewed={**reviewed,'_review_receipt':str(receipt.relative_to(u.OUT)),'_batch_response':str(response.relative_to(u.OUT))}
        u.dump(d/'batch-review.json',reviewed)
        if not reviewed['accept']:
            summary['rejected'].append({'id':rid,'reason':reviewed['reason']})
            continue
        try:
            expected={}
            for mapping in author['mapping']:
                expected.setdefault(mapping['label'],[]).append(mapping['attachment'])
            actual=json.loads(reviewed['mapping_json'])
            actual={label:([value] if isinstance(value,int) else value) for label,value in actual.items()}
            if {label:actual.get(label) for label in expected}!=expected:
                raise ValueError('Independent batch mapping differs from source author')
            u.build(rid,items[rid],parts,author,reviewed,d)
            summary['accepted'].append(rid)
        except Exception as exc:
            summary['rejected'].append({'id':rid,'reason':'Independent accepted result failed validation: '+str(exc)})
    u.dump(directory/'summary.json',summary)
    print(json.dumps(summary),flush=True)


if __name__=='__main__':
    main(sys.argv[1:])
