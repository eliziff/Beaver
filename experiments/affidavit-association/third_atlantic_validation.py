"""Final mechanical source/view/provenance audit; never grants source acceptance."""
import re,json
from functools import lru_cache
from collections import Counter,defaultdict
from datetime import datetime,timezone
from pathlib import Path
from third_atlantic_sources import s,O,provenance
from audit_expansion import iso,source_parts
s.source=lru_cache(maxsize=None)(s.source)

summary=s.read(O/'summary.json');errors=[];sources={};inventory=[];quote_counts=Counter()
def require(ok,why):
 if not ok:errors.append(why)
def parts(v,where):
 for p in source_parts(v):
  try:
   original=s.source(p['sha256']);sources[p['sha256']]=original
   require(bool(p['pages']),[where,'empty_original_page_inventory'])
   require(all(isinstance(n,int)and 1<=n<=original['pages']for n in p['pages']),[where,'source_page_bounds'])
   require((p.get('url')or'').strip()in{(original.get('url')or'').strip(),(original.get('final_url')or'').strip()},[where,'source_url_differs_from_canonical_metadata'])
  except Exception as e:errors.append([where,'source_resolution',str(e)])
def anchors(value,where):
 if isinstance(value,dict):
  if all(k in value for k in ['quote','source_sha256','source_pages']):
   try:
    f=s.views_folder(s.source(value['source_sha256']))
    t='\f'.join((f/f'page-{n:04}.txt').read_text('utf8')for n in value['source_pages'])
    fold=lambda x:re.sub(r'\s+',' ',x).strip()
    if fold(value['quote'])in fold(t):quote_counts['literal_full_source_text']+=1
    else:
     require(value.get('quote_verification')=='original_image',[where,'nonliteral_quote_without_image_verification',value['quote']])
     quote_counts['explicit_original_image_verification']+=1
   except Exception as e:errors.append([where,'quote_resolution',str(e)])
  for child in value.values():anchors(child,where)
 elif isinstance(value,list):
  for child in value:anchors(child,where)
for rid in summary['accepted']:
 d=O/'records'/rid;g=s.read(O/summary['source_gold_paths'][rid]);labels={e['label']for e in g['exhibits']}
 review=g.get('independent_source_review',{});author=s.read(d/'source-gold.json')['author_provenance']
 require(review.get('status')=='accepted',[rid,'no_completed_distinct_source_review'])
 require(review.get('job_id')!=author.get('job_id')and review.get('agent')!=author.get('agent'),[rid,'review_not_independent_author'])
 require(review.get('author_gold_sha256')==s.sha(d/'source-gold.json'),[rid,'immutable_author_binding'])
 anchors(g,rid)
 event_aliases=set(labels)
 def aliases(e,parent=None):
  event_aliases.update(e[k]for k in ['instrument_id','exhibit_id','id','scoped_reference_name']if isinstance(e.get(k),str))
  if parent:event_aliases.add(parent+' / '+e['label'])
  for child in e.get('nested_components',[]):aliases(child,e['label'])
 for e in g['exhibits']:aliases(e)
 require(len(labels)==len(g['exhibits']),[rid,'duplicate_labels'])
 parts(g['referring_document'],rid+'/body')
 for i,e in enumerate(g['exhibits']):
  parts(e,f'{rid}/exhibit{i}')
  require(bool(e.get('references')),[rid,e['label'],'no_reference'])
  for r in e.get('references',[]):require(bool(r.get('quote','').strip())and bool(r.get('source_sha256'))and bool(r.get('source_pages')),[rid,e['label'],'empty_reference_anchor'])
 for e in g['events']:
  require(bool(e.get('quote','').strip()),[rid,e.get('event_id'),'empty_event_quote'])
  require(bool(e.get('source_sha256'))and bool(e.get('source_pages')),[rid,e.get('event_id'),'empty_event_source'])
  require(set(e.get('exhibits',[]))<=event_aliases,[rid,e.get('event_id'),'unknown_event_label'])
  for k in ['date','end_date']:
   try:iso(e.get(k))
   except(ValueError,TypeError):errors.append([rid,e.get('event_id'),k,e.get(k)])
 m=s.read(d/'model-views.json');require(m['source_gold_sha256']==s.sha(O/summary['source_gold_paths'][rid]),[rid,'model_binding'])
 require({v['label']for v in m['views']}==labels,[rid,'model_inventory'])
 for v in m['views']:
  if not v.get('eligible'):require(bool(v.get('reason')or v.get('omission_reason')),[rid,v['label'],'no_unavailability_reason']);continue
  f=d/v['text_file'];require(f.exists()and s.sha(f)==v['text_sha256'],[rid,v['label'],'text_hash'])
  ps=v.get('source_files')or source_parts(next(e for e in g['exhibits']if e['label']==v['label']))
  expected='\f'.join('\f'.join((s.views_folder(s.source(p['sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in p['pages'])for p in ps)
  require(f.read_text('utf8')==expected,[rid,v['label'],'complete_page_text_reconstruction'])
 for c in s.read(d/'distractors.json')if(d/'distractors.json').exists()else []:parts(c,rid+'/counterpart/'+c.get('counterpart_id','unknown'))
for digest,original in sorted(sources.items()):
 path=Path(original['original_path']);actual=s.sha(path)
 require(actual==digest,[digest,'original_bytes_hash'])
 inventory.append(dict(sha256=digest,actual_sha256=actual,url=original.get('url'),landing_url=original.get('landing_url'),final_url=original.get('final_url'),pages=original['pages'],canonical_path=original.get('canonical_path'),content_type=original.get('content_type'),acquisition_status=original.get('status'),acquisition_checked_at_utc=original.get('acquisition_checked_at_utc'),source_views_root=original.get('source_views_root')))
# Check all concurrent third-batch bodies as well as the frozen874 identity baseline.
def grams(t):
 w=re.findall(r'\w+',t.casefold());return{hash(tuple(w[i:i+8]))for i in range(max(0,len(w)-7))}
current={rid:grams((O/'records'/rid/'affidavit.txt').read_text('utf8'))for rid in summary['accepted']};index=defaultdict(list)
for rid,gs in current.items():
 for gram in gs:index[gram].append(rid)
near={};other_bodies=0
for p in s.OUT.glob('*/records/*/affidavit.txt'):
 if p.parent.parent.parent==O:continue
 other_bodies+=1;c=Counter()
 for gram in grams(p.read_text('utf-8-sig')):c.update(index.get(gram,()))
 for rid,n in c.items():
  score=n/max(1,len(current[rid]))
  if score>near.get(rid,{}).get('containment',0):near[rid]=dict(other_record_id=p.parent.name,path=p.relative_to(s.OUT).as_posix(),containment=score)
report=dict(provenance(),status='passed'if not errors else 'failed',accepted_count=len(summary['accepted']),errors=errors,quotation_verification_counts=dict(quote_counts),source_inventory=inventory,canonical_originals_verified=len(inventory),concurrent_other_bodies=other_bodies,nearest_concurrent_bodies=near,baseline_body_audit_file='author-audit.json',baseline_body_audit_sha256=s.sha(O/'author-audit.json'),limits='Mechanical full-page text reconstruction establishes retained source-page coverage and byte integrity, not correct OCR transcription or independent all-page model fidelity. Distinct source acceptance comes only from completed fresh review receipts; original-image quote assertions remain grounded in those actual review receipts rather than newly claimed visual inspection here.',recorded_at_utc=datetime.now(timezone.utc).isoformat())
s.dump(O/'final-validation.json',report);print(json.dumps(dict(status=report['status'],accepted=len(summary['accepted']),originals=len(inventory),errors=errors,nearest_concurrent=near)))
