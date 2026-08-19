import json, re
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))
CATS = ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']

def classify(crit):
    title = (crit.get('title') or '')
    mc = crit.get('match_criteria', [])
    if isinstance(mc, list):
        mc = ' || '.join(str(x) for x in mc)
    t = title.lower()
    text = (title + ' ' + str(mc)).lower()

    # ===== FORMAT / DELIVERABLE =====
    if re.search(r'\b(memo addressed|formatted as|professional law firm memorandum|memo includes|report includes|report correctly attributes|summary count|summary table of|table present|matrix present|matrix includes|matrix assigns|executive summary|organized (section|by)|section-by-section|deliverable \d exists|overall assessment of (closing|set)|checklist item reference|includes at least three specific recommended next steps|top \d critical issues)\b', text):
        return 'FORMAT_DELIVERABLE'

    # ===== QUANTIFICATION: numeric value is the load-bearing content =====
    q_strong = re.compile(r'\b(quantif|computed|calculates? the correct|correct (total|adjusted)|~?\$[\d][\d,.]*|[\d]+(\.\d+)?%|hhi|bps|debt-to-equity|ratio of approximately|negative spread|spread (of|quantified)|headcount|probability (of|assessment)|size-of-transaction threshold of|filing fee (as|of)|enterprise value of|annual license fee of|acv (of|at risk)|payout of approximately|exposure (of|at)|revenue at risk|outstanding balance|outstanding amount|total .* (cost|exposure|amount)|pricing (identified|of)|volume discount|fee identified|retention .* (period|deadline)|deadline of|aggregate financial exposure)\b')
    if q_strong.search(text):
        # disqualify pure-identification wording
        if not re.search(r'\b(identifies (the |that |whether )?[^ ]+ (as|to|which)|flags (the )?[a-z ]+ (as|to))', text) or 'quantif' in text or 'computed' in text or 'hhi' in t:
            return 'QUANTIFICATION'
    # explicit dollar/percent in title (non-incidental)
    if re.search(r'(\$[\d][\d,.]*|[0-9]+\.?[0-9]*%)', title):
        return 'QUANTIFICATION'

    # ===== COMPLETENESS: absence / missing / must-address / drafting coverage =====
    if re.search(r'\b(absence of|missing |identifies (need for|absence)|does not address|does not contain|gap(s)?\b|not (included|addressed|covered)|should (address|include|cover)|must (address|include|cover)|omission|omitted|deficiencies|need to delineate|scope of|even if (absent|no|there is no)|no (provision|clause|covenant) for|silent on|not contemplated|untreated|not .* required)\b', text):
        return 'COMPLETENESS'
    # drafting-coverage: "Indenture includes/addresses X" "Term sheet states X" type coverage requirements
    if re.search(r'\b(indenture (includes|addresses|specifies)|includes (a |the |continuing |after-acquired |fraudulent |trustee |lien |reporting |flexibility )|addresses (continuing|regulatory|intercreditor|foreign)|covers? the|required)\b', text) and 'identif' not in t:
        return 'COMPLETENESS'

    # ===== LINKAGE =====
    if re.search(r'\b(links?|connects?|connection|cross-reference|cross-references|cumulative assessment|compounding|compound(ing)? risk|overlap|tension (between|in)|interaction between|dual (character|role)|simultaneous|inconsistency between|conflict with|relationship between|implication for|in context of|combined effect|not terminated by|interaction with)\b', text):
        return 'LINKAGE'

    # ===== PROCEDURE / ANALYSIS =====
    if re.search(r'\b(recommend|analyz|assess|evaluat|discusses?|explains?|distinguishe?s?|applies?|classified as (administrative|significant|critical)|ranked as|rates |advises|prioritiz|categoriz|methodolog|framework|test for|precedent|standard for|safe harbor|arm.?s.?length|substance|characteriz|considers?|calculates? (the|adjusted)|computes? (correct|the)|reasons?|basis for|rationale|viability|implication|alternative|mitigat|resolves?|identifies? (as )?problematic|benchmarks?|proposes?)\b', text):
        return 'PROCEDURE_ANALYSIS'

    # ===== IDENTIFICATION (residual) =====
    return 'IDENTIFICATION'


per_task = {}
pooled_crit = Counter()
pooled_events = Counter()
pooled_judge_events = defaultdict(Counter)

for t, v in master.items():
    runs = v['runs']
    crit_info = {}
    for r in runs:
        for cid in r['failed']:
            if cid not in crit_info:
                crit = v['criteria'].get(cid, {})
                cat = classify(crit)
                crit_info[cid] = {'cat': cat, 'title': crit.get('title', cid), 'mc': crit.get('match_criteria', [])}
            pooled_events[crit_info[cid]['cat']] += 1
            pooled_judge_events[r['judge']][crit_info[cid]['cat']] += 1
    for cid, info in crit_info.items():
        pooled_crit[info['cat']] += 1
    per_task[t] = {'crit_info': crit_info, 'n_runs': len(runs),
                   'judges': Counter(r['judge'] for r in runs)}

print('=== POOLED ACROSS ALL 23 TASKS ===')
print('By distinct failing criteria (union):')
for c in CATS:
    print(f'  {c:20s} {pooled_crit[c]}')
print('By fail events (run x criterion):')
for c in CATS:
    print(f'  {c:20s} {pooled_events[c]}')
print('By fail events per judge:')
for j, cc in pooled_judge_events.items():
    print(f'  {j}: ' + ' '.join(f'{c}={cc[c]}' for c in CATS))

json.dump(per_task, open('_taxonomy_classified.json', 'w'), indent=1)
print('wrote _taxonomy_classified.json')
