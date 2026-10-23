"""Explicitly partition compact records across source-author and independent-review calls."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

import us_author as u
import us_review_batch as review


def main(ids):
    if not ids or len(ids)!=len(set(ids)):
        raise ValueError('Supply distinct explicit record IDs')
    receipts=[json.loads(p.read_text(encoding='utf8')) for p in u.OUT.glob('work/*/*/*/receipt.json')]
    if sum(len(r['attempts']) for r in receipts)>108:
        raise ValueError('Two-stage batch cannot fit the US 110-attempt authorization')
    if any(a['status']=='running' for r in receipts for a in r['attempts']):
        raise ValueError('Drain and stop other US model work before batching')
    u.configure_transport()
    items={x['case']['record']+'-entry-'+str(x['entry']):x for x in u.sources()}
    text=[]
    images=[]
    parts_by_id={}
    views=[]
    cases={}
    for rid in ids:
        item=items[rid]
        case=item['case']['record']
        cases[case]=cases.get(case,0)+1
        if len(list((u.OUT/'records').glob(case+'-entry-*/gold.json')))+cases[case]>8:
            raise ValueError('Batch would exceed eight records per matter')
        d=u.OUT/'work'/rid
        d.mkdir(parents=True,exist_ok=True)
        if (u.OUT/'records'/rid/'gold.json').exists() or (d/'batch-author.json').exists():
            raise ValueError('Use existing proposal/review path for previously authored target: '+rid)
        parts,prompt,imgs=u.packet(item,d)
        if u.recover_author(parts,d) is not None:
            raise ValueError('Existing interactive/repair annotation: '+rid)
        first=len(images)+1
        images.extend(imgs)
        text.append('\nBEGIN DISTINCT RECORD '+rid+'\nIMAGE ORDINALS '+str(first)+' through '+str(len(images))+'\n'+prompt+'\nEND DISTINCT RECORD '+rid+'\n')
        parts_by_id[rid]=parts
        views.append({'record_id':rid,'image_ordinal_first':first,'image_ordinal_last':len(images),
                      'sources':[{key:p[key] for key in ['attachment','sha256','url','pages']} for p in parts]})
    prompt='Apply the following task independently to each BEGIN/END DISTINCT RECORD. Never transfer labels, facts, quotations, or dates between records. Return exactly one result per requested record ID. Select complete challenging own exhibits that can be fully independently reviewed; list other actually available exhibits honestly as available_not_selected.\n'+u.AUTHOR+'\nREQUESTED IDS '+json.dumps(ids)+'\n'+''.join(text)
    if len(prompt)>650000 or len(images)>110:
        raise ValueError('Author batch exceeds disclosed evidence bounds; use fewer targets')
    batch='author-'+hashlib.sha256(prompt.encode()).hexdigest()[:16]
    directory=u.OUT/'batches'/batch
    directory.mkdir(parents=True,exist_ok=True)
    u.dump(directory/'source-views.json',views)
    properties={'record_id':{'type':'string'},**u.FIELDS}
    item_schema={'type':'object','properties':properties,'required':list(properties),'additionalProperties':False}
    schema=directory/'schema.json'
    u.dump(schema,{'type':'object','properties':{'records':{'type':'array','items':item_schema}},'required':['records'],'additionalProperties':False})
    def shape(value):
        if len(value['records'])!=len(ids) or {r['record_id'] for r in value['records']}!=set(ids):
            raise ValueError('Missing, duplicate or unexpected author result ID')
        return value
    calls=u.OUT/'work/_author_batches'/batch
    result=u.call(prompt,schema,images,calls,u.ARGS,shape,dispatch=u.invoke,policy=u.POLICY)
    receipt=next(calls.glob('*/receipt.json'))
    accepted=[]
    rejected=[]
    for proposal in result['records']:
        rid=proposal['record_id']
        try:
            proposal=u.source_bound_author(proposal,parts_by_id[rid],u.OUT/'work'/rid)
            if proposal['accept'] and json.loads(proposal['gold_json'])['record_id']!=rid:
                raise ValueError('Gold belongs to a different target')
            proposal={**proposal,'_author_receipt':str(receipt.relative_to(u.OUT)),
                      '_batch_response':str((receipt.parent/'response.json').relative_to(u.OUT))}
            u.dump(u.OUT/'work'/rid/'batch-author.json',proposal)
            (accepted if proposal['accept'] else rejected).append(rid)
        except Exception as exc:
            rejected.append({'id':rid,'reason':str(exc)})
    u.dump(directory/'summary.json',{'source_accepted':accepted,'source_rejected':rejected,'shared_author_receipt':str(receipt.relative_to(u.OUT))})
    print('Source-author accepted',accepted,'rejected',rejected,flush=True)
    if accepted:
        review.main(accepted)


if __name__=='__main__':
    main(sys.argv[1:])
