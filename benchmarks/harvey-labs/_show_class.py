import json, sys

per_task = json.load(open('_taxonomy_classified.json'))
which = sys.argv[1] if len(sys.argv) > 1 else 'tax/draft-transfer-pricing-documentation'

v = per_task[which]
info = v['crit_info']
# sort by category then id
from collections import defaultdict
by_cat = defaultdict(list)
for cid, d in info.items():
    by_cat[d['cat']].append(cid)
for cat in ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']:
    cids = sorted(by_cat.get(cat, []))
    if not cids:
        continue
    print(f'\n### {cat} ({len(cids)})')
    for cid in cids:
        print(f'  {cid}: {info[cid]["title"][:110]}')
