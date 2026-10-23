"""Resolve direct-author manifest hashes honestly after canonical review updates."""
import json,hashlib,os
from datetime import datetime,timezone
from third_atlantic_sources import s,O,provenance
rows=[]
for d in sorted((O/'records').iterdir()):
 receipt=d/'author_receipt.json'
 if not receipt.exists():continue
 r=s.read(receipt);expected=r.get('model_views_sha256')
 if not expected:continue
 candidates=[d/'model-views.json',*d.rglob('model-views-*.json'),*d.rglob('author-model-views.json')]
 existing=next((p for p in candidates if p.is_file()and s.sha(p)==expected),None)
 if existing:
  rows.append(dict(record_id=d.name,expected_sha256=expected,status='exact_existing_bytes_retained',path=existing.relative_to(O).as_posix()));continue
 g=s.read(d/'source-gold.json')
 manifest=dict(review_status='pending_independent_review',source_gold_sha256=s.sha(d/'source-gold.json'),referring_document_view=dict(text_file='affidavit.txt',text_sha256=s.sha(d/'affidavit.txt')),views=[])
 for i,e in enumerate(g['exhibits'],1):
  parts=e.get('source_files',[])
  if not parts:manifest['views'].append(dict(label=e['label'],eligible=False,reason=e['availability']));continue
  f=d/'model-text'/f'document-{i:03}.txt'
  manifest['views'].append(dict(label=e['label'],file=f'document-{i:03}.pdf',text_file=f.relative_to(d).as_posix(),text_sha256=s.sha(f),source_files=parts,eligible=True,complete=True,reason='Complete source-page native/OCR text; independent original-source and all-page fidelity review pending. No safe PDF projection claimed.'))
 if d.name=='an3-pe-richard-notice-20191105':
  # This earlier owned author helper used its own literal one-target schema.
  e=g['exhibits'][0];f=d/'model-text/document-001.txt'
  manifest['views']=[dict(label=e['label'],file='document-001.pdf',text_file='model-text/document-001.txt',text_sha256=s.sha(f),eligible=True,complete=True,source_files=e['source_files'],reason='Complete original-page OCR; independent source and transcription fidelity review pending; no redacted PDF export claimed.')]
 raw=(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').replace('\n',os.linesep).encode('utf8');actual=hashlib.sha256(raw).hexdigest()
 row=dict(record_id=d.name,expected_sha256=expected,reconstructed_sha256=actual,status='exact_hash_reconstruction'if actual==expected else 'unresolved_original_manifest_bytes',method='Reproduced the existing direct-author materializer serialization from immutable author Gold and retained complete author target files. This is a newly recorded reconstruction, not a claim of an earlier historical snapshot.')
 if actual==expected:
  p=d/'author-baselines/reconstructed-model-views.json';p.parent.mkdir(exist_ok=True);p.write_bytes(raw);row['path']=p.relative_to(O).as_posix()
 rows.append(row)
s.dump(O/'author-model-view-history.json',dict(provenance(),scope='Only direct-author receipts that actually recorded an initial model-view SHA. CLI author receipts with no such historical binding are not given invented hashes. Canonical reviewed views and all Gold unchanged.',records=rows,recorded_at_utc=datetime.now(timezone.utc).isoformat()))
print(len(rows),'direct-author initial manifest hashes:',{status:sum(x['status']==status for x in rows)for status in sorted({x['status']for x in rows})})
