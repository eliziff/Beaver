import json
from collections import Counter, defaultdict

data = json.load(open('_taxonomy_consolidated.json'))

# Focus on deepseek-v4-flash judged runs for the primary analysis
for key, v in data.items():
    print('=' * 100)
    print(f'TASK: {key}  (total criteria: {v["n_total"]})')
    runs = v['runs']
    # all runs
    print(f'  total runs: {len(runs)}')
    # filter deepseek
    ds_runs = [r for r in runs if r['judge'] == 'deepseek-v4-flash']
    print(f'  deepseek-v4-flash runs: {len(ds_runs)}')
    # build fail counter
    fc = Counter()
    run_fails = defaultdict(list)  # crit -> list of run files
    for r in ds_runs:
        for cid in r['failed']:
            fc[cid] += 1
            run_fails[cid].append(r['file'] + ' (' + str(r['n_passed']) + 'p)')
    print(f'  distinct criteria that failed in >=1 ds run: {len(fc)}')
    # sort by frequency
    for cid, cnt in fc.most_common():
        crit = v['criteria'][cid]
        title = crit['title']
        mc = crit.get('match_criteria', [])
        mc_str = json.dumps(mc)[:200] if mc else '(no match_criteria)'
        print(f'   FAIL[{cnt:2d}/{len(ds_runs):2d}] {cid}: {title}')
        print(f'        match: {mc_str}')
        # show run files
        print(f'        runs: {", ".join(run_fails[cid])}')
    # stable vs noise: criteria that failed in >50% of ds runs
    thr = len(ds_runs) / 2
    stable = [c for c, n in fc.items() if n > thr]
    print(f'  STABLE (failed in >50% of ds runs, n_ds={len(ds_runs)}): {sorted(stable)}')
