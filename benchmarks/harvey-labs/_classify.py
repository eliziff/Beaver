import json, re
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))

CATS = ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']

def classify(crit):
    title = (crit.get('title') or '')
    mc = crit.get('match_criteria', [])
    if isinstance(mc, list):
        mc = ' || '.join(str(x) for x in mc)
    text = (title + ' ' + str(mc)).lower()

    # FORMAT/DELIVERABLE
    fmt = re.compile(r'\b(table|matrix|memo includes|report includes|formatted as|column|fields?\b|heading|structure|deliverable|summary (count|table)|organized|sections?|subsection|bullet|chart|executive summary|appendix)\b')
    # QUANTIFICATION
    qty = re.compile(r'(quantif|\$[\d,.]|percent|%|ratio|spread|amount|approximately|~[\d]|figure of|estimate[sd]? (the|potential|exposure)|threshold of|hhi|\bbps\b|share of|headcount|fee of|\bacv\b|range of|payout|probability|debt-to-equity|markup|amortization period|useful life|allocation|multiples?|compounded annual)')
    # LINKAGE
    lnk = re.compile(r'\b(links?|connects?|connection|cross-referenc|consolidated|cumulative|overlap(s|ping)?|compounding|compound|tension|relationship|between [a-z]|dual (character|role)|simultaneous|interaction|interrelated|implication for|meaning for)\b')
    # COMPLETENESS
    cmp = re.compile(r'\b(absence|lacks?|missing|not (included|addressed|covered)|should (address|include|covers?)|must (address|include)|even if (absent|no)|does not (contain|address|include|cover)|no .* (present|included)|gap|omission|omitted|exclusion|exception|exempt|carve.?out|basket|reservation|deficiency|insufficient|coverage)\b')
    # IDENTIFICATION
    ide = re.compile(r'\b(identif|names?|states|notes?|flags?|reports?|correctly states|references?|mentions?|addresses|attributes?|addressees?|documents?|part(y|ies)|date|deadline|cusip|section|clause|provision|term|applies to|governs|defines|titled|entitled)\b')
    # PROCEDURE/ANALYSIS
    pro = re.compile(r'\b(analyz|assess|evaluat|recommend|methodolog|reasoning|basis for|explain|explains?|discusses?|applies?|test for|distinguishe?s?|characteriz|considers?|calculat|precedent|standard for|analysis|approach|framework|prong|safe harbor|arm.?s.length|substantive|procedure)\b')

    scores = {}
    scores['FORMAT_DELIVERABLE'] = len(fmt.findall(text))
    scores['QUANTIFICATION'] = len(qty.findall(text))
    scores['LINKAGE'] = len(lnk.findall(text))
    scores['COMPLETENESS'] = len(cmp.findall(text))
    scores['IDENTIFICATION'] = len(ide.findall(text))
    scores['PROCEDURE_ANALYSIS'] = len(pro.findall(text))

    # Choose primary: highest score; ties broken by priority order below
    order = ['FORMAT_DELIVERABLE', 'QUANTIFICATION', 'LINKAGE', 'COMPLETENESS', 'IDENTIFICATION', 'PROCEDURE_ANALYSIS']
    best = max(order, key=lambda c: scores[c])
    return best, scores

# Classify every criterion in every task, and tally failures
per_task = {}
pooled_crit = Counter()          # type -> # distinct failing criteria (union)
pooled_events = Counter()        # type -> # fail events (run-criterion pairs)
pooled_judge_events = defaultdict(Counter)

for t, v in master.items():
    runs = v['runs']
    crit_info = {}
    for r in runs:
        for cid in r['failed']:
            if cid not in crit_info:
                crit = v['criteria'].get(cid, {})
                cat, sc = classify(crit)
                crit_info[cid] = {'cat': cat, 'scores': sc, 'title': crit.get('title', cid), 'mc': crit.get('match_criteria', [])}
            cat = crit_info[cid]['cat']
            pooled_events[cat] += 1
            pooled_judge_events[r['judge']][cat] += 1
    for cid, info in crit_info.items():
        pooled_crit[info['cat']] += 1
    per_task[t] = {'crit_info': crit_info, 'n_runs': len(runs),
                   'judges': Counter(r['judge'] for r in runs)}

print('=== POOLED ACROSS ALL 23 TASKS ===')
print('By distinct failing criteria (union):')
for c in ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']:
    print(f'  {c:20s} {pooled_crit[c]}')
print('By fail events (run x criterion):')
for c in ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']:
    print(f'  {c:20s} {pooled_events[c]}')
print('By fail events per judge:')
for j, cc in pooled_judge_events.items():
    print(f'  {j}: ' + ' '.join(f'{c}={cc[c]}' for c in ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']))

json.dump(per_task, open('_taxonomy_classified.json', 'w'), indent=1)
print('wrote _taxonomy_classified.json')
