"""Complete original native text plus installed OCR, private replayable receipts."""
from pathlib import Path
import json,hashlib,os,subprocess,concurrent.futures,fitz,sys
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory');D=O/'source-text';D.mkdir(exist_ok=True);E=r'C:\Program Files\Tesseract-OCR\tesseract.exe'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def one(job):
 source,n,dpi,*options=job;force=bool(options and options[0]);doc=fitz.open(source);p=doc[n-1];key=sha(source);folder=D/key;folder.mkdir(exist_ok=True);raw=folder/f'{n:04}.native.txt';native=p.get_text();raw.write_text(native,encoding='utf-8');body=native;images=p.get_image_info();fullscan=any(fitz.Rect(x['bbox']).get_area()>p.rect.get_area()*.60 for x in images);bad_controls=sum(ord(c)<32 and c not in '\r\n\t\f' for c in native);need=force or (folder/f'{n:04}.ocr.txt').exists() or len(native.strip())<100 or bad_controls>=5 or (bool(images) and (len(images)>=4 or len(native.strip())<450 or fullscan));meta={'source_sha256':key,'source_page':n,'native_file':str(raw.relative_to(O)),'native_sha256':sha(raw),'ocr':False,'raster_image_count':len(images),'full_page_scan':fullscan,'bad_native_control_characters':bad_controls,'forced_source_image_ocr':force}
 if need:
  png=folder/f'{n:04}.png';txt=folder/f'{n:04}.ocr.txt'
  if not png.exists():p.get_pixmap(dpi=dpi,alpha=False).save(png)
  if not txt.exists():
   env=os.environ.copy();env['OMP_THREAD_LIMIT']='1';r=subprocess.run([E,str(png),'stdout','-l','eng'],capture_output=True,text=True,encoding='utf-8',check=True,env=env);txt.write_text(r.stdout,encoding='utf-8')
  body+=txt.read_text(encoding='utf-8');meta.update(ocr=True,image_file=str(png.relative_to(O)),image_sha256=sha(png),ocr_file=str(txt.relative_to(O)),ocr_sha256=sha(txt),command=[E,png.name,'stdout','-l','eng'],no_model_call=True)
 rotations=[]
 extras=sorted(folder.glob(f'{n:04}.rotation*.ocr.txt'))+sorted(folder.glob(f'{n:04}.sparse.ocr.txt'))+sorted(folder.glob(f'{n:04}.visual-transcription.txt'))
 for extra in extras:
  body+=extra.read_text(encoding='utf-8');rotations.append(dict(text_file=str(extra.relative_to(O)),text_sha256=sha(extra),reason='Explicit source-image recovery; raw installed OCR and separately audited intrinsic visual transcription preserved.'))
 if rotations:meta['orientation_ocr']=rotations
 dest=folder/f'{n:04}.txt';dest.write_text(body,encoding='utf-8');meta.update(text_file=str(dest.relative_to(O)),text_sha256=sha(dest));doc.close();return meta
def main():
 rows=json.loads((O/'acquisitions.json').read_text(encoding='utf-8'));sources={}
 for r in rows:
  if r['exit_code']==0:
   f=r['output'].strip().split('\t')
   if not sys.argv[1:] or f[1] in sys.argv[1:]:sources[f[1]]=Path(f[-1])
 jobs=[(p,n+1,300) for p in sources.values() for n in range(len(fitz.open(p)))];results=[]
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  for i,r in enumerate(pool.map(one,jobs)):
   results.append(r)
   if (i+1)%10==0:print('PAGES',i+1,'/',len(jobs),flush=True)
 for key,path in sources.items():
  pages=[r for r in results if r['source_sha256']==key];text='\f'.join((O/p['text_file']).read_text(encoding='utf-8') for p in pages);dest=D/(key+'.txt');dest.write_text(text,encoding='utf-8');(D/(key+'.json')).write_text(json.dumps(dict(source_sha256=key,source_path=str(path),pages=pages,text_sha256=sha(dest)),ensure_ascii=False,indent=2),encoding='utf-8')
 print('COMPLETE',len(sources),len(jobs),flush=True)
if __name__=='__main__':main()
