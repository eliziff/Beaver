import json
from collections import Counter

master = json.load(open('_taxonomy_master.json'))

lines = []
for t, v in master.items():
    runs = v['runs']
    n_total = len(v['criteria'])
    fc = Counter()
    for r in runs:
        for cid in r['failed']:
            fc[cid] += 1
    judges = Counter(r['judge'] for r in runs)
    lines.append(f'### TASK: {t}  (n_criteria={n_total}, runs={len(runs)}, judges={dict(judges)})')
    lines.append(f'### distinct failing criteria: {len(fc)}')
    for cid, cnt in fc.most_common():
        crit = v['criteria'].get(cid, {})
        title = crit.get('title', cid)
        lines.append(f'  {cid} [{cnt}/{len(runs)}] {title}')
    lines.append('')

open('_titles.txt', 'w', encoding='utf-8').write('\n'.join(lines))
print('wrote _titles.txt', len(lines))
