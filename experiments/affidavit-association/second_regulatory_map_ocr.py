"""Explicit source-image orientation recovery for filed maps, not model inference."""
from pathlib import Path
import json,hashlib,subprocess,os
from PIL import Image
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory');S='edd98fab3db98d2b92252761f36b3ec97c0ae1527a2207f822960c7b0e12ea15';E=r'C:\Program Files\Tesseract-OCR\tesseract.exe'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 audit=[]
 for n in [157,160,239,253,269]:
  d=O/'source-text'/S;im=Image.open(d/f'{n:04}.png');extra=[]
  for angle in [90,270]:
   p=d/f'{n:04}.rotation{angle}.png';t=d/f'{n:04}.rotation{angle}.ocr.txt';im.rotate(angle,expand=True).save(p)
   if not t.exists():
    env=os.environ.copy();env['OMP_THREAD_LIMIT']='1';r=subprocess.run([E,str(p),'stdout','-l','eng','--psm','11'],capture_output=True,text=True,encoding='utf-8',check=True,env=env);t.write_text(r.stdout,encoding='utf-8')
   extra.append(t.read_text(encoding='utf-8'));audit.append(dict(source_sha256=S,source_page=n,angle=angle,image_file=p.relative_to(O).as_posix(),image_sha256=sha(p),text_file=t.relative_to(O).as_posix(),text_sha256=sha(t),ocr_tool='installed Tesseract --psm11 eng',model_call=False))
  combined=(d/f'{n:04}.native.txt').read_text(encoding='utf-8')+(d/f'{n:04}.ocr.txt').read_text(encoding='utf-8')+''.join(extra);(d/f'{n:04}.txt').write_text(combined,encoding='utf-8')
 meta=json.loads((O/'source-text'/f'{S}.json').read_text(encoding='utf-8'))
 for p in meta['pages']:
  if p['source_page'] in [157,160,239,253,269]:p['orientation_ocr']=[a for a in audit if a['source_page']==p['source_page']];p['text_sha256']=sha(O/p['text_file'])
 full=O/'source-text'/f'{S}.txt';full.write_text('\f'.join((O/p['text_file']).read_text(encoding='utf-8') for p in meta['pages']),encoding='utf-8');meta['text_sha256']=sha(full);(O/'source-text'/f'{S}.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');(O/'wozniuk-map-ocr-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__':main()
