"""Shorten literal anchors in two failed author responses; preserve all source claims."""
import sys,json,re
from copy import deepcopy
from third_atlantic_sources import s,O,provenance
fixes={
'an3-pe-frostwicks-notice-20191015':{'be rescinded, and a rejection of the application be entered':'be rescinded, and a rejection'},
'an3-pe-hillbay-notice-20200131':{'I have included planning on this response.':'have included planning on this response.','I oppose the re-zoning of the lot at 68 Brackley Point Road.':'oppose the re-zoning of the lot at 68 Brackley Point Road.','I would like to express my concern about the proposal on 68 Brackley Point Rd.':'would like to express my concern about the proposal on 68 Brackley Point Rd.','the Sherwood residents were properly notified of the Appellant’s application':'the Sherwood residents were properly notified'}}
for rid,replacements in fixes.items():
 raw=list((s.OUT/'calls'/rid/'author').rglob('last-message.json'))[-1]; result=s.read(raw);g=deepcopy(json.loads(result['gold_json']));changes=[]
 def visit(v):
  if isinstance(v,dict):
   if v.get('quote') in replacements:
    old=v['quote'];new=replacements[old];text='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in v['source_pages']);fold=lambda t:re.sub(r'\s+',' ',t).strip();assert new in old and fold(new)in fold(text)
    changes.append(dict(old_quote=old,new_quote=new,source_sha256=v['source_sha256'],source_pages=v['source_pages']));v['quote']=new
   for z in v.values():visit(z)
  elif isinstance(v,list):
   for z in v:visit(z)
 visit(g);assert len(changes)==len(replacements)
 result['gold_json']=json.dumps(g,ensure_ascii=False);result['source_correction_receipt']=dict(provenance(),original_runner_response=raw.relative_to(s.OUT).as_posix(),original_runner_response_sha256=s.sha(raw),changes=changes,scope='Contiguous shorter literal source quotations only. Facts, dates, claims, page bindings and complete inventories unchanged; fresh review required.')
 s.dump(O/'corrections'/(rid+'.json'),result);print(rid,len(changes))
