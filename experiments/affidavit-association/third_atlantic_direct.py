"""Materialize directly authored source Gold without claiming runner inference."""
from pathlib import Path
import sys,datetime,re
from third_atlantic_sources import s,O,provenance

def materialize(gold,spec,inspected_images,counterparts):
 rid=gold['record_id'];d=O/'records'/rid;d.mkdir(parents=True,exist_ok=True);assert not(d/'source-gold.json').exists()
 full=lambda sh,pages:'\f'.join((s.views_folder(s.source(sh))/f'page-{n:04}.txt').read_text('utf8')for n in pages)
 def check(v):
  if isinstance(v,dict):
   if v.get('quote') and v.get('source_sha256') and v.get('source_pages') and v.get('quote_verification')!='original_image':
    assert re.sub(r'\s+',' ',v['quote']).strip()in re.sub(r'\s+',' ',full(v['source_sha256'],v['source_pages'])).strip(),v['quote']
   for x in v.values():check(x)
  elif isinstance(v,list):
   for x in v:check(x)
 check(gold);gold.update(author_provenance=provenance(),review_status='pending_independent_review',independent_source_review={'status':'pending'})
 (d/'affidavit.txt').write_text(full(spec['body_sha256'],spec['body_pages']),encoding='utf8');s.dump(d/'source-gold.json',gold);s.dump(d/'source.json',dict(provenance(),source_selection=spec,source_scope='Full source-derived instruments; Gold is independent of model text transcription or export limitations.'))
 manifest=dict(review_status='pending_independent_review',source_gold_sha256=s.sha(d/'source-gold.json'),referring_document_view=dict(text_file='affidavit.txt',text_sha256=s.sha(d/'affidavit.txt')),views=[])
 (d/'model-text').mkdir(exist_ok=True)
 for i,e in enumerate(gold['exhibits'],1):
  parts=e.get('source_files',[])
  if not parts:manifest['views'].append(dict(label=e['label'],eligible=False,reason=e['availability']));continue
  f=d/'model-text'/f'document-{i:03}.txt';f.write_text('\f'.join(full(x['sha256'],x['pages'])for x in parts),encoding='utf8');manifest['views'].append(dict(label=e['label'],file=f'document-{i:03}.pdf',text_file=f.relative_to(d).as_posix(),text_sha256=s.sha(f),source_files=parts,eligible=True,complete=True,reason='Complete source-page native/OCR text; independent original-source and all-page fidelity review pending. No safe PDF projection claimed.'))
 s.dump(d/'model-views.json',manifest);(d/'counterparts').mkdir(exist_ok=True)
 for i,c in enumerate(counterparts,1):
  f=d/'counterparts'/f'counterpart-{i:03}.txt';f.write_text('\f'.join(full(x['sha256'],x['pages'])for x in c['source_files']),encoding='utf8');c.update(text_file=f.relative_to(d).as_posix(),text_sha256=s.sha(f),same_proceeding=True,review_status='pending_independent_review')
 s.dump(d/'distractors.json',counterparts);s.dump(O/'specs'/(rid+'.json'),spec)
 images=[dict(source_sha256=sh,page=n,path=(s.views_folder(s.source(sh))/f'page-{n:04}.png').relative_to(s.OUT).as_posix(),sha256=s.sha(s.views_folder(s.source(sh))/f'page-{n:04}.png'))for sh,pg in inspected_images for n in pg]
 s.dump(d/'author_receipt.json',dict(provenance(),status='source_authored_pending_distinct_review',record_id=rid,source_gold_sha256=s.sha(d/'source-gold.json'),model_views_sha256=s.sha(d/'model-views.json'),full_body_text_sha256=s.sha(d/'affidavit.txt'),directly_inspected_original_images=images,source_selection=spec,recorded_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat()))
 print(rid,s.sha(d/'source-gold.json'),len(gold['exhibits']),len(gold['events']))
