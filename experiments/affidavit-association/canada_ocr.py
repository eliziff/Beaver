"""Prepare reviewed-source OCR derivatives without duplicating original corpus PDFs."""
import pathlib,json,subprocess,tempfile,sys,fitz,os,collections
import regulatory_expand as w
import canada_masks

BASE=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada').resolve()
TESS=r'C:\Program Files\Tesseract-OCR\tesseract.exe'

def main():
    global BASE
    jccf=len(sys.argv)>1 and sys.argv[1]=='jccf'
    if jccf:BASE=BASE/'jccf'
    rows=json.loads((BASE/('sources.json' if jccf else 'acquired.json')).read_text())
    if jccf:
        for r in rows:
            r['path']=str(w.HOME/r['path']);r['family']='sk-urpride' if 'UR-Pride' in r['label'] else 'mb-gateway' if r['label'].startswith(('2021-','2020-')) else 'ab-academic' if r['label'].startswith('2307') else 'mb-publichealth'
            r['landing_url']=r['url']
    selected=[]
    picks=('B Muldoon','H MacLeod','J Martin','C Stevens','C Glebe','D Richards')
    for family in (('sk-urpride','mb-gateway','ab-academic','mb-publichealth') if jccf else ('2023','2024','2022','2021','2020')):
        candidates=[r for r in rows if r['family']==family]
        if family=='2023':candidates=[r for r in candidates if any(x in r['label'] for x in picks)]
        else:candidates.sort(key=lambda r:r['pages'] or 10000)
        selected+=candidates[:8]
    accepted=[]
    for row in selected:
        rid='nsarb-'+row['family']+'-'+row['sha256'][:10]
        derivative=BASE/'ocr'/f'{rid}.pdf';derivative.parent.mkdir(exist_ok=True)
        if not derivative.exists():
            with fitz.open(row['path']) as source,fitz.open() as out,tempfile.TemporaryDirectory(prefix='canada-ocr-') as scratch:
                for n,p in enumerate(source):
                    if len(p.get_text().strip())>150:
                        out.insert_pdf(source,from_page=n,to_page=n)
                    else:
                        image=pathlib.Path(scratch)/'page.png';target=pathlib.Path(scratch)/'ocr'
                        p.get_pixmap(dpi=180).save(image)
                        subprocess.run([TESS,str(image),str(target),'--dpi','180','pdf'],check=True,capture_output=True,env={**os.environ,'OMP_THREAD_LIMIT':'1'})
                        with fitz.open(target.with_suffix('.pdf')) as d:out.insert_pdf(d)
                    if n%25==0:print('ocr',rid,n+1,len(source),flush=True)
                out.save(derivative,garbage=4,deflate=True)
        dest=BASE/'records'/rid
        if not (dest/'split.json').exists():
            r=subprocess.run([sys.executable,str(w.ROOT/'benchmarks/court-record-exhibits/split.py'),str(derivative),rid,'--out',str(BASE/'records')],capture_output=True,text=True,encoding='utf-8')
            if r.returncode:print('split failed',rid,r.stderr[-300:],flush=True);continue
        spl=w.read_json(dest/'split.json')
        if not spl['exhibits']:continue
        source=w.read_json(dest/'source.json');source.update(source_sha256=row['sha256'],source_file=pathlib.Path(row['path']).name,url=row['url'],landing_url=row['landing_url'],canonical_source_path=str(pathlib.Path(row['path']).relative_to(w.HOME)),retrieved='2026-10-22',origin='machine_test',run_id='affidavit-association-canada-20261022',ocr_derivative=str(derivative.relative_to(w.ROOT)),ocr_derivative_sha256=w.hashlib.sha256(derivative.read_bytes()).hexdigest())
        w.atomic_json(dest/'source.json',source)
        canada_masks.apply(dest,derivative)
        accepted.append(dict(row,record_id=rid,path=str(pathlib.Path(row['path']).relative_to(w.HOME))))
        w.atomic_json(BASE/'prepared.json',accepted)
        print('prepared',rid,len(spl['exhibits']),len(spl['affidavit_pages']),'leaks',len(spl['leak_audit']),flush=True)

if __name__=='__main__':main()
