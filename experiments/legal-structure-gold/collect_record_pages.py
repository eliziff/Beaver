"""Collect visually checked original clinical-record or receipt pages, with source provenance."""
import argparse
from collections import Counter
from contextlib import closing
import hashlib
import html
import json
from pathlib import Path
import re
from types import SimpleNamespace
from urllib.parse import urljoin
import uuid

import fitz
import contracts as c

RANGE_ITEM={'type':'object','properties':{'first':{'type':'integer'},'last':{'type':'integer'},'reason':{'type':'string'}},'required':['first','last','reason'],'additionalProperties':False}
RANGES={'type':'object','properties':{'ranges':{'type':'array','items':RANGE_ITEM}},'required':['ranges'],'additionalProperties':False}
PAGE_ITEM={'type':'object','properties':{'page':{'type':'integer'},'eligible':{'type':'boolean'},'category':{'type':'string'},'visible_patient_identifiers':{'type':'boolean'},'reason':{'type':'string'}},'required':['page','eligible','category','visible_patient_identifiers','reason'],'additionalProperties':False}
PAGES={'type':'object','properties':{'pages':{'type':'array','items':PAGE_ITEM}},'required':['pages'],'additionalProperties':False}
MEDICAL='''Find actual patient-specific clinical records attached as exhibits in this public legal filing.
Include completed treatment/progress/nursing notes, clinical correspondence, diagnostic or lab reports,
prescriptions, medication/vital-sign charts, and actual postmortem clinical reports. Exclude pleadings,
affidavit narrative, expert opinions summarizing care, medical-policy/inspection reports, guidelines,
blank forms, release authorizations alone, research papers, transcripts and discussion ABOUT records.
Return physical PDF page ranges containing the actual records. Return no ranges if none is evidenced.
Do not infer that an entire exhibit is clinical merely because it mentions medical records.
'''
CHECK_MEDICAL='''Classify EACH listed physical PDF page from its image. Eligible means it is an actual
completed clinical record: treatment/progress/nursing note, patient-specific clinical letter, diagnostic
or lab report, prescription, medication/vital-sign chart or actual postmortem report. Exclude narrative
about care in pleadings, witness statements, expert summaries, policy/inspection reports, blank forms,
consent/release authorizations alone, separators, transcripts and text-free medical images.
Set visible_patient_identifiers true if a patient's actual name, date of birth, address or medical ID
is legible and unredacted. Clinician names, clinical event dates, and anonymous Child A/Patient 1
identifiers do not count as visible patient identifiers. Preserve published redactions; do not infer
hidden text or identities. Reject illegible pages. Give a brief category and reason without names.
'''
CHECK_RECEIPTS='''Classify EACH listed physical PDF page from its image. Eligible means it contains an
actual receipt or evidence of a completed payment, including retail, food, accommodation, transport,
settled hotel folios and supplier invoices explicitly showing payment or zero balance. Exclude cover
sheets, expense summaries, reimbursement/claim forms, bank/card statements, quotes, unpaid invoices,
blank forms, contracts and duplicate-only administrative copies. Do not count a page just because
the bundle is labelled receipts. A page with several receipts counts as one physical page. Reject
illegible pages. Set visible_patient_identifiers false. Give a brief category and reason.
'''


def checked_pages(value, expected):
    actual=[r['page'] for r in value['pages']]
    if sorted(actual)!=sorted(expected):raise ValueError('Classify every shown page exactly once')
    return value['pages']


def eligible_pages(checks):
    # The collection permits real publicly released records, including named court exhibits.
    # Retain identifier flags in provenance and preserve every publisher redaction.
    return [row['page'] for row in checks if row['eligible']]


def unindexed_image_pages(pdf):
    # A text-only index cannot establish that an un-OCRed scanned exhibit is irrelevant.
    return [n for n,page in enumerate(pdf,1)
            if page.get_images() and sum(ch.isalpha() for ch in page.get_text())<80]


def checked_ranges(value, count):
    for r in value['ranges']:
        if not 1<=r['first']<=r['last']<=count:raise ValueError('Medical range outside source')
    return value['ranges']


def groups(numbers):
    result=[]
    for n in sorted(set(numbers)):
        if result and n==result[-1][-1]+1:result[-1].append(n)
        else:result.append([n])
    return result


def download(lead,kind,run_id):
    if lead.get('path'):
        return {**lead,'path':str(c.corpus_store.HOME/lead['path'])}
    url=lead.get('url')
    if not url:
        status,final,_,body,_=c.corpus_store.get(lead['landing'])
        if status!=200:raise ValueError(f'Public evidence listing HTTP {status}')
        links=[urljoin(final,html.unescape(m.group(2))) for m in c.corpus_store.LINK.finditer(body.decode('utf8',errors='replace')) if '.pdf' in m.group(2).lower()]
        if len(set(links))!=1:raise ValueError('Evidence page must identify one published PDF')
        url=links[0]
    if kind=='receipts' and c.corpus_store.urlsplit(url).hostname=='www.leg.bc.ca':
        url='https://lims.leg.bc.ca/pdms/file'+c.corpus_store.urlsplit(url).path
    meta={'collection':'public-medical-legal-sources' if kind=='medical' else 'canadian-public-receipts',
          'jurisdiction':lead.get('jurisdiction','bc'),'kind':'medical-record-exhibit' if kind=='medical' else 'receipt-bundle',
          'label':lead['label'],'provenance':json.dumps({'origin':'machine_test','run_id':run_id, 'landing':lead.get('landing'),
          'published_href':lead.get('url'),'download_url':url,'source_access':'Publicly published legal/inquiry evidence' if kind=='medical' else 'Official legislative receipt disclosure'})}
    with closing(c.corpus_store.connect()) as db:
        sha,result=c.corpus_store.fetch(db,url,meta,refresh=False);db.commit()
        if not sha:raise ValueError('No public source PDF: '+result)
        path=c.corpus_store.HOME/db.execute('select path from files where sha256=?',(sha,)).fetchone()[0]
    with fitz.open(path) as pdf:count=len(pdf)
    return {**lead,'url':url,'sha256':sha,'path':str(path),'pages':count}


def store_pages(source,selected,checks,state,kind):
    with fitz.open(source['path']) as original:
        unique=[];fingerprints={};seen=set(state['page_raster_sha256s'])
        for number in selected:
            page=original[number-1];pix=page.get_pixmap(alpha=False)
            raster=hashlib.sha256(str((pix.width,pix.height)).encode()+pix.samples).hexdigest()
            if raster in seen:continue
            seen.add(raster);unique.append(number);fingerprints[number]=raster
        # Retain the actual physical pages and their layout; no generated medical/receipt content.
        for block in groups(unique):
            body=c.excerpt(original,block[0],block[-1])
            classification=[r for r in checks if r['page'] in block]
            provenance={'origin':'machine_test','run_id':state['run_id'],'parent_sha256':source['sha256'],
                'source_url':source.get('url'),'source_landing':source.get('landing'),'source_pages':[block[0],block[-1]],
                'page_classification':classification,'review_policy':'actual-record-pages.v2',
                'human_review_status':'not_human_reviewed','partition_status':'unassigned pending source/family and exposure review',
                'derivation':'Original complete PDF pages; every page dimension, native text and RGB raster independently preserved',
                'source_extent':'Clinical/receipt page excerpt; not a claim of a complete patient chart or filing'}
            meta={'collection':'public-clinical-record-pages' if kind=='medical' else 'canadian-receipt-pages',
                  'jurisdiction':source.get('jurisdiction','unknown'),'kind':'medical-record' if kind=='medical' else 'receipt',
                  'label':f'Public {kind} record pages {block[0]}–{block[-1]}','provenance':json.dumps(provenance)}
            url=(source.get('url') or 'sha256:'+source['sha256']).split('#')[0]+f'#page={block[0]}&endpage={block[-1]}'
            with closing(c.corpus_store.connect()) as db,db:
                sha=c.corpus_store.add_file(db,body,'application/pdf',c.corpus_store.place(meta));c.corpus_store.note(db,sha,meta,url)
                path=c.corpus_store.HOME/db.execute('select path from files where sha256=?',(sha,)).fetchone()[0]
                db.execute('insert or ignore into gold_memberships values (?,?,?,?)',('medical-receipts-500.v1',sha,source['sha256'],sha))
            if sha not in {r['sha256'] for r in state['documents']}:
                state['documents'].append({**provenance,'sha256':sha,'path':str(path),'pages':len(block),'mode':'ocr','jurisdiction':meta['jurisdiction'],'kind':meta['kind']})
            state['page_raster_sha256s'] += [fingerprints[n] for n in block]


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('kind',choices=['medical','receipts']);p.add_argument('--target-pages',type=int,default=500)
    options=p.parse_args();c.low_priority()
    base=c.ROOT/'benchmarks/local-data/legal-structure-gold/medical-receipts';out=base/options.kind;out.mkdir(parents=True,exist_ok=True)
    manifest=out/'manifest.json';state=c.read_json(manifest) if manifest.exists() else {'origin':'machine_test','run_id':str(uuid.uuid4()),'target_pages':options.target_pages,'documents':[],'sources':{},'page_raster_sha256s':[]}
    args=SimpleNamespace(model='gpt-6.1-sol',effort='low',attempts=3,timeout=900,max_calls=None)
    c.atomic_json(out/'ranges-schema.json',RANGES);c.atomic_json(out/'pages-schema.json',PAGES)
    if options.kind=='receipts':
        leads=c.read_json(base/'bc-receipt-candidates.json')
        leads=sorted(leads,key=lambda r:hashlib.sha256(('receipt-variety:'+r['url']).encode()).hexdigest())
        leads=[{**r,'label':Path(c.corpus_store.urlsplit(r['url']).path).name,'jurisdiction':'bc'} for r in leads]
    else:
        # Start with existing filed evidence; anonymous inquiry exhibits are the next public source.
        local=c.read_json(base/'local-clinical-filings.json');leads=[];seen=set()
        for r in sorted(local,key=lambda r:(r['pages']>500,-r['hits'])):
            if r.get('url') and r['sha256'] not in seen:leads.append(r);seen.add(r['sha256'])
        leads += [{**r,'direct_medical_exhibit':True} for r in c.read_json(base/'thirlwall-clinical-candidates.json')]
        extra=base/'additional-medical-candidates.json'
        if extra.exists():leads+=c.read_json(extra)
    for lead in leads:
        if sum(r['pages'] for r in state['documents'])>=options.target_pages:break
        key=lead.get('sha256') or lead.get('url') or lead['landing']
        previous=state['sources'].get(key,{})
        if previous.get('status')=='reviewed' and (options.kind=='receipts' or previous.get('review_policy')=='actual-record-pages.v2'):continue
        try:
            source=download(lead,options.kind,state['run_id']);directory=out/source['sha256'];directory.mkdir(exist_ok=True)
            assert c.digest(Path(source['path']))==source['sha256']
            with fitz.open(source['path']) as pdf:
                if options.kind=='receipts' or source.get('direct_medical_exhibit'):
                    proposed=[{'first':1,'last':len(pdf),'reason':'Published receipt/medical-record exhibit; every page still requires visual eligibility review'}]
                else:
                    proposed=c.call(f"origin: machine_test; run_id: {state['run_id']}\n"+MEDICAL+'\n'+c.page_index(pdf),out/'ranges-schema.json',[],directory/'calls/find',args,lambda v:checked_ranges(v,len(pdf)),policy=c.POLICY)
                candidates=sorted({n for r in proposed for n in range(r['first'],r['last']+1)})
                if options.kind=='medical':
                    candidates=sorted(set(candidates)|set(unindexed_image_pages(pdf)))
                for start in range(0,len(candidates),10):
                    if sum(r['pages'] for r in state['documents'])>=options.target_pages:break
                    pages=candidates[start:start+10]
                    for n in pages:c.render(pdf,n,directory)
                    checks=c.call(f"origin: machine_test; run_id: {state['run_id']}\n"+(CHECK_MEDICAL if options.kind=='medical' else CHECK_RECEIPTS)+'\nPHYSICAL PDF PAGES: '+str(pages),
                        out/'pages-schema.json',[directory/f'page-{n:04}.png' for n in pages],directory/f'calls/pages-{pages[0]:04}-{pages[-1]:04}',args,lambda v:checked_pages(v,pages),policy=c.POLICY)
                    selected=eligible_pages(checks)
                    store_pages(source,selected,checks,state,options.kind);c.atomic_json(manifest,state)
            state['sources'][key]={**source,'status':'reviewed','proposed_ranges':proposed,'review_policy':'actual-record-pages.v2'}
        except Exception as error:state['sources'][key]={'status':'failed','error':str(error)[-1500:]}
        c.atomic_json(manifest,state)
        print(json.dumps({'kind':options.kind,'verified_pages':sum(r['pages'] for r in state['documents']),'target_pages':options.target_pages,'sources':len(state['sources'])}),flush=True)
    print(json.dumps({'kind':options.kind,'verified_pages':sum(r['pages'] for r in state['documents']),'target_pages':options.target_pages,'status':'target_reached' if sum(r['pages'] for r in state['documents'])>=options.target_pages else 'more_sources_needed'}),flush=True)


if __name__=='__main__':main()
