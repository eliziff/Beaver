"""Seed a small cross-publisher URL-rule check from the installed public inventory."""
import collections
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[2]
database = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts/LegalData/providers/a2aj/a2aj.sqlite'
groups = collections.defaultdict(dict)
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for dataset, en, fr, en_url, fr_url in connection.execute(
            "select dataset,citation_en,citation_fr,url_en,url_fr from document where doc_type='cases'"):
        for language, citation, url in [('en', en, en_url), ('fr', fr, fr_url)]:
            if not url or '/item/' not in url or not url.endswith('/index.do'):
                continue
            groups[urlparse(url).hostname].setdefault(url, dict(dataset=dataset, citation=citation, url=url, language=language))
selected = []
for host, rows in sorted(groups.items()):
    selected.extend(sorted(rows.values(), key=lambda row: hashlib.sha256(row['url'].encode()).hexdigest())[:3])
out = root / 'tmp/pdf-pagination/rule-candidates.json'
out.write_text(json.dumps(selected, indent=2), encoding='utf-8')
print(json.dumps({'available_by_host': {host: len(rows) for host, rows in groups.items()}, 'selected': len(selected)}, indent=2))
