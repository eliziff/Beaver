"""Collect additional Canadian scanned agreements, affidavits, and SCC factums."""
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

AFFIDAVIT_FIND = """Locate complete sworn or affirmed Canadian affidavits in this filed record.
Return physical PDF first/last pages, title, kind, deponent in parties, and date.
Include the affidavit's jurat and all attached exhibits belonging to it. Do not include
the next affidavit, motion, factum or other separate filing. Exclude unfilled forms,
drafts, certificates of service alone, statutory declarations, witness statements
without a jurat, and documents merely quoting or referring to an affidavit.
Prefer substantive evidentiary affidavits from varied ordinary civil/commercial
disputes; do not return several arbitrary pieces of one affidavit. An affidavit can
be at most 200 pages including exhibits. Return no candidate when uncertain.
"""
AFFIDAVIT_CHECK = """Verify the proposed pages comprise a complete Canadian sworn or affirmed
affidavit, with its deponent identified, operative evidence, signed/sworn jurat,
and all attached exhibits that belong to this filed affidavit. Reject templates,
drafts, other documents, uncertain boundaries and an incomplete affidavit.
The images show opening/ending pages, adjacent pages, and any located jurat.
Set complete_agreement true only when the affidavit qualifies (the field is
shared with the agreement selector). State the printed Canadian nexus and the
specific evidence for completeness in reason. Do not infer a missing jurat.
"""


def scanned(pdf, first, last):
    return sum(any(fitz.Rect(im['bbox']).get_area() >= p.rect.get_area() * .85
                   and im['width'] * im['height'] > 40_000 for im in p.get_image_info())
               for p in (pdf[n] for n in range(first-1, last)))


def store(source, item, check, state, kind):
    if any(old['parent_sha256'] == source['sha256'] and item['first'] <= old['last']
           and item['last'] >= old['first'] for old in state['documents'] + state.get('baseline', [])):
        return None
    path = c.corpus_store.HOME / source['path']
    with fitz.open(path) as pdf:
        count = item['last'] - item['first'] + 1
        raster = scanned(pdf, item['first'], item['last'])
        if kind == 'contracts' and raster * 2 < count:
            return None
        text = c.normalized('\n'.join(pdf[n].get_text() for n in range(item['first']-1, item['last'])))
        text_hash = hashlib.sha256(text.encode()).hexdigest() if len(text) > 200 else None
        identity = c.normalized(item['parties'] + ' ' + item['date'] + ' ' + item['title'])
        if any((text_hash and text_hash == old.get('text_sha256')) or
               (item['date'] and item['parties'] and identity == old.get('instrument_identity'))
               for old in state['documents'] + state.get('baseline', [])):
            return None
        body = path.read_bytes() if item['first'] == 1 and item['last'] == len(pdf) else c.excerpt(pdf, item['first'], item['last'])
    provenance = {'origin': 'machine_test', 'run_id': state['run_id'], 'parent_sha256': source['sha256'],
                  'source_url': source['url'], 'source_pages': [item['first'], item['last']],
                  'boundary_review': check, 'human_review_status': 'not_human_reviewed',
                  'derivation': 'Complete original PDF pages; all native text and RGB page rasters preserved',
                  'partition_status': 'unassigned pending source/proceeding family and exposure review'}
    collection = {'contracts': 'canadian-contract-excerpts', 'affidavits': 'canadian-affidavit-excerpts', 'factums': 'scc-factums'}[kind]
    meta = {'collection': collection, 'jurisdiction': source['jurisdiction'],
            'kind': {'contracts': 'contract', 'affidavits': 'affidavit', 'factums': 'factum'}[kind],
            'label': item['title'] + ' — ' + item['parties'], 'provenance': json.dumps(provenance)}
    url = source['url'].split('#')[0] + f"#page={item['first']}&endpage={item['last']}"
    with closing(c.corpus_store.connect()) as db, db:
        sha = c.corpus_store.add_file(db, body, 'application/pdf', c.corpus_store.place(meta))
        if any(old['sha256'] == sha for old in state['documents'] + state.get('baseline', [])):
            return None
        c.corpus_store.note(db, sha, meta, url)
        db.execute('insert or ignore into gold_memberships values (?,?,?,?)', ('canadian-expansion-150.v1', sha, source['sha256'], sha))
        relative = db.execute('select path from files where sha256=?', (sha,)).fetchone()[0]
    return {**item, **provenance, 'sha256': sha, 'path': str(c.corpus_store.HOME/relative),
            'pages': count, 'mode': 'ocr' if raster*2 >= count else 'digitalborn',
            'raster_page_count': raster, 'jurisdiction': source['jurisdiction'],
            'text_sha256': text_hash, 'instrument_identity': identity}


def candidates(kind):
    with closing(c.corpus_store.connect()) as db:
        db.row_factory = c.sqlite3.Row
        if kind == 'affidavits':
            rows = db.execute("""select f.sha256,f.path,f.pages,d.label,d.url,d.jurisdiction from files f join documents d using(sha256)
                where f.pages between 2 and 1000 and (d.label like '%affidavit%' or d.kind='affidavit')
                and d.url is not null order by f.pages,d.id""").fetchall()
        else:
            rows = db.execute("""select f.sha256,f.path,f.pages,d.label,d.url,d.jurisdiction from files f join documents d using(sha256)
                where f.pages between 1 and 120 and (d.kind='contract' or d.kind='agreement' or d.label like '%agreement%' or d.label like '%lease%')
                and d.url is not null order by f.pages,d.id""").fetchall()
        unique = {}
        for row in rows:
            if row['jurisdiction'] in c.CANADA and (c.corpus_store.HOME/row['path']).exists():
                unique.setdefault(row['sha256'],dict(row))
        if kind == 'contracts':
            for row in c.source_rows():
                unique.setdefault(row['sha256'],row)
        return list(unique.values())


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('kind', choices=['contracts','affidavits'])
    p.add_argument('--target', type=int, default=50)
    p.add_argument('--sources', type=int, default=1000)
    options = p.parse_args()
    c.low_priority()
    out = c.ROOT/'benchmarks/local-data/legal-structure-gold/expansion-150'/options.kind
    out.mkdir(parents=True,exist_ok=True)
    manifest = out/'manifest.json'
    state = c.read_json(manifest) if manifest.exists() else {'origin':'machine_test','run_id':str(uuid.uuid4()),'documents':[], 'sources':{},'target':options.target}
    state['target']=options.target
    if options.kind == 'contracts':
        state['baseline'] = c.read_json(out.parents[1]/'contracts/manifest.json')['documents']
    c.atomic_json(out/'find-schema.json',c.PROPOSALS)
    c.atomic_json(out/'review-schema.json',c.REVIEW)
    args = SimpleNamespace(model='gpt-6.1-sol',effort='low',attempts=3,timeout=900,max_calls=None)
    if options.kind == 'contracts':
        original = c.read_json(out.parents[1]/'contracts/manifest.json')
        for source in original['sources'].values():
            for item,check in zip(source.get('candidates',[]),source.get('reviews',[])):
                if len(state['documents']) >= options.target:break
                if check.get('policy') != c.REVIEW_POLICY or not check.get('complete_agreement') or not check.get('canadian_nexus','').strip():continue
                row=store(source,item,check,state,options.kind)
                if row:
                    row['boundary_review_origin']='Existing accepted visual review, original contracts collection'
                    state['documents'].append(row);c.atomic_json(manifest,state)
                    print(json.dumps({'reused_review':row['sha256'],'selected':len(state['documents'])}),flush=True)
    for source in candidates(options.kind)[:options.sources]:
        if len(state['documents']) >= options.target: break
        if source['sha256'] in state['sources']: continue
        if any(old['sha256']==source['sha256'] for old in state.get('baseline',[])):
            state['sources'][source['sha256']]={'status':'excluded_already_selected_contract'}
            c.atomic_json(manifest,state);continue
        directory = out/source['sha256'];directory.mkdir(exist_ok=True)
        try:
            with fitz.open(c.corpus_store.HOME/source['path']) as pdf:
                if options.kind == 'contracts' and not scanned(pdf,1,len(pdf)):
                    state['sources'][source['sha256']]={'status':'excluded_no_scan_pages'}
                    c.atomic_json(manifest,state);continue
                text = c.page_index(pdf)
                prompt = c.FIND if options.kind == 'contracts' else AFFIDAVIT_FIND
                found = c.call(f"origin: machine_test; run_id: {state['run_id']}\n"+prompt+'\nSOURCE: '+source['label']+'\n'+text,
                    out/'find-schema.json',[],directory/'calls/find',args,
                    lambda v:c.proposed(v,len(pdf)) if options.kind == 'contracts' else validate_affidavits(v,len(pdf)),policy=c.POLICY)
                found = sorted(found,key=lambda x:x['last']-x['first'])[:15]
                for item in found:
                    if len(state['documents']) >= options.target: break
                    if options.kind == 'contracts' and scanned(pdf,item['first'],item['last'])*2 < item['last']-item['first']+1:continue
                    pages = set(c.review_pages(item,len(pdf)))
                    if options.kind == 'affidavits':
                        jurats=[n for n in range(item['first'],item['last']+1) if re.search(r'\bsworn\b|\baffirmed\b|commiss[ai]on[ea]r|asserment',pdf[n-1].get_text(),re.I)]
                        pages.update(jurats[:3]);pages.update(jurats[-3:])
                    pages=sorted(pages)
                    for n in pages:c.render(pdf,n,directory)
                    check=c.call(f"origin: machine_test; run_id: {state['run_id']}\n"+(c.CHECK if options.kind=='contracts' else AFFIDAVIT_CHECK)+'\n'+json.dumps(item)+'\nIMAGE PAGES: '+str(pages),
                        out/'review-schema.json',[directory/f'page-{n:04}.png' for n in pages],directory/f"calls/review-{item['first']:04}-{item['last']:04}",args,lambda v:v,policy=c.POLICY)
                    if check['complete_agreement'] and check['canadian_nexus'].strip():
                        check.update(policy='complete-canadian-'+options.kind+'.v1',pages_shown=pages)
                        row=store(source,item,check,state,options.kind)
                        if row:state['documents'].append(row);c.atomic_json(manifest,state)
            state['sources'][source['sha256']]={**source,'candidates':found,'status':'reviewed'}
        except Exception as error:
            state['sources'][source['sha256']]={**source,'status':'failed','error':str(error)[-1500:]}
        c.atomic_json(manifest,state)
        print(json.dumps({'kind':options.kind,'selected':len(state['documents']),'sources':len(state['sources'])}),flush=True)


def validate_affidavits(value, pages):
    seen=set()
    for item in value['contracts']:
        bounds=(item['first'],item['last'])
        if not 1 <= bounds[0] <= bounds[1] <= pages or bounds[1]-bounds[0]+1>200 or bounds in seen:
            raise ValueError('Affidavit boundaries must be unique, complete, and within the source')
        seen.add(bounds)
    return value['contracts']


if __name__=='__main__':main()
