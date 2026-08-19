import json
from collections import defaultdict
master = json.load(open('_taxonomy_master.json'))
M = json.load(open('_manual_map.json'))
CAT = {'Q':'QUANTIFICATION','I':'IDENTIFICATION','L':'LINKAGE','P':'PROCEDURE_ANALYSIS','C':'COMPLETENESS','F':'FORMAT_DELIVERABLE'}
cat_tasks = defaultdict(set)
cat_per_task = defaultdict(dict)
for t, v in master.items():
    fc = set()
    for r in v['runs']:
        for cid in r['failed']:
            fc.add(cid)
    for cid in fc:
        c = CAT.get(M.get(t, {}).get(cid), '?')
        cat_tasks[c].add(t)
        cat_per_task[c][t] = cat_per_task[c].get(t, 0) + 1

print('=== UNIVERSALITY: how many of 23 tasks show each category ===')
for c in ['IDENTIFICATION','PROCEDURE_ANALYSIS','QUANTIFICATION','LINKAGE','COMPLETENESS','FORMAT_DELIVERABLE']:
    print('  %-20s appears in %d/23 tasks' % (c, len(cat_tasks[c])))

print()
print('=== TASK-SPECIFIC CONCENTRATION per category ===')
for c in ['LINKAGE','COMPLETENESS','FORMAT_DELIVERABLE','QUANTIFICATION']:
    top = sorted(cat_per_task[c].items(), key=lambda x: -x[1])[:3]
    tot = sum(cat_per_task[c].values())
    row = ' | '.join('%s=%d' % (t[:44], n) for t, n in top)
    print('  %-20s total=%3d  top: %s' % (c, tot, row))

# Which tasks are SINGLE-category dominant (>40% of their distinct failures in one cat)
print()
print('=== TASKS WITH A SINGLE DOMINANT FAILURE CATEGORY (>40% of distinct failures) ===')
for t, v in master.items():
    fc = set()
    for r in v['runs']:
        for cid in r['failed']:
            fc.add(cid)
    catc = defaultdict(int)
    for cid in fc:
        c = CAT.get(M.get(t, {}).get(cid), '?')
        catc[c] += 1
    tot = len(fc)
    dom = max(catc.items(), key=lambda x: x[1])
    if dom[1] / tot > 0.40:
        print('  %-58s %-20s %.0f%% (%d/%d)' % (t[:57], dom[0], 100*dom[1]/tot, dom[1], tot))
