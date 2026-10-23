"""Cache complete source-page OCR text with canonical/source render hashes, no inference."""
import concurrent.futures, hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
import fitz
from second_canada_author import OUT, source, dump
TESS=Path(r'C:\Program Files\Tesseract-OCR\tesseract.exe')

def transcribe(prefix):
    r=source(prefix); dest=OUT/'source-ocr'/r['sha256']; dest.mkdir(parents=True,exist_ok=True)
    receipt=[]
    with fitz.open(r['canonical_path']) as doc, tempfile.TemporaryDirectory(prefix='second-canada-ocr-') as scratch:
        for n,page in enumerate(doc,1):
            txt=dest/f'{n:04}.txt'; meta=dest/f'{n:04}.json'
            if meta.exists(): receipt.append(json.loads(meta.read_text(encoding='utf-8'))); continue
            native=page.get_text(); bad=sum(ord(c)<32 and c not in '\n\t\r' for c in native)
            if len(native.strip())>150 and not bad:
                content=native; mode='native_full_page'; render_sha=None
            else:
                pix=page.get_pixmap(dpi=200,alpha=False); png=Path(scratch)/'page.png'; pix.save(png)
                render_sha=hashlib.sha256(png.read_bytes()).hexdigest()
                out=Path(scratch)/'page'
                subprocess.run([str(TESS),str(png),str(out),'--dpi','200','--psm','3','txt'],
                    check=True,capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
                content=out.with_suffix('.txt').read_text(encoding='utf-8'); mode='tesseract_full_rendered_page'
            txt.write_text(content,encoding='utf-8',newline='')
            row=dict(source_sha256=r['sha256'],source_page=n,method=mode,text_sha256=hashlib.sha256(txt.read_bytes()).hexdigest(),
                     render_sha256=render_sha,source_native_sha256=hashlib.sha256(native.encode()).hexdigest(),dpi=200 if render_sha else None)
            dump(meta,row);receipt.append(row)
            if n%10==0: print(prefix,n,len(doc),flush=True)
    dump(dest/'coverage.json',dict(source_sha256=r['sha256'],pages=receipt,complete=True))
    print('complete',prefix,len(receipt),flush=True)

if __name__=='__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(transcribe,sys.argv[1:]))
