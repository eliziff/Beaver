"""Add SHA-verified public A2AJ PDF receipts to the diverse Canadian sample."""
import collections
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
folder = OUT / 'canadian-diverse-originals'
manifest = folder / 'manifest.json'
rows = json.loads(manifest.read_text(encoding='utf-8'))
known = {row['sha256'] for row in rows if row.get('outcome') == 'original'}
reporter = {row['sha256'] for row in json.loads(
    (OUT / 'canadian-cached-manifest.json').read_text(encoding='utf-8'))}
root = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts'

def key(url):
    parsed = urlparse(url or '')
    return (parsed.hostname, parsed.path.rstrip('/').lower()) if parsed.hostname else None

stores = [
    (root / 'LegalData/cache/a2aj/pdf/requests', root / 'LegalData/cache/a2aj/pdf/blobs'),
    (root / 'MikeCanada/data-20260904/projections/v1/source-pdf',
     root / 'MikeCanada/data-20260904/projections/v1/content/pdf'),
    (root / 'LegalData/apps/mike/library-v9/projections/v1/source-pdf',
     root / 'LegalData/apps/mike/library-v9/projections/v1/content/pdf'),
]
pending = []
for receipts, blobs in stores:
    for receipt in receipts.glob('*.json'):
        record = json.loads(receipt.read_text(encoding='utf-8'))
        canonical = record.get('canonicalUrl') or record.get('canonical_url')
        digest = record.get('source_sha256', '')
        if (record.get('provider') != 'a2aj' or record.get('status') != 'downloaded'
                or key(canonical) is None or key(record.get('url')) is None
                or key(record['url'])[0] != key(canonical)[0]
                or not re.fullmatch('[a-f0-9]{64}', digest) or digest in known):
            continue
        pending.append((receipt, blobs, record, canonical, digest))

wanted = {key(canonical) for _, _, _, canonical, _ in pending}
by_url = collections.defaultdict(set)
documents = {}
database = root / 'LegalData/providers/a2aj/a2aj.sqlite'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for row in connection.execute(
            "select id,dataset,citation_en,citation_fr,citation2_en,citation2_fr,"
            "name_en,name_fr,document_date_en,document_date_fr,url_en,url_fr "
            "from document where doc_type='cases'"):
        for url in row[-2:]:
            if (canonical := key(url)) in wanted:
                by_url[canonical].add(row[0])
                documents[row[0]] = row

added = []
for receipt, blobs, record, canonical, digest in pending:
    matches = by_url.get(key(canonical), set())
    if len(matches) != 1 or digest in known:
        continue
    ident = next(iter(matches))
    if digest in reporter and ident != 193662:  # Jordan also tests the general PDF UI.
        continue
    pdf = (blobs / (digest + '.pdf') if blobs.name == 'blobs' else
           blobs / digest[:2] / (digest + '.pdf'))
    if not pdf.is_file() or hashlib.sha256(pdf.read_bytes()).hexdigest() != digest:
        continue
    destination = folder / 'pdfs' / (digest + '.pdf')
    shutil.copyfile(pdf, destination)
    with fitz.open(destination) as document:
        page_count = len(document)
    ident, court, citation_en, citation_fr, alternate_en, alternate_fr, title_en, title_fr, date_en, date_fr, _, _ = documents[ident]
    citation = citation_en or citation_fr or alternate_en or alternate_fr
    year = int((date_en or date_fr)[:4])
    row = {'citation': citation, 'resolutionCitation': citation, 'provider': 'a2aj',
           'id': ident, 'jurisdiction': 'CA', 'court': court, 'reporter': None,
           'year': year, 'stratum': f'{key(canonical)[0]}:{year // 10 * 10}',
           'sourceUrl': canonical, 'outcome': 'original', 'origin': 'original',
           'sha256': digest, 'path': str(destination), 'url': record['url'],
           'title': record.get('title') or title_en or title_fr,
           'page_count': page_count, 'sourceReceipt': str(receipt)}
    rows.append(row)
    known.add(digest)
    added.append({'id': ident, 'court': court, 'sha256': digest})

manifest.write_text(json.dumps(rows, indent=2), encoding='utf-8')
print(json.dumps({'unique_originals': len(known), 'added': added}))
