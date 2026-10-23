"""Contiguous shorter literal review anchors only; no new provider calls."""
import json,re
from third_atlantic_sources import s,O,provenance
for rid,paths in [('an3-nl-hunt-hillyard-factum-20170220',[(['events',35],'boxes of business records were seized'),(['events',42],'were never recorded properly as an expense')]),('an3-nl-hart-amicus-factum',[(['exhibits',12,'references',1],'Counsel gave their closing addresses')])]:
 raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);g=json.loads(r['gold_json']);changes=[]
 for path,new in paths:
  v=g
  for k in path:v=v[k]
  old=v['quote'];t='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in v['source_pages'])
  assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t),(rid,old,new)
  v['quote']=new;changes.append(dict(path=path,before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages']))
 r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only contiguous shorter review quotations avoiding apostrophe, capitalization or OCRmoming typography. All independent source-review claims, full inventory, dates and narrative unchanged. No provider call.')
 s.dump(O/'corrections'/(rid+'-review.json'),r)
