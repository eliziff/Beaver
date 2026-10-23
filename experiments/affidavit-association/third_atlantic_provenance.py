"""Index all actual gathered, rejected and failed acquisition/search receipts."""
from datetime import datetime,timezone
from third_atlantic_sources import s,O,provenance
rows=[]
for p in sorted(set((O/'acquisitions').glob('*.json'))|set((s.OUT/'acquisitions').glob('*.json'))):
 r=s.read(p)
 if p.parent.parent!=O and r.get('agent')!='/root/gold_regulatory':continue
 observation=next((v for v in r.get('corpus_observations',[])if(v.get('url')or'').strip()==(r.get('url')or'').strip()),{})
 rows.append(dict(receipt=p.relative_to(s.OUT).as_posix(),receipt_sha256=s.sha(p),source_sha256=r.get('sha256'),url=r.get('url'),final_url=r.get('final_url')or observation.get('final_url'),landing_url=r.get('landing_url'),pages=r.get('pages'),content_type=r.get('content_type'),status=r.get('status'),fetched_at=r.get('fetched_at')or observation.get('fetched_at'),acquisition_checked_at_utc=r.get('acquisition_checked_at_utc'),canonical_path=r.get('canonical_path'),derivative_root=r.get('source_views_root'),observation_basis='Exact original request-URL match after whitespace normalization; raw stored URL and receipt retained. No guessed observation dates.'))
search=[dict(path=p.relative_to(s.OUT).as_posix(),sha256=s.sha(p))for p in sorted(set((O/'search-receipts').glob('*'))|set(O.glob('search-*.json')))if p.is_file()]
s.dump(O/'gathered-source-provenance.json',dict(provenance(),path_base='expansion-3',scope='All lane acquisition receipts and shared acquisition receipts identifying this actual author, including prior indexed sources, listings, rejected candidates and failed requests. Actual receipt bytes are authoritative; absent timestamps/landing URLs are unknown, not fabricated. Retained discovery results do not imply a source was acquired or qualified.',acquisitions=rows,search_receipts=search,candidate_dispositions=dict(path='atlantic-north/candidate-dispositions.json',sha256=s.sha(O/'candidate-dispositions.json')),derivative_methods='Source-view page manifests retain native/OCR method, full projections and actual images. Original legal bytes live once bySHA in canonical corpus. Model transcription fidelity remains separate from source Gold.',recorded_at_utc=datetime.now(timezone.utc).isoformat()))
print(len(rows),'acquisition receipts',len(search),'discovery receipts')
