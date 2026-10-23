"""Literal shorter quotes only for typography in retained King author response."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-nl-hunt-johnking-factum-20170301';raw=list((s.OUT/'calls'/rid/'author').rglob('last-message.json'))[-1]
r=s.read(raw);g=json.loads(r['gold_json']);changes=[]
targets=[(g['events'][10],'records revealed fictitious accounting entries.'),(g['events'][14],'boxes of business records were seized.'),(g['events'][29],'Nor does this testimony suggest a')]+[(g['coverage']['underlying_context_inventory'][1]['references'][i],q)for i,q in enumerate(['It is now being filed in the','Affidavit, paragraph 26 and Tab 6','Affidavit, paragraph 27 and Tab 7.'])]
for v,new in targets:
 old=v['quote'];t='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in v['source_pages'])
 assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t),(old,new)
 v['quote']=new;changes.append(dict(before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages']))
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Six contiguous shorter anchors avoiding extracted apostrophe/dash typography. Original complete inventory, source scope, dates and narrative unchanged. No provider call.')
s.dump(O/'corrections'/(rid+'-author.json'),r)
