"""Collect 50 distinct public SCC factums using existing candidate leads and official metadata."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
from types import SimpleNamespace
from urllib.parse import quote
import uuid

import fitz
import contracts as c
from expand_sources import scanned, store


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target',type=int,default=50)
    options=parser.parse_args()
    c.low_priority()
    out=c.ROOT/'benchmarks/local-data/legal-structure-gold/expansion-150/factums'
    out.mkdir(parents=True,exist_ok=True)
    manifest=out/'manifest.json'
    state=c.read_json(manifest) if manifest.exists() else {'origin':'machine_test','run_id':str(uuid.uuid4()),'documents':[],'sources':{},'target':50}
    state['target']=options.target
    candidates=c.corpus_store.LEGAL_PDF/'state/candidates.jsonl'
    ids=set()
    with candidates.open(encoding='utf8') as f:
        for line in f:
            row=json.loads(line)
            match=re.search(r'/case-documents/(\d+)/',row.get('url',''))
            if match:ids.add(match[1])
    official_ids=out/'official-case-ids.json'
    if official_ids.exists():
        # Public online factums are concentrated in the modern docket; retain older local leads too.
        ids.update(case for case in c.read_json(official_ids) if int(case)>=39000)
    ids=sorted(ids,key=lambda x:hashlib.sha256(('scc-factums-expansion:'+x).encode()).hexdigest())
    c.atomic_json(out/'review-schema.json',c.REVIEW)
    args=SimpleNamespace(model='gpt-6.1-sol',effort='low',attempts=3,timeout=900,max_calls=None)
    with closing(c.corpus_store.connect()) as db:
        prior={r[0] for r in db.execute("select distinct sha256 from gold_records where status='complete'")}
    for case in ids:
        if len(state['documents'])>=options.target:break
        if case in state['sources']:continue
        try:
            meta_url=f'https://www.scc-csc.ca/data/case-documents/{case}.json'
            status,_,_,body,_=c.corpus_store.get(meta_url)
            if status!=200:raise ValueError(f'Official metadata HTTP {status}')
            metadata=json.loads(body)
            directory=out/case;directory.mkdir(exist_ok=True)
            (directory/'official-index.json').write_bytes(body)
            names=sorted(metadata.get('factums',[]),key=lambda n:(not str(n).startswith('FM010'),not str(n).startswith('FM020'),str(n)))
            accepted=[]
            for name in names:
                if accepted:break  # Spread sources across proceedings, one factum per SCC file.
                url=f'https://www.scc-csc.ca/pdf/case-documents/{case}/{quote(str(name))}'
                provenance={'origin':'machine_test','run_id':state['run_id'],'official_index':meta_url,'scc_case':case,'human_review_status':'not_human_reviewed'}
                with closing(c.corpus_store.connect()) as db:
                    sha,result=c.corpus_store.fetch(db,url,{'collection':'scc-factums','jurisdiction':'ca','kind':'factum','label':str(name),'provenance':json.dumps(provenance)},refresh=False)
                    db.commit()
                    if not sha or sha in prior:continue
                    row=db.execute('select path,pages from files where sha256=?',(sha,)).fetchone()
                path=c.corpus_store.HOME/row[0]
                with fitz.open(path) as pdf:
                    if not 3<=len(pdf)<=200:continue
                    source={'sha256':sha,'path':row[0],'pages':len(pdf),'jurisdiction':'ca','url':url,'label':str(name)}
                    item={'first':1,'last':len(pdf),'title':f'SCC {case} — {name}','kind':'Supreme Court of Canada factum','parties':str(name),'date':''}
                    pages=c.review_pages(item,len(pdf))
                    for n in pages:c.render(pdf,n,directory/sha if (directory/sha).exists() else make_dir(directory/sha))
                    check=c.call(f"origin: machine_test; run_id: {state['run_id']}\nVerify this entire PDF is an actual filed Supreme Court of Canada factum (English or French), with its opening, legal argument and a complete ending. Reject judgments, appeal records, memoranda on leave applications, authorities alone, incomplete extracts and unrelated material. The official SCC index lists it under factums. Set complete_agreement true only if it qualifies; state the printed Canadian/SCC nexus and boundary evidence.\nOfficial index: "+meta_url+'\n'+json.dumps(item)+'\nIMAGE PAGES: '+str(pages),
                        out/'review-schema.json',[directory/sha/f'page-{n:04}.png' for n in pages],directory/sha/'calls/review',args,lambda v:v,policy=c.POLICY)
                if check['complete_agreement'] and check['canadian_nexus'].strip():
                    check.update(policy='complete-official-scc-factum.v1',pages_shown=pages)
                    selected=store(source,item,check,state,'factums')
                    if selected:
                        selected.update(scc_case=case,official_index=meta_url)
                        state['documents'].append(selected);accepted.append(sha);c.atomic_json(manifest,state)
            state['sources'][case]={'official_index':meta_url,'accepted':accepted,'status':'reviewed'}
        except Exception as error:
            state['sources'][case]={'status':'failed','error':str(error)[-1500:]}
        c.atomic_json(manifest,state)
        print(json.dumps({'factums':len(state['documents']),'cases_reviewed':len(state['sources'])}),flush=True)


def make_dir(path):
    path.mkdir(parents=True,exist_ok=True)
    return path


if __name__=='__main__':main()
