"""Which development yardstick=main OCR-mode documents were read by our recognizer?

Reads the shipped OCR-cache exports (ocr-cache-state.json) and counts each document's pages by
`source` as the parser recorded it. Writes qualify.json.
"""
import collections, gzip, json, sys
from pathlib import Path

store = Path(r'C:\Users\elias\Desktop\oajd_compute\lsg-v4\benchmarks\local-data\legal-structure-gold')
manifest = {d['sha256']: d for d in json.loads((store / 'cohort-manifest.json').read_text(encoding='utf-8'))['documents']}
groups = json.loads(Path(r'C:\Users\elias\fable\groups.json').read_text(encoding='utf-8'))['sources']
state = json.loads((store / 'ocr-cache-state.json').read_text(encoding='utf-8'))
rows = []
for entry in state['inputs']:
    sha = entry['source_sha256']
    doc = manifest.get(sha, {})
    g = groups.get(sha, {})
    export = json.loads(gzip.open(entry['candidate']).read())
    pages = export['extraction']['pages']
    sources = collections.Counter(p.get('source', 'unset') for p in pages)
    ocr_lines = sum(1 for p in pages for l in p['lines'] if l.get('source') == 'ocr')
    all_lines = sum(len(p['lines']) for p in pages)
    rows.append({'sha': sha, 'split': doc.get('split'), 'mode': doc.get('mode'), 'yardstick': g.get('yardstick'),
                 'manifest_yardstick': doc.get('yardstick'), 'pages': len(pages), 'page_sources': dict(sources),
                 'ocr_lines': ocr_lines, 'lines': all_lines, 'pdf': doc.get('path'), 'candidate': entry['candidate']})
Path('qualify.json').write_text(json.dumps(rows, indent=1), encoding='utf-8')
print(collections.Counter((r['split'], r['yardstick'], r['mode']) for r in rows).most_common(12))
print(collections.Counter(k for r in rows for k in r['page_sources']))
for split in ['development', 'train']:
    sel = [r for r in rows if r['split'] == split and r['yardstick'] == 'main' and r['mode'] == 'ocr']
    full = [r for r in sel if r['lines'] and r['ocr_lines'] / r['lines'] >= 0.9]
    some = [r for r in sel if r['ocr_lines'] > 0]
    print(split, 'main+ocr', len(sel), 'any ocr lines', len(some), '>=90% ocr lines', len(full),
          'pages', sum(r['pages'] for r in full))
