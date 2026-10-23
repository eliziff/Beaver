"""Contiguous shorter anchors avoid curly/native apostrophe differences only."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-ns-npr-respondent-factum';raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);changes=[]
for e,new in [(g['exhibits'][5]['references'][0],'evidence unhelpful, and excised portions of his report.'),(g['events'][20],'if one believes Ms.'),(g['events'][30],'The Crown appealed the trial judge')]:
 old=e['quote'];t='\f'.join((s.views_folder(s.source(e['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in e['source_pages']);assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t);e['quote']=new;changes.append(dict(before=old,after=new,source_sha256=e['source_sha256'],source_pages=e['source_pages']))
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only contiguous shorter literal anchors; native straight apostrophes differ from reviewer curly apostrophes. All facts, dates, labels and bounds unchanged; no new inference.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
