"""Store explicitly selected Canadian public originals once in corpus_store."""
import json,subprocess,sys
from pathlib import Path
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory')
def main():
 plan=json.loads((O/sys.argv[1]).read_text(encoding='utf-8'));ledger=O/'acquisitions.json';rows=json.loads(ledger.read_text(encoding='utf-8')) if ledger.exists() else []
 for x in plan:
  if any(r['url']==x['url'] and r['exit_code']==0 for r in rows):continue
  r=subprocess.run([sys.executable,'-X','utf8','experiments/legal_pdf_corpus/corpus_store.py','add',x['url'],'--collection','court-record-sources','--jurisdiction',x.get('jurisdiction','ca'),'--kind','court-record','--label',x['label']],capture_output=True,text=True,encoding='utf-8');rows.append(dict(**x,exit_code=r.returncode,output=r.stdout,error=r.stderr));ledger.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(x['label'],r.returncode,r.stdout,flush=True)
if __name__=='__main__':main()
