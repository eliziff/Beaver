"""Verify and index the locally acquired non-SCC Canadian judgment originals."""
import collections
import hashlib
import json
import re
from pathlib import Path

import fitz

ROOT = Path('tmp/pdf-pagination')
SOURCES = (
    'canadian-diverse-originals',
    'canadian-manitoba-direct',
    'canadian-official-direct',
    'canadian-new-brunswick-direct',
)
output = ROOT / 'canadian-non-scr-expanded'
output.mkdir(exist_ok=True)
unique = {}
excluded = []
for source in SOURCES:
    manifest = ROOT / source / 'manifest.json'
    if not manifest.exists():
        continue
    for row in json.loads(manifest.read_text(encoding='utf-8')):
        if row.get('outcome') != 'original' or row.get('court') == 'SCC':
            continue
        filename = Path(row['path'])
        data = filename.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if not data.startswith(b'%PDF-') or digest != row['sha256']:
            raise ValueError(f'Invalid original or hash: {filename}')
        with fitz.open(stream=data, filetype='pdf') as pdf:
            count = len(pdf)
            opening = ' '.join(pdf[i].get_text() for i in range(min(2, count)))
        if row.get('page_count') is not None and row['page_count'] != count:
            raise ValueError(f'Page count changed: {filename}')
        citation = ' '.join(row['citation'].replace('\u00c2\u00a0', ' ').split())
        if source != 'canadian-diverse-originals' and opening.strip():
            pattern = r'\b' + r'\s+'.join(map(re.escape, citation.split())) + r'\b'
            if not re.search(pattern, opening, re.I):
                excluded.append({'citation': citation, 'sha256': digest,
                                 'sourceManifest': str(manifest), 'reason': 'opening citation mismatch'})
                continue
        if digest in unique:
            if unique[digest]['citation'] != citation:
                raise ValueError(f'Duplicate hash with different citation: {filename}')
            continue
        unique[digest] = {**row, 'citation': citation, 'page_count': count,
                          'opening_native_chars': len(opening),
                          'sourceManifest': str(manifest)}

rows = sorted(unique.values(), key=lambda row: (row['court'], row['citation']))
(output / 'manifest.json').write_text(json.dumps(rows, indent=2), encoding='utf-8')
(output / 'excluded.json').write_text(json.dumps(excluded, indent=2), encoding='utf-8')
summary = {'originals': len(rows), 'physical_pages': sum(row['page_count'] for row in rows),
           'with_native_opening_text': sum(row['opening_native_chars'] > 0 for row in rows),
           'excluded_mismatches': len(excluded),
           'courts': dict(sorted(collections.Counter(
    row['court'] for row in rows).items())), 'sources': dict(sorted(collections.Counter(
    Path(row['sourceManifest']).parent.name for row in rows).items()))}
(output / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
print(json.dumps(summary))
