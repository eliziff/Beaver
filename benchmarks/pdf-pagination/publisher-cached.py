"""Join cached original receipts to independently stored A2AJ landing-page URLs."""
import json
import os
from pathlib import Path
import sqlite3

root = Path(__file__).resolve().parents[2]
database = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts/LegalData/providers/a2aj/a2aj.sqlite'
receipts = {}
for name in ['canadian-cached-manifest.json', 'canadian-authorities-manifest.json']:
    for row in json.loads((root / 'tmp/pdf-pagination' / name).read_text(encoding='utf-8-sig')):
        if row.get('origin') == 'original':
            receipts.setdefault(row['sha256'], row)
rows = list(receipts.values())
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for row in rows:
        source = connection.execute('select url_en,url_fr from document where id=?', (row['id'],)).fetchone()
        row['indexUrls'] = [url for url in source if url] if source else []
(root / 'tmp/pdf-pagination/publisher-cached.json').write_text(json.dumps(rows), encoding='utf-8')
print(f'{len(rows)} cached receipts joined to inventory URLs')
