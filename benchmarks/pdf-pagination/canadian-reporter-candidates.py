"""Prioritize uncollected SCC reporter originals from the installed A2AJ index."""
import json
import os
from pathlib import Path
import sqlite3

OUT = Path(__file__).resolve().parents[2] / 'tmp/pdf-pagination'
known = {row['id'] for row in json.loads(
    (OUT / 'canadian-cached-manifest.json').read_text(encoding='utf-8'))}
database = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts/LegalData/providers/a2aj/a2aj.sqlite'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    urls = {ident: en or fr for ident, en, fr in connection.execute(
        "select id,url_en,url_fr from document where dataset='SCC' and doc_type='cases'")}

rows = []
for row in json.loads((OUT / 'canadian-authorities-candidates.json').read_text(encoding='utf-8')):
    url = urls.get(row['id'])
    if row['year'] >= 1970 and row['id'] not in known and url and \
            url.startswith('https://decisions.scc-csc.ca/') and url.endswith('/index.do'):
        rows.append(dict(row, sourceUrl=url))
(OUT / 'canadian-reporter-fetch-candidates.json').write_text(
    json.dumps(rows, indent=2), encoding='utf-8')
print(json.dumps({'candidates': len(rows), 'known_skipped': len(known)}))
