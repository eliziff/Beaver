"""Pool the per-split grades of both arms and print key layers, pooled and per document.

  structure_report.py      (run in the markers work directory)
Writes structure-ab/merged-<arm>-<set>.json (per_run lists) for compare_group.py.
"""
import json, sys
from pathlib import Path
sys.stdout.reconfigure(encoding='utf-8')
root = Path(__file__).resolve().parent / 'structure-ab'
LAYERS = ['markers_list_item', 'units_list_item', 'markers_text', 'units_text', 'note_references', 'note',
          'transcription', 'units_heading', 'hierarchy_parent', 'order', 'coverage']
KEY = ['markers_list_item', 'units_list_item', 'markers_text', 'note_references', 'transcription']
SETS = {'development': ['development'], 'held-out (dev+test)': ['development', 'test'],
        'train (in A training data)': ['train'], 'all': ['development', 'test', 'train']}


def runs(arm, splits):
    out = []
    for split in splits:
        out += json.loads((root / f'grade-{arm}-{split}.json').read_text(encoding='utf-8'))['per_run']
    return {r['source_sha256']: r for r in out}


def f1(t):
    e, p, c = t
    pr = c / p if p else 1.0
    rc = c / e if e else 1.0
    return 2 * pr * rc / (pr + rc) if pr + rc else 0.0


def pooled(rs, layer):
    t = [0, 0, 0]
    for r in rs:
        m = r['metrics'].get(layer)
        if m:
            t[0] += m['expected']; t[1] += m['predicted']; t[2] += m['correct']
    return t


for name, splits in SETS.items():
    a, b = runs('shipped', splits), runs('packA', splits)
    shas = sorted(set(a) & set(b))
    for arm, rs in (('shipped', a), ('packA', b)):
        (root / f"merged-{arm}-{name.split()[0]}.json").write_text(json.dumps({'per_run': [rs[s] for s in shas]}))
    print(f'\n== {name}: {len(shas)} documents')
    print(f"{'layer':18} {'expected':>8} {'shipped':>8} {'packA':>8} {'delta':>7} better worse")
    for layer in LAYERS:
        ta, tb = pooled([a[s] for s in shas], layer), pooled([b[s] for s in shas], layer)
        better = worse = 0
        for s in shas:
            ma, mb = a[s]['metrics'].get(layer), b[s]['metrics'].get(layer)
            if ma and mb:
                d = f1((mb['expected'], mb['predicted'], mb['correct'])) - f1((ma['expected'], ma['predicted'], ma['correct']))
                better += d > 1e-9; worse += d < -1e-9
        print(f'{layer:18} {ta[0]:8} {f1(ta):8.3f} {f1(tb):8.3f} {f1(tb) - f1(ta):+7.3f} {better:6} {worse:5}')
print('\n== per document (F1 shipped -> packA)')
a, b = runs('shipped', ['development', 'test', 'train']), runs('packA', ['development', 'test', 'train'])
print(f"{'doc':10} {'split':6} " + ' '.join(f'{k[:14]:>15}' for k in KEY))
for s in sorted(a, key=lambda s: (a[s]['split'], s)):
    cells = []
    for k in KEY:
        ma, mb = a[s]['metrics'].get(k), b[s]['metrics'].get(k)
        if not ma or ma['expected'] == 0 and mb['predicted'] == 0 and ma['predicted'] == 0:
            cells.append(f"{'-':>15}")
            continue
        fa, fb = f1((ma['expected'], ma['predicted'], ma['correct'])), f1((mb['expected'], mb['predicted'], mb['correct']))
        cells.append(f'{fa:.2f}>{fb:.2f}({ma["expected"]:>3})'.rjust(15))
    print(f"{s[:10]} {a[s]['split'][:5]:6} " + ' '.join(cells))
