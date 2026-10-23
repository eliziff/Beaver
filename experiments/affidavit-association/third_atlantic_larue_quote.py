"""Contiguous shorter Crown quotation; original allegation attribution retained."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-yt-larue-respondent-factum';raw=list((s.OUT/'calls'/rid/'author').rglob('last-message.json'))[-1]
r=s.read(raw);g=json.loads(r['gold_json']);v=g['events'][28];old=v['quote'];new='there is no evidence that Ms. Asp is a'
t='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8') for p in v['source_pages'])
assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t)
v['quote']=new;r['gold_json']=json.dumps(g,ensure_ascii=False)
r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=[dict(before=old,after=new,source_sha256=v['source_sha256'],source_pages=v['source_pages'])],scope='Only contiguous shorter quote before single-versus-double typographical quotation marks. All complete original sources, dates, narrative and uncertainty unchanged. No provider call.')
s.dump(O/'corrections'/(rid+'-author.json'),r)
