"""Source retrieval and full text inspection for private Canadian Gold authoring."""
import os,json,sys,hashlib,sqlite3,re,urllib.request,urllib.parse,html
from pathlib import Path
from datetime import datetime,timezone
import fitz
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'benchmarks/local-data/affidavit-association/expansion-2/tribunals'
sys.path.insert(0,str(ROOT/'experiments/legal_pdf_corpus'))
import corpus_store as cs
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def dump(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
def fetch(url,label,jurisdiction):
 db=cs.connect();digest,status=cs.fetch(db,url,{'collection':'affidavit-association-expansion-2','jurisdiction':jurisdiction,'kind':'court-record','label':label,'provenance':'Public Canadian litigation source; direct Codex source authoring, second expansion'},refresh=False)
 if not digest:raise ValueError(status)
 db.row_factory=sqlite3.Row
 row=dict(db.execute('select * from files where sha256=?',(digest,)).fetchone());p=cs.HOME/row['path'];assert sha(p)==digest
 return {'url':url,'label':label,'jurisdiction':jurisdiction,'sha256':digest,'canonical_path':row['path'],'pages':row['pages'],'retrieved_at':datetime.now(timezone.utc).isoformat()}
def inspect(item,pages=None):
 with fitz.open(cs.HOME/item['canonical_path'])as pdf:
  selected=range(1,len(pdf)+1)if pages is None else pages
  return '\n\n'.join(f'[original source page {n}]\n'+pdf[n-1].get_text()for n in selected)
if __name__=='__main__':
 if sys.argv[1]=='fetch':
  item=fetch(*sys.argv[2:5]);dump(OUT/'sources'/(item['sha256']+'.json'),item);print(json.dumps(item))
 elif sys.argv[1]=='inspect':
  item=json.loads(Path(sys.argv[2]).read_text(encoding='utf8'));print(inspect(item,[int(n)for n in sys.argv[3:]]or None))
 elif sys.argv[1]=='links':
  url=sys.argv[2];raw=urllib.request.urlopen(urllib.request.Request(url,headers=cs.HEADERS),timeout=90).read();key=hashlib.sha256(url.encode()).hexdigest()[:16];folder=OUT/'source-pages';folder.mkdir(exist_ok=True);(folder/(key+'.html')).write_bytes(raw)
  links=[{'url':urllib.parse.urljoin(url,html.unescape(m[2])),'text':re.sub('<[^>]+>','',html.unescape(m[3])).strip()}for m in cs.LINK.finditer(raw.decode('utf8',errors='replace'))]
  links=[x for x in links if '.pdf'in x['url'].lower()or re.search(r'classaction[.]|settlement[.]',x['url'],re.I)]
  dump(folder/(key+'.json'),{'source_url':url,'html_sha256':hashlib.sha256(raw).hexdigest(),'retrieved_at':datetime.now(timezone.utc).isoformat(),'public_links':links});print(json.dumps(links,ensure_ascii=False,indent=2))
 elif sys.argv[1]=='fetch-listed-records':
  for p in sorted((OUT/'source-pages').glob('*.json')):
   listing=json.loads(p.read_text(encoding='utf8'))
   for link in listing['public_links']:
    if not re.search(r'(?:[/-]Record|MOTION-RECORD|Supplementary-Affidavit)',link['url'],re.I):continue
    item=fetch(link['url'],link['url'].rsplit('/',1)[-1],sys.argv[2]);item['landing_url']=listing['source_url'];dump(OUT/'sources'/(item['sha256']+'.json'),item);print(json.dumps(item),flush=True)
 elif sys.argv[1]=='render':
  digest=sys.argv[2];item=json.loads((OUT/'sources'/(digest+'.json')).read_text(encoding='utf8'));folder=OUT/'source-views'/digest;folder.mkdir(parents=True,exist_ok=True)
  with fitz.open(cs.HOME/item['canonical_path'])as pdf:
   for arg in sys.argv[3:]:
    n=int(arg);pg=pdf[n-1];target=folder/f'page-{n:04}.png';pg.get_pixmap(matrix=fitz.Matrix(1400/pg.rect.width,1400/pg.rect.width),alpha=False).save(target);print(str(target))
