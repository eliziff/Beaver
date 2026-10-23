"""Public Canadian source discovery; no inference, login, filing or docket actions."""
import json,urllib.request,sys,re
from pathlib import Path
from html.parser import HTMLParser
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory');O.mkdir(parents=True,exist_ok=True)
class Links(HTMLParser):
 def __init__(self):super().__init__();self.links=[];self.link=None
 def handle_starttag(self,t,a):
  if t=='a':self.link=[dict(a).get('href',''),'']
 def handle_data(self,s):
  if self.link:self.link[1]+=s
 def handle_endtag(self,t):
  if t=='a' and self.link:self.links.append(self.link);self.link=None
def main():
 u=sys.argv[1];s=urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=60).read().decode('utf-8',errors='replace');p=Links();p.feed(s);name=sys.argv[2] if len(sys.argv)>2 else 'page';(O/(name+'.html')).write_text(s,encoding='utf-8');(O/(name+'.links.json')).write_text(json.dumps({'url':u,'links':p.links},indent=2),encoding='utf-8');print('\n'.join(str(x) for x in p.links))
if __name__=='__main__':main()
