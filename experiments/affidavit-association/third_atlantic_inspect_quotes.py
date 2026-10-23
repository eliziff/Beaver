"""Inspect literal-anchor failures without editing any Gold or runner output."""
import sys,json,re
from third_atlantic_sources import s
rid,phase=sys.argv[1:3]
raw=list((s.OUT/'calls'/rid/phase).rglob('last-message.json'))[-1]
g=json.loads(s.read(raw)['gold_json']);print(raw)
fold=lambda t:re.sub(r'\s+',' ',t).strip()
def walk(v,path=''):
 if isinstance(v,dict):
  if v.get('quote') and v.get('source_sha256') and v.get('source_pages') and v.get('quote_verification')!='original_image':
   txt='\f'.join((s.views_folder(s.source(v['source_sha256']))/f'page-{p:04}.txt').read_text('utf8') for p in v['source_pages'])
   if fold(v['quote'])not in fold(txt):print(json.dumps(dict(path=path,quote=v['quote'],pages=v['source_pages'],source=v['source_sha256'],event=v.get('event'),description=v.get('description')),ensure_ascii=False))
  for k,x in v.items():walk(x,path+'/'+k)
 elif isinstance(v,list):
  for i,x in enumerate(v):walk(x,path+'/'+str(i))
walk(g)
