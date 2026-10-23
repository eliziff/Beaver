"""Consolidate actual distinct peer receipts and freeze lane bindings, no inference."""
from collections import Counter
from datetime import datetime,timezone
from third_atlantic_sources import s,O,provenance

summary=s.read(O/'summary.json')
peer=O/'review/final-peer-batch/summary.json'
if peer.exists():
 p=s.read(peer)
 for rid in p['accepted']:
  d=O/'records'/rid;r=s.read(peer.parent/rid/'receipt.json')
  assert r['method']=='codex_collaboration' and r['agent']=='/root/gold_us' and not r['runner_call']
  assert r['author_gold_sha256']==s.sha(d/'source-gold.json')
  assert r['reviewed_source_gold_sha256']==s.sha(d/'reviewed-source-gold.json')
  if rid not in summary['accepted']:summary['accepted'].append(rid)
  summary['source_gold_paths'][rid]=p['source_gold_paths'][rid]
  summary['record_paths'][rid]=p['record_paths'][rid]
 summary['accepted_count']=len(summary['accepted'])
 summary['peer_batch_provenance']=dict(summary_file=peer.relative_to(O).as_posix(),sha256=s.sha(peer),job_id=p['review_job'],method=p['method'],agent=p['agent'],runner_call=False,root_ledger_registration=p['root_ledger_registration'])
 s.dump(O/'summary.json',summary)
records=[];families=Counter();labels=events=available=0
actual_cases={'frostwicks':'pe-IRAC-LA19015','hillbay':'pe-IRAC-LA20002','richard':'pe-IRAC-LA19016','brownvolkswagen':'pe-IRAC-LA19009','inquiry':'nl-Innu-Inquiry','nachonyakdun':'yt-SCC-36779','oland':'nb-SCC-36986','kerr':'bc-SCC-33157','rick':'bc-SCC-32098','cody':'nl-SCC-37310','larue':'yt-SCC-38224','lafferty':'nt-SCC-42284','hunt':'nl-SCC-37314','hart':'nl-SCC-35049','basque':'nb-SCC-39997','tayotompouba':'bc-SCC-40332','lynch':'nl-SCC-40302','npr':'ns-SCC-34272'}
for rid in summary['accepted']:
 d=O/'records'/rid;gf=O/summary['source_gold_paths'][rid];g=s.read(gf);a=s.read(d/'source-gold.json')
 assert g['country']=='CA' and g['jurisdiction'] in ['ca','federal','ab','bc','mb','nb','nl','ns','nt','nu','on','pe','pei','qc','sk','yt']
 assert a['author_provenance']['origin']=='machine_test'
 assert a['author_provenance']['run_id']==provenance()['run_id']
 # Author/reviewer spelling of family is deliberately immutable. Group actual
 # proceedings by verified captions/files, not spelling differences in that field.
 case=actual_cases[rid.split('-')[2]]
 families[case]+=1;labels+=len(g['exhibits']);events+=len(g['events']);available+=sum(bool(e.get('source_files'))for e in g['exhibits'])
 mf=d/'model-views.json';m=s.read(mf)
 assert m['source_gold_sha256']==s.sha(gf),rid
 assert [e['label']for e in g['exhibits']]==[e['label']for e in m['views']],rid
 for v in m['views']:
  if v.get('eligible'):assert s.sha(d/v['text_file'])==v['text_sha256'],(rid,v['label'])
 records.append(dict(record_id=rid,source_gold_path=gf.relative_to(O).as_posix(),source_gold_sha256=s.sha(gf),author_source_gold_path=(d/'source-gold.json').relative_to(O).as_posix(),author_source_gold_sha256=s.sha(d/'source-gold.json'),model_views_path=mf.relative_to(O).as_posix(),model_views_sha256=s.sha(mf),model_fidelity_status=m['review_status'],family=g['family'],actual_proceeding_key=case,labels=len(g['exhibits']),events=len(g['events'])))
assert max(families.values(),default=0)<=3,dict(families)
manifest=dict(provenance(),status='completed'if len(records)==46 else 'independent_review_in_progress',accepted=summary['accepted'],accepted_count=len(records),target=46,source_gold_paths=summary['source_gold_paths'],records=records,proceedings=dict(families),proceeding_count=len(families),labels=labels,events=events,located_labels=available,unavailable_labels=labels-available,summary_sha256=s.sha(O/'summary.json'),source_gold_independent_of_model_fidelity=True,model_fidelity='Every available target has full source-bound text. Whole-page native/OCR fidelity remains separately pending unless explicitly accepted; no pixel-safe PDF export is claimed.',global_ledger_note='Actual final existing-agent review batch3139d72b and separately actual Canada batchf5f83804 await root registration; neither is represented as a CLI call. All failures count and no dispatch beyond the250 global cap is authorized.',recorded_at_utc=datetime.now(timezone.utc).isoformat())
manifest['audits']=[dict(path=name,sha256=s.sha(O/name))for name in ['final-author-manifest.json','author-model-view-history.json','author-audit.json','final-validation.json','gathered-source-provenance.json','duplicate-overlap-adjudication.json','root-ledger-adjudication-request.json']if(O/name).exists()]
s.dump(O/'completed-manifest.json',manifest)
print({k:manifest[k]for k in ['status','accepted_count','proceeding_count','labels','events','located_labels','unavailable_labels']})
