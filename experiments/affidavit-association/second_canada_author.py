"""Materialize source-authored Canadian proposals; never invoke inference or accept gold.

Private specifications and original-source page transcripts belong to expansion-2/canada.
Original PDFs remain in the shared corpus; this helper creates complete text views only.
"""
from pathlib import Path
import datetime, hashlib, json, os, re
import fitz

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/local-data/affidavit-association/expansion-2/canada'
HOME = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData'
PROVENANCE = dict(origin='machine_test', method='codex_collaboration', agent='/root/gold_canada',
                  run_id='7a71d3b5-b4a5-4f3e-a79e-9204111ce7d3',
                  job_id='f225eab6-c77c-4aec-8be5-6edbb3c6dfc0', runner_call=False)

def digest(data): return hashlib.sha256(data).hexdigest()
def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='')
def textfile(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding='utf-8', newline='')
    return digest(path.read_bytes())

def source(prefix):
    rows=json.loads((OUT/'local-source-candidates.json').read_text(encoding='utf-8'))
    matches=[r for r in rows if r['sha256'].startswith(prefix)]
    assert matches, prefix
    r=matches[0].copy(); r['canonical_path']=str(HOME/r['path'])
    assert digest(Path(r['canonical_path']).read_bytes()) == r['sha256']
    return r

def pages_for(r, derivative=None):
    cache=OUT/'source-ocr'/r['sha256']
    if (cache/'coverage.json').exists():
        return [(cache/f'{n:04}.txt').read_text(encoding='utf-8') for n in range(1,r['pages']+1)]
    pdf=Path(derivative) if derivative else Path(r['canonical_path'])
    with fitz.open(pdf) as doc:
        return [p.get_text(sort=False) for p in doc]

def materialize(spec):
    r=source(spec['source']); rid=spec['record_id']; dest=OUT/'records'/rid
    assert not (dest/'source-gold.json').exists(), 'Frozen author gold must not be overwritten'
    pages=pages_for(r, spec.get('ocr_derivative'))
    assert len(pages)==r['pages']
    body_pages=spec['body_pages']; body='\f\n'.join(pages[p-1] for p in body_pages)
    assert body.strip()
    transcript=[]
    for p,t in enumerate(pages,1):
        sh=textfile(OUT/'source-transcripts'/r['sha256']/f'{p:04}.txt',t)
        transcript.append(dict(page=p,text_sha256=sh,chars=len(t)))
    bodysha=textfile(dest/'affidavit.txt',body)
    reference=dict(source_files=[dict(sha256=r['sha256'],url=r['url'],pages=body_pages)],
                   text_sha256=bodysha, completeness='complete_referring_body')
    exhibits=[]; views=[]; removals=[]
    for item in spec['exhibits']:
        target=source(item['target_source']) if item.get('target_source') else r
        target_pages=pages_for(target) if item.get('target_source') else pages
        label=item['label']; ps=item.get('pages',[]); raw='\f\n'.join(target_pages[p-1] for p in ps)
        clean=raw
        for old in item.get('remove_exact',[]):
            assert clean.count(old)==1, (rid,label,repr(old),clean.count(old))
            clean=clean.replace(old,'',1)
            removals.append(dict(label=label,exact_removed=old,reason='outer exhibit certification only'))
        if 'model_text_override' in item:
            clean=item['model_text_override']
            removals.append(dict(label=label,reason='Source-image checked manual transcription of complete legible intrinsic text',
                                 raw_ocr_sha256=digest(raw.encode()),manual_text_sha256=digest(clean.encode()),
                                 evidence=item['model_text_evidence']))
        filename='document-'+digest((rid+'|'+label).encode())[:12]
        sha=textfile(dest/'files'/(filename+'.txt'),clean)
        refs=[]
        for ref in item['references']:
            quote=ref['quote']; page=ref['page']
            assert quote in pages[page-1], (rid,label,page,quote)
            refs.append(dict(paragraph=ref.get('paragraph'),quote=quote,source_sha256=r['sha256'],source_pages=[page]))
        exhibits.append(dict(label=label,description=item['description'],kind=item.get('kind','other'),
                             references=refs,reference_source_sha256=r['sha256'],
                             reference_source_pages=sorted({x['page'] for x in item['references']}),
                             association_namespace=item.get('namespace','own_attached_exhibit'),
                             source_sha256=target['sha256'],source_url=target['url'],source_pages=ps,
                             source_cover_pages=item.get('cover_pages',[]),availability=item.get('availability','available_public'),
                             date=item.get('date'),date_precision=item.get('date_precision','unknown'),
                             source_excerpt=item.get('source_excerpt',False),file=filename+'.pdf'))
        views.append(dict(label=label,file=filename+'.pdf',text_file='files/'+filename+'.txt',
                          text_sha256=sha,eligible=bool(ps),source_sha256=target['sha256'],source_pages=ps,
                          reason=item.get('unavailable_reason') if not ps else 'Complete original filed content pages; text-only projection, physical PDF withheld',
                          modality=item.get('modality','text'),complete=True))
    events=[]
    for i,e in enumerate(spec.get('events',[]),1):
        assert e['quote'] in pages[e['page']-1], (rid,e)
        events.append(dict(event_id=f'e{i:03}',date=e.get('date'),end_date=e.get('end_date'),
                           date_precision=e.get('date_precision','day' if e.get('date') else 'unknown'),
                           event=e['event'],summary=e['event'],quote=e['quote'],paragraph=e.get('paragraph'),
                           source_sha256=r['sha256'],source_pages=[e['page']],
                           exhibits=e.get('labels',[]),attribution='Affiant statement; not an adjudicated finding'))
    statements=[]
    for p in body_pages:
        t=pages[p-1]
        matches=list(re.finditer(r'(?m)^\s*(\d{1,3})\.\s*$',t))
        for i,m in enumerate(matches):
            end=matches[i+1].start() if i+1<len(matches) else len(t)
            quote=t[m.end():end].strip()
            if quote:
                statements.append(dict(paragraph=int(m[1]),source_sha256=r['sha256'],source_pages=[p],quote=quote))
    gold=dict(record_id=rid,country='CA',jurisdiction=spec['jurisdiction'],court=spec['court'],
              court_file=spec['court_file'],family=spec['family'],proceeding=spec['proceeding'],
              subject=spec['subject'],document=spec.get('document','Affidavit'),deponent=spec['deponent'],
              document_type=spec.get('document_type','affidavit'),
              sworn_date=spec.get('sworn_date'),sworn_date_notes=spec.get('sworn_date_notes'),
              referring_document=reference,exhibits=exhibits,source_exhibits=exhibits,
              events=events,source_events=events,source_attachments=spec.get('source_attachments',[]),
              source_statements=statements,
              source_discrepancies=spec.get('discrepancies',[]),
              coverage=dict(body_pages=body_pages,body_complete=True,attachment_inventory_complete=True,
                            all_original_pages=len(pages),source_transcript_pages=transcript,
                            narrative_scope=spec.get('narrative_scope','Full referring body read; events capture material factual history and attachment chronology; opinions remain attributed.')),
              provenance={**PROVENANCE,'authored_at':datetime.datetime.now(datetime.timezone.utc).isoformat()},
              author_provenance=PROVENANCE,independent_source_review={'status':'pending'},
              review_status='pending_independent_review')
    dump(dest/'source.json',dict(**r,origin='machine_test',run_id=PROVENANCE['run_id'],
                               referring_document_pages=body_pages,historical_origin='public_source',
                               ocr_derivative=spec.get('ocr_derivative')))
    dump(dest/'source-gold.json',gold)
    dump(dest/'model-views.json',dict(review_status='pending_independent_review',
          source_gold_sha256=digest((dest/'source-gold.json').read_bytes()),views=views,
          referring_document_view=dict(text_file='affidavit.txt',text_sha256=bodysha),
          physical_pdf_export='withheld; original immutable PDF remains canonical',
          provenance=PROVENANCE))
    dump(dest/'author-receipt.json',dict(**PROVENANCE,source_sha256=r['sha256'],
          source_gold_sha256=digest((dest/'source-gold.json').read_bytes()),
          source_page_transcripts=transcript,source_boundary_pages_for_review=spec.get('visual_pages',[]),
          actual_visual_views=spec.get('actual_visual_views',[]),
          exact_model_text_removals=removals,author_assertion='Source-authored proposal; independent review not yet performed'))
    dump(dest/'difficulty.json',dict(family=spec['family'],reasons=spec['difficulty'],
          same_proceeding_distractors=spec.get('distractors',[])))
    return rid

if __name__=='__main__':
    specs=json.loads((OUT/'author-specs.json').read_text(encoding='utf-8'))
    excluded=json.loads((OUT/'excluded-records.json').read_text(encoding='utf-8')) if (OUT/'excluded-records.json').exists() else {}
    done=[]
    for spec in specs:
        if spec['record_id'] in excluded: continue
        if not (OUT/'records'/spec['record_id']/'source-gold.json').exists(): materialize(spec)
        done.append(spec['record_id'])
    status=json.loads((OUT/'status.json').read_text(encoding='utf-8'))
    status.update(stage='authoring',authored_records=done,independently_accepted=[],excluded_records=excluded)
    dump(OUT/'status.json',status)
    print(json.dumps(dict(authored=len(done),ids=done)))
