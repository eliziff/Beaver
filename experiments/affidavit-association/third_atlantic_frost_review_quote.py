"""Contiguous shorter quotation only; retained independent review facts unchanged."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-pe-frostwicks-staffreport-20191202'
raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1]
result=s.read(raw);g=json.loads(result['gold_json']);changes=[]
def walk(v):
 if isinstance(v,dict):
  if v.get('quote','').startswith('At second reading, City Council again voted'):
   old=v['quote'];new='in favour of the proposal.'
   assert new in old
   txt='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8') for p in v['source_pages'])
   assert re.sub(r'\s+',' ',new) in re.sub(r'\s+',' ',txt)
   v['quote']=new;changes.append(dict(before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages']))
  for x in v.values():walk(x)
 elif isinstance(v,list):
  for x in v:walk(x)
walk(g);assert len(changes)==1
result['gold_json']=json.dumps(g,ensure_ascii=False)
result['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only one contiguous shorter quotation avoiding dash typography mismatch. All independent-review claims, dates, sources and inventory unchanged. No provider call.')
s.dump(O/'corrections'/(rid+'-review.json'),result)
