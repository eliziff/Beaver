"""Train and evaluate the page-level document splitter: per page, does a document start here, and
of what type. Trained on real packets plus synthetic packets assembled from clean single documents;
evaluated only on real packets from families never seen in training.

  python docsplit_train.py --data data.pkl --parser-starts parser-starts --existing <cpu-model dir> --out out

Evaluation designs:
  folds    grouped 5-fold by source family over every non-test gold source (all real packets are
           scored once, by a model that never saw their family);
  existing the existing page-stream partition (its train families train, its development sources
           score), to compare with the existing doc-split models' saved development predictions.
The decision threshold is chosen inside each training fold (an inner family split), never on the
evaluated packets.
"""
import argparse
import collections
import json
import pickle
import random
import re
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
from sklearn.metrics import average_precision_score

from docsplit_features import PageTable

SEED = 7411


def load(path):
    data = pickle.load(open(path, 'rb'))
    sources = data['sources']
    pages, offsets = [], []
    for s in sources:
        offsets.append(len(pages))
        pages.extend(s['pages'])
    n = len(pages)
    edge = np.zeros(n, np.int8)
    inside = np.zeros(n, np.int8)
    start_type = [None] * n
    docs = []
    for k, s in enumerate(sources):
        o = offsets[k]
        start_type[o] = s['first_type']
        bounds = [(1, 'edge', s['first_type'])]
        for line, page, kind, typ in sorted(s['starts'], key=lambda x: x[1]):
            bounds.append((page, kind, typ))
            if kind == 'edge':
                edge[o + page - 1] = 1
                start_type[o + page - 1] = typ
            else:
                inside[o + page - 1] = 1
        inside[edge == 1] = 0
        # clean pieces: documents whose own start and the next document's start are page edges
        count = len(s['pages'])
        for j, (page, kind, typ) in enumerate(bounds):
            end = bounds[j + 1][0] if j + 1 < len(bounds) else count + 1
            nxt_kind = bounds[j + 1][1] if j + 1 < len(bounds) else 'edge'
            if kind == 'edge' and nxt_kind == 'edge' and end > page:
                docs.append(dict(source=k, first=o + page - 1, end=o + end - 1, type=typ, mode=s['mode']))
    return sources, pages, offsets, edge, inside, start_type, docs


class Splitter:
    """LightGBM start head + type head over PageTable rows."""

    def __init__(self, table, style=True, rounds=400):
        self.table, self.style, self.rounds = table, style, rounds
        self.threads = 2

    def fit(self, X, y, w):
        params = dict(objective='binary', learning_rate=0.05, num_leaves=31, min_data_in_leaf=20,
                      feature_fraction=0.5, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0,
                      num_threads=2, verbose=-1, seed=SEED)
        self.start = lgb.train(params, lgb.Dataset(X, y, weight=w), self.rounds)
        return self

    def fit_type(self, X, labels):
        counts = collections.Counter(labels)
        self.classes = sorted(c for c, n in counts.items() if n >= 8 and c != 'other') + ['other']
        index = {c: i for i, c in enumerate(self.classes)}
        y = np.array([index.get(c, index['other']) for c in labels])
        params = dict(objective='multiclass', num_class=len(self.classes), learning_rate=0.05, num_leaves=15,
                      min_data_in_leaf=5, feature_fraction=0.5, lambda_l2=1.0, num_threads=2, verbose=-1, seed=SEED)
        self.type = lgb.train(params, lgb.Dataset(X, y), 250)
        return self

    def predict(self, seq):
        if len(seq) < 2:
            return np.zeros(0)
        return self.start.predict(self.table.rows(seq, range(1, len(seq)), self.style), num_threads=self.threads)

    def predict_type(self, seq, positions):
        p = self.type.predict(self.table.type_rows(seq, positions), num_threads=self.threads)
        return [self.classes[i] for i in p.argmax(1)]


def training_rows(table, train, offsets, sources, edge, inside, docs, target, synth, style, rng):
    """Rows from the real training packets, then from synthetic packets of their clean documents."""
    seqs, positions, ys, ws = [], [], [], []
    X_parts = []
    for k in train:
        n = len(sources[k]['pages'])
        if n < 2:
            continue
        seq = np.arange(offsets[k], offsets[k] + n)
        pos = np.arange(1, n)
        y = edge[seq[pos]].astype(np.int8)
        keep = np.ones(len(pos), bool)
        if target == 'edge':
            keep = inside[seq[pos]] == 0
        else:
            y = np.maximum(y, inside[seq[pos]])
        if not synth.get('real', True):
            # synthetic-only arm: real packets still give their natural interior negatives, no real starts
            keep &= y == 0
        if keep.any():
            X_parts.append(table.rows(seq, pos[keep], style))
            ys.append(y[keep])
            ws.append(np.ones(keep.sum()))
    packets = synth.get('packets', 0)
    if packets:
        trainset = set(train)
        pool = [d for d in docs if d['source'] in trainset]
        by_family = collections.defaultdict(list)
        for d in pool:
            by_family[sources[d['source']]['family']].append(d)
        families = sorted(by_family)
        by_mode = collections.defaultdict(list)
        for d in pool:
            by_mode[d['mode']].append(d)
        rows_y, rows_seq, rows_pos = [], [], []
        for _ in range(packets):
            length = rng.randint(2, 6)
            chosen = [rng.choice(by_family[rng.choice(families)])]
            while len(chosen) < length:
                if rng.random() < synth.get('match_mode', 0.0):
                    d = rng.choice(by_mode[chosen[-1]['mode']])
                else:
                    d = rng.choice(by_family[rng.choice(families)])
                if d['source'] != chosen[-1]['source']:
                    chosen.append(d)
            seq = np.concatenate([np.arange(d['first'], d['end']) for d in chosen])
            at = 0
            for j, d in enumerate(chosen):
                size = d['end'] - d['first']
                if j > 0:
                    rows_seq.append(seq); rows_pos.append(at); rows_y.append(1)
                if j < len(chosen) - 1 and size > 1:
                    rows_seq.append(seq); rows_pos.append(at + size - 1); rows_y.append(0)
                at += size
        # group rows by packet sequence for vectorised building
        grouped = collections.defaultdict(list)
        for i, s in enumerate(rows_seq):
            grouped[id(s)].append(i)
        seq_by_id = {id(s): s for s in rows_seq}
        for key, idx in grouped.items():
            X_parts.append(table.rows(seq_by_id[key], [rows_pos[i] for i in idx], style))
            ys.append(np.array([rows_y[i] for i in idx], np.int8))
            ws.append(np.full(len(idx), synth.get('weight', 1.0)))
    import scipy.sparse as sp
    return sp.vstack(X_parts, format='csr'), np.concatenate(ys), np.concatenate(ws)


def type_rows(table, train, offsets, sources, start_type, docs):
    globals_ = set()
    for k in train:
        o = offsets[k]
        for i in range(len(sources[k]['pages'])):
            if start_type[o + i] is not None:
                globals_.add(o + i)
    for d in docs:
        if d['source'] in train:
            globals_.add(d['first'])
    g = sorted(globals_)
    return table.type_rows(g, range(len(g))), [start_type[x] for x in g]


def best_threshold(y, p):
    order = np.argsort(-p)
    ys, ps = y[order], p[order]
    tp = np.cumsum(ys)
    fp = np.cumsum(1 - ys)
    total = ys.sum()
    if total == 0:
        return 0.5
    f1 = 2 * tp / (tp + fp + total)
    i = int(np.argmax(f1))
    return float(ps[i])


def fit_fold(table, train, offsets, sources, edge, inside, start_type, docs, cfg, rng):
    """Inner family split picks the threshold; then refit on every training family."""
    target, synth, style = cfg['target'], cfg['synth'], cfg['style']
    fams = sorted({sources[k]['family'] for k in train})
    r = random.Random(SEED)
    r.shuffle(fams)
    inner_val = set(fams[: max(1, len(fams) // 5)])
    inner_train = [k for k in train if sources[k]['family'] not in inner_val]
    inner_eval = [k for k in train if sources[k]['family'] in inner_val]
    X, y, w = training_rows(table, inner_train, offsets, sources, edge, inside, docs, target, scaled(synth, inner_train, train), style, rng)
    m = Splitter(table, style).fit(X, y, w)
    ys, ps = [], []
    for k in inner_eval:
        seq = np.arange(offsets[k], offsets[k] + len(sources[k]['pages']))
        if len(seq) < 2:
            continue
        yy, mask = page_truth(seq, edge, inside, target)
        ps.append(m.predict(seq)[mask]); ys.append(yy[mask])
    thr = best_threshold(np.concatenate(ys), np.concatenate(ps))
    X, y, w = training_rows(table, train, offsets, sources, edge, inside, docs, target, synth, style, rng)
    model = Splitter(table, style).fit(X, y, w)
    model.threshold = thr
    model.train_rows = int(len(y)); model.train_pos = int(y.sum())
    Xt, labels = type_rows(table, set(train), offsets, sources, start_type, docs)
    model.fit_type(Xt, labels)
    return model


def scaled(synth, part, whole):
    s = dict(synth)
    if s.get('packets'):
        s['packets'] = int(s['packets'] * len(part) / max(1, len(whole)))
    return s


def page_truth(seq, edge, inside, target):
    pos = seq[1:]
    if target == 'edge':
        return edge[pos].astype(int), inside[pos] == 0
    return np.maximum(edge[pos], inside[pos]).astype(int), np.ones(len(pos), bool)


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 1.0
    r = tp / (tp + fn) if tp + fn else 1.0
    return dict(tp=int(tp), fp=int(fp), fn=int(fn), precision=round(p, 4), recall=round(r, 4),
                f1=round(2 * p * r / (p + r), 4) if p + r else 0.0)


def parser_pages(path, source):
    """Pages (>= 2) on which the parser opens a document, from the grader's document-layer explain."""
    text = path.read_text(encoding='utf-8', errors='replace')
    gold = {x[0] for x in source['starts']}
    missed, spurious = set(), set()
    for line in text.splitlines():
        m = re.match(r'\s+([-+]) (p(\d{4})-l\d{4})@', line)
        if m:
            (missed if m.group(1) == '-' else spurious).add(m.group(2))
    starts = (gold - missed) | spurious
    head = re.search(r'== document: (\d+) missed, (\d+) spurious', text)
    return {int(s[1:5]) for s in starts}, starts, head is not None


def evaluate(models_by_source, eval_sources, sources, offsets, edge, inside, start_type, parser_dir, existing):
    """Pooled page metrics over real held-out packets for the model, the parser and existing models."""
    out = {}
    for target in ('edge', 'any'):
        acc = collections.defaultdict(lambda: [0, 0, 0])
        all_y, all_p = [], []
        exact = collections.Counter()
        for k in eval_sources:
            s = sources[k]
            n = len(s['pages'])
            seq = np.arange(offsets[k], offsets[k] + n)
            if n < 2:
                continue
            model = models_by_source[k]
            y, mask = page_truth(seq, edge, inside, target)
            p = model.probs[k]
            pred = (p >= model.threshold).astype(int)
            group = 'multi' if s['starts'] else 'single'
            for g in ('all', group):
                a = acc[('model', g)]
                a[0] += int(((pred == 1) & (y == 1) & mask).sum()); a[1] += int(((pred == 1) & (y == 0) & mask).sum()); a[2] += int(((pred == 0) & (y == 1) & mask).sum())
            exact[('model', group)] += int(((pred == y) | ~mask).all())
            all_y.append(y[mask]); all_p.append(p[mask])
            pf = parser_dir / f"{s['sha256']}.txt"
            if pf.exists():
                ppages, _, ok = parser_pages(pf, s)
                pp = np.array([int(i + 2 in ppages) for i in range(n - 1)])
                for g in ('all', group):
                    a = acc[('parser', g)]
                    a[0] += int(((pp == 1) & (y == 1) & mask).sum()); a[1] += int(((pp == 1) & (y == 0) & mask).sum()); a[2] += int(((pp == 0) & (y == 1) & mask).sum())
                exact[('parser', group)] += int(((pp == y) | ~mask).all())
                exact[('parser_n', group)] += 1
            exact[('n', group)] += 1
        res = {f'{who}/{g}': prf(*v) for (who, g), v in sorted(acc.items())}
        yy, pp = np.concatenate(all_y), np.concatenate(all_p)
        res['model/all']['average_precision'] = round(float(average_precision_score(yy, pp)), 4) if yy.sum() else None
        res['exact_packets'] = {f'{a}/{b}': v for (a, b), v in sorted(exact.items())}
        out[target] = res
    # type accuracy at true starts
    hit = collections.Counter()
    confusion = collections.Counter()
    for k in eval_sources:
        s = sources[k]
        n = len(s['pages'])
        seq = np.arange(offsets[k], offsets[k] + n)
        model = models_by_source[k]
        pos = [i for i in range(n) if start_type[offsets[k] + i] is not None]
        pred = model.predict_type(seq, pos)
        for i, t in zip(pos, pred):
            truth = start_type[offsets[k] + i]
            where = 'internal' if i > 0 else 'first_page'
            truth_c = truth if truth in model.classes else 'other'
            hit[(where, 'n')] += 1
            hit[(where, 'ok')] += int(t == truth_c)
            confusion[(truth, t)] += 1
    out['type'] = {w: dict(n=hit[(w, 'n')], accuracy=round(hit[(w, 'ok')] / max(1, hit[(w, 'n')]), 4)) for w in ('internal', 'first_page')}
    out['type_confusion_top'] = [[a, b, c] for (a, b), c in confusion.most_common(25) if a != b][:15]
    return out


def existing_comparison(existing_dir, eval_sources, sources, offsets, edge, inside, models_by_source, target='edge'):
    """On pages the existing doc-split model scored, compare at its 0.5 threshold."""
    res = {}
    for name in ('full-page-and-line/development-edges.json', 'quadrants-224/development.json'):
        f = existing_dir / name
        if not f.exists():
            continue
        prob = {r['sha256']: r['probabilities'] for r in json.loads(f.read_text())['sources']}
        acc = {'existing': [0, 0, 0], 'model': [0, 0, 0], 'parser': [0, 0, 0]}
        ys, pe, pm = [], [], []
        for k in eval_sources:
            s = sources[k]
            if s['sha256'] not in prob:
                continue
            n = len(s['pages'])
            seq = np.arange(offsets[k], offsets[k] + n)
            y, mask = page_truth(seq, edge, inside, target)
            model = models_by_source[k]
            pf = Path(PARSER_DIR) / f"{s['sha256']}.txt"
            ppages = parser_pages(pf, s)[0] if pf.exists() else set()
            for page_s, pr in prob[s['sha256']].items():
                i = int(page_s) - 2
                if i < 0 or i >= n - 1 or not mask[i]:
                    continue
                for who, val in (('existing', pr >= 0.5), ('model', model.probs[k][i] >= model.threshold), ('parser', i + 2 in ppages)):
                    a = acc[who]
                    a[0] += int(val and y[i]); a[1] += int(val and not y[i]); a[2] += int((not val) and y[i])
                ys.append(y[i]); pe.append(pr); pm.append(model.probs[k][i])
        if ys:
            res[name] = {who: prf(*v) for who, v in acc.items()}
            res[name]['pages'] = len(ys)
            res[name]['existing_ap'] = round(float(average_precision_score(ys, pe)), 4)
            res[name]['model_ap'] = round(float(average_precision_score(ys, pm)), 4)
    return res


PARSER_DIR = None


def main():
    global PARSER_DIR
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--data', type=Path, required=True)
    ap.add_argument('--parser-starts', type=Path, required=True)
    ap.add_argument('--existing', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--arms', default='real,real+synth,real+synth-nostyle,synth')
    ap.add_argument('--target', default='edge')
    ap.add_argument('--packets', type=int, default=6000)
    ap.add_argument('--folds', type=int, default=5)
    args = ap.parse_args()
    PARSER_DIR = args.parser_starts
    args.out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    sources, pages, offsets, edge, inside, start_type, docs = load(args.data)
    table = PageTable(pages)
    print(json.dumps(dict(sources=len(sources), pages=len(pages), edge_starts=int(edge.sum()), inside_starts=int(inside.sum()),
                          clean_docs=len(docs), families=len({s['family'] for s in sources}), own_dim=table.dim,
                          table_seconds=round(time.time() - t0, 1))), flush=True)
    arms = {
        'real': dict(target=args.target, style=True, synth=dict(packets=0)),
        'real+synth': dict(target=args.target, style=True, synth=dict(packets=args.packets, match_mode=0.7, weight=0.5)),
        'real+synth-nostyle': dict(target=args.target, style=False, synth=dict(packets=args.packets, match_mode=0.7, weight=0.5)),
        'synth': dict(target=args.target, style=True, synth=dict(packets=args.packets, match_mode=0.7, weight=0.5, real=False)),
    }
    # family folds, balanced by real starts
    fam_starts = collections.Counter()
    for s in sources:
        fam_starts[s['family']] += len(s['starts'])
    fams = sorted(fam_starts, key=lambda f: (-fam_starts[f], f))
    fold_of = {}
    r = random.Random(SEED)
    for i in range(0, len(fams), args.folds):
        block = list(range(args.folds))
        r.shuffle(block)
        for f, b in zip(fams[i:i + args.folds], block):
            fold_of[f] = b
    report = dict(data=dict(sources=len(sources), pages=len(pages), edge_starts=int(edge.sum()), inside_starts=int(inside.sum()),
                            multi_packets=sum(1 for s in sources if s['starts']), clean_docs=len(docs)), arms={})
    for arm in [a for a in args.arms.split(',') if a]:
        cfg = arms[arm]
        rng = random.Random(SEED)
        res = {}
        # design 1: grouped family folds over all sources
        models_by_source = {}
        tfit = time.time()
        for fold in range(args.folds):
            train = [k for k, s in enumerate(sources) if fold_of[s['family']] != fold]
            held = [k for k, s in enumerate(sources) if fold_of[s['family']] == fold]
            model = fit_fold(table, train, offsets, sources, edge, inside, start_type, docs, cfg, rng)
            model.probs = {}
            for k in held:
                seq = np.arange(offsets[k], offsets[k] + len(sources[k]['pages']))
                model.probs[k] = model.predict(seq)
                models_by_source[k] = model
            print(json.dumps(dict(arm=arm, fold=fold, train_sources=len(train), held=len(held), rows=model.train_rows,
                                  positives=model.train_pos, threshold=round(model.threshold, 3))), flush=True)
        res['folds'] = evaluate(models_by_source, range(len(sources)), sources, offsets, edge, inside, start_type, args.parser_starts, args.existing)
        res['folds']['fit_seconds'] = round(time.time() - tfit, 1)
        # design 2: the existing partition
        train = [k for k, s in enumerate(sources) if s['split'] == 'train']
        held = [k for k, s in enumerate(sources) if s['split'] == 'development']
        assert not ({sources[k]['family'] for k in train} & {sources[k]['family'] for k in held})
        model = fit_fold(table, train, offsets, sources, edge, inside, start_type, docs, cfg, rng)
        model.probs = {}
        mbs = {}
        for k in held:
            seq = np.arange(offsets[k], offsets[k] + len(sources[k]['pages']))
            model.probs[k] = model.predict(seq)
            mbs[k] = model
        res['existing_partition'] = evaluate(mbs, held, sources, offsets, edge, inside, start_type, args.parser_starts, args.existing)
        res['existing_partition']['vs_existing_models'] = existing_comparison(args.existing, held, sources, offsets, edge, inside, mbs)
        # CPU speed: features + both heads, one thread, on held-out packets, per page
        timed_pages = 0
        t = time.perf_counter()
        for k in held:
            sub = _bind(model, PageTable(sources[k]['pages']))
            sub.threads = 1
            seq = np.arange(len(sources[k]['pages']))
            p = sub.predict(seq)
            starts = [0] + [i + 1 for i in np.flatnonzero(p >= model.threshold)]
            sub.predict_type(seq, starts)
            timed_pages += len(seq)
        res['ms_per_page_cpu'] = round(1000 * (time.perf_counter() - t) / max(1, timed_pages), 3)
        res['timed_pages'] = timed_pages
        report['arms'][arm] = res
        print(json.dumps({arm: dict(folds_edge=res['folds']['edge'].get('model/all'), parser=res['folds']['edge'].get('parser/all'),
                                    type=res['folds']['type'], ms=res['ms_per_page_cpu'])}), flush=True)
        (args.out / 'report.json').write_text(json.dumps(report, indent=1))
    print('done', round(time.time() - t0, 1))


def _bind(model, table):
    s = Splitter(table, model.style)
    s.start, s.type, s.classes, s.threshold = model.start, model.type, model.classes, model.threshold
    return s


if __name__ == '__main__':
    main()
