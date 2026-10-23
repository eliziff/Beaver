"""Explicit all-page image OCR where native fonts omit visible legal text."""
import importlib.util,json,sys,concurrent.futures,fitz,hashlib
from pathlib import Path
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory')
def main():
 keys=sys.argv[1:];spec=importlib.util.spec_from_file_location('extract','experiments/affidavit-association/second_regulatory_extract.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);rows=json.loads((O/'acquisitions.json').read_text());audit=[]
 for key in keys:
  row=next(r for r in rows if r['exit_code']==0 and r['output'].split('\t')[1]==key);source=Path(row['output'].strip().split('\t')[-1]);jobs=[(source,n+1,300,True) for n in range(len(fitz.open(source)))];result=[]
  with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
   for i,r in enumerate(pool.map(m.one,jobs)):result.append(r);print(key[:8],i+1,len(jobs),flush=True)
  dest=O/'source-text'/f'{key}.txt';dest.write_text('\f'.join((O/p['text_file']).read_text(encoding='utf-8') for p in result),encoding='utf-8');meta=dict(source_sha256=key,source_path=str(source),pages=result,text_sha256=m.sha(dest),reason='Source images show visible clauses absent from native extraction; all original pages forced through installed OCR, no preview cap or inference call.');(O/'source-text'/f'{key}.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');audit.append(meta)
 (O/'forced-source-ocr-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__':main()
