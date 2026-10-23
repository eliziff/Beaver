"""Complete per-page native/OCR evidence cache; originals remain unchanged."""
import sys,json,re
from concurrent.futures import ThreadPoolExecutor
import fitz
from second_tribunals_sources import OUT,ROOT,cs,sha,dump
sys.path.insert(0,str(ROOT/'benchmarks/court-record-exhibits'))
from split import tesseract_cli
def main(digest,force_pages=(),only_pages=None):
 item=json.loads((OUT/'sources'/(digest+'.json')).read_text(encoding='utf8'));p=cs.HOME/item['canonical_path'];assert sha(p)==digest
 folder=OUT/'source-text'/digest;folder.mkdir(parents=True,exist_ok=True)
 def page(n):
  target=folder/f'page-{n:04}.txt'
  if target.exists()and n not in force_pages:return
  with fitz.open(p)as pdf:
   pg=pdf[n-1];native=pg.get_text();broken=any(ord(c)<32 and c not in '\n\r\t'for c in native);ocr=n in force_pages or broken or(len(re.findall(r'\w+',native))<25 and bool(pg.get_images()));text=tesseract_cli(pg)if ocr else native
  target.write_text(text,encoding='utf8');dump(target.with_suffix('.json'),{'original_source_sha256':digest,'original_source_page':n,'method':'tesseract_cli_300dpi_eng'if ocr else'native_full_page','text_sha256':sha(target)})
  print(n,'ocr'if ocr else'native',flush=True)
 with fitz.open(p)as pdf:count=len(pdf)
 selected=list(only_pages)if only_pages is not None else list(range(1,count+1))
 assert all(1<=n<=count for n in selected)
 with ThreadPoolExecutor(max_workers=2)as pool:list(pool.map(page,selected))
 print('COMPLETE_REQUESTED_SOURCE_PAGES',digest,len(selected),'OF',count,flush=True)
if __name__=='__main__':
 import argparse
 parser=argparse.ArgumentParser();parser.add_argument('digest');parser.add_argument('force',nargs='*',type=int);parser.add_argument('--only',nargs='+',type=int)
 args=parser.parse_args();main(args.digest,args.force,args.only)
