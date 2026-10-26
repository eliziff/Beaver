"""Run on the desktop: reconcile split gold directly into its private GitHub store.

Token arrives on stdin, is never persisted or printed. Existing B7 records remain
the owner of their labels; additional records contain only uncovered decisions.
"""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import sys
import urllib.request
from urllib.error import HTTPError


REPO='eliziff/benchmarks-private'


def encode(value):
    return (json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode()


def main(root,legal,checkout=None):
    token=sys.stdin.readline().strip()
    assert token, 'Missing transient GitHub credential'
    def api(path,body=None,method=None):
        request=urllib.request.Request('https://api.github.com/repos/'+REPO+('/'+path if path else ''),
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+token,'Accept':'application/vnd.github+json',
                'User-Agent':'private-split-gold-reconciler'},method=method)
        with urllib.request.urlopen(request,timeout=120) as response:
            return json.load(response)
    assert api('')['private'] is True, 'Destination must remain private'
    head=api('git/ref/heads/main')['object']['sha']
    base_tree=api('git/commits/'+head)['tree']['sha']
    def remote(path):
        item=api('contents/'+path+'?ref='+head)
        assert item['type']=='file'
        return base64.b64decode(item['content'])
    final=json.loads((legal/'authoring-splits.json').read_bytes())
    old=json.loads(remote('structure-gold/b7/split/authoring-splits.json'))
    old_sources={s['sha256']:s for s in old['sources']}
    changes=[]
    for source in final['sources']:
        before=old_sources[source['sha256']]
        if before!=source:
            assert {**before,'document_starts':source['document_starts']}==source
            removed=[s for s in before['document_starts'] if s not in source['document_starts']]
            added=[s for s in source['document_starts'] if s not in before['document_starts']]
            assert removed==[251] and not added, 'Unexpected gold modification'
            changes.append(source['sha256'])
    assert len(changes)<=1
    files={}
    if changes:
        sha=changes[0]
        for relative in ('authoring-splits.json','gold.json','annotations/'+sha+'/gold.json'):
            files['structure-gold/b7/split/'+relative]=(legal/relative).read_bytes()
    sources={s['sha256']:s for s in final['sources']}
    labels={}; anchors={}; provenance={}
    def add(sha,page,label,origin):
        key=sha,int(page)
        assert label in (0,1)
        if key in labels: assert labels[key]==label, 'Conflicting accepted gold'
        labels[key]=label
        provenance.setdefault(sha,set()).add(origin)
    inventory_path=root/'gold-inventory-local.json'
    if not inventory_path.exists(): inventory_path=root/'gold-inventory.json'
    inventory=json.loads(inventory_path.read_bytes())
    for record in inventory['records']:
        sha=record['sha256']
        for page,label in record['targets'].items(): add(sha,page,label,record['source_category'])
        for start in record['internal_starts']:
            key=sha,start['page'],start['line_id']
            anchors[key]=dict(page=start['page'],line_id=start['line_id'])
    teacher=json.loads((root/'teacher-data/teacher-training.json').read_bytes())
    for case in teacher['cases']:
        add(case['sha256'],case['right_page'],case['label'],'reviewed-teacher-reference')
    held_path=root/'teacher-data/test.json'
    if not held_path.exists(): held_path=root/'teacher-data/teacher-test.json'
    held=json.loads(held_path.read_bytes())
    for case in held['cases']:
        targets=case.get('targets',{str(case['right_page']):case['label']})
        for page,label in targets.items():
            add(case['sha256'],page,label,'sealed-final-reference')
    uncovered={}; covered=0; superseded=[]
    for (sha,page),label in sorted(labels.items()):
        source=sources.get(sha)
        scope=set(source['pages']) if source and 'pages' in source else None
        if source and page>1 and (scope is None or (page in scope and page-1 in scope)):
            expected=int(page in source['document_starts'])
            if label!=expected:
                superseded.append(dict(sha256=sha,page=page,historical_label=label,
                    authoritative_label=expected,provenance=sorted(provenance[sha]),
                    authority='structure-gold/b7/split/authoring-splits.json',
                    training_status='excluded-historical-reference'))
            covered+=1
        else:
            uncovered.setdefault(sha,{})[str(page)]=label
    records=[]
    for sha in sorted(set(uncovered)|{key[0] for key in anchors}):
        starts=[]
        existing={(s['page'],s['line_id']) for s in sources.get(sha,{}).get('document_starts',[]) if isinstance(s,dict)}
        for (source,page,line),anchor in sorted(anchors.items()):
            if source==sha and (page,line) not in existing: starts.append(anchor)
        if not uncovered.get(sha) and not starts: continue
        record=dict(schema='page-stream-gold.v1',sha256=sha,
            page_boundaries=uncovered.get(sha,{}),internal_starts=starts,
            provenance=sorted(provenance.get(sha,set())),historical_submission_origin='unknown')
        path='page-stream-gold/sources/'+sha+'.json'
        raw=encode(record); files[path]=raw
        records.append(dict(sha256=sha,path=path,record_sha256=hashlib.sha256(raw).hexdigest(),
            page_boundaries=len(record['page_boundaries']),internal_starts=len(starts)))
    # Keep the immutable source frame for each additional internal anchor once.
    frame_paths=list((root/'additional-gold-frames').glob('*.json'))
    frame_paths+=list((root.parent/'within-page-check/annotations').glob('*/packet-extraction.json'))
    for path in frame_paths:
        sha=path.parent.name if path.name=='packet-extraction.json' else path.stem
        if any(r['sha256']==sha and r['internal_starts'] for r in records):
            files['page-stream-gold/frames/'+sha+'.json.gz']=gzip.compress(path.read_bytes(),mtime=0)
    try: existing_index=json.loads(remote('page-stream-gold/index.json'))
    except HTTPError as error:
        if error.code!=404: raise
        existing_index={}
    index=dict(existing_index,schema='page-stream-gold-index.v1',origin='machine_test',run_id='split-gold-reconciliation',
        existing_gold='structure-gold/b7/split/authoring-splits.json',
        existing_gold_sha256=hashlib.sha256((legal/'authoring-splits.json').read_bytes()).hexdigest(),
        additional_sources=records,overlapping_edges_referenced_only=covered,
        source_pdfs='Canonical corpus identified by source sha256; not copied.',
        final_holdout_policy='Stored for preservation; excluded from fitting and development scoring.')
    files['page-stream-gold/index.json']=encode(index)
    files['page-stream-gold/superseded-references.json']=encode(superseded)
    correction=root/'gold-correction.json'
    if correction.exists(): files['page-stream-gold/correction.json']=correction.read_bytes()
    if not existing_index:
        files['page-stream-gold/README.md']=b'''# Page-stream split gold\n\nThe B7 labels remain in `../structure-gold/b7/split/authoring-splits.json`.\n`index.json` references those labels and lists only additional decisions, once\nper PDF sha256. Each page-boundary key is the physical right page (1-based);\n0 means continuation and 1 means a new document. Missing keys are unknown.\nInternal starts preserve physical page and immutable source-frame line ID.\nFrames for additional internal anchors are stored once under `frames/`.\nPage-only decisions do not imply within-page negative labels.\nOriginal PDFs and model weights are not stored here. Historical origin is\nunknown; the reconciliation submission is machine_test. Family holdout policy\nmust be preserved by training exporters.\n'''
    tree=[]
    for path,raw in files.items():
        if checkout:
            target=checkout/path
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(raw)
        # Idempotent: unchanged paths retain their existing Git object.
        blob=api('git/blobs',{'content':base64.b64encode(raw).decode(),'encoding':'base64'})
        tree.append(dict(path=path,mode='100644',type='blob',sha=blob['sha']))
    new_tree=api('git/trees',{'base_tree':base_tree,'tree':tree})['sha']
    if new_tree==base_tree:
        commit=head
    else:
        commit=api('git/commits',dict(message='Reconcile complete page-stream split gold and corrected B7 boundary',
            tree=new_tree,parents=[head],author=dict(name='eliziff',email='eliziff@users.noreply.github.com')))['sha']
        api('git/refs/heads/main',{'sha':commit,'force':False},method='PATCH')
    assert api('git/ref/heads/main')['object']['sha']==commit
    verified=json.loads(base64.b64decode(api('contents/page-stream-gold/index.json?ref='+commit)['content']))
    assert verified==index
    receipt=dict(repository=REPO,commit=commit,private=True,records=len(records),
        additional_page_edges=sum(r['page_boundaries'] for r in records),
        additional_internal_starts=sum(r['internal_starts'] for r in records),
        overlapping_edges_referenced_only=covered,b7_sources=len(sources),
        corrected_gold_sources=len(changes),superseded_reference_edges=len(superseded),verified=True)
    (root/'teacher-data/private-gold-save.json').write_bytes(encode(receipt))
    print(json.dumps(receipt))


if __name__=='__main__':
    main(Path(sys.argv[1]),Path(sys.argv[2]),Path(sys.argv[3]) if len(sys.argv)>3 else None)
