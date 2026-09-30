"""Reuse public Canadian originals with app acquisition receipts; never user uploads."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from urllib.parse import urlparse
import fitz

OUT = Path(__file__).resolve().parents[2] / 'tmp/pdf-pagination'
candidates = json.loads((OUT / 'canadian-authorities-candidates.json').read_text(encoding='utf-8'))
by_id = {row['id']: row for row in candidates}
root = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts'
database = root / 'LegalData/providers/a2aj/a2aj.sqlite'

def canonical_key(url):
    parsed = urlparse(url or '')
    if parsed.hostname != 'decisions.scc-csc.ca':
        return None
    return parsed.path.rstrip('/').lower()

by_url = {}
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for ident, en, fr in connection.execute(
            "select id,url_en,url_fr from document where dataset='SCC' and doc_type='cases'"):
        if ident in by_id:
            for url in [en, fr]:
                if key := canonical_key(url):
                    by_url.setdefault(key, set()).add(ident)

rows = {}
for row in json.loads((OUT / 'publisher-cached.json').read_text(encoding='utf-8')):
    candidate = by_id.get(row['id'])
    if candidate and row['provider'] == 'a2aj' and row['origin'] == 'original':
        rows[row['sha256']] = dict(row, **{key: candidate[key] for key in
                                  ['jurisdiction', 'court', 'reporter', 'year', 'stratum']})
added = []
def include_receipt(receipt, pdf, record):
    if (record.get('provider') != 'a2aj' or record.get('status') != 'downloaded'
            or not canonical_key(record.get('url'))):
        return
    key = canonical_key(record.get('canonicalUrl') or record.get('canonical_url'))
    matches = by_url.get(key, set())
    digest = record.get('source_sha256', '')
    if (len(matches) != 1 or not re.fullmatch('[a-f0-9]{64}', digest)
            or digest in rows or not pdf.is_file()):
        return
    candidate = by_id[next(iter(matches))]
    citation = candidate['citation']
    reporter = re.search(r'\b(?:S\.?\s*C\.?\s*R\.?|R\.?\s*C\.?\s*S\.?)\s+(\d+)\s*$', citation)
    if not reporter or hashlib.sha256(pdf.read_bytes()).hexdigest() != digest:
        return
    destination = OUT / 'authorities' / pdf.name
    shutil.copyfile(pdf, destination)
    with fitz.open(destination) as document:
        count = len(document)
    source = record.get('source') or {}
    rows[digest] = dict(candidate, sha256=digest, path=str(destination), origin='original',
                        category='authorities', page_count=count, title=record.get('title'),
                        url=record['url'], sourceReceipt=str(receipt), split='validation',
                        citations=list(dict.fromkeys(filter(None, [source.get('citation'),
                                       source.get('alternateCitation'), citation]))),
                        starts=[int(reporter[1])])
    added.append({'citation': citation, 'sha256': digest, 'sourceReceipt': str(receipt)})

for base in [root / 'MikeCanada/data-20260904', root / 'LegalData/apps/mike/library-current',
             root / 'LegalData/apps/mike/library-v9']:
    for receipt in (base / 'projections/v1/source-pdf').glob('*.json'):
        record = json.loads(receipt.read_text(encoding='utf-8'))
        digest = record.get('source_sha256', '')
        pdf = base / 'projections/v1/content/pdf' / digest[:2] / (digest + '.pdf')
        include_receipt(receipt, pdf, record)
cache = root / 'LegalData/cache/a2aj/pdf'
for receipt in (cache / 'requests').glob('*.json'):
    record = json.loads(receipt.read_text(encoding='utf-8'))
    digest = record.get('source_sha256', '')
    include_receipt(receipt, cache / 'blobs' / (digest + '.pdf'), record)
(OUT / 'canadian-cached-manifest.json').write_text(json.dumps(list(rows.values()), indent=2), encoding='utf-8')
print(json.dumps({'cached_public_originals': len(rows), 'added': added}))
