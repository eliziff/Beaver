"""Source-correct an invalid quote anchor in an otherwise accepted isolated review."""
from third_atlantic_sources import s,O,provenance
from pathlib import Path
import json,re,sys,copy
sys.path[:0]=[str(O.parent),str(Path('tools').resolve())]
from ledger_utils import ledger_transaction
from audit_expansion import source_parts,iso
rid='an3-bc-tayotompouba-appellant-merits-20230411';d=O/'records'/rid;raw=O.parent/'calls'/rid/'review/a5789ae75a998ae7/attempt-1/last-message.json';r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);old=copy.deepcopy(g);v=g['events'][17];assert v['quote']=='jeune' and v['source_pages']==[38] and v['source_sha256'].startswith('231d8711')
v['quote']='n’était pas l’officier ayant procédé à l’arrestation'
spec=s.read(O/'specs'/(rid+'.json'));sp={x['sha256']:set(x['pages'])for x in spec['sources']};im={x['sha256']:set(x.get('image_pages',[]))for x in spec['sources']}
full=lambda h,pg:'\f'.join((s.views_folder(s.source(h))/f'page-{n:04}.txt').read_text('utf8')for n in pg)
fold=lambda t:re.sub(r'\s+',' ',t).strip()
assert fold(v['quote'])in fold(full(v['source_sha256'],v['source_pages']))
assert old['events'][17]['event']==v['event'];test=copy.deepcopy(g);test['events'][17]['quote']='jeune';assert test==old
labels={e['label']for e in g['exhibits']};assert len(labels)==len(g['exhibits'])
for e in g['exhibits']+g['events']:iso(e.get('date'));iso(e.get('end_date'))
for e in g['exhibits']:
 for p in source_parts(e):assert p['pages'] and set(p['pages'])<=sp[p['sha256']]
for e in g['events']:assert set(e.get('exhibits',[]))<=labels
def walk(v):
 if isinstance(v,dict):
  if all(k in v for k in ['quote','source_sha256','source_pages']):
   h=v['source_sha256'];pg=v['source_pages'];assert pg and v['quote']and set(pg)<=sp[h]
   assert fold(v['quote'])in fold(full(h,pg))or(v.get('quote_verification')=='original_image'and set(pg)<=im[h]),v['quote']
  for z in v.values():walk(z)
 elif isinstance(v,list):
  for z in v:walk(z)
walk(g)
job=next(z for z in reversed(s.read(O.parent/'jobs/receipt.json')['attempts'])if z.get('record_id')==rid and z.get('phase')=='review'and z.get('runner_call'));assert job['status']=='failed'
first=d/'first-review-source-gold.json';assert not(d/'reviewed-source-gold.json').exists();first.write_text(r['gold_json'],encoding='utf8');author=d/'source-gold.json';receipt=d/'review-literal-anchor-correction.json'
g['author_provenance']=s.read(author)['author_provenance'];g['review_status']='accepted';g['independent_source_review']=dict(origin='machine_test',run_id=provenance()['run_id'],job_id=job['job_id'],agent=job['agent'],method='codex_runner_with_explicit_local_source_projection',runner_call=True,status='accepted',author_gold_sha256=s.sha(author),reviewed_at_utc=job['finished_at'],reason=r['reason'],raw_response=raw.relative_to(O.parent).as_posix(),raw_response_sha256=s.sha(raw),actual_call_receipts=job['call_receipts'],original_mechanical_validation_status=job.get('error'),canonical_projection_receipt=receipt.name)
s.dump(d/'reviewed-source-gold.json',g);s.dump(receipt,dict(provenance(),scope='Only invalid quotation anchor replaced against the already cited complete original page. No event wording, source pages, attribution, date, label or association fact changed. Raw reviewer acceptance and all original receipt failures preserved. Correction was performed by source author and verified by full-string source match, not falsely attributed to reviewer.',raw_response=raw.relative_to(O.parent).as_posix(),raw_response_sha256=s.sha(raw),author_gold_sha256=s.sha(author),first_review_gold_sha256=s.sha(first),reviewed_gold_sha256=s.sha(d/'reviewed-source-gold.json'),changes=[dict(path='/events/17/quote',before='jeune',after=v['quote'],source_sha256=v['source_sha256'],source_pages=[38])],provider_call=False))
with ledger_transaction(O/'summary.json',{})as z:
 if rid not in z['accepted']:z['accepted'].append(rid)
 z['accepted_count']=len(z['accepted']);z['source_gold_paths'][rid]='records/'+rid+'/reviewed-source-gold.json';z['record_paths'][rid]='records/'+rid
 if rid not in z.setdefault('pending_model_view_review',[]):z['pending_model_view_review'].append(rid)
print(rid,'accepted raw review plus audited literal source anchor',s.sha(d/'reviewed-source-gold.json'))
