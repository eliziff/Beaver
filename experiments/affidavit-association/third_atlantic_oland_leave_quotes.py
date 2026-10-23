"""Two contiguous shorter source anchors avoid native J.A. spacing only."""
import json,re
from third_atlantic_sources import s,O,provenance
rid='an3-nb-oland-crown-leaveresponse-20160526';raw=list((s.OUT/'calls'/rid/'review').rglob('last-message.json'))[-1];r=s.read(raw);assert r['accept'];g=json.loads(r['gold_json']);changes=[]
for n,new in [(12,'Such an observation cannot be equated to a requirement by Richard'),(16,'made any errors and thus deference was owed.')]:
 e=g['events'][n];old=e['quote'];t='\f'.join((s.views_folder(s.source(e['source_sha256']))/f'page-{p:04}.txt').read_text('utf8')for p in e['source_pages']);assert new in old and re.sub(r'\s+',' ',new)in re.sub(r'\s+',' ',t);e['quote']=new;changes.append(dict(before=old,after=new,source_sha256=e['source_sha256'],source_pages=e['source_pages']))
r['gold_json']=json.dumps(g,ensure_ascii=False);r['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Two contiguous shorter literal source anchors only; native J.A. spacing varies. All independently reviewed facts, dates, labels and bounds unchanged. No new inference.')
s.dump(O/'corrections'/(rid+'-review.json'),r)
