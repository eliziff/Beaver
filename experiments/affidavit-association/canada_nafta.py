"""Acquire unused public constitutional-trade case records in the canonical corpus."""
import json,pathlib,sys,fitz
import canada_acquire as acquire
store=acquire.store
BASE=acquire.BASE/'nafta'
def main():
    BASE.mkdir(exist_ok=True);db=store.connect();rows=[]
    for num,name in [(2,'Conacher'),(3,'Mahy'),(4,'Darcy'),(5,'Crawford'),(6,'Paulsson'),(7,'MacKenzie')]:
        url=f'https://www.international.gc.ca/trade-agreements-accords-commerciaux/assets/pdfs/disp-diff/cupe-{num:02}.pdf'
        try:
            sha,status=store.fetch(db,url,dict(collection='affidavit-association-expansion',jurisdiction='on',kind='affidavit',label=f'Democracy Watch NAFTA {name}',provenance=json.dumps(dict(origin='machine_test',run_id='affidavit-association-canada-20261022'))))
            if sha:
                f=db.execute('select path,pages from files where sha256=?',(sha,)).fetchone();path=store.HOME/f[0]
                with fitz.open(path) as doc:text='\n'.join(p.get_text() for p in doc)
                row=dict(record_id=f'nafta-{name.lower()}-{sha[:10]}',sha256=sha,path=str(path),url=url,label=f'Democracy Watch NAFTA {name}',pages=f[1],family='democracywatch-nafta-constitutional');rows.append(row)
                (BASE/(name+'.txt')).write_text(text,encoding='utf-8');print(name,status,f[1],len(text),flush=True)
        except Exception as exc:print(name,type(exc).__name__,str(exc)[:100],flush=True)
        (BASE/'sources.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
if __name__=='__main__':main()
