"""Lossless existing event-identifier projection to canonical target labels."""
from copy import deepcopy
from datetime import datetime,timezone
from pathlib import Path
import sys
from third_atlantic_sources import s,O
sys.path.insert(0,str(s.ROOT/'tools'))
from ledger_utils import ledger_transaction

JOB='6c6d7e30-9245-4c7a-809d-aec9c361b576'
RUN='b29b8749-30fa-4827-96a1-6ee61137c7b6'
OUT=O/'event-link-reconciliation'
def provenance():return dict(origin='machine_test',run_id=RUN,job_id=JOB,agent='/root/gold_regulatory',method='existing_source_identifier_namespace_reconciliation',runner_call=False)

def aliases(gold):
 known={e['label']for e in gold['exhibits']};result={};needed={v for event in gold['events']for v in event.get('exhibits',[])}-known
 def add(alias,label,basis):
  if not isinstance(alias,str)or not alias or alias not in needed:return
  item=dict(canonical_label=label,**basis)
  if alias in result:assert result[alias]['canonical_label']==label,(gold['record_id'],alias)
  else:result[alias]=item
 for index,exhibit in enumerate(gold['exhibits']):
  label=exhibit['label']
  for key in ['instrument_id','target_id','exhibit_id','id','scoped_reference_name']:
   add(exhibit.get(key),label,dict(kind='exact_existing_target_identifier',source_inventory_pointer=f'/exhibits/{index}/{key}'))
  def children(parent,pointer):
   for n,child in enumerate(parent.get('nested_components',[])):
    ptr=f'{pointer}/nested_components/{n}'
    basis=dict(kind='existing_nested_component_within_existing_canonical_target',source_inventory_pointer=ptr,nested_label=child['label'],nested_parent_instrument=child.get('parent_instrument'),nested_source_files=child.get('source_files',[]),scope='The full canonical parent target already contains this explicitly annotated component. Exact original child scope remains on the event; no new target or external-document equivalence is introduced.')
    for key in ['instrument_id','target_id','exhibit_id','id','scoped_reference_name']:add(child.get(key),label,dict(basis,identifier_field=key))
    add(parent['label']+' / '+child['label'],label,dict(basis,identifier_field='existing parent label / existing nested label'))
    children(child,ptr)
  children(exhibit,f'/exhibits/{index}')
 return known,result

def main():
 summary_path=O/'summary.json';summary=s.read(summary_path)
 assert len(summary['accepted'])==46
 original_completed=O/'completed-manifest.json';original_completed_sha=s.sha(original_completed)
 plans=[];all_records=[]
 # Complete read-only preflight: no mutations until every unknown identifier
 # has an exact existing inventory binding. Context cannot become a target.
 for rid in summary['accepted']:
  path=O/summary['source_gold_paths'][rid];gold=s.read(path);known,mapping=aliases(gold)
  unknown={v for event in gold['events']for v in event.get('exhibits',[])}-known
  assert not unknown-mapping.keys(),(rid,sorted(unknown-mapping.keys()))
  all_records.append(dict(record_id=rid,original_canonical_gold=path.relative_to(O).as_posix(),original_canonical_gold_sha256=s.sha(path)))
  if unknown:plans.append((rid,path,gold,known,mapping,unknown))
 if '--preview' in sys.argv:
  for rid,path,gold,known,mapping,unknown in plans:print(rid,len(unknown),'identifiers',sum(any(v in unknown for v in e.get('exhibits',[]))for e in gold['events']),'events')
  print(len(plans),'records',sum(sum(any(v in unknown for v in e.get('exhibits',[]))for e in gold['events'])for _,_,gold,_,_,unknown in plans),'events')
  return
 assert not(OUT/'manifest.json').exists(),'Frozen correction manifest already exists'
 OUT.mkdir(parents=True,exist_ok=True)
 (OUT/'summary-before.json').write_bytes(summary_path.read_bytes())
 changes=[]
 for rid,path,old,known,mapping,unknown in plans:
  gold=deepcopy(old);d=path.parent;events=[]
  for event in gold['events']:
   before=list(event.get('exhibits',[]))
   if not any(v in unknown for v in before):continue
   event['source_scoped_exhibits']=list(dict.fromkeys(event.get('source_scoped_exhibits',[])+before))
   event['exhibits']=list(dict.fromkeys(v if v in known else mapping[v]['canonical_label']for v in before))
   events.append(dict(event_id=event['event_id'],before=before,after=event['exhibits'],source_scoped_exhibits=list(event['source_scoped_exhibits']),resolutions=[dict(original_identifier=v,**mapping[v])for v in before if v in unknown]))
   assert set(event['exhibits'])<=known
  # Check the exact change surface independently of serialization.
  for before,after in zip(old['events'],gold['events']):
   expected=deepcopy(before)
   if any(v in unknown for v in before.get('exhibits',[])):
    expected['source_scoped_exhibits']=list(dict.fromkeys(before.get('source_scoped_exhibits',[])+before.get('exhibits',[])))
    expected['exhibits']=list(dict.fromkeys(v if v in known else mapping[v]['canonical_label']for v in before['exhibits']))
   assert after==expected
  untouched=deepcopy(gold);untouched['events']=old['events'];assert untouched==old
  record_out=d/'event-link-reconciliation';record_out.mkdir()
  receipt=record_out/'receipt.json'
  s.dump(receipt,dict(provenance(),previous_gold=path.relative_to(O).as_posix(),previous_gold_sha256=s.sha(path),immutable_original_completed_manifest='completed-manifest.json',immutable_original_completed_manifest_sha256=original_completed_sha,changes=events,context_only_references_reclassified=[],scope='Namespace-only projection of exact existing instrument identifiers and explicitly annotated nested components to existing canonical parent labels. All original event scopes retained. No quote, date, attribution, source SHA/page, target inventory, availability, source URL, author Gold, first independent source review, or counterpart decision changed.',recorded_at_utc=datetime.now(timezone.utc).isoformat()))
  gold['event_link_projection']=dict(**provenance(),receipt=receipt.relative_to(d).as_posix(),receipt_path_base='record_directory',sha256=s.sha(receipt),previous_gold=path.name,previous_gold_sha256=s.sha(path),immutable_original_completed_manifest_sha256=original_completed_sha)
  target=d/'event-link-canonicalized-reviewed-source-gold.json';assert not target.exists();s.dump(target,gold)
  model=d/'model-views.json';before_model=s.read(model);assert before_model['source_gold_sha256']==s.sha(path),(rid,'unexpected prior model binding')
  (record_out/'model-views-before.json').write_bytes(model.read_bytes());before_model_sha=s.sha(model)
  after_model=deepcopy(before_model);after_model['source_gold_sha256']=s.sha(target)
  after_model['event_link_reconciliation']=dict(**provenance(),receipt=receipt.relative_to(d).as_posix(),receipt_path_base='record_directory',receipt_sha256=s.sha(receipt),previous_model_manifest_sha256=before_model_sha,scope='Gold hash binding only; all target labels, complete text files, hashes, source parts and pending fidelity status unchanged.')
  s.dump(model,after_model)
  expected=deepcopy(after_model);expected.pop('event_link_reconciliation');expected['source_gold_sha256']=before_model['source_gold_sha256'];assert expected==before_model
  with ledger_transaction(summary_path)as current:
   assert current['source_gold_paths'][rid]==path.relative_to(O).as_posix()
   current['source_gold_paths'][rid]=target.relative_to(O).as_posix()
  changes.append(dict(record_id=rid,previous_gold=path.relative_to(O).as_posix(),previous_gold_sha256=s.sha(path),canonical_gold=target.relative_to(O).as_posix(),canonical_gold_sha256=s.sha(target),receipt=receipt.relative_to(O).as_posix(),receipt_sha256=s.sha(receipt),mapped_identifier_count=len(unknown),changed_event_count=len(events),nested_component_event_count=sum(any(x['kind']=='existing_nested_component_within_existing_canonical_target'for x in e['resolutions'])for e in events),model_manifest=(d/'model-views.json').relative_to(O).as_posix(),previous_model_manifest_sha256=before_model_sha,model_manifest_sha256=s.sha(model)))
 assert s.sha(original_completed)==original_completed_sha
 current=s.read(summary_path)
 for rid in current['accepted']:
  d=O/'records'/rid;gold=s.read(O/current['source_gold_paths'][rid]);known={e['label']for e in gold['exhibits']}
  assert all(set(e.get('exhibits',[]))<=known for e in gold['events']),rid
  assert s.read(d/'model-views.json')['source_gold_sha256']==s.sha(O/current['source_gold_paths'][rid]),rid
 s.dump(OUT/'manifest.json',dict(provenance(),status='completed',accepted_count=46,records_changed=len(changes),events_changed=sum(x['changed_event_count']for x in changes),identifier_mappings=sum(x['mapped_identifier_count']for x in changes),nested_component_events=sum(x['nested_component_event_count']for x in changes),immutable_original_completed_manifest='completed-manifest.json',immutable_original_completed_manifest_sha256=original_completed_sha,before_summary='event-link-reconciliation/summary-before.json',before_summary_sha256=s.sha(OUT/'summary-before.json'),current_summary='summary.json',current_summary_sha256=s.sha(summary_path),original_canonical_gold_bindings=all_records,corrections=changes,source_semantics='Every exact original link retained in source_scoped_exhibits. No source fact, target inventory, existing nested component, date, quote, availability or independent source review changed. No context-only reference was promoted to a target. Historical HTTP URLs remain unchanged; root owns counterpart reconciliation.',recorded_at_utc=datetime.now(timezone.utc).isoformat()))
 print(len(changes),'records',sum(x['changed_event_count']for x in changes),'events',sum(x['mapped_identifier_count']for x in changes),'identifiers; correction manifest',s.sha(OUT/'manifest.json'))
if __name__=='__main__':main()
