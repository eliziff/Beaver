"""Narrowly shorten one OCR-case-sensitive reviewer quotation; no source facts change."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-pe-richard-staffreport-20191007';raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);e=g['events'][15];old=e['quote'];new='22 standard parking spaces and two (2)'
t='\f'.join((s.views_folder(s.source(e['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in e['source_pages'])
assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t)
e['quote']=new;r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=[dict(before=old,after=new,source_sha256=e['source_sha256'],source_pages=e['source_pages'])],scope='One contiguous shorter literal source anchor avoids OCR capitalized Spaces at a line boundary. Full semantic parking calculation, dates, labels and original source bounds unchanged. No new inference.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
