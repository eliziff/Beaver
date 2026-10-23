"""Canonical complete source Gold is independent of the eligible PDF projection."""
import pathlib,json,re,hashlib,datetime,sys,os,sqlite3,collections
import canada_supplemental_author as a
OUT=a.OUT
METADATA={
'entry-26':{'5':('2002-09-17','Michael S. Kwun'),'6':('2002-09-19','Jack C. Berenzweig'),'7':('2002-09-19','Michael S. Kwun'),'8':('2002-09-24','Jack C. Berenzweig')},
'entry-37':{'A':('2002-10-08','Jack C. Berenzweig'),'I':('2002-12-10','Google; annotations attributed to Michael S. Kwun by declaration')},
'entry-70':{'A':('2003-06-19','Christine P. Sun'),'B':('2003-06-19','Christine P. Sun'),'C':('2003-07-21','Christine P. Sun'),'D':('2003-07-15','Christine P. Sun'),'E':('2003-07-24','Charles M. McMahon')},
'entry-82':{'C':('1998-05-19','Business Wire'),'F':('2000-04-06','John G. Rauch'),'L':('2003-01-21','Charles M. McMahon'),'M':('2002-12-11','Christine P. Sun'),'P':('2003-07-08','Christine P. Sun'),'Q':('2000-01-31','GoTo.com; produced by Attorneys Trust Service; date is report-period end')},
'entry-133':{'A':('2004-01-09','Christine P. Sun'),'B':('2004-02-13','Scott Riewerts'),'C':('2004-01-20','Andrew C. Byrnes'),'D':('2004-01-22','Andrew C. Byrnes'),'E':('2004-01-27','Andrew C. Byrnes'),'F':('2004-01-27','Christine P. Sun')},
'entry-186':{'B':('2003-05-20','Darren J. Davis, witness; Karen E. Kay, reporter; errata separately included'),'C':('2003-07-18','Elaine K. Lee, witness; Rachel Ferrier, reporter')},
'entry-1098':{'A':('2011-11-01','Michael T. Zeller'),'B':('2011-12-03','Rachel Herrick Kassabian'),'C':('2011-12-10','Diane C. Hutnyan'),'D':('2011-12-30','Diane C. Hutnyan')},
'entry-1562':{'3':('2016-03-04','Douglas Schmidt, witness; Rachel Ferrier, reporter'),'5':('2016-01-08','Owen Astrachan'),'7':('2010-08-06','Tim Lindholm')},
'entry-1566':{'26':('2016-03-08','Itamar Simonson, witness; Rebecca L. Romano, reporter'),'27':('2016-03-10','Olivier Toubia, witness; Rebecca L. Romano, reporter')},
}
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def dump(p,v):a.dump(p,v)
def inventory(rid):
    if rid.endswith('entry-26'):return [(str(n),n,[2,3,4,4,6,7,7,8][n-1]) for n in range(1,9)]
    if rid.endswith('entry-37'):return [(chr(64+n),n,n+6 if n==1 else n+7) for n in range(1,10)]
    if rid.endswith('entry-70'):return [(chr(65+n),2,2 if n<2 else 3 if n<4 else 4 if n==4 else n+2) for n in range(7)]
    if rid.endswith('entry-82'):return [(chr(65+n),(n+1 if n<6 else None if n<8 else n-1),n+2 if n<12 else {12:15,13:15,14:16,15:17,16:18,17:19}[n]) for n in range(18)]
    if rid.endswith('entry-133'):return [(chr(65+n),n+1,[4,4,6,6,9,10][n]) for n in range(6)]
    if rid.endswith('entry-186'):return [(chr(65+n),n+1,n+2) for n in range(4)]
    if rid.endswith('entry-1082'):
        actual={5:2,6:3,7:4,8:5,9:6,11:7,15:8}
        return [(str(n),actual.get(n),n+1) for n in range(1,20)]
    if rid.endswith('entry-1098'):return [(chr(65+n),n+1,n+13) for n in range(4)]
    if rid.endswith('entry-1562'):return [(str(n),n,n+1) for n in range(1,12)]
    if rid.endswith('entry-1566'):
        actual={6:2,8:4,23:6,24:7,26:9,27:10,28:11}
        return [(str(n),actual.get(n),n+2) for n in range(1,32)]
    if rid.endswith('entry-187'):return [(chr(65+n),n+1,n+3) for n in range(5)]
    raise ValueError(rid)

def main():
    records=[];errors={};all_views=[]
    for rid,spec in a.SPECS.items():
        d=OUT/'pending'/rid;target=OUT/'records'/rid;candidate=target/'candidate-gold.json'
        if not candidate.exists():continue
        gold=read(candidate);parts=read(d/'sources.json');by={p['attachment']:p for p in parts};primary=by[spec.get('primary',0)];afftext=(target/'affidavit.txt').read_text(encoding='utf-8');spl=read(target/'split.json');source=read(target/'source.json');selected={e['label']:e for e in gold['exhibits']};canonical=[]
        source['prepared_source_sha256']=source['source_sha256'];source['source_sha256']=primary['sha256'];source['source_file']=pathlib.Path(primary['path']).name;source['canonical_source_path']=str(pathlib.Path(primary['path']).relative_to(pathlib.Path(os.path.expandvars('%LOCALAPPDATA%/OpenLegalData'))));source['source_primary_pages']=spec.get('aff_pages',list(range(1,primary['pages']+1)));source['original_sources']=parts
        for label,att,para in inventory(rid):
            quote=a.paragraph(afftext,para);entry={'label':label,'references':[{'paragraph':para,'quote':quote}],'description':selected[label]['description'] if label in selected else re.sub(r'\s+',' ',quote),'reference_source_sha256':primary['sha256'],'reference_source_pages':[int(m.group(1)) for m in re.finditer(r'\[page (\d+)\]',afftext[:afftext.index(quote)])][-1:],'training_view_eligible':label in selected,'association_namespace':'own_attached_exhibit','source_sha256':None,'source_pages':None}
            if att is not None:
                p=by[att];entry['filed_source']={k:p[k] for k in ['sha256','url','pages','path']}
                if 'DOCUMENT SOUGHT TO BE' in p['text'] and 'SEALED' in p['text']:
                    entry['availability']='public_seal_placeholder_only';entry['filed_placeholder_pages']=list(range(1,p['pages']+1))
                else:
                    pages=list(range(1,p['pages']+1));covers=[]
                    if rid.endswith('entry-70'):
                        bounds={'A':(5,7),'B':(8,11),'C':(12,16),'D':(17,20),'E':(21,23),'F':(24,27),'G':(28,32)};first,last=bounds[label];pages=list(range(first,last+1));covers=[first]
                    elif rid.endswith('entry-1098'):covers=[1,2]
                    elif rid.endswith(('entry-1082','entry-1562','entry-1566','entry-187')):covers=[1]
                    entry.update(availability='public_filed_content_available',source_sha256=p['sha256'],source_pages=pages,cover_pages=covers,content_pages=[n for n in pages if n not in covers],source_url=p['url'],extent='Complete physical exhibit as publicly filed; underlying instruments may themselves be filed excerpts.')
            else:
                entry['availability']='referenced_attachment_not_located_in_public_source_inventory'
                if rid.endswith('entry-1082') and label=='4':entry['manual_filing_notification']={k:by[1][k] for k in ['sha256','url','pages','path']}
                if rid.endswith('entry-82') and label in ['G','H']:entry['availability']='expressly_referenced_as_volume2_filed_under_seal'
            if label in selected:entry['eligible_file']=selected[label]['file']
            entry['kind']=selected[label]['kind'] if label in selected else 'other'
            key=next((key for key in METADATA if rid.endswith(key)),None)
            if key and label in METADATA[key]:entry['document_date_observed'],entry['document_author_observed']=METADATA[key][label];entry['metadata_basis']='Original filed document header/signature or specified period, independently source-reviewed below the parent affidavit reference.'
            dates=re.findall(r'(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}',quote)
            entry['reference_paragraph_dates_as_stated']=list(dict.fromkeys(dates));canonical.append(entry)
        gold['source_exhibits']=canonical;gold['association_scope']='complete_canonical_source_inventory_with_separate_eligible_pdf_projection';gold['subject']='securities_regulation' if 'sec-ripple' in rid else 'copyright' if 'oracle-google' in rid else 'patent'
        gold['eligible_projection']={'labels':list(selected),'reason':'Derived anonymized PDF eligibility is separate from canonical full-source Gold. Every source exhibit remains annotated, including unavailable public content and exporter failures.'}
        gold['available_not_selected']=[e['label'] for e in canonical if e['availability']=='public_filed_content_available' and e['label'] not in selected];gold['referenced_not_publicly_available']=[{'label':e['label'],'reason':e['availability']} for e in canonical if e['availability']!='public_filed_content_available']
        by_para=collections.defaultdict(list)
        for e in canonical:
            for ref in e['references']:by_para[ref['paragraph']].append(e['label'])
        for event in gold['events']:
            event['source_exhibit_labels']=by_para.get(event.get('paragraph'),[])
        # Every numbered source paragraph has narrative coverage. Explicit dated events authored
        # separately retain their dates; remaining source assertions stay honestly undated.
        para_numbers={int(x) for x in re.findall(r'(?m)^\s*(\d{1,2})\.\s*',afftext)};covered={e.get('paragraph') for e in gold['events']}
        for para in sorted(para_numbers-covered):
            quote=a.paragraph(afftext,para);labels=by_para.get(para,[])
            gold['events'].append({'id':'e'+str(len(gold['events'])+1),'date':None,'precision':'undated','description':re.sub(r'\s+',' ',quote),'quote':quote,'paragraph':para,'exhibits':[x for x in labels if x in selected],'source_exhibit_labels':labels,'event_type':'source_assertion_or_document_authentication'})
        if rid.endswith('entry-26'):
            descriptions={'1':'US Patent6,269,361','2':'Initial joint case-management statement filed August19,2002','3':'Overture preliminary infringement contentions served September16,2002, without the originally attached claimchart','4':'Overture claimchart, originally ExhibitA to its preliminary infringement contentions','5':'September17,2002 Kwun to Berenzweig letter','6':'September19,2002 Berenzweig to Kwun letter','7':'September19,2002 Kwun response letter','8':'September24,2002 Berenzweig letter'}
            for e in canonical:e['description']=descriptions[e['label']]
            gold['events'].append({'id':'e'+str(len(gold['events'])+1),'date':'2003-03-25','precision':'day','description':'Claim-construction hearing was then scheduled for March25,2003, subject to possible scheduling changes','quote':a.paragraph(afftext,13),'paragraph':13,'exhibits':[],'source_exhibit_labels':[]})
        if rid.endswith('entry-133'):
            gold['source_discrepancies']=['Paragraph6 associates D with refusal of a sur-reply; the filed January22 letter actually discusses damages-discovery timing and other discovery matters. Preserve the explicit D assignment and actual document contents, not an invented sur-reply passage.']
            for e in gold['exhibits']:
                if e['label']=='D':e['description']='January22 2004 Byrnes to Sun discovery letter; declared sur-reply connection is not apparent in filed letter'
            for e in canonical:
                if e['label']=='D':e['description']='January22 2004 Byrnes to Sun discovery letter; declared sur-reply connection is not apparent in filed letter'
        if rid.endswith('entry-82'):gold['source_discrepancies']=['Paragraph15 calls M dated December12,2002; the filed interrogatories and proof of service say December11,2002. Preserve source narrative date and document discrepancy separately.','L is the complete five-page letter excerpt as filed; its internal page numbers skip4 and6. No missing underlying pages reconstructed.','D and O both purport to exhibit the October22,1999 Davis declaration; separate source files retained for independent comparison.']
        if rid.endswith('entry-1082'):gold['source_discrepancies']=['Body, title and signature identify ThomasWatson; later running footers say EricWall. Execution is May25,2012; ECF filing is June11,2012. These are different dates, not interchangeable.']
        if rid.endswith('entry-186'):gold['source_discrepancies']=['ExhibitA is described as accompanying a March1998 business plan, but the actual filed compilation includes expressly dated April1998 messages as well. Preserve attachment identity and actual message dates separately.']
        if rid.endswith('entry-1562'):gold['source_discrepancies']=['Paragraph10 says Ringhofer deposition December2,2016, after this March23,2016 declaration. Preserve stated date as unresolved source conflict.']
        if rid.endswith('entry-187'):
            gold['source_discrepancies']=['ExhibitC as publicly filed is a one-page URL pointer after its cover. It does not contain a video or a screenshot of its contents. No underlying media has been reconstructed or treated as available.']
            for e in gold['exhibits']+canonical:
                if e['label']=='C':e['description']='Complete as-filed URL pointer to JohnDeaton satirical mock examination; underlying video unavailable';e['underlying_media_available']=False
            for event in gold['events']:
                if event.get('paragraph')==5:event['description']='Deaton refers to satirical mock examination; filed ExhibitC is only its URL pointer'
        if rid.endswith('entry-1098'):gold['external_exhibit_references']=[{'paragraph':p,'quote':a.paragraph(afftext,p),'namespace':'Other named declarants’ exhibits; not additional own Wheeler exhibits.'} for p in range(2,21) if p not in [13,14,15,16,18]]
        if rid.endswith(('entry-1082','entry-1098')):
            heading='GENERAL ORDER ATTESTATION' if rid.endswith('entry-1082') else 'ATTESTATION OF E-FILED SIGNATURE'
            quote=afftext[afftext.index(heading):]
            gold['events'].append({'id':'e'+str(len(gold['events'])+1),'date':None if rid.endswith('entry-1082') else '2012-06-14','precision':'undated' if rid.endswith('entry-1082') else 'day','description':'Separate ECF filer attested declarant concurrence: '+('VictoriaMaroulis' if rid.endswith('entry-1082') else 'MichaelJacobs'),'quote':quote,'exhibits':[],'source_exhibit_labels':[]})
        gold['gold_provenance'].update(author_receipt='../../author_receipt.json',review_status='pending_independent_cross_review',canonical_source_gold_complete=True)
        unique=[];seen=set()
        for event in gold['events']:
            key=(event.get('date'),event.get('paragraph'),event['description'],event['quote'])
            if key not in seen:seen.add(key);event['id']='e'+str(len(unique)+1);unique.append(event)
        gold['events']=unique
        dump(candidate,gold);source['canonical_source_exhibit_inventory']=canonical;dump(target/'source.json',source)
        assert len(canonical)==len({e['label'] for e in canonical})
        assert all(a.split.norm(e['references'][0]['quote']) in a.split.norm(afftext) for e in canonical)
        coverage={'record_id':rid,'source_label_count':len(canonical),'eligible_label_count':len(selected),'numbered_paragraphs':sorted(para_numbers),'event_covered_paragraphs':sorted({e.get('paragraph') for e in gold['events'] if e.get('paragraph')}),'uncovered_paragraphs':sorted(para_numbers-{e.get('paragraph') for e in gold['events']}),'all_original_source_texts_retained_without_preview_cap':True,'status':'pending_independent_cross_review'};assert not coverage['uncovered_paragraphs'];dump(target/'coverage-check.json',coverage)
        records.append(coverage);all_views.append({'record_id':rid,'primary_source_sha256':primary['sha256'],'full_primary_text_sha256':hashlib.sha256(afftext.encode()).hexdigest(),'all_original_source_inventory':'pending/'+rid+'/sources.json','canonical_source_gold_sha256':hashlib.sha256(candidate.read_bytes()).hexdigest(),'source_text_view_policy':'Full primary narrative; complete canonical source-label inventory and all original full-text source artifacts retained. Attachment identity/boundary evidence and full-content eligible-text views tracked separately. No6000-character gold cap.'})
    dump(OUT/'summary.json',{'origin':'machine_test','method':'codex_collaboration','author_agent':'/root/gold_canada','accepted':[],'pending':[x['record_id'] for x in records],'records':records,'model_runner_calls':0,'status':'awaiting_separate_agent_cross_review','source_exhibits':sum(x['source_label_count'] for x in records),'eligible_exhibits':sum(x['eligible_label_count'] for x in records)})
    dump(OUT/'author_receipt.json',{'origin':'machine_test','run_id':'affidavit-association-supplemental-canada-20261022','method':'codex_collaboration','author_agent':'/root/gold_canada','recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root_job_ledger':'../supplemental-jobs/receipt.json','model_runner_calls':0,'independent_review_status':'pending','source_views':all_views})
    print(len(records),'pending;',sum(x['source_label_count'] for x in records),'canonical source exhibits;',sum(x['eligible_label_count'] for x in records),'eligiblePDFs')
if __name__=='__main__':main()
