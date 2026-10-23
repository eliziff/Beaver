"""Audited schema-only normalization of a genuinely accepted isolated HTML review."""
from third_atlantic_sources import s,O,provenance
from pathlib import Path
import sys,json,re,copy
sys.path[:0]=[str(O.parent),str(Path('tools').resolve())]
from ledger_utils import ledger_transaction
from audit_expansion import source_parts,iso
rid='an3-bc-tayotompouba-crown-merits-20230605';d=O/'records'/rid
raw=O.parent/'calls'/rid/'review/fc85b569356735f7/attempt-1/last-message.json'
r=s.read(raw);assert r['accept'] is True;g=json.loads(r['gold_json']);before=copy.deepcopy(g)
changes=[]
for e in g['exhibits']:
 for p in source_parts(e):
  if p.get('original_format')=='text/html' and p.get('pages')==[]:
   assert p.get('capture_units')==[1] and p.get('whole_document') is True and p.get('physical_page_numbering') is False
   p['pages']=[1];changes.append(dict(label=e['label'],sha256=p['sha256'],before=[],after=[1],basis='Existing capture_units[1], whole_document:true, physical_page_numbering:false; harness logical serialization only, never a physical PDF page claim.'))
assert len(changes)==1
html_sha=changes[0]['sha256']
for e in g['events']:
 if e.get('source_sha256')==html_sha and e.get('source_pages')==[]:
  assert e.get('source_locator','').startswith('Whole unpaginated HTML')
  e['source_pages']=[1];changes.append(dict(event_id=e['event_id'],sha256=html_sha,before=[],after=[1],basis='Same complete unpaginated HTML and explicit whole-document paragraph locator; logical capture-unit serialization only.'))
spec=s.read(O/'specs'/(rid+'.json'));supplied={x['sha256']:set(x['pages'])for x in spec['sources']};ims={x['sha256']:set(x.get('image_pages',[]))for x in spec['sources']}
text=lambda sha,pages:'\f'.join((s.views_folder(s.source(sha))/f'page-{n:04}.txt').read_text('utf8')for n in pages)
fold=lambda z:re.sub(r'\s+',' ',z).strip()
labels={e['label']for e in g['exhibits']};assert len(labels)==len(g['exhibits'])
for e in g['exhibits']+g['events']:iso(e.get('date'));iso(e.get('end_date'))
for e in g['exhibits']:
 for p in source_parts(e):assert p['pages'] and set(p['pages'])<=supplied[p['sha256']]
for e in g['events']:assert set(e.get('exhibits',[]))<=labels
def walk(v):
 if isinstance(v,dict):
  if all(k in v for k in ['quote','source_sha256','source_pages']):
   sha=v['source_sha256'];pg=v['source_pages'];assert v['quote'] and pg and set(pg)<=supplied[sha]
   assert fold(v['quote'])in fold(text(sha,pg))or(v.get('quote_verification')=='original_image'and set(pg)<=ims[sha]),v['quote']
  for z in v.values():walk(z)
 elif isinstance(v,list):
  for z in v:walk(z)
walk(g)
job=next(x for x in reversed(s.read(O.parent/'jobs/receipt.json')['attempts'])if x.get('record_id')==rid and x.get('phase')=='review'and x.get('runner_call'));assert job['status']=='failed'
author=d/'source-gold.json';first=d/'first-review-source-gold.json'
if first.exists():assert first.read_text('utf8')==r['gold_json']
else:first.write_text(r['gold_json'],encoding='utf8')
receipt=d/'review-logical-unit-correction.json'
g['author_provenance']=s.read(author)['author_provenance'];g['review_status']='accepted';g['independent_source_review']=dict(origin='machine_test',run_id=provenance()['run_id'],job_id=job['job_id'],agent=job['agent'],method='codex_runner_with_explicit_local_source_projection',runner_call=True,status='accepted',author_gold_sha256=s.sha(author),reviewed_at_utc=job['finished_at'],reason=r['reason'],raw_response=raw.relative_to(O.parent).as_posix(),raw_response_sha256=s.sha(raw),actual_call_receipts=job['call_receipts'],original_mechanical_validation_status=job.get('error'),canonical_projection_receipt=receipt.name)
if (d/'reviewed-source-gold.json').exists():assert s.read(d/'reviewed-source-gold.json')==g
else:s.dump(d/'reviewed-source-gold.json',g)
s.dump(receipt,dict(provenance(),status='schema_only_logical_unit_normalization',raw_response=raw.relative_to(O.parent).as_posix(),raw_response_sha256=s.sha(raw),first_review_gold_sha256=s.sha(first),author_gold_sha256=s.sha(author),reviewed_gold_sha256=s.sha(d/'reviewed-source-gold.json'),changes=changes,source_facts_changed=False,paid_retry=False,validation='All exact quotes, event labels, ISO dates and complete supplied source bounds independently checked. Original accept:true and all original rejected receipts preserved. Only []pages to existing[1]capture unit normalized.'))
with ledger_transaction(O/'summary.json',{})as summary:
 if rid not in summary['accepted']:summary['accepted'].append(rid)
 summary['accepted_count']=len(summary['accepted']);summary['source_gold_paths'][rid]='records/'+rid+'/reviewed-source-gold.json';summary['record_paths'][rid]='records/'+rid
 if rid not in summary.setdefault('pending_model_view_review',[]):summary['pending_model_view_review'].append(rid)
print(rid,'actual independent accept:true materialized with logical-unit serialization audit',s.sha(d/'reviewed-source-gold.json'))
