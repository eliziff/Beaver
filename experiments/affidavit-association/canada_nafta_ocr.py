"""Inspect newly acquired constitutional-trade affidavits before metered annotation."""
import pathlib,json,subprocess,tempfile,os,fitz
import canada_ocr as o
BASE=o.BASE/'nafta'
def main():
    for row in json.loads((BASE/'sources.json').read_text(encoding='utf-8')):
        target=BASE/(row['record_id']+'.pdf')
        if not target.exists():
            with fitz.open(row['path']) as source,fitz.open() as out,tempfile.TemporaryDirectory(prefix='canada-nafta-ocr-') as scratch:
                for n,p in enumerate(source):
                    if len(p.get_text().strip())>150:out.insert_pdf(source,from_page=n,to_page=n)
                    else:
                        image=pathlib.Path(scratch)/'page.png';dest=pathlib.Path(scratch)/'ocr';p.get_pixmap(dpi=180).save(image)
                        subprocess.run([o.TESS,str(image),str(dest),'--dpi','180','pdf'],check=True,capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
                        with fitz.open(dest.with_suffix('.pdf')) as d:out.insert_pdf(d)
                out.save(target,garbage=4,deflate=True)
        with fitz.open(target) as d:text='\n'.join(f'\n[SOURCE PAGE {n+1}]\n'+p.get_text() for n,p in enumerate(d))
        target.with_suffix('.txt').write_text(text,encoding='utf-8');print(row['record_id'],len(text),flush=True)
if __name__=='__main__':main()
