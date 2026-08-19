import json, re, os
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))
M = json.load(open('_manual_map.json'))
CAT_LABEL = {'Q':'QUANTIFICATION','I':'IDENTIFICATION','L':'LINKAGE','P':'PROCEDURE_ANALYSIS','C':'COMPLETENESS','F':'FORMAT_DELIVERABLE'}

def derive_arm(path):
    m = re.search(r'beaver-[a-z0-9_]+', path)
    if m: return m.group(0)
    m = re.search(r'--([a-z0-9_]+v\d)/scores\.json$', path)
    if m: return m.group(1)
    return os.path.basename(os.path.dirname(path))

# Per-task: top categories + examples, plus judge-consistency (does top cat fail under ALL judges present?)
for t, v in sorted(master.items()):
    runs = v['runs']
    fc = Counter()
    for r in runs:
        for cid in r['failed']:
            fc[cid] += 1
    cat_crit = defaultdict(list)   # cat -> [(cid, title, cnt)]
    for cid, cnt in fc.items():
        cat = CAT_LABEL.get(M.get(t, {}).get(cid), 'UNMAPPED')
        crit = v['criteria'].get(cid, {})
        cat_crit[cat].append((cid, crit.get('title', cid), cnt))
    # judges present and their totals
    jruns = Counter(r['judge'] for r in runs)
    # For each category, how many distinct judges saw at least one fail event of that cat?
    cat_judges = defaultdict(set)
    for r in runs:
        for cid in r['failed']:
            cat = CAT_LABEL.get(M.get(t, {}).get(cid), 'UNMAPPED')
            cat_judges[cat].add(r['judge'])
    print(f'### {t}')
    print(f'  n_criteria={len(v["criteria"])} runs={len(runs)} distinct_failing={len(fc)} judges={dict(jruns)}')
    order = sorted(cat_crit, key=lambda c: -len(cat_crit[c]))
    for cat in order:
        items = sorted(cat_crit[cat], key=lambda x: -x[2])
        top = items[:2]
        ex = ' | '.join(f'{cid} "{tle[:48]}" x{cnt}' for cid, tle, cnt in top)
        njud = len(cat_judges[cat])
        print(f'    {cat:20s} n={len(items):3d}  (seen under {njud}/{len(jruns)} judges)  e.g. {ex}')
    print()
