"""Shorter literal independent-review quotations, preserving all original bindings."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-nl-hunt-johnking-factum-20170301';raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);g=json.loads(r['gold_json']);changes=[]
targets=[(g['referring_document']['collective_adoptions'][6]['references'][0],'John King generally adopts the arguments of the Respondent Hunt'),(g['events'][37],'wife began work as a supermarket cashier'),(g['coverage']['underlying_context_inventory'][1]['references'][0],'It is now being filed in the')]
for v,new in targets:
 old=v['quote'];t='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in v['source_pages'])
 assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t),(old,new)
 v['quote']=new;changes.append(dict(before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages']))
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only three contiguous shorter anchors, avoiding page-footer interruption and extracted apostrophe typography. Collective source-page range9–10, all precise semantic scope, identity conflicts, dates and independent-review facts unchanged. No provider call.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
