import os, json
from collections import Counter

sweep = json.load(open('_sweep_all.json'))

# Load criteria per task
task_defs = {}
for s in sweep:
    t = s['task']
    if t in task_defs:
        continue
    cands = [
        os.path.join('tasks', t, 'task.json'),
        os.path.join('tasks', t.replace('/scenario-01', ''), 'task.json'),
    ]
    for c in cands:
        if os.path.isfile(c):
            d = json.load(open(c))
            task_defs[t] = {c['id']: c for c in d['criteria']}
            break

# Master record
master = {}
for s in sweep:
    t = s['task']
    if t not in master:
        master[t] = {'runs': [], 'criteria': task_defs.get(t, {})}
    master[t]['runs'].append(s)

# Save master
json.dump(master, open('_taxonomy_master.json', 'w'), indent=1)
print('master tasks:', len(master))

# Generate failure dump with full text
lines = []
for t, v in master.items():
    runs = v['runs']
    n_total = len(v['criteria'])
    judge_counts = Counter(r['judge'] for r in runs)
    lines.append('=' * 110)
    lines.append(f'TASK: {t}   (total criteria: {n_total}; runs: {len(runs)}; judges: {dict(judge_counts)})')
    # fail counter across all runs
    fc = Counter()
    for r in runs:
        for cid in r['failed']:
            fc[cid] += 1
    # Also count per judge
    fc_judge = {}
    for j in judge_counts:
        fc_judge[j] = Counter()
        for r in runs:
            if r['judge'] == j:
                for cid in r['failed']:
                    fc_judge[j][cid] += 1
    lines.append(f'  distinct failing criteria: {len(fc)}')
    # sort by total fail count desc
    for cid, cnt in fc.most_common():
        crit = v['criteria'].get(cid, {})
        title = crit.get('title', '?')
        mc = crit.get('match_criteria', [])
        if isinstance(mc, list):
            mcs = ' || '.join(str(x) for x in mc)
        else:
            mcs = str(mc)
        jstr = ' '.join(f'{j}:{fc_judge[j].get(cid, 0)}/{judge_counts[j]}' for j in judge_counts)
        lines.append(f'  FAIL[{cnt:3d}/{len(runs):3d}] {cid} {jstr} | {title}')
        lines.append(f'      MC: {mcs}')
    lines.append('')

open('_taxonomy_failures_full.txt', 'w', encoding='utf-8').write('\n'.join(lines))
print('wrote _taxonomy_failures_full.txt lines=', len(lines))
