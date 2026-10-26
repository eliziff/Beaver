"""Collect page-level split data from structure gold v4 (b5-b7) and the parser's own extraction.

For every gold source outside the test split: its pages as the parser reads them (lines with text,
box, font size/weight, page size, printed label), its document starts from the gold units
(`starts_document`, `document_type`), each start marked as a page-edge start (nothing but page
furniture before it on its page) or a within-page start, and its source family and partition from
the existing page-stream exports. Writes one pickle; reads no test-split row.

  python docsplit_data.py --fable C:/Users/elias/fable --exports C:/Users/elias/beaver-train/page-stream-segmentation/teacher-data --out data.pkl
"""
import argparse
import gzip
import json
import pickle
import statistics
from pathlib import Path

INPUTS_KEY = '740b104eeae9bc39'
OWN = {'furniture', 'page_label', 'line_label'}
TOP_LINES = 8
BOTTOM_LINES = 8


def gold_starts(gold):
    """[(line_id, page, kind, type)] for every document start after the first, and the first's type."""
    units = gold['units']
    first = next(i for i, u in enumerate(units) if 'document_type' in u)
    page_of = {l['id']: l['page'] for l in gold['lines']}
    order = {l['id']: n for n, l in enumerate(gold['lines'])}
    body = {s['line_id'] for t in gold['typed'] if t['region'] not in OWN for s in t['spans']}
    by_page = {}
    for l in gold['lines']:
        by_page.setdefault(l['page'], []).append(l['id'])
    starts = []
    for i, unit in enumerate(units):
        if i <= first or not unit.get('starts_document'):
            continue
        # a start unit without spans opens at the next unit's first span
        line = next((s['line_id'] for u in units[i:] for k in u['lines'] for s in gold['typed'][k]['spans']), None)
        if line is None:
            continue
        page = page_of[line]
        before = [x for x in by_page[page] if order[x] < order[line]]
        kind = 'inside' if any(x in body for x in before) else 'edge'
        starts.append((line, page, kind, unit.get('document_type', 'unknown')))
    return starts, units[first].get('document_type', 'unknown')


def line_record(line, width, height):
    spans = line.get('spans') or []
    chars = [(len(s.get('text', '')), s.get('size') or 0.0, s.get('flags') or 0, s.get('font') or '') for s in spans]
    total = sum(c[0] for c in chars) or 1
    size = sum(c[0] * c[1] for c in chars) / total if chars else 0.0
    bold = sum(c[0] for c in chars if (c[2] & 16) or 'bold' in c[3].lower()) / total if chars else 0.0
    italic = sum(c[0] for c in chars if (c[2] & 2) or 'italic' in c[3].lower()) / total if chars else 0.0
    font = max(chars, key=lambda c: c[0])[3] if chars else ''
    x0, y0, x1, y1 = line.get('bbox') or (0, 0, 0, 0)
    return dict(text=line.get('text', ''), x0=x0 / width, y0=y0 / height, x1=x1 / width, y1=y1 / height,
                size=size, bold=bold, italic=italic, font=font,
                furniture=bool(line.get('exclude_from_body')), region=line.get('region_type', ''))


def page_record(page, embedded_label):
    width = page.get('width') or 612.0
    height = page.get('height') or 792.0
    lines = [line_record(l, width, height) for l in page.get('lines', []) if (l.get('text') or '').strip()]
    by_y = sorted(lines, key=lambda l: (round(l['y0'], 3), l['x0']))
    sizes = [l['size'] for l in lines if l['size'] > 0]
    fonts = {}
    for l in lines:
        fonts[l['font']] = fonts.get(l['font'], 0) + len(l['text'])
    body = [l for l in lines if not l['furniture']]
    return dict(
        width=width, height=height, source=page.get('source', ''), quality=page.get('text_quality') or 0.0,
        printed_label=page.get('printed_label'), embedded_label=embedded_label,
        n_lines=len(lines), n_chars=sum(len(l['text']) for l in lines),
        median_size=statistics.median(sizes) if sizes else 0.0, max_size=max(sizes) if sizes else 0.0,
        fonts=sorted(fonts, key=fonts.get, reverse=True)[:3],
        left=min((l['x0'] for l in body), default=0.0), right=max((l['x1'] for l in body), default=0.0),
        top=by_y[:TOP_LINES], bottom=by_y[-BOTTOM_LINES:] if len(by_y) > TOP_LINES else by_y[TOP_LINES:],
        # the whole page's text, capped, for the type head and keyword cues
        text=' \n'.join(l['text'] for l in by_y)[:3000],
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--fable', type=Path, required=True)
    ap.add_argument('--exports', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()
    known = {}
    for c in json.loads((args.exports / 'full-training.json').read_text(encoding='utf-8'))['cases']:
        known[c['sha256']] = (c['split'], c['family_id'])
    for p in json.loads((args.exports / 'internal-training.json').read_text(encoding='utf-8'))['pages']:
        known.setdefault(p['sha256'], (p['split'], p['family_id']))
    sources = []
    skipped = []
    for batch in ('b5', 'b6', 'b7'):
        manifest = {d['sha256']: d for d in json.loads((args.fable / batch / 'cohort-manifest.json').read_text(encoding='utf-8'))['documents']}
        for job in sorted((args.fable / batch / 'a' / 'v4').iterdir()):
            if not (job / 'gold.json.gz').exists():
                continue
            sha = json.loads((job / 'receipt.json').read_text(encoding='utf-8'))['source_sha256']
            doc = manifest.get(sha)
            if doc is None or doc.get('split') == 'test' or sha not in known or known[sha][0] == 'test':
                skipped.append((batch, sha, 'not a train/development source'))
                continue
            extraction_path = args.fable / batch / 'inputs' / INPUTS_KEY / f'{sha}.json.gz'
            if not extraction_path.exists():
                skipped.append((batch, sha, 'no extraction'))
                continue
            gold = json.loads(gzip.decompress((job / 'gold.json.gz').read_bytes()))
            extraction = json.loads(gzip.decompress(extraction_path.read_bytes()))
            labels = (extraction.get('metadata') or {}).get('embedded_page_labels') or []
            pages = [page_record(p, labels[i] if i < len(labels) else None) for i, p in enumerate(extraction['pages'])]
            if len(pages) != gold['page_count']:
                skipped.append((batch, sha, f'page count {len(pages)} != {gold["page_count"]}'))
                continue
            starts, first_type = gold_starts(gold)
            sources.append(dict(sha256=sha, batch=batch, family=known[sha][1], split=known[sha][0],
                                mode=doc.get('mode'), genre=doc.get('genre_group'), collection=Path(doc['path']).parent.name,
                                pages=pages, starts=starts, first_type=first_type))
            print(json.dumps(dict(batch=batch, sha=sha[:12], pages=len(pages), starts=len(starts))), flush=True)
    with open(args.out, 'wb') as f:
        pickle.dump(dict(sources=sources, skipped=skipped), f)
    print(json.dumps(dict(sources=len(sources), skipped=len(skipped), pages=sum(len(s['pages']) for s in sources),
                          starts=sum(len(s['starts']) for s in sources),
                          inside=sum(1 for s in sources for x in s['starts'] if x[2] == 'inside'))))
    for s in skipped:
        print('skipped', s)


if __name__ == '__main__':
    main()
