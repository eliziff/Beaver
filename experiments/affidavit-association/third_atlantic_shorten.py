"""Replay only an explicitly chosen contiguous shorter literal source quotation."""
import sys,json,re
from third_atlantic_sources import s,O,provenance
rid,path,new=sys.argv[1:];raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);v=g
for key in path.strip('/').split('/'):v=v[int(key)]if isinstance(v,list)else v[key]
old=v['quote'];assert new in old
t='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in v['source_pages']);assert re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t)
v['quote']=new;r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=[dict(before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages'])],scope='Only explicitly selected contiguous shorter literal anchor; all independently reviewed facts, dates, labels and source bounds unchanged. No provider inference.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
