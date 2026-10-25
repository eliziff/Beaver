"""Collect OCR gold lines (box, cached OCR text, corrected text, marker/reference spans)."""
import collections, gzip, json, sys
from pathlib import Path

root = Path(r'C:\Users\elias\Desktop\oajd_compute\lsg-v4\benchmarks\local-data\legal-structure-gold')
out = Path(sys.argv[1])
rows = json.loads((root / 'cohort-manifest.json').read_text(encoding='utf-8'))['documents']
stats = collections.Counter()
bad_offsets = []
with gzip.open(out, 'wt', encoding='utf-8') as sink:
    for doc in rows:
        if doc.get('mode') != 'ocr':
            continue
        sha = doc['sha256']
        gpath, ipath = root / 'v4' / sha / 'gold.json.gz', root / 'inputs' / f'{sha}.json.gz'
        if not gpath.exists() or not ipath.exists():
            stats['missing_gold_or_input'] += 1
            continue
        g = json.loads(gzip.open(gpath).read())
        inp = json.loads(gzip.open(ipath).read())
        pages = inp['extraction']['pages'] if 'extraction' in inp else inp['pages']
        gold = {line['id']: line['text'] for line in g['lines']}
        edits = collections.defaultdict(list)
        for e in g.get('text_edits', []):
            edits[e['line_id']].append(e)
        for lid, es in edits.items():
            text = gold.get(lid)
            if text is None:
                continue
            for e in sorted(es, key=lambda e: (e['start'], e['end']), reverse=True):
                if text[e['start']:e['end']] != e['old']:
                    stats['edit_old_mismatch'] += 1
                text = text[:e['start']] + e['text'] + text[e['end']:]
            gold[lid] = text
        stats['edited_lines'] += len(edits)
        markers, refs = collections.defaultdict(list), collections.defaultdict(list)
        for t in g['typed']:
            for group in t['markers']:
                for s in group:
                    markers[s['line_id']].append((s['start'], s['end']))
            for r in t['references']:
                for s in r['spans']:
                    refs[s['line_id']].append((s['start'], s['end'], r.get('label')))
        stats['docs'] += 1
        for page in pages:
            ocr_lines = [l for l in page['lines'] if l.get('source') == 'ocr' or l.get('ocr')]
            if not ocr_lines:
                continue
            stats['ocr_pages'] += 1
            for line in ocr_lines:
                stats['ocr_lines'] += 1
                lid = line['id']
                if lid not in gold:
                    stats['line_not_in_gold'] += 1
                    continue
                text = gold[lid]
                for a, b, label in refs.get(lid, []):
                    stats['ref_spans'] += 1
                    if label is not None and text[a:b] != label:
                        stats['ref_label_mismatch'] += 1
                        if len(bad_offsets) < 8:
                            bad_offsets.append((lid, text, a, b, label, line['text']))
                stats['marker_spans'] += len(markers.get(lid, []))
                stats['lines_with_marker_at_0'] += any(a == 0 for a, _ in markers.get(lid, []))
                stats['lines_with_ref'] += bool(refs.get(lid))
                sink.write(json.dumps({
                    'sha': sha, 'split': doc.get('split'), 'path': doc['path'], 'page': page['number'],
                    'page_w': page['width'], 'page_h': page['height'], 'id': lid, 'bbox': line['bbox'],
                    'ocr': line['text'], 'gold': text, 'markers': markers.get(lid, []),
                    'refs': [[a, b] for a, b, _ in refs.get(lid, [])],
                    'confidence': (line.get('ocr') or {}).get('confidence'),
                }, ensure_ascii=False) + '\n')
                stats[f"split_{doc.get('split')}"] += 1
print(json.dumps(stats, indent=1))
for b in bad_offsets:
    print(b)
