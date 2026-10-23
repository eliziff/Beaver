"""Materialize explicit source-grounded author annotations; no model calls."""
from pathlib import Path
import json,os,hashlib,fitz,re,sys
from datetime import datetime,timezone
O=Path('benchmarks/local-data/affidavit-association/expansion-2/regulatory');H=Path(os.environ['LOCALAPPDATA'])/'OpenLegalData';RUN='7a71d3b5-b4a5-4f3e-a79e-9204111ce7d3';JOB='44137270-8c26-487f-b5a0-086b66a65cfc'
read=lambda p:json.loads(p.read_text(encoding='utf-8'));sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();norm=lambda s:re.sub(r'\s+',' ',s).strip()
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def main():
 plan=read(O/sys.argv[1]);rid=plan['record_id'];d=O/'records'/rid;d.mkdir(parents=True,exist_ok=True);gp=d/'source-gold.json';assert not gp.exists(),'Frozen author Gold already exists; explicit repair requires a sibling audit.'
 acq=next(r for r in read(O/'acquisitions.json') if r['exit_code']==0 and r['output'].split('\t')[1]==plan['source_sha256']);src=Path(acq['output'].strip().split('\t')[-1]);assert sha(src)==plan['source_sha256'];doc=fitz.open(src);sourcepages=plan['affidavit_pages'];extraction=[]
 def source(key):
  r=next(r for r in read(O/'acquisitions.json') if r['exit_code']==0 and r['output'].split('\t')[1]==key);path=Path(r['output'].strip().split('\t')[-1]);assert sha(path)==key;return r,path
 def text(pages,key=None):
  key=key or plan['source_sha256'];targetdoc=doc if key==plan['source_sha256'] else fitz.open(source(key)[1])
  out=[]
  for n in pages:
   raw=targetdoc[n-1].get_text();cached=O/'source-text'/key/f'{n:04}.txt';body=cached.read_text(encoding='utf-8') if cached.exists() else raw
   assert cached.exists() or len(body.strip())>30 or not targetdoc[n-1].get_image_info(),f'Unprocessed scan on source page {n}'
   policy=plan.get('text_policy','historical_combined')
   if policy=='ocr_only':
    op=cached.with_name(f'{n:04}.ocr.txt');assert op.exists();body=op.read_text(encoding='utf-8')
   elif policy=='native_or_scan_ocr':
    op=cached.with_name(f'{n:04}.ocr.txt');scan=any(fitz.Rect(x['bbox']).get_area()>targetdoc[n-1].rect.get_area()*.60 for x in targetdoc[n-1].get_image_info());bad=sum(ord(c)<32 and c not in '\r\n\t\f' for c in raw)>=5;body=op.read_text(encoding='utf-8') if op.exists() and (scan or bad or len(raw.strip())<100) else raw
   override=plan.get('text_page_overrides',{}).get(f'{key}:{n}')
   if override:body=(O/override).read_text(encoding='utf-8')
   out.append(body);extraction.append(dict(source_sha256=key,source_page=n,native_characters=len(raw),text_policy=policy,cached_original_derived_text_file=str(cached.relative_to(O)) if cached.exists() else None))
  return '\f'.join(out)
 aff=d/'affidavit.txt';aff.write_text(text(sourcepages),encoding='utf-8');origin=dict(source_sha256=plan['source_sha256'],source_url=acq['url'],canonical_source_path=str(src.relative_to(H)),source_pages=sourcepages,full_affidavit_text_file='affidavit.txt',full_affidavit_text_sha256=sha(aff));g={k:v for k,v in plan.items() if k not in ['affidavit_pages','source_sha256','distractors','inspected_image_pages','boundary_notes']};g.update(country='CA',origin='machine_test',run_id=RUN,author_provenance=dict(method='codex_collaboration',job_id=JOB,run_id=RUN,agent='/root/gold_regulatory',runner_call=False,authored_at_utc=datetime.now(timezone.utc).isoformat(),independent_review_status='pending'),original_referring_instrument=origin,independent_source_review={'status':'pending','require_different_reviewer':True});views=[]
 for e in g['exhibits']:
  for ref in e['references']:
   assert norm(ref['quote']) in norm(text(ref['source_pages'])),ref['quote'];ref['source']=dict(sha256=plan['source_sha256'],pages=ref['source_pages']);ref.pop('source_pages')
  if e.pop('unavailable_identified_publication',False):
   e.setdefault('source_files',[]);views.append(dict(label=e['label'],eligible=False,reason=e['availability_reason'],omission_reason=e['availability_reason'],source_pages=[]));continue
  key=e.get('source_sha256',plan['source_sha256']);er,ep=source(key);removals=e.pop('model_prefix_removals',[]);eligible=e.pop('model_eligible',True);viewreason=e.pop('model_reason',None);e.update(source_sha256=key,source_url=er['url'],availability=e.get('availability','public_filed_content_available'),source_files=[dict(sha256=key,url=er['url'],path=str(ep),pages=e['source_pages'],cover_pages=[e['source_cover_page']] if e.get('source_cover_page') else [])]);content=text(e['source_pages'],key);rawdest=d/'source-exhibits'/f'{e["label"]}.txt';rawdest.parent.mkdir(exist_ok=True);rawdest.write_text(content,encoding='utf-8');e.update(source_text_file=str(rawdest.relative_to(d)),source_text_sha256=sha(rawdest));modelparts=content.split('\f')
  for removal in removals:
   i=e['source_pages'].index(removal['source_page']);assert modelparts[i].count(removal['text'])==1;modelparts[i]=modelparts[i].replace(removal['text'],'',1)
  filekey=hashlib.sha256((key+str(e['source_pages'])).encode()).hexdigest()[:16];dest=d/'files'/f'doc-{filekey}.txt';dest.parent.mkdir(exist_ok=True);dest.write_text('\f'.join(modelparts),encoding='utf-8');views.append(dict(label=e['label'],file=f'doc-{filekey}.pdf',text_file=dest.relative_to(d).as_posix(),text_sha256=sha(dest),eligible=eligible,pdf_available=False,pdf_eligible=False,reason=viewreason or 'Complete original filed content pages; only source-verified standalone outer cover and explicitly documented binding prefixes omitted; all intrinsic text, pagination, Unicode and dates preserved. No preview or model-size cap.',source_sha256=key,source_pages=e['source_pages'],exact_outer_binding_text_removals=removals))
 for ev in g['events']:
  key=ev.get('source_sha256',plan['source_sha256']);quoted=text(ev['source_pages'],key);assert norm(ev['quote']) in norm(quoted),ev['quote'];ev['source']=dict(sha256=key,pages=ev.pop('source_pages'))
 write(d/'source.json',dict(origin='machine_test',run_id=RUN,country='CA',source_sha256=sha(src),canonical_source_path=str(src.relative_to(H)),url=acq['url'],acquisition_ledger='../../acquisitions.json',affidavit_pages=sourcepages,full_original_pages=len(doc),boundary_notes=plan['boundary_notes']));write(gp,g);write(d/'model-views.json',dict(origin='machine_test',run_id=RUN,review_status='pending',source_gold_sha256=sha(gp),views=views));write(d/'distractors.json',dict(origin='machine_test',run_id=RUN,documents=[dict(x,same_proceeding=x.get('same_proceeding',True),source_sha256=x.get('source_sha256',sha(src)),source_url=x.get('source_url',acq['url']),canonical_source_path=x.get('canonical_source_path',str(src.relative_to(H)))) for x in plan['distractors']]));images=d/'source-images';images.mkdir(exist_ok=True)
 for n in plan['inspected_image_pages']:doc[n-1].get_pixmap(dpi=100,alpha=False).save(images/f'{n:04}.png')
 write(d/'author-receipt.json',dict(origin='machine_test',run_id=RUN,job_id=JOB,method='codex_collaboration',agent='/root/gold_regulatory',runner_call=False,source_gold_sha256=sha(gp),source_sha256=sha(src),full_original_pages=len(doc),original_referring_body_pages=sourcepages,source_inventory_labels=[e['label'] for e in g['exhibits']],all_available_labels_covered=True,model_view_files=[dict(file=v['text_file'],sha256=v['text_sha256'],pages=v['source_pages']) for v in views if v.get('text_file')],source_boundary_images=[dict(source_page=n,file=f'source-images/{n:04}.png',sha256=sha(images/f'{n:04}.png')) for n in plan['inspected_image_pages']],extraction_pages=extraction,boundary_notes=plan['boundary_notes'],status='authored_pending_independent_review'));print(rid,len(g['exhibits']),len(g['events']),sha(gp))
def refresh_status():
 p=O/'author-status.json';status=read(p) if p.exists() else {};files=sorted((O/'records').glob('*/source-gold.json'));status.update(authored=len(files),authored_ids=[p.parent.name for p in files],packets=[dict(record_id=p.parent.name,source_gold_path=p.as_posix(),source_gold_sha256=sha(p),status='authored_pending_distinct_peer_review') for p in files]);write(p,status)
if __name__=='__main__':main();refresh_status()
