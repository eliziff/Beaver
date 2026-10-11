"""Where the parser loses each journal gold note, from the latest saved parse of every gold PDF:
the label's line missing from the extraction, present but outside the notes' region, present
with its number misread, present and read but unpaired, or paired.

    python experiments/footnote-gold/loss_buckets.py [--show N]
"""
import argparse, difflib, glob, gzip, json, os, re, unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/local-data/olj-footnote-gold'


def norm(text):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text or '')).strip().lower()


def latest(sha):
    paths = glob.glob(str(OUT / 'candidates' / sha / '*' / '*' / '*.json.gz'))
    return max(paths, key=os.path.getmtime) if paths else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--show', type=int, default=0)
    args = parser.parse_args()
    buckets, examples = Counter(), defaultdict(list)
    for gold_path in sorted(OUT.glob('gold/*/gold.json')):
        gold = json.load(open(gold_path, encoding='utf-8'))
        path = latest(gold['source_sha256'])
        if not path:
            continue
        candidate = json.load(gzip.open(path, 'rt', encoding='utf-8'))
        pages = {p['number']: p['lines'] for p in candidate['extraction']['pages']}
        document = candidate.get('document', candidate)
        structure = document.get('structure_graph', document.get('structure', document))
        lines = {l['id']: (p, l) for p, ls in pages.items() for l in ls}
        paired = set()
        for node in structure['nodes']:
            if node['kind'] in ('footnote', 'endnote') and node.get('line_ids'):
                page, line = lines.get(node['line_ids'][0], (None, None))
                paired.add((page, str(node.get('label') or '').strip('.)( ')))
        for note in gold['notes']:
            for label in note['labels']:
                page, want = label['page'], norm(label['line_text'])
                value = str(note['note_id'])
                best, best_line = 0.0, None
                for line in pages.get(page, []):
                    ratio = difflib.SequenceMatcher(None, want, norm(line['text'])).ratio()
                    if ratio > best:
                        best, best_line = ratio, line
                if (page, value) in paired:
                    bucket = 'paired'
                elif best < 0.6:
                    bucket = 'label line missing from extraction'
                elif best_line.get('region_type') not in ('footnote', 'endnote', 'note') and not best_line.get('note_region_mode'):
                    bucket = 'label line outside the notes region'
                elif not re.match(r'\W{0,2}' + re.escape(value) + r'(?!\d)', norm(best_line['text'])):
                    bucket = 'label number misread or missing'
                else:
                    bucket = 'read but unpaired'
                buckets[bucket] += 1
                if len(examples[bucket]) < args.show:
                    examples[bucket].append(f"{gold['dataset']}:{gold['article_id']} p{page} n{value}: gold {label['line_text'][:50]!r} | ours {(best_line or {}).get('text', '')[:50]!r}")
    total = sum(buckets.values())
    for bucket, count in buckets.most_common():
        print(f'{count:5} {count / total:6.1%}  {bucket}')
        for example in examples[bucket]:
            print('        ', example)


if __name__ == '__main__':
    main()
