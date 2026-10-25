"""Native legalocr A/B on gold OCR pages: run a model pack, then score its lines against gold.

  ocr_ab.py run   --split development --pack DIR --tier balanced --backend cpu --out OUTDIR
  ocr_ab.py score --split development --out OUTDIR [--out OUTDIR2 ...] --report REPORT.json

Lines are matched to the gold extraction's OCR line boxes by IoU (>= 0.5) on the same page;
detection is identical across packs, so both arms score the same boxes.
"""
import argparse, collections, gzip, json, subprocess, sys, time
from pathlib import Path

LEGALOCR = r'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\dist\legal-ocr-runtime-windows-x64\legalocr.exe'
HERE = Path(__file__).resolve().parent


def iou(a, b):
    x0, y0, x1, y1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def cmd_run(args):
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    docs = sorted((HERE / 'subset' / args.split).glob('*.pdf'))
    for pdf in docs:
        target = out / f'{pdf.stem}.json'
        if target.exists():
            continue
        command = [LEGALOCR, str(pdf), '--tier', args.tier, '--backend', args.backend, '--output', str(target)]
        if args.pack:
            command += ['--model-pack', args.pack]
        subprocess.run(command, check=True)
    print(json.dumps({'documents': len(docs), 'seconds': round(time.perf_counter() - started, 1)}))


def predictions(split, out, threshold=0.5):
    rows = [json.loads(x) for x in gzip.open(HERE / 'lines.jsonl.gz', 'rt', encoding='utf-8')]
    rows = [dict(r, text=r['gold']) for r in rows if r['split'] == split]
    by_doc = collections.defaultdict(list)
    for r in rows:
        by_doc[r['sha']].append(r)
    preds, identity = {}, None
    for sha, items in by_doc.items():
        numbers = json.loads((HERE / 'subset' / split / f'{sha}.pages.json').read_text())
        doc = json.loads((Path(out) / f'{sha}.json').read_text(encoding='utf-8'))
        identity = doc['identity']
        page_lines = {numbers[p.get('page_index', i)]: p['lines'] for i, p in enumerate(doc['pages'])}
        if 'pdfium' in Path(out).name:  # image-input runs report pixels of the 144 dpi render
            page_lines = {k: [dict(l, bbox=[v / 2 for v in l['bbox']]) for l in v] for k, v in page_lines.items()}
        for r in items:
            # Every recognized line inside the gold line's box, left to right: the detector may
            # split a tab-separated marker from its body; the parser rejoins them downstream.
            x0, y0, x1, y1 = r['bbox']
            inside = []
            for candidate in page_lines.get(r['page'], []):
                c0, d0, c1, d1 = candidate['bbox']
                overlap = min(y1, d1) - max(y0, d0)
                centre = (c0 + c1) / 2
                if overlap >= 0.5 * min(y1 - y0, d1 - d0) and x0 - 2 <= centre <= x1 + 2:
                    inside.append(candidate)
            inside.sort(key=lambda c: c['bbox'][0])
            line = {'text': ' '.join(c['text'] for c in inside), 'parts': len(inside)} if inside else None
            preds[(r['sha'], r['id'])] = (r, line, len(inside))
    return preds, identity


def cmd_score(args):
    sys.path.insert(0, str(HERE))
    import random
    from markers import score, usable, is_target, offset_text, span_status
    from rapidfuzz.distance import Levenshtein
    from screen import normalized
    arms = {out: predictions(args.split, out) for out in args.out}
    keys = set.intersection(*[{k for k, v in p.items() if v[1] is not None} for p, _ in arms.values()])
    first = next(iter(arms.values()))[0]
    total = len(first)
    keys = sorted(keys)
    targets = [k for k in keys if is_target(first[k][0]) and usable(first[k][0])]
    others = [k for k in keys if not is_target(first[k][0]) and usable(first[k][0])]
    refs = [k for k in targets if first[k][0]['refs']]
    rest = [k for k in targets if not first[k][0]['refs']]
    random.Random(714).shuffle(rest)
    sample = refs + rest[:max(0, 300 - len(refs))]
    report = {'split': args.split, 'gold_ocr_lines': total, 'matched_all_arms': len(keys),
              'usable_target_lines': len(targets), 'usable_other_lines': len(others), 'sample300': len(sample), 'arms': {}}
    for out, (preds, identity) in arms.items():
        entry = {'identity': identity}
        for name, chosen in [('targets', targets), ('sample300', sample), ('other', others)]:
            rows = [preds[k][0] for k in chosen]
            entry[name] = score(rows, [normalized(preds[k][1]['text']) for k in chosen])
        examples = []
        for k in sample:
            r, line, _ = preds[k]
            text = normalized(line['text'])
            gold = offset_text(r['text'])
            ops = Levenshtein.opcodes(gold, text)
            spans = [(a, b, 'reference') for a, b in r['refs']] + [(a, b, 'marker') for a, b in r['markers'] if a == 0]
            for a, b, kind in spans:
                status = span_status(ops, a, b, gold)
                if status != 'ok':
                    examples.append({'kind': kind, 'status': status, 'gold_span': r['text'][a:b],
                                     'gold': r['text'][max(0, a - 30):b + 30], 'ocr': text[max(0, a - 30):b + 32],
                                     'id': f"{r['sha'][:8]}:{r['id']}"})
                    break
        entry['examples'] = examples
        report['arms'][out] = entry
        t, s = entry['targets'], entry['sample300']
        print(out, json.dumps({'targets_cer': round(t['cer'], 5), 'markers': (t['markers']['errors'], t['markers']['spans']),
                               'refs': (t['references']['errors'], t['references']['spans']),
                               'sample300_cer': round(s['cer'], 5), 'sample_markers': (s['markers']['errors'], s['markers']['spans']),
                               'sample_refs': (s['references']['errors'], s['references']['spans']),
                               'other_cer': round(entry['other']['cer'], 5)}))
    print(json.dumps({k: v for k, v in report.items() if k != 'arms'}))
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    r = sub.add_parser('run')
    r.add_argument('--split', required=True)
    r.add_argument('--pack')
    r.add_argument('--tier', default='balanced')
    r.add_argument('--backend', default='cpu')
    r.add_argument('--out', required=True)
    s = sub.add_parser('score')
    s.add_argument('--split', required=True)
    s.add_argument('--out', action='append', required=True)
    s.add_argument('--report', required=True)
    args = parser.parse_args()
    {'run': cmd_run, 'score': cmd_score}[args.command](args)


if __name__ == '__main__':
    main()
