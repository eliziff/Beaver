"""Locate and catalogue Canadian questioning transcripts in existing local sources.

Private discovery and visual-review receipts live beside the selection manifest.
Canonical PDF bytes and source/page provenance live in corpus_store's SQLite.
"""
import argparse
from contextlib import closing
import hashlib
import json
import re
from pathlib import Path
from types import SimpleNamespace
import uuid

import fitz
import contracts as c

REVIEW = {**c.REVIEW, 'properties': {**c.REVIEW['properties'],
    'commercial_dispute': {'type':'boolean'}, 'dispute_type': {'type':'string'},
    'commercial_basis': {'type':'string'}, 'eligible_transcript':{'type':'boolean'},
    'transcript_extent':{'type':'string','enum':['complete','filed_excerpt','not_transcript']},
    'examination_identity':{'type':'string'}},
    'required': [*c.REVIEW['required'],'commercial_dispute','dispute_type','commercial_basis',
                 'eligible_transcript','transcript_extent','examination_identity']}

FIND = """Locate actual Canadian witness questioning transcripts in this legal record.
Include only examination for discovery and questioning/cross-examination on
affidavits. Exclude trial testimony, public-inquiry testimony, public hearings,
and examinations under oath for other purposes. Require verbatim Q&A testimony.
French interrogatoires préalables and interrogatoires sur affidavit qualify too.
Exclude judgments quoting testimony, affidavits describing examinations, written
interrogatories, submissions, transcript order forms, and lawyers' argument alone.
Return one separately identifiable witness/session transcript per item,
with all testimony pages and its certification/errata when included. Do not split
a transcript arbitrarily, count each witness answer, or select transcript exhibits
as separate transcripts. A complete separately filed volume may qualify; identify
its volume. Genuine excerpts already filed in the court record also qualify;
retain the whole filed excerpt block and identify it as an excerpt. Never create
new excerpts or count several blocks from one examination as different transcripts.
Set first/last to physical PDF page numbers. Use title for examination
type, parties for witness and proceeding, date for the examination date (empty if
not printed). kind must describe the examination. Sources can contain several
transcripts. The page index is only a lead; boundaries will be visually reviewed.
"""
CHECK = """Verify this is an actual Canadian verbatim witness questioning transcript,
not a judgment quoting evidence, affidavit, argument, interrogatory or order form.
Only discovery or questioning/cross-examination on an affidavit qualifies. Reject
trial testimony, public-inquiry testimony, and other public-hearing transcripts.
Images show physical PDF pages at both boundaries and adjacent pages. Require a
separately identifiable witness/session transcript, complete filed volume, or genuine
excerpt already filed in this record. Never cut testimony to invent a new excerpt.
Certification/errata should be
included where present; unrelated exhibits need not be included. Canadian court,
proceeding or examination location must be evident in the instrument. Set
complete_agreement true only for a complete transcript/volume. Set
eligible_transcript true for a qualifying complete transcript
or genuine filed excerpt, and classify transcript_extent explicitly. Give a stable
examination_identity using the printed court file, witness and examination date
(ISO date if known); use the same identity for overlapping excerpts of one examination.
Use the examination's own caption, not the cover of the brief filing it in another
proceeding, when identifying its court file.
Give the printed Canadian nexus in canadian_nexus and
brief boundary evidence in reason. If uncertain, reject rather than infer.
Classify the underlying dispute. Commercial includes lending/security enforcement,
commercial leases or real estate, construction, sale of goods/services, business
ownership/shareholders, and business insolvency. A company appearing in a public-law
or constitutional case does not make it commercial. Give dispute_type and the
printed evidence in commercial_basis. Set commercial_dispute false if uncertain.
Where insolvency is the setting, identify the underlying commercial issue visible
in the testimony (for example lease payments, lending, construction fees, business
ownership or a transaction) rather than relying only on the insolvency caption.
"""


def validate(value, pages):
    seen = set()
    for row in value['contracts']:
        bounds = row['first'], row['last']
        if not 1 <= bounds[0] <= bounds[1] <= pages or bounds in seen:
            raise ValueError('Invalid or duplicate transcript range')
        if not row['title'].strip() or not row['parties'].strip() or not row['kind'].strip():
            raise ValueError('Transcript identity missing')
        seen.add(bounds)
    return value['contracts']


def checked(value):
    if value['eligible_transcript'] and (value['transcript_extent']=='not_transcript'
            or not value['examination_identity'].strip() or not value['canadian_nexus'].strip()):
        raise ValueError('Eligible transcripts require extent, examination identity and Canadian evidence')
    if value['complete_agreement'] != (value['transcript_extent']=='complete'):
        raise ValueError('Completeness must agree with transcript extent')
    return value


def store(source, item, check, selection):
    if any(old.get('selection_status') in ('excluded_duplicate_examination',
                                          'excluded_failed_independent_preservation',
                                          'excluded_continuation_of_counted_examination')
           and old['parent_sha256'] == source['sha256']
           and (old['first'], old['last']) == (item['first'], item['last'])
           for old in selection.get('excluded', [])):
        return None
    with fitz.open(c.corpus_store.HOME / source['path']) as pdf:
        text = c.normalized('\n'.join(pdf[n].get_text() for n in range(item['first']-1, item['last'])))
        text_sha = hashlib.sha256(text.encode()).hexdigest() if len(text) > 200 else None
        identity = c.normalized(item['title']+' '+item['parties']+' '+item['date'])
        if any((text_sha and text_sha == old.get('text_sha256')) or identity == old['transcript_identity']
               or (check.get('examination_identity') and c.normalized(check['examination_identity'])==c.normalized(old.get('examination_identity','')))
               or (source['sha256'] == old['parent_sha256'] and item['first'] <= old['last'] and item['last'] >= old['first'])
               for old in selection['documents']):
            return None
        body = ((c.corpus_store.HOME/source['path']).read_bytes() if item['first']==1 and item['last']==len(pdf)
                else c.excerpt(pdf,item['first'],item['last']))
    provenance = {'origin':'machine_test','run_id':selection['run_id'], 'parent_sha256':source['sha256'],
                  'source_url':source['url'],'source_pages':[item['first'],item['last']],
                  'boundary_review':check,'commercial_dispute':check['commercial_dispute'],
                  'dispute_type':check['dispute_type'],'commercial_basis':check['commercial_basis'],
                  'selection_status':'selected',
                  'transcript_extent':check['transcript_extent'],'examination_identity':check['examination_identity'],
                  'derivation':'Complete PDF pages; native text and raster pixels preserved',
                  'partition_status':'unassigned pending family and exposure review'}
    meta = {'collection':'canadian-questioning-transcripts','jurisdiction':source['jurisdiction'],
            'kind':'questioning-transcript','label':item['title']+' — '+item['parties'],
            'provenance':json.dumps(provenance)}
    url = source['url']+('&' if '#' in source['url'] else '#')+f"page={item['first']}&endpage={item['last']}"
    with closing(c.corpus_store.connect()) as db, db:
        sha = c.corpus_store.add_file(db,body,'application/pdf',c.corpus_store.place(meta))
        c.corpus_store.note(db,sha,meta,url)
        if sha != source['sha256']:
            db.execute('insert or ignore into gold_memberships values (?,?,?,?)',
                       ('canadian-questioning.v1',sha,source['sha256'],sha))
        path = db.execute('select path from files where sha256=?',(sha,)).fetchone()[0]
    return {**item,'sha256':sha,'path':str(c.corpus_store.HOME/path),'pages':item['last']-item['first']+1,
            **provenance,'jurisdiction':source['jurisdiction'],'text_sha256':text_sha,'transcript_identity':identity}


def review(source,item,directory,args,out,run_id):
    pages=set(c.review_pages(item,source['pages'])) | {
        min(item['first']+4,item['last']),(item['first']+item['last'])//2}
    with fitz.open(c.corpus_store.HOME/source['path']) as pdf:
        # A long word index can follow the certificate and conceal the actual ending.
        certificates=[n for n in range(item['first'],item['last']+1) if re.search(
            r"hereby\s+certify|reporter.?s?\s+certificate|certificate\s+of\s+(?:transcri|report)",
            pdf[n-1].get_text(),re.I)]
        for page in certificates[-3:]:
            pages.update(range(max(item['first'],page-1),min(item['last'],page+1)+1))
        pages=sorted(pages)
        for page in pages:c.render(pdf,page,directory)
    check=c.call(f"origin: machine_test; run_id: {run_id}\n"+CHECK+'\n'+json.dumps({k:item[k] for k in c.FIELDS})+'\nIMAGE PAGES: '+str(pages),
        out/'review-schema.json',[directory/f'page-{p:04}.png' for p in pages],
        directory/'calls'/f"review-{item['first']:04}-{item['last']:04}",args,checked,policy=c.POLICY)
    return {**check,'policy':'filed-canadian-questioning.v4','pages_shown':pages}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=c.ROOT/'benchmarks/local-data/legal-structure-gold/questioning')
    parser.add_argument('--sources',type=int,default=100)
    parser.add_argument('--target',type=int,default=100)
    options=parser.parse_args()
    c.low_priority()
    out=options.out.resolve();out.mkdir(parents=True,exist_ok=True)
    c.atomic_json(out/'find-schema.json',c.PROPOSALS);c.atomic_json(out/'review-schema.json',REVIEW)
    args=SimpleNamespace(model='gpt-6.1-sol',effort='low',attempts=3,timeout=900,max_calls=None)
    target=out/'manifest.json'
    selection=c.read_json(target) if target.exists() else {'origin':'machine_test','run_id':str(uuid.uuid4()),
        'target':options.target,'documents':[],'sources':{},'scope':'Canadian discovery and affidavit questioning: complete transcripts and clearly labelled genuine filed excerpts'}
    selection['scope']='Canadian discovery and affidavit questioning: complete transcripts and clearly labelled genuine filed excerpts'
    for row in list(selection['documents']):
        if row['boundary_review'].get('policy') in ('complete-canadian-questioning.v3','filed-canadian-questioning.v4'):
            row.setdefault('transcript_extent','complete')
            continue
        source=selection['sources'][row['parent_sha256']]
        directory=out/source['sha256'];directory.mkdir(exist_ok=True)
        check=review(source,row,directory,args,out,selection['run_id'])
        row.update(boundary_review=check,**{k:check[k] for k in ('commercial_dispute','dispute_type','commercial_basis')})
        if not check['eligible_transcript'] or not check['canadian_nexus'].strip():
            row['selection_status']='excluded_after_boundary_review'
            selection['documents'].remove(row);selection.setdefault('excluded',[]).append(row)
            source['accepted']=[sha for sha in source['accepted'] if sha!=row['sha256']]
        else:row['selection_status']='selected'
        with closing(c.corpus_store.connect()) as db,db:
            meta={'collection':'canadian-questioning-transcripts','jurisdiction':row['jurisdiction'],
                  'kind':'questioning-transcript','label':row['title']+' — '+row['parties'],
                  'provenance':json.dumps({k:v for k,v in row.items() if k!='path'})}
            url=row['source_url']+('&' if '#' in row['source_url'] else '#')+f"page={row['first']}&endpage={row['last']}"
            c.corpus_store.note(db,row['sha256'],meta,url)
        c.atomic_json(target,selection)
        print(json.dumps({'reclassified':row['sha256'][:12],'commercial':check['commercial_dispute'],'total':len(selection['documents'])}),flush=True)
    for _ in range(options.sources):
        if len(selection['documents']) >= options.target: break
        sources=c.read_json(out/'local-candidates.json')
        pending=[s for s in sources if s.get('url') and (s['sha256'] not in selection['sources'] or
            (selection['sources'][s['sha256']].get('eligibility_policy')!='filed-canadian-questioning.v4' and
             any(host in s['url'] for host in ('fticonsulting.com','bdo.ca','ksvadvisory.com','alixpartners.com',
                 'pwc.com','mnpdebt.ca','alvarezandmarsal.com','deloitte.ca','ey.com','tdbadvisory.ca'))))]
        if not pending:break
        source=pending[0]
        if not source.get('url'): continue
        directory=out/source['sha256'];directory.mkdir(exist_ok=True)
        assert c.digest(c.corpus_store.HOME/source['path']) == source['sha256']
        with fitz.open(c.corpus_store.HOME/source['path']) as pdf:
            prompt=f"origin: machine_test; run_id: {selection['run_id']}\n"+FIND+'\n'+c.page_index(pdf)
            items=c.call(prompt,out/'find-schema.json',[],directory/'calls/find',args,
                         lambda value:validate(value,len(pdf)),policy=c.POLICY)
            for page in sorted({p for item in items for p in c.review_pages(item,len(pdf))}):
                c.render(pdf,page,directory)
        accepted=list(selection['sources'].get(source['sha256'],{}).get('accepted',[]));reviews=[]
        for item in items:
            check=review(source,item,directory,args,out,selection['run_id']);reviews.append(check)
            noncommercial = sum(not row.get('commercial_dispute',False) for row in selection['documents'])
            if (check['eligible_transcript'] and check['canadian_nexus'].strip()
                    and len(selection['documents'])<options.target and (check['commercial_dispute'] or noncommercial < options.target*3//10)):
                try:row=store(source,item,check,selection)
                except AssertionError as error:
                    selection.setdefault('materialization_failures',[]).append({**item,
                        'parent_sha256':source['sha256'],'error':str(error) or 'Source preservation check failed',
                        'origin':'machine_test','run_id':selection['run_id']})
                    continue
                if row: selection['documents'].append(row);accepted.append(row['sha256'])
        selection['sources'][source['sha256']]={**source,'candidates':items,'reviews':reviews,'accepted':accepted,
                                               'eligibility_policy':'filed-canadian-questioning.v4'}
        c.atomic_json(target,selection)
        print(json.dumps({'source':source['sha256'][:12],'candidates':len(items),'accepted':len(accepted),'total':len(selection['documents'])}),flush=True)


if __name__=='__main__': main()
