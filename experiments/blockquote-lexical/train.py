"""Train and test a lexical block-quotation scorer: smoothed log-odds weights over words and cues
read from a unit, the text before it and the text after it, with no layout at all.

    python train.py <units.jsonl>... --out weights.json [--test-source a2aj|journal]

Units are held out by document (one in ten). With --test-source, every document from that
source is held out instead, so the score shows how the weights carry across sources.
"""
import argparse, json, math, re, zlib
from collections import Counter

WORD = re.compile(r"[A-Za-zÀ-ɏ]+(?:'[a-z]+)?|\d+|[^\sA-Za-z\d]")


def tokens(text):
    return [t.lower() for t in WORD.findall(text)]


def shape(char):
    if not char: return 'none'
    if char.islower(): return 'lower'
    if char.isupper(): return 'upper'
    if char.isdigit(): return 'digit'
    return {'"': 'quote', '“': 'quote', '‘': 'quote', "'": 'quote', '”': 'quote', '’': 'quote',
            '.': 'stop', ':': 'colon', ';': 'semi', ',': 'comma', '(': 'paren', '[': 'bracket', ']': 'bracket',
            ')': 'paren', '…': 'ellipsis', '-': 'dash', '–': 'dash', '—': 'dash'}.get(char, 'other')


def features(unit):
    text, before, after = unit['text'].strip(), unit['before'].strip(), unit['after'].strip()
    words, lead, follow = tokens(text), tokens(before), tokens(after)
    out = {f'len:{min(len(words) // 20, 8)}', f'start:{shape(text[:1])}', f'end:{shape(text[-1:])}',
           f'lead_end:{shape(before[-1:])}', f'follow_start:{shape(after[:1])}'}
    if text.startswith(('...', '. . .')): out.add('start:ellipsis')
    for n in (1, 2, 3):
        if len(lead) >= n: out.add('lead:' + ' '.join(lead[-n:]))
        if len(words) >= n:
            out.add('head:' + ' '.join(words[:n]))
            out.add('tail:' + ' '.join(words[-n:]))
    if follow: out.add('follow:' + follow[0])
    out.update('w:' + w for w in set(words))
    if re.search(r'\[[A-Za-z][^\]]{0,25}\]', text): out.add('cue:bracketed_alteration')
    if re.search(r'(?:emphasis|italics|footnotes?|citations?) (?:added|omitted|in original)', text, re.I): out.add('cue:alteration_note')
    if '...' in text or '…' in text or '. . .' in text: out.add('cue:ellipsis')
    return out


def source(unit):
    return 'a2aj' if unit['article'].startswith('a2aj/') else 'journal'


def held_out(unit, test_source):
    if test_source:
        return source(unit) == test_source
    return zlib.crc32(unit['article'].encode()) % 10 == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('units', nargs='+')
    parser.add_argument('--out')
    parser.add_argument('--test-source', choices=['a2aj', 'journal'])
    parser.add_argument('--min-count', type=int, default=20)
    args = parser.parse_args()
    counts = {True: Counter(), False: Counter()}
    totals = Counter()
    test = []
    for path in args.units:
        for line in open(path, encoding='utf-8'):
            unit = json.loads(line)
            if held_out(unit, args.test_source):
                test.append((unit['quote'], source(unit), features(unit)))
                continue
            totals[unit['quote']] += 1
            counts[unit['quote']].update(features(unit))
    prior = math.log(totals[True] / totals[False])
    weights = {}
    for feature in set(counts[True]) | set(counts[False]):
        q, t = counts[True][feature], counts[False][feature]
        if q + t < args.min_count:
            continue
        weights[feature] = math.log((q + 1) / (totals[True] + 2)) - math.log((t + 1) / (totals[False] + 2))
    # Scores of the held-out units, then the best threshold on them, per source.
    scored = [(label, src, prior + sum(weights.get(f, 0.0) for f in feats)) for label, src, feats in test]
    for src in sorted({s for _, s, _ in scored}):
        rows = sorted(((score, label) for label, s, score in scored if s == src), reverse=True)
        positives = sum(label for _, label in rows)
        best = (0, 0, 0, 0)
        hits = 0
        for rank, (score, label) in enumerate(rows, 1):
            hits += label
            p, r = hits / rank, hits / max(1, positives)
            f = 2 * p * r / (p + r) if p + r else 0
            if f > best[0]: best = (f, p, r, score)
        print(f"{src:8} held-out units {len(rows):8} quotes {positives:7}  best F1 {best[0]:.3f} (P {best[1]:.3f} R {best[2]:.3f} at score {best[3]:.2f})")
    if args.out:
        json.dump({'prior': prior, 'weights': weights}, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False)
        top = sorted(weights.items(), key=lambda kv: -kv[1])
        print('strongest quote features:', [k for k, _ in top[:25]])
        print('strongest text features:', [k for k, _ in top[-15:]])


if __name__ == '__main__':
    main()
