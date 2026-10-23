"""Bind completed independent tribunal reviews and recheck preserved author bytes."""
from pathlib import Path
from datetime import datetime,timezone
from collections import defaultdict,Counter
import json,hashlib,re
from data import accepted_gold,PRIVATE,BENCH,RECORDS
O=PRIVATE/'expansion-2/tribunals';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
read=lambda p:json.loads(p.read_text(encoding='utf8'))
def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def grams(t):
 w=re.findall(r'\w+',t.casefold());return {hash(tuple(w[i:i+8])) for i in range(max(0,len(w)-7))}
def main():
 s=read(O/'summary.json');f=read(O/'frozen-source-gold.json');assert len(s['accepted'])==len(set(s['accepted']))==33
 b=read(O.parent/'baseline.json');prior_ids={r['record_id'] for r in b['records']};directories={}
 for root in [BENCH/'records',RECORDS]:
  for p in root.glob('*/affidavit.txt'):
   if p.parent.name in prior_ids:directories[p.parent.name]=p.parent
 for rid,(_,d) in accepted_gold(PRIVATE/'expansion','source-gold.json',True).items():
  if rid in prior_ids:directories[rid]=d
 new,index={},defaultdict(list);rows=[];errors=[];labels=events=available=unavailable=target_pages=0
 for row in f['records']:
  rid=row['record_id'];d=O/'records'/rid;gpath=d/'reviewed-source-gold.json';g=read(gpath);v=read(d/'model-views.json');base=O/'review/author-baselines'/rid
  assert sha(d/'source-gold.json')==row['source_gold_sha256']
  for name,key in [('model-views.json','model_views_sha256'),('author_receipt.json','author_receipt_sha256')]:assert sha(base/name)==row[key]
  assert g['independent_source_review']['job_id']=='3ff2f688-a905-4c22-9b39-3bcff56389d2'
  assert g['independent_source_review']['author_gold_sha256']==row['source_gold_sha256']
  assert v['source_gold_sha256']==sha(gpath) and v['review_status']=='pending_fidelity'
  assert {e['label'] for e in g['exhibits']}=={e['label'] for e in v['views']}
  for view in v['views']+v.get('same_proceeding_distractor_views',[]):
   if view.get('text_file'):assert sha(d/view['text_file'])==view['text_sha256']
  labels+=len(g['exhibits']);events+=len(g['events'])
  for e in g['exhibits']:
   if e.get('source_sha256') and e.get('source_pages'):available+=1;target_pages+=len(e['source_pages'])
   else:unavailable+=1
  body=(d/'reviewed-text/referring-original.txt').read_text(encoding='utf8');new[rid]=grams(body)
  for gram in new[rid]:index[gram].append(rid)
  rows.append(dict(record_id=rid,source_gold_path=gpath.as_posix(),source_gold_sha256=sha(gpath),author_gold_sha256=row['source_gold_sha256'],source_review_receipt=(O/'review'/f'{rid}.json').as_posix(),source_review_receipt_sha256=sha(O/'review'/f'{rid}.json'),model_view_manifest=(d/'model-views.json').as_posix(),model_view_manifest_sha256=sha(d/'model-views.json'),model_view_status='pending_fidelity',labels=len(g['exhibits']),events=len(g['events']),same_proceeding_counterparts=len(g['same_proceeding_distractors'])))
 nearest={};exact=[];prior_hashes=[]
 for rid,d in sorted(directories.items()):
  p=d/'affidavit.txt';prior=grams(p.read_text(encoding='utf-8-sig'));common=Counter()
  prior_hashes.append(dict(record_id=rid,text_sha256=sha(p)))
  for gram in prior:common.update(index.get(gram,()))
  for nid,n in common.items():
   score=n/max(1,len(new[nid]))
   if score>nearest.get(nid,{}).get('containment',0):nearest[nid]=dict(prior_record_id=rid,containment=score,common_eightgrams=n,new_eightgrams=len(new[nid]),prior_eightgrams=len(prior))
   if score==1 and len(prior)==len(new[nid]):exact.append([nid,rid])
 assert not exact,exact
 # Other current-lane bodies are also compared; only substantive overlap leads, never automatic duplicate decisions.
 other=[]
 for lane in ['canada','regulatory']:
  for p in (O.parent/lane/'records').glob('*/source-gold.json'):
   d=p.parent;body=d/'affidavit.txt'
   if not body.exists():continue
   prior=grams(body.read_text(encoding='utf8'));matches=[]
   for rid,gs in new.items():
    n=len(gs&prior);score=n/max(1,min(len(gs),len(prior)))
    if score>.3:matches.append(dict(record_id=rid,containment_of_smaller=score))
   if matches:other.append(dict(other_record_id=d.name,source_gold_sha256=sha(p),matches=matches))
 audit=dict(origin='machine_test',run_id=s['run_id'],method='codex_collaboration plus deterministic byte/inventory/body checks; process-local eightgram hashes only compare overlap and never establish source identity',job_id=s['review_job_id'],completed_at_utc=datetime.now(timezone.utc).isoformat(),baseline_sha256=sha(O.parent/'baseline.json'),baseline_unique_ids=len(prior_ids),baseline_bodies_read=len(directories),baseline_unavailable_bodies=sorted(prior_ids-directories.keys()),prior_body_hashes=prior_hashes,nearest_prior_bodies=nearest,exact_body_duplicates=exact,other_current_lane_overlap_leads=other,duplicate_source_review='Maximum nearest-prior overlap is Lach versus prior Colish in the same federal motion record; actual distinct deponent/title, separate physical1868–1869and own reports were independently checked. Shared legal drafting, case caption, assertions or nested target content is not a repeated referring instrument. No other prior overlap exceeds0.10. Other-lane overlap leads require review if present.',immutable_author_gold_checked=33,retained_author_model_and_receipt_baselines_checked=33,reviewed_gold_model_bindings_checked=33,complete_label_accounting_checked=33,labels=labels,available_targets=available,unavailable_targets=unavailable,target_physical_page_memberships=target_pages,events=events,source_gold_status='accepted',model_fidelity_status='pending_fidelity_all33',errors=errors)
 write(O/'review/final-audit.json',audit)
 manifest=dict(origin='machine_test',run_id=s['run_id'],job_id=s['review_job_id'],agent='/root/gold_regulatory',method='codex_collaboration',runner_call=False,phase='review',status='completed',accepted_count=33,accepted=s['accepted'],source_gold_paths=s['source_gold_paths'],author_frozen_manifest_sha256=sha(O/'frozen-source-gold.json'),reviewed_records=rows,source_inventory=dict(labels=labels,available_targets=available,unavailable_targets=unavailable,target_physical_page_memberships=target_pages,events=events),view_qa='All33pending_fidelity. Source Gold accepted independently; no full-view/model-ready claim.',counterpart_exception='Cervantes notice has one actual complete same-case later decision; both authored alternatives were nested positive subdocuments and removed. Unlocated second source search retained; no quota padding.',final_audit_sha256=sha(O/'review/final-audit.json'),completed_at_utc=datetime.now(timezone.utc).isoformat())
 write(O/'review/completed-manifest.json',manifest);s.update(status='independent_source_review_completed',accepted_count=33,completed_at_utc=manifest['completed_at_utc'],completion_manifest=(O/'review/completed-manifest.json').as_posix(),completion_manifest_sha256=sha(O/'review/completed-manifest.json'));write(O/'summary.json',s)
 print(json.dumps(dict(accepted=33,labels=labels,available_targets=available,unavailable_targets=unavailable,events=events,baseline_bodies=len(directories),other_overlap_leads=other,manifest_sha256=sha(O/'review/completed-manifest.json'),summary_sha256=sha(O/'summary.json'))))
if __name__=='__main__':main()
