"""Atlantic/northern discovery, source receipts and uncut original page views."""
from pathlib import Path
from datetime import datetime,timezone
import json,sys,os,hashlib,sqlite3,re
ROOT=Path(__file__).resolve().parents[2]
B=ROOT/'benchmarks/local-data/affidavit-association/expansion-3'
O=B/'atlantic-north';sys.path.insert(0,str(B));import source_tools as s
RUN='b29b8749-30fa-4827-96a1-6ee61137c7b6';JOB='d9e402ab-79fd-449c-8c77-e52563749b88'
def provenance():return dict(origin='machine_test',run_id=RUN,job_id=JOB,agent='/root/gold_regulatory',method='codex_collaboration',runner_call=False)
def acquire(item):
 item=dict(item,**provenance(),source_views_root='atlantic-north/source-views')
 result=s.acquire(item);s.dump(O/'acquisitions'/(hashlib.sha256(item['url'].encode()).hexdigest()+'.json'),result);return result
def local(prefix):
 db=s.cs.connect();db.row_factory=sqlite3.Row
 try:
  rows=[dict(x) for x in db.execute('select d.*,f.path as canonical_path,f.pages,f.content_type,f.bytes from documents d join files f using(sha256) where d.sha256 like ?',(prefix+'%',))]
  assert rows,prefix;row=dict(rows[0]);row.update(provenance());row.update(original_path=str(s.cs.HOME/row['canonical_path']),source_views_root='atlantic-north/source-views',status='existing_local_source',acquisition_checked_at_utc=datetime.now(timezone.utc).isoformat(),corpus_observations=rows)
  assert s.sha(Path(row['original_path']))==row['sha256'];s.dump(O/'acquisitions'/(hashlib.sha256((row.get('url') or row['sha256']).encode()).hexdigest()+'.json'),row);return row
 finally:db.close()
if __name__=='__main__':
 action=sys.argv[1]
 if action=='acquire':
  for item in s.read(Path(sys.argv[2])):
   try:r=acquire(item);print(json.dumps({k:r.get(k) for k in ['label','sha256','pages','status']},ensure_ascii=False),flush=True)
   except Exception as e:print('FAILED',item['url'],str(e),flush=True)
 elif action=='local':
  for prefix in sys.argv[2:]:
   r=local(prefix);print(r['sha256'],r['pages'],r['label'])
 elif action=='extract':
  for prefix in sys.argv[2:]:
   r=s.source(prefix);print(prefix,len(s.extract(r)),flush=True)
 elif action=='show':
  r=s.source(sys.argv[2]);folder=s.views_folder(r)
  for n in map(int,sys.argv[3:]):print(f'\nORIGINAL {r["sha256"]} PHYSICAL {n}\n'+(folder/f'page-{n:04}.txt').read_text(encoding='utf8'))
