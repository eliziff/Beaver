import json, io, sys

data = json.load(open('_taxonomy_consolidated.json'))

buf = io.StringIO()

for key, v in data.items():
    runs = v['runs']
    ds = [r for r in runs if r['judge'] == 'deepseek-v4-flash']
    other = [r for r in runs if r['judge'] != 'deepseek-v4-flash']
    buf.write('=' * 100 + '\n')
    buf.write(f'TASK: {key}  (total criteria: {v["n_total"]})\n')
    buf.write(f'  deepseek runs: {len(ds)}; other-judge runs: {len(other)}\n')
    # fail counts across ALL runs
    from collections import Counter
    fc_all = Counter()
    for r in runs:
        for cid in r['failed']:
            fc_all[cid] += 1
    fc_ds = Counter()
    for r in ds:
        for cid in r['failed']:
            fc_ds[cid] += 1
    # sort by ds fail count desc, then all
    crit_ids = sorted(fc_all.keys(), key=lambda c: (-fc_ds[c], -fc_all[c]))
    buf.write(f'  distinct failing criteria (all runs): {len(crit_ids)}\n\n')
    for cid in crit_ids:
        crit = v['criteria'][cid]
        buf.write(f'  {cid} | dsFail={fc_ds[cid]}/{len(ds)} allFail={fc_all[cid]}/{len(runs)} | {crit["title"]}\n')
        mc = crit.get('match_criteria', [])
        if mc:
            # join match_criteria strings
            if isinstance(mc, list):
                mcs = ' || '.join(str(x) for x in mc)
            else:
                mcs = str(mc)
            buf.write(f'      MC: {mcs}\n')

open('_taxonomy_failures.txt', 'w', encoding='utf-8').write(buf.getvalue())
print('wrote _taxonomy_failures.txt, bytes=', len(buf.getvalue()))
