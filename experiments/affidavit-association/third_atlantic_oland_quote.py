"""Shorten literal anchors only, preserving the independently reviewed source facts."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-nb-oland-crown-factum-20161011';raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);changes=[]
for a,b,new in [(1,0,'Factum, paras. 1-23'),(2,1,'vol 1, tab 1, Oland v. R. para. 10'),(3,1,'vol 1, tab 2, Oland v. R. para. 15'),(6,0,'affidavit of Michael Lacy'),(8,0,'extremely limited history with release pending appeal applications in murder cases is set out')]:
 e=g['exhibits'][a]['references'][b];old=e['quote'];t='\f'.join((s.views_folder(s.source(e['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in e['source_pages']);assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t),new;e['quote']=new;changes.append(dict(before=old,after=new,source_sha256=e['source_sha256'],source_pages=e['source_pages']))
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Five contiguous shorter literal anchors avoid reviewer curly apostrophes versus native straight apostrophes. All source facts, labels, dates, boundaries unchanged; no inference call.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
