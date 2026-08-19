import json
from collections import Counter, defaultdict

CATS = ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']
CAT_LABEL = {'Q':'QUANTIFICATION','I':'IDENTIFICATION','L':'LINKAGE','P':'PROCEDURE_ANALYSIS','C':'COMPLETENESS','F':'FORMAT_DELIVERABLE'}

M = json.load(open('_manual_map.json'))          # task -> cid -> single-letter cat
master = json.load(open('_taxonomy_master.json'))  # task -> {runs, criteria}

# Check coverage: every failing criterion in master must be in M
missing = []
for t, v in master.items():
    seen = set()
    for r in v['runs']:
        for cid in r['failed']:
            seen.add(cid)
    for cid in seen:
        if (t, cid) not in [(t, k) for k in M.get(t, {})]:
            missing.append((t, cid))
print('MISSING from manual map:', len(missing))
for x in missing[:30]:
    print('  ', x)

# ---- Build per-task aggregates ----
# We need judge + arm info per run. Check master run schema.
def show_run_keys(v):
    r0 = v['runs'][0]
    return list(r0.keys())

print('\nRun keys:', show_run_keys(list(master.values())[0]))
print('Task keys:', list(list(master.values())[0].keys()))

# ---- Distributions ----
# Per task: distinct failing criteria union + fail events, split by cat; also per judge events
def full_report():
    out_lines = []
    for t, v in master.items():
        runs = v['runs']
        judges = Counter(r['judge'] for r in runs)
        arms = Counter(r.get('arm') or r.get('trial') or r.get('variant') or '?' for r in runs)
        crit_fail_count = Counter()   # cid -> #runs failing it
        for r in runs:
            for cid in r['failed']:
                crit_fail_count[cid] += 1
        # distinct criteria by cat
        dc = Counter()
        ev = Counter()
        ev_judge = defaultdict(Counter)
        ev_arm = defaultdict(Counter)
        for cid, cnt in crit_fail_count.items():
            cat = CAT_LABEL.get(M.get(t, {}).get(cid, '?'), 'UNMAPPED')
            dc[cat] += 1
            ev[cat] += cnt
        for r in runs:
            for cid in r['failed']:
                cat = CAT_LABEL.get(M.get(t, {}).get(cid, '?'), 'UNMAPPED')
                ev_judge[r['judge']][cat] += 1
                ev_arm[r.get('arm') or r.get('trial') or r.get('variant') or '?'][cat] += 1
        n_crit = len(v['criteria'])
        n_failed_distinct = len(crit_fail_count)
        out_lines.append(f"### TASK: {t}")
        out_lines.append(f"  n_criteria={n_crit}  runs={len(runs)}  distinct_failing={n_failed_distinct}  judges={dict(judges)}")
        out_lines.append(f"  DISTINCT failing criteria by category:")
        for c in CATS:
            out_lines.append(f"    {c:20s} {dc[c]}")
        out_lines.append(f"  FAIL EVENTS by category:")
        for c in CATS:
            out_lines.append(f"    {c:20s} {ev[c]}")
        out_lines.append(f"  FAIL EVENTS by category per judge:")
        for j in sorted(ev_judge):
            cc = ev_judge[j]
            out_lines.append(f"    {j:20s} " + ' '.join(f"{c}={cc[c]}" for c in CATS))
        out_lines.append('')
    return '\n'.join(out_lines)

rep = full_report()
open('_taxonomy_report.txt', 'w', encoding='utf-8').write(rep)
print('wrote _taxonomy_report.txt', len(rep.splitlines()), 'lines')
