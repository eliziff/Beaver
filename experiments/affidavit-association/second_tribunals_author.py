"""Materialize private, directly source-authored specifications without inference."""
import json,sys,re
from datetime import datetime,timezone
from pathlib import Path
from second_tribunals_sources import OUT,sha,dump

def build(specpath):
 s=json.loads(Path(specpath).read_text(encoding='utf8'));digest=s.pop('source_digest');source=json.loads((OUT/'sources'/f'{digest}.json').read_text(encoding='utf8'))
 folder=OUT/'records'/s['record_id'];folder.mkdir(parents=True,exist_ok=True)
 cache=OUT/'source-text'/digest
 def full(pages):
  return '\n\n'.join((cache/f'page-{p:04}.txt').read_text(encoding='utf8') for p in pages)
 def target_text(e):
  targetcache=OUT/'source-text'/e.get('source_digest',digest)
  return '\n\n'.join((targetcache/f'page-{p:04}.txt').read_text(encoding='utf8') for p in e['source_pages'])
 remove=s.pop('model_text_remove_exact_lines',[])
 def project(text):return '\n'.join(line for line in text.splitlines() if line.strip() not in remove)
 bodypages=s.pop('body_pages');body=full(bodypages);(folder/'affidavit.txt').write_text(body,encoding='utf8')
 (folder/'model-affidavit.txt').write_text(project(body),encoding='utf8')
 s.update(country='CA',origin='machine_test',author_provenance={'origin':'machine_test','run_id':'7a71d3b5-b4a5-4f3e-a79e-9204111ce7d3','method':'codex_collaboration','agent':'/root/gold_us','job_id':'d8da3bbf-725b-47f9-9d81-3a4f0062c0e4','runner_call':False},independent_source_review={'status':'pending'})
 s['original_referring_instrument']={'source_sha256':digest,'source_url':source['url'],'canonical_source_path':source['canonical_path'],'source_pages':bodypages,'full_affidavit_text_file':'affidavit.txt','full_affidavit_text_sha256':sha(folder/'affidavit.txt')}
 views=[]
 for i,e in enumerate(s['exhibits']):
  for ref in e.get('references',[]):
   assert re.sub(r'\s+',' ',ref['quote']).strip() in re.sub(r'\s+',' ',body),ref
  if e.get('availability') not in [None,'public_attached','public_external']:
   views.append({'label':e['label'],'eligible':False,'reason':e.get('unavailability_reason',e['availability'])});continue
  targetdigest=e.get('source_digest',digest);targetsource=json.loads((OUT/'sources'/f'{targetdigest}.json').read_text(encoding='utf8'))
  pages=e['source_pages'];text=target_text(e);projected=project(text);replacements=e.pop('model_text_replacements',[])
  for replacement in replacements:
   assert projected.count(replacement['before'])==1,replacement
   projected=projected.replace(replacement['before'],replacement.get('after',''),1)
  relative=f'model-text/document-{i+1:03}.txt';target=folder/relative;target.parent.mkdir(exist_ok=True);target.write_text(projected,encoding='utf8')
  rawname=e['label'] if re.fullmatch(r'[A-Za-z0-9.-]+',e['label']) else f'instrument-{i+1:03}'
  raw=folder/f'source-exhibits/{rawname}.txt';raw.parent.mkdir(exist_ok=True);raw.write_text(text,encoding='utf8')
  e.update(source_sha256=targetdigest,source_url=targetsource['url'],canonical_source_path=targetsource['canonical_path'],source_text_file=raw.relative_to(folder).as_posix(),source_text_sha256=sha(raw),availability=e.get('availability','public_attached'))
  e.pop('source_digest',None)
  for ref in e.get('references',[]):
   assert re.sub(r'\s+',' ',ref['quote']).strip() in re.sub(r'\s+',' ',body),ref
  views.append({'label':e['label'],'file':f'document-{i+1:03}.pdf','text_file':relative,'text_sha256':sha(target),'eligible':True,'modality':'complete_original_text','projection_exact_replacements':replacements,'reason':'Complete filed content pages; any separate outer exhibit certification cover omitted. Only explicitly logged extrinsic stamp spans removed. Original pagination and intrinsic labels retained. PDF projection withheld; original immutable PDF remains available.'})
 for i,e in enumerate(s.get('events',[])):
  e.setdefault('id',f'e{i+1:02}')
  quote=e.get('quote','');evidence=full([e['source_page']])if e.get('evidence_type')=='exhibit'else body
  assert not quote or re.sub(r'\s+',' ',quote).strip() in re.sub(r'\s+',' ',evidence),e
 distractors=[]
 for i,item in enumerate(s.get('same_proceeding_distractors',[])):
  texts=OUT/'source-text'/item['source_sha256'];relative=f'model-text/counterpart-{i+1:03}.txt';target=folder/relative
  target.write_text('\n\n'.join((texts/f'page-{p:04}.txt').read_text(encoding='utf8') for p in item['source_pages']),encoding='utf8')
  distractors.append({'file':f'counterpart-{i+1:03}.pdf','text_file':relative,'text_sha256':sha(target),'source_sha256':item['source_sha256'],'source_pages':item['source_pages'],'eligible':True})
 source=dict(source);source['jurisdiction']=s['jurisdiction'];source['country']='CA'
 dump(folder/'source.json',source);dump(folder/'source-gold.json',s)
 dump(folder/'model-views.json',{'review_status':'pending','source_gold_sha256':sha(folder/'source-gold.json'),'projection_remove_exact_lines':remove,'referring_document_view':{'text_file':'model-affidavit.txt','text_sha256':sha(folder/'model-affidavit.txt')},'views':views,'same_proceeding_distractor_views':distractors})
 evidence=[]
 for p in sorted(set(bodypages+[n for e in s['exhibits'] if e.get('source_sha256')==digest for n in e.get('source_pages',[])])):
  t=cache/f'page-{p:04}.txt';evidence.append({'source_page':p,'text_sha256':sha(t),'extraction':json.loads(t.with_suffix('.json').read_text(encoding='utf8'))})
 imagefolder=OUT/'source-views'/digest
 external=[]
 for e in s['exhibits']:
  if e.get('source_sha256') and e['source_sha256']!=digest:
   for p in e['source_pages']:
    t=OUT/'source-text'/e['source_sha256']/f'page-{p:04}.txt';external.append({'source_sha256':e['source_sha256'],'source_page':p,'text_sha256':sha(t),'extraction':json.loads(t.with_suffix('.json').read_text(encoding='utf8'))})
 external_images=[p for h in {e.get('source_sha256') for e in s['exhibits']} - {digest,None} for p in (OUT/'source-views'/h).glob('*.png')]
 dump(folder/'author_receipt.json',{'origin':'machine_test','method':'codex_collaboration','agent':'/root/gold_us','job_id':s['author_provenance']['job_id'],'run_id':s['author_provenance']['run_id'],'runner_call':False,'finished_utc':datetime.now(timezone.utc).isoformat(),'source_gold_sha256':sha(folder/'source-gold.json'),'source_sha256':digest,'source_text_views':evidence,'external_target_text_views':external,'rendered_original_views':[{'path':str(p.relative_to(OUT)),'sha256':sha(p)} for p in imagefolder.glob('*.png')],'external_rendered_original_views':[{'path':str(p.relative_to(OUT)),'sha256':sha(p)} for p in sorted(external_images)],'render_note':'Rendered artifacts are hash-bound for replay; this inventory does not assert every rendered page was visually inspected. Complete source text and critical boundary images were read during direct authoring.','status':'author_ready_pending_independent_review'})
 print(s['record_id'],len(s['exhibits']),len(s.get('events',[])))
if __name__=='__main__':build(sys.argv[1])
