"""Reconcile every reviewed source label to complete retained source text; no fidelity acceptance."""
import json,datetime
from third_atlantic_sources import s,O,provenance
import sys
sys.path.insert(0,str(s.ROOT/'experiments/affidavit-association'))
from audit_expansion import source_parts
summary=s.read(O/'summary.json')
for rid in summary['accepted']:
 d=O/'records'/rid;gfile=d/'reviewed-source-gold.json';gold=s.read(gfile);mf=d/'model-views.json';old=s.read(mf)
 if old.get('reconciliation',{}).get('reviewed_gold_sha256')==s.sha(gfile):continue
 baseline=d/'review-baselines';baseline.mkdir(exist_ok=True);name='model-views-'+s.sha(mf)+'.json';(baseline/name).write_bytes(mf.read_bytes())
 manifest=dict(review_status='pending_fidelity_review',source_gold_sha256=s.sha(gfile),referring_document_view=old.get('referring_document_view'),views=[],reconciliation=dict(provenance(),reviewed_gold_sha256=s.sha(gfile),prior_manifest_sha256=s.sha(mf),prior_manifest_file='review-baselines/'+name,recorded_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),scope='Every final reviewed canonical label now accounted for; all available source pages materialized in full, with no inference or fidelity acceptance. Original author/reviewer Gold unchanged.'))
 folder=d/'reviewed-model-text';folder.mkdir(exist_ok=True)
 for i,e in enumerate(gold['exhibits'],1):
  parts=source_parts(e)
  if not parts:manifest['views'].append(dict(label=e['label'],eligible=False,reason=e.get('availability','unavailable_in_reviewed_source_inventory')));continue
  text='\f'.join('\f'.join((s.views_folder(s.source(x['sha256']))/f'page-{n:04}.txt').read_text('utf8')for n in x['pages'])for x in parts);f=folder/f'document-{i:03}.txt';f.write_text(text,encoding='utf8');manifest['views'].append(dict(label=e['label'],file=f'document-{i:03}.pdf',text_file=f.relative_to(d).as_posix(),text_sha256=s.sha(f),source_files=parts,eligible=True,complete=True,fidelity_status='pending_independent_all_page_text_fidelity',reason='All original source-bound content pages retained, no character/page clipping. Availability is source-reviewed; model-view fidelity remains pending under the global manifest status.'))
 s.dump(mf,manifest);print(rid,len(manifest['views']))
