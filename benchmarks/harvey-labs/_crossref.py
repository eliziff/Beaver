import json, re, os
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))
CAT_LABEL = {'Q':'QUANTIFICATION','I':'IDENTIFICATION','L':'LINKAGE','P':'PROCEDURE_ANALYSIS','C':'COMPLETENESS','F':'FORMAT_DELIVERABLE'}
M = json.load(open('_manual_map.json'))

def derive_arm(path):
    m = re.search(r'beaver-[a-z0-9_]+', path)
    if m:
        return m.group(0)
    m = re.search(r'--([a-z0-9_]+v\d)/scores\.json$', path)
    if m:
        return m.group(1)
    return os.path.basename(os.path.dirname(path))

def arm_cls(a):
    if 'mike_upstream_native_v1' in a: return 'NATIVE'
    if 'reqecho' in a: return 'REQECHO'
    if a.startswith('beaver-coding_markdown_v5'): return 'LEAN'
    return a

# ============ 1. POOLED TAXONOMY ============
print('=== POOLED TAXONOMY (all 23 tasks, manual map) ===')
pooled_crit = Counter(); pooled_ev = Counter(); pooled_judge_ev = defaultdict(Counter)
for t, v in master.items():
    fc = Counter()
    for r in v['runs']:
        for cid in r['failed']:
            fc[cid] += 1
    for cid, cnt in fc.items():
        cat = CAT_LABEL.get(M.get(t, {}).get(cid), 'UNMAPPED')
        pooled_crit[cat] += 1
        pooled_ev[cat] += cnt
    for r in v['runs']:
        for cid in r['failed']:
            cat = CAT_LABEL.get(M.get(t, {}).get(cid), 'UNMAPPED')
            pooled_judge_ev[r['judge']][cat] += 1
print('By distinct failing criteria (union of 706):')
for c in ['QUANTIFICATION','IDENTIFICATION','LINKAGE','PROCEDURE_ANALYSIS','COMPLETENESS','FORMAT_DELIVERABLE']:
    print(f'  {c:20s} {pooled_crit[c]:4d}  ({100*pooled_crit[c]/706:.1f}%)')
print('By fail events:')
for c in ['QUANTIFICATION','IDENTIFICATION','LINKAGE','PROCEDURE_ANALYSIS','COMPLETENESS','FORMAT_DELIVERABLE']:
    print(f'  {c:20s} {pooled_ev[c]:4d}  ({100*pooled_ev[c]/sum(pooled_ev.values()):.1f}%)')
print('By fail events per judge:')
for j, cc in sorted(pooled_judge_ev.items()):
    tot = sum(cc.values())
    print(f'  {j:20s} ' + ' '.join(f'{c[0]}={cc[c]}' for c in ['QUANTIFICATION','IDENTIFICATION','LINKAGE','PROCEDURE_ANALYSIS','COMPLETENESS','FORMAT_DELIVERABLE']) + f'  total={tot}')

# ============ 2. NATIVE vs LEAN vs REQECHO, same judge ============
print()
print('=== NATIVE/LEAN/REQECHO cross-reference, per judge ===')
for t in sorted(master):
    buckets = defaultdict(list)
    for r in master[t]['runs']:
        a = derive_arm(r['path'])
        cls = arm_cls(a)
        if cls in ('NATIVE','LEAN','REQECHO'):
            buckets[(cls, r['judge'])].append(r['n_pass'])
    if not buckets: continue
    lines = []
    for (cls, j), passes in sorted(buckets.items()):
        lines.append(f'{cls[:6]:8s}[{j[:12]:12s}] n={len(passes):2d} pass={min(passes)}..{max(passes)} mean={sum(passes)/len(passes):.1f}')
    if len(buckets) >= 2:
        print(f'{t[:58]:60s}')
        for l in lines: print('   ' + l)

# ============ 3. DeepSeek-only native vs lean (gen-7 fixed judge) ============
print()
print('=== DEEPSEEK-ONLY native vs lean vs reqecho ===')
for t in sorted(master):
    b = defaultdict(list)
    for r in master[t]['runs']:
        if r['judge'] != 'deepseek-v4-flash': continue
        a = derive_arm(r['path'])
        cls = arm_cls(a)
        if cls in ('NATIVE','LEAN','REQECHO'):
            b[cls].append(r['n_pass'])
    if b:
        parts = []
        for cls in ('NATIVE','LEAN','REQECHO'):
            if cls in b:
                ps = b[cls]
                parts.append(f'{cls[:6]}={min(ps)}..{max(ps)}(n{len(ps)})')
        print(f'{t[:55]:57s} ' + '  '.join(parts))
