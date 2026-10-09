"""Train and test a logistic block-quotation scorer over the same lexical features as
train.py, hashed into a fixed table, so correlated words are not counted twice.

    python train_lr.py <units.jsonl>... [--out quote_lexicon.tsv] [--test-source a2aj|journal]
"""
import argparse, json, random, zlib
import numpy as np
from train import features, source, held_out

BITS = 20


def fnv1a(text):
    """32-bit FNV-1a over UTF-8, as the parser's quote lexicon hashes its features."""
    value = 0x811C9DC5
    for byte in text.encode('utf-8'):
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value


def hashed(feats):
    return np.array(sorted({fnv1a(f) & ((1 << BITS) - 1) for f in feats}), dtype=np.int32)


def load(paths, test_source, negatives, keep):
    rng = random.Random(0)
    train, test = ([], [], []), []
    for path in paths:
        for line in open(path, encoding='utf-8'):
            unit = json.loads(line)
            # A share of the articles, whole, apart from which are held out.
            if zlib.crc32(('keep/' + unit['article']).encode()) % 1000 >= keep * 1000:
                continue
            if held_out(unit, test_source):
                test.append((unit['quote'], source(unit), hashed(features(unit))))
            elif unit['quote'] or rng.random() < negatives:
                ids = hashed(features(unit))
                train[0].append(ids); train[1].append(float(unit['quote'])); train[2].append(1.0 if unit['quote'] else 1.0 / negatives)
    return train, test


def scores(w, b, rows):
    return np.array([b + w[ids].sum() for ids in rows])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('units', nargs='+')
    parser.add_argument('--out')
    parser.add_argument('--test-source', choices=['a2aj', 'journal'])
    parser.add_argument('--negatives', type=float, default=0.3, help='Share of running-text units trained on')
    parser.add_argument('--epochs', type=int, default=4)
    parser.add_argument('--keep', type=float, default=1.0, help='Share of articles read at all')
    args = parser.parse_args()
    (rows, labels, weights), test = load(args.units, args.test_source, args.negatives, args.keep)
    labels, weights = np.array(labels), np.array(weights)
    w, b = np.zeros(1 << BITS), 0.0
    rate, l2, batch = 0.5, 1e-6, 2048
    order = np.arange(len(rows))
    for epoch in range(args.epochs):
        np.random.default_rng(epoch).shuffle(order)
        for start in range(0, len(order), batch):
            chunk = order[start:start + batch]
            ids = [rows[i] for i in chunk]
            z = b + np.array([w[x].sum() for x in ids])
            p = 1.0 / (1.0 + np.exp(-z))
            g = (p - labels[chunk]) * weights[chunk] / len(chunk)
            flat = np.concatenate(ids)
            np.add.at(w, flat, -rate * np.repeat(g, [len(x) for x in ids]))
            w *= 1.0 - rate * l2
            b -= rate * g.sum()
        rate *= 0.5
        print(f'epoch {epoch + 1} done', flush=True)
    for src in sorted({s for _, s, _ in test}):
        items = [(label, ids) for label, s, ids in test if s == src]
        z = scores(w, b, [ids for _, ids in items])
        y = np.array([label for label, _ in items])
        order_ = np.argsort(-z)
        hits = np.cumsum(y[order_])
        precision = hits / np.arange(1, len(y) + 1)
        recall = hits / max(1, y.sum())
        f1 = np.where(precision + recall > 0, 2 * precision * recall / (precision + recall + 1e-12), 0)
        k = int(np.argmax(f1))
        ranked = z[order_]
        print(f"{src:8} held-out {len(y):8} quotes {int(y.sum()):7}  best F1 {f1[k]:.3f} (P {precision[k]:.3f} R {recall[k]:.3f} at score {ranked[k]:.2f})")
        for floor in (0.8, 0.9):
            ok = np.flatnonzero(precision >= floor)
            if len(ok):
                last = ok[-1]
                print(f"         precision >= {floor}: recall {recall[last]:.3f} at score {ranked[last]:.2f}")
    if args.out:
        # The table the parser reads: the bias, then each bucket that moves a score at all.
        with open(args.out, 'w', encoding='utf-8', newline=chr(10)) as handle:
            handle.write('bias' + chr(9) + f'{b:.6f}' + chr(10))
            for bucket in np.flatnonzero(np.abs(w) > 0.01):
                handle.write(f'{bucket}' + chr(9) + f'{w[bucket]:.6f}' + chr(10))


if __name__ == '__main__':
    main()
