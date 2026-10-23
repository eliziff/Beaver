"""Freeze complete original-source annotation independently of mutable PDF projections."""
import pathlib,json,hashlib,datetime,copy
import canada_supplemental_coverage as c
O=c.OUT
def main():
    c.main();rows=[];now=datetime.datetime.now(datetime.timezone.utc).isoformat()
    for target in sorted((O/'records').iterdir()):
        proposal=target/'candidate-gold.json'
        if not proposal.exists():continue
        g=c.read(proposal);source=c.read(target/'source.json');gold={k:copy.deepcopy(v) for k,v in g.items() if k not in ['exhibits','source_exhibits','events','eligible_projection','association_scope','gold_provenance','available_not_selected','referenced_not_publicly_available','notes']}
        exhibits=copy.deepcopy(g['source_exhibits'])
        for e in exhibits:
            for key in ['eligible_file','training_view_eligible']:e.pop(key,None)
        events=copy.deepcopy(g['events'])
        for e in events:e['exhibits']=list(e.get('source_exhibit_labels',[]));e.pop('source_exhibit_labels',None)
        gold.update(exhibits=exhibits,source_exhibits=copy.deepcopy(exhibits),events=events,source_events=copy.deepcopy(events),association_scope='complete_original_source_record',notes='Complete original referring-record narrative and own source-exhibit inventory. Public unavailability, sealed placeholders, manual filing notices and unresolved source discrepancies are explicit. Derived anonymized training views have no authority to remove source Gold.',reference_instrument={'source_sha256':source['source_sha256'],'source_url':source['url'],'source_pages':source['source_primary_pages'],'canonical_path':source['canonical_source_path'],'full_text_sha256':hashlib.sha256((target/'affidavit.txt').read_bytes()).hexdigest()},original_source_inventory=[{k:p[k] for k in ['attachment','sha256','url','pages','path']} for p in source['original_sources']],gold_provenance={'origin':'machine_test','method':'codex_collaboration','author_agent':'/root/gold_canada','run_id':'affidavit-association-supplemental-canada-20261022','recorded_at':now,'author_receipt':'../../source-gold-author-receipt.json','root_job_ledger':'../../supplemental-jobs/receipt.json','content_origin':'public_court_sources','annotation_status':'source_author_completed; separate independent cross-review required'})
        file=target/'source-gold.json';assert not file.exists(),('Frozen artifact already exists; never overwrite',file)
        c.dump(file,gold);sha=hashlib.sha256(file.read_bytes()).hexdigest();rows.append({'record_id':target.name,'file':str(file.relative_to(O)),'sha256':sha,'source_exhibits':len(exhibits),'source_events':len(events),'primary_source_sha256':source['source_sha256']})
    core=hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest();receipt={'origin':'machine_test','method':'codex_collaboration','author_agent':'/root/gold_canada','recorded_at':now,'root_job_ledger':'../supplemental-jobs/receipt.json','model_runner_calls':0,'core_sha256':core,'frozen_records':rows,'independent_review_status':'pending_separate_agent_cross_review','immutability':'Do not alter these source-gold.json files. A reviewer writes separate adjudications or corrected reviewed artifacts with explicit source-author hash references.'};file=O/'source-gold-author-receipt.json';assert not file.exists();c.dump(file,receipt);print(json.dumps({'frozen_records':len(rows),'source_exhibits':sum(x['source_exhibits'] for x in rows),'core_sha256':core},indent=2))
if __name__=='__main__':main()
