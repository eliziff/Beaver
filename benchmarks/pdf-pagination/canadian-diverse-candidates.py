"""Deterministic cross-court Canadian judgment sample from the installed A2AJ index."""
import collections
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tmp/pdf-pagination'
database = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts/LegalData/providers/a2aj/a2aj.sqlite'
groups = collections.defaultdict(list)
by_url = {}
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
    for ident, dataset, en, fr, alternate_en, alternate_fr, url_en, url_fr, date in connection.execute(
            "select id,dataset,citation_en,citation_fr,citation2_en,citation2_fr,"
            "url_en,url_fr,document_date_en from document where doc_type='cases'"):
        if dataset == 'SCC':
            continue  # The SCR/RCS cohort is measured separately.
        citation = en or fr
        source_url = url_en or url_fr
        if not citation or not source_url or '/item/' not in source_url or not source_url.endswith('/index.do'):
            continue
        host = urlparse(source_url).hostname or ''
        if not (host.endswith('.ca') or host.endswith('.gc.ca')):
            continue
        year = int(date[:4]) if date and date[:4].isdigit() else None
        if not year:
            continue
        row = {'citation': citation, 'resolutionCitation': citation, 'provider': 'a2aj',
               'id': ident, 'jurisdiction': 'CA', 'court': dataset,
               'reporter': alternate_en or alternate_fr or None, 'year': year,
               'stratum': f'{host}:{year // 10 * 10}', 'sourceUrl': source_url}
        groups[host].append(row)
        by_url[source_url] = row

# Spread the first requests across hosts and decades; each host can stop independently.
selected = []
for host, rows in sorted(groups.items()):
    rows.sort(key=lambda row: (hashlib.sha256(str(row['id']).encode()).hexdigest(), row['id']))
    by_decade = collections.defaultdict(list)
    for row in rows:
        by_decade[row['year'] // 10 * 10].append(row)
    picked = []
    while len(picked) < 20 and any(by_decade.values()):
        for decade in sorted(by_decade):
            if by_decade[decade] and len(picked) < 20:
                picked.append(by_decade[decade].pop())
    selected.append((host, picked))
ordered = []
for index in range(20):
    ordered.extend(rows[index] for _, rows in selected if index < len(rows))
known_file = OUT / 'publisher-rule-after-clearance/summary.json'
known = []
if known_file.exists():
    for receipt in json.loads(known_file.read_text(encoding='utf-8'))['results']:
        if receipt.get('outcome') == 'valid_pdf' and receipt['url'] in by_url:
            known.append(by_url[receipt['url']])
known_ids = {row['id'] for row in known}
ordered = known + [row for row in ordered if row['id'] not in known_ids]
(OUT / 'canadian-diverse-candidates.json').write_text(json.dumps(ordered, indent=2), encoding='utf-8')
print(json.dumps({'hosts': {host: {'available': len(groups[host]), 'selected': len(rows)}
                            for host, rows in selected}, 'known_valid_seeded': len(known),
                  'selected': len(ordered)}))
