"""Plain text read alone, scored against what the tags say. python -I plaincmp.py TAG OUT. Run from C:/courtlistener-structure."""
import json, collections, random, sys
sys.stdout.reconfigure(encoding='utf-8')
tag, out = sys.argv[1:3]; random.seed(9)
rows = {}
for l in open(f'{tag}/rows.jsonl', encoding='utf-8'):
    r = json.loads(l); rows[r['id']] = r
T = collections.Counter(); ex = collections.defaultdict(list)
norm = lambda s: str(s).strip('[]().,: ')
for l in open(f'samples/{out}-truth.jsonl', encoding='utf-8'):
    t = json.loads(l); y = rows.get(t['id'])
    if not y or 'panic' in y: T['panic'] += 1; continue
    T['records'] += 1
    got = {norm(x) for x in (y.get('note_labels') or [])}; want = set(t['notes'])
    if want:
        T['note truth'] += len(want); T['note found'] += len(want & got); T['note read'] += len({x for x in got if x.isdigit()}); T['note wrong'] += len({x for x in got if x.isdigit()} - want)
        if want - got: ex['note missed'].append((t['id'], sorted(want - got)[:6], len(want)))
        if {x for x in got if x.isdigit()} - want: ex['note extra'].append((t['id'], sorted({x for x in got if x.isdigit()} - want)[:6], len(want)))
    got = {str(x) for v in (y.get('pages') or {}).values() for x in v}; want = set(t['pages'])
    if want:
        T['page truth'] += len(want); T['page found'] += len(want & got)
        if want - got: ex['page missed'].append((t['id'], sorted(want - got)[:6], len(want)))
    got = {str(x) for x in (y.get('numbers') or [])}; want = {str(x) for x in t['signs']}
    if len(want) >= 3:
        T['sign truth'] += len(want); T['sign found'] += len(want & got)
        if want - got: ex['sign missed'].append((t['id'], sorted(want - got, key=lambda v: int(v))[:6], len(want)))
    got = {h.lower().strip() for h in (y.get('headings') or []) if isinstance(h, str)}; want = {h for h in t['heads'] if len(h) > 2 and h != 'notes'}
    if want:
        T['heading truth'] += len(want); T['heading found'] += len(want & got)
print(dict(T))
for a, b, c in (('note found', 'note truth', 'footnotes found (recall)'), ('page found', 'page truth', 'page marks found (recall)'), ('sign found', 'sign truth', 'paragraph signs found (recall)'), ('heading found', 'heading truth', 'headings found (recall)')):
    if T[b]: print(f'{c:34}{T[a]:>9,} of {T[b]:>9,} {T[a] * 100 / T[b]:6.2f}%')
if T['note read']: print(f"footnote numbers read that the tags confirm {100 - T['note wrong'] * 100 / T['note read']:.2f}% of {T['note read']:,} (precision)")
for k, v in ex.items():
    print(k, len(v)); [print('  ', x) for x in random.sample(v, min(6, len(v)))]
