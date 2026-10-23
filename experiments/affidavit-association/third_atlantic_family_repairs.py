"""Retain failed raw authors; correct only quote span/explicit logical-unit serialization."""
import json,re
from third_atlantic_sources import s,O,provenance
for rid in ['an3-bc-kerr-respondent-factum','an3-bc-rick-leaf-factum-2008']:
 raw=list((s.OUT/'calls'/rid/'author').rglob('last-message.json'))[-1];result=s.read(raw);g=json.loads(result['gold_json']);changes=[]
 def walk(v):
  if isinstance(v,dict):
   q=v.get('quote')
   replacement='72.' if q=='AR p. 72.' else 'the entered order of the court did not address' if q and q.startswith('the entered order of the court did not address') else None
   if replacement:
    assert replacement in q
    text='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in v['source_pages'])
    assert re.sub(r'\s+',' ',replacement)in re.sub(r'\s+',' ',text)
    v['quote']=replacement;changes.append(dict(field='quote',before=q,after=replacement,source_sha256=v['source_sha256'],source_pages=v['source_pages']))
   if v.get('sha256')=='7492a186d6e2dee578635aa13da75e2762622409f59cd1d07ade872e3c851340' and v.get('pages')==[]:
    assert v['whole_document'] and v['capture_units']==[1] and v['physical_page_numbering']is False
    v['pages']=[1];changes.append(dict(field='source_files.pages',before=[],after=[1],source_sha256=v['sha256'],basis='Serialize already-explicit complete whole-HTML logical capture_units:[1] for harness. Still explicitly not physical PDF pagination; no source scope or facts changed.'))
   for x in v.values():walk(x)
  elif isinstance(v,list):
   for x in v:walk(x)
 walk(g);assert len(changes)==(2 if 'kerr' in rid else 1)
 result['gold_json']=json.dumps(g,ensure_ascii=False);result['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Only contiguous shorter literal quote anchors or mechanical serialization of already-explicit whole-document logical HTML unit1. No factual claims, original SHA, body/target scope, dates, inventory membership or physical pagination claims changed. No provider call.')
 s.dump(O/'corrections'/(rid+'-author.json'),result)
 print(rid,len(changes))
