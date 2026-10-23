"""Explicit sparse OCR recovery of intrinsic lettering in filed photographs."""
from pathlib import Path
import subprocess,json,os,hashlib
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory');S='2bd17fc49e5a38c1022d91652f25e480f2d4b542a39b0dfe579d01e59cd68fdc';E=r'C:\Program Files\Tesseract-OCR\tesseract.exe';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 rows=[];d=O/'source-text'/S
 for n in range(307,319):
  img=d/f'{n:04}.png';out=d/f'{n:04}.sparse.ocr.txt';env=os.environ.copy();env['OMP_THREAD_LIMIT']='1'
  if not out.exists():
   r=subprocess.run([E,str(img),'stdout','-l','eng','--psm','11'],capture_output=True,text=True,encoding='utf-8',check=True,env=env);out.write_text(r.stdout,encoding='utf-8')
  base=(d/f'{n:04}.native.txt').read_text(encoding='utf-8')+(d/f'{n:04}.ocr.txt').read_text(encoding='utf-8');dest=d/f'{n:04}.txt';dest.write_text(base+out.read_text(encoding='utf-8'),encoding='utf-8');rows.append(dict(source_sha256=S,source_page=n,image_file=img.relative_to(O).as_posix(),image_sha256=sha(img),sparse_ocr_file=out.relative_to(O).as_posix(),sparse_ocr_sha256=sha(out),text_sha256=sha(dest),command=[E,img.name,'stdout','-l','eng','--psm','11'],model_call=False));print(n,out.read_text(encoding='utf-8').replace('\n',' ')[:350],flush=True)
 (O/'brandum-photo-ocr-audit.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 meta=json.loads((O/'source-text'/f'{S}.json').read_text(encoding='utf-8'))
 for p in meta['pages']:
  if p['source_page'] in range(307,319):p['sparse_photo_ocr']=next(r for r in rows if r['source_page']==p['source_page']);p['text_sha256']=sha(O/p['text_file'])
 full=O/'source-text'/f'{S}.txt';full.write_text('\f'.join((O/p['text_file']).read_text(encoding='utf-8') for p in meta['pages']),encoding='utf-8');meta['text_sha256']=sha(full);(O/'source-text'/f'{S}.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__':main()
