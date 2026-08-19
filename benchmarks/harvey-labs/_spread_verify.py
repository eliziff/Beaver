import json, re, os
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))

def derive_arm(path):
    # New task-area layout: results/<area>/<task>/<arm>-<model>/<ts>/scores.json
    m = re.search(r'beaver-[a-z0-9_]+(?:v\d[^/]*)?', path)
    if m:
        return m.group(0)
    # Flat 2026-08-03 layout: 2026-08-03-...--<arm>/scores.json
    m = re.search(r'--([a-z0-9_]+v\d)/scores\.json$', path)
    if m:
        return m.group(1)
    # Flat ab/cx/pilot dirs
    b = os.path.basename(os.path.dirname(path))
    return b

# Build (task, arm, judge) -> list of n_pass
groups = defaultdict(list)
for t, v in master.items():
    for r in v['runs']:
        arm = derive_arm(r['path'])
        n_crit = r['n_crit']
        n_pass = r['n_pass']
        # verify n_pass is number
        if isinstance(n_pass, (int, float)):
            score = n_pass / n_crit * 100 if n_crit else 0
        else:
            score = None
        groups[(t, arm, r['judge'])].append({'n_pass': n_pass, 'n_crit': n_crit, 'score': score, 'path': r['path']})

# Judge-spread: for each group with >=2 runs, compute range of n_pass and score
print('=== JUDGE SPREAD (same task + arm + judge, >=2 replicates) ===')
print(f'{"task":58s} {"arm":28s} {"judge":18s} n  n_pass(min-max)  spread  score(range)')
spread_rows = []
for (t, arm, judge), runs in sorted(groups.items()):
    if len(runs) >= 2:
        passes = [r['n_pass'] for r in runs]
        scores = [r['score'] for r in runs]
        spread = max(passes) - min(passes)
        spread_rows.append((t, arm, judge, len(runs), spread))
        # score spread in points
        sc_spread = max(scores) - min(scores)
        print(f'{t[:57]:58s} {arm[:27]:28s} {judge[:17]:18s} {len(runs)}  {min(passes)}..{max(passes)}  {spread:3d}  {sc_spread:.1f}')

print()
print('=== SPREAD SUMMARY ===')
spreads = [s for (_,_,_,_,s) in spread_rows]
print('groups with >=2 replicates:', len(spread_rows))
print('mean spread (n_pass):', sum(spreads)/len(spreads) if spreads else 0)
print('median spread:', sorted(spreads)[len(spreads)//2] if spreads else 0)
print('max spread:', max(spreads) if spreads else 0)

# Now specifically: tax v5 deepseek replicates
print()
print('=== TAX v5 deepseek replicates detail ===')
for (t, arm, judge), runs in sorted(groups.items()):
    if t == 'tax/draft-transfer-pricing-documentation' and arm.startswith('beaver-coding_markdown_v5') and judge == 'deepseek-v4-flash':
        for r in runs:
            print(' ', r['n_pass'], '/', r['n_crit'], r['path'])

# Native vs lean cross-reference: for each task, native = *native_v1*, lean = *coding_markdown_v5*
print()
print('=== NATIVE vs LEAN cross-reference (per task, same judge where possible) ===')
native_kw = 'mike_upstream_native_v1'
lean_kw = 'coding_markdown_v5'
for t in sorted(master):
    native_runs = [r for r in master[t]['runs'] if native_kw in derive_arm(r['path'])]
    lean_runs = [r for r in master[t]['runs'] if lean_kw in derive_arm(r['path']) and 'reqecho' not in derive_arm(r['path']) and 'echo' not in derive_arm(r['path'])]
    reqecho_runs = [r for r in master[t]['runs'] if 'reqecho' in derive_arm(r['path'])]
    if native_runs or lean_runs:
        def summ(runs):
            if not runs: return '--'
            passes = [r['n_pass'] for r in runs]
            return f'n={len(runs)} pass={min(passes)}..{max(passes)} mean={sum(passes)/len(passes):.1f} judges={dict(Counter(r["judge"] for r in runs))}'
        print(f'{t[:60]:62s}')
        print(f'   NATIVE  : {summ(native_runs)}')
        print(f'   LEAN(v5): {summ(lean_runs)}')
        if reqecho_runs:
            print(f'   REQECHO : {summ(reqecho_runs)}')
