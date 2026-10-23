"""Publish a manually source-reviewed sibling, preserving immutable author provenance."""
from pathlib import Path
from datetime import datetime, timezone
import json, hashlib, os, sys, re, copy, shutil, fitz

O=Path('benchmarks/local-data/affidavit-association/expansion-2/tribunals')
H=Path(os.environ['LOCALAPPDATA'])/'OpenLegalData'
JOB='3ff2f688-a905-4c22-9b39-3bcff56389d2'
RUN='7a71d3b5-b4a5-4f3e-a79e-9204111ce7d3'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
norm=lambda s:re.sub(r'\s+',' ',s).strip()
read=lambda p:json.loads(p.read_text(encoding='utf-8'))
def write(p,v): p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def prose(s):
    for before,after in [('FirstNations','First Nations'),('CaringSociety','Caring Society'),('CanadaLife','Canada Life'),('ClassCounsel','Class Counsel'),('sampleadvisor','sample advisor'),('TorontoSymphony','Toronto Symphony'),('Jordan’sPrinciple','Jordan’s Principle'),('FederalCourt','Federal Court')]:s=s.replace(before,after)
    return re.sub(r'(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])',' ',s)
def main():
    rid=sys.argv[1];config=read(O/'review/configs'/f'{rid}.json')
    assert config.get('source_review_complete') is True,'Explicit manual completion required'
    folder=O/'records'/rid;author=folder/'source-gold.json';frozen=read(O/'frozen-source-gold.json');f=next(x for x in frozen['records'] if x['record_id']==rid)
    assert sha(author)==f['source_gold_sha256'];assert not (folder/'reviewed-source-gold.json').exists(),'Reviewed siblings are immutable after handoff; record a later audited revision separately.'
    baseline=O/'review/author-baselines'/rid;baseline.mkdir(parents=True,exist_ok=True)
    for name,key in [('model-views.json','model_views_sha256'),('author_receipt.json','author_receipt_sha256')]:
        path=folder/name;assert sha(path)==f[key];shutil.copyfile(path,baseline/name)
    g=copy.deepcopy(read(author));ori=g['original_referring_instrument'];source=H/ori['canonical_source_path'];assert sha(source)==ori['source_sha256'];doc=fitz.open(source);bodypages=ori['source_pages'];assert all(1<=n<=len(doc) for n in bodypages)
    key=ori['source_sha256'];cache=O/'source-text'/key
    def page_text(n,k=key):return (O/'source-text'/k/f'page-{n:04}.txt').read_text(encoding='utf-8')
    allbody='\n\n'.join(page_text(n) for n in bodypages);assert sha(folder/ori['full_affidavit_text_file'])==ori['full_affidavit_text_sha256']
    reviewedbody=folder/'reviewed-text/referring-original.txt';reviewedbody.parent.mkdir(exist_ok=True);reviewedbody.write_text(allbody,encoding='utf-8')
    changes=[];recovery_views=[];recovery_coverage=[]
    for recovery in config.get('public_source_recoveries',[]):
        label=recovery['label'];e=next((x for x in g['exhibits'] if x['label']==label),None)
        if e is None:
            e=copy.deepcopy(recovery['new_exhibit']);assert e['label']==label;g['exhibits'].append(e)
        before=copy.deepcopy(e);k=recovery['source_sha256'];meta=read(O/'sources'/f'{k}.json');path=H/meta['canonical_path'];assert sha(path)==k
        target=fitz.open(path);pages=recovery['source_pages'];assert all(1<=n<=len(target) for n in pages)
        token=hashlib.sha256(label.encode()).hexdigest()[:16];dest=folder/'reviewed-text'/f'recovered-{token}.txt';dest.write_text('\n\n'.join(page_text(n,k) for n in pages),encoding='utf-8')
        e.update(recovery.get('updates',{}));e.update(source_sha256=k,source_url=meta['url'],source_pages=pages,source_cover_pages=recovery.get('source_cover_pages',[]),source_text_file=dest.relative_to(folder).as_posix(),source_text_sha256=sha(dest),availability='public_external_independently_identified',identity_basis=recovery['identity_basis'])
        changes.append(dict(field=f'exhibits.{label}',before=before,after=copy.deepcopy(e),reason=recovery['reason']))
        recovery_views.append(dict(label=label,file=f'recovered-{token}.pdf',text_file=dest.relative_to(folder).as_posix(),text_sha256=sha(dest),eligible=True,pdf_available=False,source_sha256=k,source_pages=pages,reason='Complete original-derived instrument text, no clipping or generic line removal. Source identity independently reviewed; full model transcription fidelity remains pending with this manifest.'))
        recovery_coverage.append(dict(label=label,source_sha256=k,source_pages=pages,original_file=str(path),full_text_sha256=sha(dest),pages=[dict(page=n,text_sha256=sha(O/'source-text'/k/f'page-{n:04}.txt')) for n in pages],identity_basis=recovery['identity_basis']))
    for e in g['exhibits']:
        if e.get('date')=='':e['date']=None;changes.append(dict(field=f'exhibits.{e["label"]}.date',reason='Normalize an explicitly unknown blank date to null, without inventing a date.'))
        if e.get('date'):assert re.fullmatch(r'\d{4}(?:-\d{2}(?:-\d{2})?)?',e['date']),e['date']
        if e.get('source_sha256') and e.get('source_pages'):
            meta=read(O/'sources'/f'{e["source_sha256"]}.json');path=H/meta['canonical_path'];assert sha(path)==e['source_sha256'];target=fitz.open(path);assert all(1<=n<=len(target) for n in e['source_pages'])
            e['source_files']=[dict(sha256=e['source_sha256'],url=e['source_url'],path=str(path),pages=e['source_pages'],cover_pages=e.get('source_cover_pages',[]))]
            assert sha(folder/e['source_text_file'])==e['source_text_sha256']
            expected='\n\n'.join(page_text(n,e['source_sha256']) for n in e['source_pages']);assert (folder/e['source_text_file']).read_text(encoding='utf-8')==expected,e['label']
        for ref in e.get('references',[]):
            explicit=ref.get('source_page');matches=[explicit] if explicit else [n for n in bodypages if norm(ref['quote']) in norm(page_text(n))]
            assert matches and all(norm(ref['quote']) in norm(page_text(n)) for n in matches),ref
            ref['source']=dict(sha256=key,pages=matches)
    for ev in g['events']:
        n=ev.get('source_page');assert n and norm(ev['quote']) in norm(page_text(n)),ev
        ev['source']=dict(sha256=ev.get('source_sha256',key),pages=[n]);ev.setdefault('precision','day' if ev.get('date') and len(ev['date'])==10 else 'month' if ev.get('date') and len(ev['date'])==7 else 'year' if ev.get('date') else 'undated')
        if any(x in ev['quote'].lower() for x in ['approximately','around','in or about']):ev.setdefault('date_qualifier','approximate')
    for i,ev in enumerate(config.get('extra_events',[]),1):
        ev=copy.deepcopy(ev);ev['description']=prose(ev['description']);n=ev['source_page'];assert norm(ev['quote']) in norm(page_text(n)),ev
        assert set(ev.get('exhibits',[]))<={e['label'] for e in g['exhibits']},ev
        ev.update(id=f'review-{i:02}',source_sha256=key,source=dict(sha256=key,pages=[n]),review_added=True);g['events'].append(ev)
    replacements=config.get('counterpart_replacements',[])+([config['counterpart_replacement']] if config.get('counterpart_replacement') else [])
    for replacement in replacements:
        i=replacement['index'];old=g['same_proceeding_distractors'][i];g['same_proceeding_distractors'][i]={k:v for k,v in replacement.items() if k!='index'};changes.append(dict(field=f'same_proceeding_distractors.{i}',before=old,after=g['same_proceeding_distractors'][i],reason=replacement['reason']))
    for removal in sorted(config.get('counterpart_removals',[]),key=lambda x:x['index'],reverse=True):
        i=removal['index'];old=g['same_proceeding_distractors'].pop(i);changes.append(dict(field=f'same_proceeding_distractors.{i}',before=old,after=None,reason=removal['reason']))
    for item in config.get('top_level_updates',[]):
        before=g.get(item['field']);g[item['field']]=item['value'];changes.append(dict(field=item['field'],before=before,after=item['value'],reason=item['reason']))
    for correction in config.get('event_corrections',[]):
        ev=next(e for e in g['events'] if e['id']==correction['id']);before=copy.deepcopy(ev)
        ev.update(correction['updates']);changes.append(dict(field=f'events.{ev["id"]}',before=before,after=copy.deepcopy(ev),reason=correction['reason']))
    for correction in config.get('exhibit_corrections',[]):
        e=next(e for e in g['exhibits'] if e['label']==correction['label']);before=copy.deepcopy(e);e.update(correction['updates']);changes.append(dict(field=f'exhibits.{e["label"]}',before=before,after=copy.deepcopy(e),reason=correction['reason']))
    for ev in g['events']:
        for field in ['date','end_date']:
            if ev.get(field):assert re.fullmatch(r'\d{4}(?:-\d{2}(?:-\d{2})?)?',ev[field]),ev
    g.update(country='CA',origin='machine_test',run_id=RUN)
    g.setdefault('document_type','affidavit')
    g['referring_document']=dict(document_type=g['document_type'],source_files=[dict(sha256=key,url=ori['source_url'],path=str(source),pages=bodypages)],text_file=reviewedbody.relative_to(folder).as_posix(),text_sha256=sha(reviewedbody))
    g['independent_source_review']=dict(status='accepted',origin='machine_test',method='codex_collaboration',agent='/root/gold_regulatory',job_id=JOB,run_id=RUN,runner_call=False,author_gold_sha256=sha(author),author_frozen_manifest_sha256=sha(O/'frozen-source-gold.json'),reviewed_at_utc=datetime.now(timezone.utc).isoformat(),evidence_receipt=f'../../review/{rid}.json',source_inventory_coverage='All original referring pages and full own/named instrument inventory, including unavailable originals; every available target page is preserved in its original source PDF and full-page text extraction, with separate OCR/font fidelity limitations rather than a claim of perfect transcription. Scope of actual visual/semantic inspection is recorded in the receipt, not expanded into a claim that every paragraph of report merits was analyzed.')
    write(folder/'reviewed-source-gold.json',g);gp=folder/'reviewed-source-gold.json'
    manifest=read(baseline/'model-views.json');manifest['source_gold_sha256']=sha(gp);manifest['review_status']='pending_fidelity';manifest['source_gold_review_status']='accepted';manifest['review_job_id']=JOB;manifest['author_baseline_manifest']=str((baseline/'model-views.json').relative_to(O));manifest['author_baseline_manifest_sha256']=sha(baseline/'model-views.json')
    manifest['fidelity_status']='Separate complete original-derived text, OCR and outer-wrapper inspection pending; source Gold accepted independently. Author eligibility flags are provisional until this manifest review_status becomes accepted.'
    manifest['referring_document_view']=dict(text_file=reviewedbody.relative_to(folder).as_posix(),text_sha256=sha(reviewedbody),fidelity_review='Complete original-source referring body retained without lossy generic line removal; anonymized model projection remains separate.')
    for recovered in recovery_views:
        idx=next((i for i,v in enumerate(manifest['views']) if v['label']==recovered['label']),None)
        if idx is None:manifest['views'].append(recovered)
        else:manifest['views'][idx]=recovered
    for repl in replacements:
        i=repl['index'];dest=folder/'reviewed-text'/f'counterpart-{i+1:03}.txt';dest.write_text('\n\n'.join(page_text(n,repl['source_sha256']) for n in repl['source_pages']),encoding='utf-8');manifest['same_proceeding_distractor_views'][i]=dict(file=f'review-counterpart-{i+1:03}.pdf',text_file=dest.relative_to(folder).as_posix(),text_sha256=sha(dest),source_sha256=repl['source_sha256'],source_pages=repl['source_pages'],eligible=True,same_proceeding=True,reason=repl['reason'])
    for removal in sorted(config.get('counterpart_removals',[]),key=lambda x:x['index'],reverse=True):manifest['same_proceeding_distractor_views'].pop(removal['index'])
    for d in manifest.get('same_proceeding_distractor_views',[]):d['same_proceeding']=True
    write(folder/'model-views.json',manifest)
    inspection=read(O/'review/inspection'/rid/'inventory.json');receipt=dict(origin='machine_test',run_id=RUN,method='codex_collaboration',agent='/root/gold_regulatory',job_id=JOB,runner_call=False,status='source_gold_accepted_model_fidelity_separate',author_gold_sha256=sha(author),reviewed_gold_sha256=sha(gp),source_sha256=key,full_referring_body_read_pages=bodypages,source_inventory_labels=[e['label'] for e in g['exhibits']],source_target_full_page_coverage=inspection['inventory'],visually_inspected_original_images=inspection['images'],source_review_notes=config['source_inventory_review_notes'],corrections=changes,added_narrative_event_count=len(config.get('extra_events',[])),canonical_model_view_manifest_sha256=sha(folder/'model-views.json'),model_view_status='pending_fidelity',completed_at_utc=datetime.now(timezone.utc).isoformat())
    receipt['independently_recovered_public_sources']=recovery_coverage;receipt['recovery_original_image_inspection']=config.get('recovery_original_image_inspection',[])
    write(O/'review'/f'{rid}.json',receipt);summary_path=O/'summary.json';summary=read(summary_path) if summary_path.exists() else dict(origin='machine_test',run_id=RUN,review_job_id=JOB,target=33,status='independent_source_review_in_progress',accepted=[],source_gold_paths={})
    summary['accepted'].append(rid);summary['accepted_count']=len(summary['accepted']);summary['source_gold_paths'][rid]=str(gp.as_posix());summary['reviewed_hashes']={i:sha(Path(p)) for i,p in summary['source_gold_paths'].items()};summary['model_fidelity_status']='Separate pending per-record manifests; Gold acceptance does not claim all model views audited.';write(summary_path,summary)
    assert sha(author)==f['source_gold_sha256'];print('SOURCE_GOLD_ACCEPTED',rid,len(g['events']),sha(gp))

if __name__=='__main__':main()
