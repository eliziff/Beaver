"""Search the parser's composed structure decisions against the structure gold's real scores.

A tagged run (score_all.py --tag BASE, with RESOLVER_DUMP=1) leaves every gold run's candidate and
the parser's witness dump: each counted line's witnesses at the heading stage and at the candidates
stage (legal-pdf-witnesses). Starting from the compositions in force (LEGALPDF_COMPOSITIONS or the
parser's shipped ones), each step proposes moves (add a conjunction a quick screen over the witnesses
ranks well, or drop one in force), finds from the dumps the documents a move changes, parses and
scores only those with the move in force, and keeps the move that most raises the training
documents' pooled score (documents split by a hash of their run); the held-out half is reported.

  python compose.py BASE [--steps 10] [--moves 12] [--out compositions.json]

The objective, per mode, is the mean pooled F1 of the layers in OBJECTIVE, summed over modes.
"""
import argparse, hashlib, json, os, sys, tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import evaluate, hierarchy_pass, score_all, worker  # noqa: E402

OUT = HERE.parents[1] / 'benchmarks/local-data/legal-structure-gold'
SHIPPED = HERE.parents[1] / 'legal-pdf-parser/legal-pdf-witnesses/data/compositions.json'
STAGE = {'heading': 'headings', 'list_item': 'candidates', 'numbered_paragraph': 'candidates'}
OBJECTIVE = ('hierarchy', 'hierarchy_units', 'roles', 'groups', 'joins')


def held_out(run):
    return int(hashlib.sha1(run.encode()).hexdigest(), 16) % 2 == 1


def labelled(row):
    """One run's witness rows: (run, stage, line id, witnesses, gold label)."""
    run, witnesses = row['run'], row.get('witnesses')
    if not witnesses or not Path(witnesses).is_file():
        return []
    try:
        _, reference = evaluate.state_of(hierarchy_pass.apply(OUT / run, worker.read_json(OUT / run / 'gold.json.gz')))
    except Exception:
        return []
    lines = {line['id']: line for line in reference['lines']}
    label = {}
    for group in reference['groups']:
        kind = 'numbered_paragraph' if group['kind'] == 'prose' and group['attributes'].get('marker') else group['kind']
        for ident in group['line_ids']:
            label[lines.get(ident, {}).get('source_id') or ident] = kind
    return [(run, item['stage'], item['id'], item['w'], label.get(item['id'], 'prose'))
            for item in map(json.loads, Path(witnesses).read_text(encoding='utf-8').splitlines())]


def holds(conjunctions, w):
    return any(all((w[name] >= t) if op == '>=' else (w[name] < t) for name, op, t in c) for c in conjunctions)


def verdicts(compositions, rows):
    """Per run, the tuple of every decision's verdict on every row it reads."""
    out = {}
    for run, stage, ident, w, _ in rows:
        for decision, sets in compositions['decisions'].items():
            if STAGE.get(decision) != stage: continue
            kind = 'recognized' if w['recognized'] >= 0.5 else 'typeset'
            if sets.get(kind):
                out.setdefault(run, []).append(holds(sets[kind], w))
    return {run: tuple(v) for run, v in out.items()}


def screen(rows, decision, kind, keep, sets):
    """Moves for one decision and kind of line, ranked in the context of the composition in force,
    never alone: an addition by what it adds on the lines the current union leaves out, a trimmer
    (a conjunction in force narrowed by one more literal) by the wrong lines it drops against the
    right ones it loses, given the rest of the union. Only proposals: the real scores judge them."""
    part = [r for r in rows if STAGE[decision] == r[1] and (r[3]['recognized'] >= 0.5) == (kind == 'recognized')
            and (decision == 'heading' or r[3].get('marker_any', 0) >= 0.5)]
    if len(part) < 200: return [], []
    names = sorted(part[0][3])
    X = np.array([[r[3][n] for n in names] for r in part], dtype=np.float32)
    y = np.array([r[4] == decision for r in part]); train = np.array([not held_out(r[0]) for r in part])
    column = {n: X[:, j] for j, n in enumerate(names)}
    def mask_of(conjunction):
        m = np.ones(len(y), bool)
        for name, op, t in conjunction:
            m &= (column[name] >= t) if op == '>=' else (column[name] < t)
        return m
    members = [mask_of(c) for c in sets]
    union = np.zeros(len(y), bool)
    for m in members: union |= m
    literals = []
    for name in names:
        values = np.unique(column[name])
        for t in ([0.5] if len(values) <= 2 else sorted(set(np.quantile(column[name], [0.1, 0.25, 0.5, 0.75, 0.9]).round(3)))):
            for op, m in (('>=', column[name] >= t), ('<', column[name] < t)):
                if 15 < m.sum() < len(y) - 15: literals.append(([name, op, float(t)], m))
    # Additions: what a conjunction adds outside the current union, on training documents.
    outside = ~union & train
    def added(m):
        n = int((m & outside).sum()); tp = int((m & outside & y).sum())
        return tp * tp / n - (n - tp) * 0.5 if n else -1
    seeds = sorted(literals, key=lambda l: -added(l[1]))[:60]
    additions = []
    for combo, m in seeds:
        additions.append((added(m), [combo], m))
        for lit, other in literals:
            if lit[0] != combo[0]: additions.append((added(m & other), [combo, lit], m & other))
    additions.sort(key=lambda a: -a[0])
    adds, seen = [], set()
    for value, combo, _ in additions:
        key = json.dumps(sorted(combo))
        if value > 0 and key not in seen and combo not in sets:
            seen.add(key); adds.append(combo)
        if len(adds) >= keep: break
    # Trimmers: narrow a member, counting only the lines no other member claims.
    trims = []
    for k, (conjunction, m) in enumerate(zip(sets, members)):
        others = np.zeros(len(y), bool)
        for j, other in enumerate(members):
            if j != k: others |= other
        own = m & ~others & train
        best = []
        for lit, other in literals:
            dropped = own & ~other
            gain = int((dropped & ~y).sum()) - int((dropped & y).sum())
            if gain > 0: best.append((gain, conjunction + [lit]))
        best.sort(key=lambda b: -b[0])
        trims.extend((k, c) for _, c in best[:3])
    return adds, trims


def objective(per_run, runs):
    total = 0.0
    for mode in ('digitalborn', 'ocr'):
        rows = [per_run[r] for r in runs if r.replace('\\', '/').startswith(mode) and r in per_run]
        if not rows: continue
        pooled = score_all.aggregate(rows)
        total += sum(pooled[layer]['f1'] for layer in OBJECTIVE if layer in pooled) / len(OBJECTIVE)
    return total


def evaluate_move(compositions, changed, items, base_metrics, workers):
    """Parse and score the changed runs with `compositions` in force; the rest keep the base's."""
    if not changed:
        return dict(base_metrics)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8') as handle:
        json.dump(compositions, handle); path = handle.name
    os.environ['LEGALPDF_COMPOSITIONS'] = path
    try:
        produced, _ = score_all.extract_all([i for i in items if str(i[1].relative_to(OUT)) in changed], OUT, workers)
        with ProcessPoolExecutor(workers) as pool:
            results = list(pool.map(score_all.score_one, [(run, str(OUT), file, None) for run, (file, _, _) in produced.items()]))
    finally:
        os.unlink(path)
    metrics = dict(base_metrics)
    for result in results:
        if 'metrics' in result:
            metrics[result['run']] = {'metrics': result['metrics']}
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('base', help='Tag of a run made with RESOLVER_DUMP=1 and the starting compositions in force')
    parser.add_argument('--steps', type=int, default=10)
    parser.add_argument('--moves', type=int, default=12, help='Conjunctions proposed per decision and kind each step')
    parser.add_argument('--out', type=Path, default=OUT / 'score/runs/compositions.json')
    parser.add_argument('--workers', type=int, default=os.cpu_count() or 8)
    args = parser.parse_args()
    runs_dir = OUT / 'score/runs'
    base = worker.read_json(runs_dir / f'{args.base}.json')
    manifest = worker.read_json(runs_dir / f'{args.base}.manifest.json')
    start = os.environ.get('LEGALPDF_COMPOSITIONS')
    compositions = json.loads(Path(start or SHIPPED).read_text(encoding='utf-8'))
    with ProcessPoolExecutor(args.workers) as pool:
        rows = [r for part in pool.map(labelled, manifest, chunksize=4) for r in part]
    items = {str(job.relative_to(OUT)): (mode, job, receipt) for mode, job, receipt in score_all.completed(OUT)}
    items = [items[r['run']] for r in manifest if r['run'] in items]
    metrics = {row['run']: {'metrics': row['metrics']} for row in base['per_run']}
    runs = list(metrics)
    train = [r for r in runs if not held_out(r)]; test = [r for r in runs if held_out(r)]
    current = verdicts(compositions, rows)
    print(f"start: train {objective(metrics, train):.4f}, held out {objective(metrics, test):.4f}")
    for step in range(args.steps):
        moves = []
        for decision in STAGE:
            for kind in ('typeset', 'recognized'):
                sets = compositions['decisions'].setdefault(decision, {}).setdefault(kind, [])
                adds, trims = screen(rows, decision, kind, args.moves, sets)
                for c in adds:
                    moves.append((f'+ {decision}/{kind} {c}', decision, kind, sets + [c]))
                for k, narrowed in trims:
                    moves.append((f'~ {decision}/{kind} {narrowed}', decision, kind, sets[:k] + [narrowed] + sets[k + 1:]))
                for k in range(len(sets)):
                    moves.append((f'- {decision}/{kind} {sets[k]}', decision, kind, sets[:k] + sets[k + 1:]))
        best = None
        for name, decision, kind, new_sets in moves:
            candidate = json.loads(json.dumps(compositions))
            candidate['decisions'][decision][kind] = new_sets
            changed = {run for run, v in verdicts(candidate, rows).items() if v != current.get(run)}
            if not changed: continue
            trial = evaluate_move(candidate, changed, items, metrics, args.workers)
            gain = objective(trial, train) - objective(metrics, train)
            print(f"  {gain:+.4f} on {len(changed):4} runs  {name[:110]}", flush=True)
            if best is None or gain > best[0]:
                best = (gain, name, candidate, trial)
        if best is None or best[0] <= 0.0002:
            break
        gain, name, compositions, metrics = best
        current = verdicts(compositions, rows)
        print(f"step {step + 1}: {name[:110]} -> train {objective(metrics, train):.4f}, held out {objective(metrics, test):.4f}", flush=True)
        args.out.write_text(json.dumps(compositions, indent=1), encoding='utf-8')
    print('->', args.out)


if __name__ == '__main__':
    main()
