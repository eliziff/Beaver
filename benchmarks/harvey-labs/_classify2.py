import json, re
from collections import Counter, defaultdict

master = json.load(open('_taxonomy_master.json'))

CATS = ['QUANTIFICATION', 'IDENTIFICATION', 'LINKAGE', 'PROCEDURE_ANALYSIS', 'COMPLETENESS', 'FORMAT_DELIVERABLE']

def text_of(crit):
    title = (crit.get('title') or '')
    mc = crit.get('match_criteria', [])
    if isinstance(mc, list):
        mc = ' || '.join(str(x) for x in mc)
    return title, (title + ' ' + str(mc)).lower()

def classify(crit):
    title, text = text_of(crit)
    t = title.lower()

    # --- FORMAT / DELIVERABLE: structure of the memo/report/deliverable itself ---
    fmt_phrases = [
        'action item matrix present', 'action item matrix includes', 'risk quantification table present',
        'memo includes', 'report includes', 'formatted as', 'includes a table', 'summary count',
        'overall assessment of', 'professional law firm memorandum', 'matrix present',
        'matrix includes', 'table present', 'structured summary', 'risk quantification table',
        'list of all', 'organized by', 'executive summary', 'section',
    ]
    if any(p in text for p in fmt_phrases) or re.search(r'\b(matrix|table) (includes|present|presents|has|assigns)\b', text):
        # Only if it's about the structure of the deliverable, not a substantive issue.
        if not re.search(r'identified|flagged|risk|issue|exposure|address', text.split('MC:')[0].lower()) or 'matrix' in t or 'table' in t:
            return 'FORMAT_DELIVERABLE'

    # --- QUANTIFICATION: a number/amount/ratio/spread/figure must be stated ---
    q_verb = re.compile(r'(quantif|the specific .* (amount|ratio|rate|figure|number|spread)|\bstate[sd]? (the|a|an) (specific )?(amount|dollar|figure|ratio|rate)|approximate (annual|total)|potential .* exposure of|estimated .* of|reports? (a|an|the) (specific )?(increase|combined share|fee|amount|ratio)|correctly states .* fee of|fee of \$|\$[\d][\d,.]*|~[\d]|\d+(\.\d+)?%|\bmarkup inconsistency exposure\b|negative spread|\bdebt-to-equity ratio\b|1\.85:1|ratio of approximately|spread quantified|headcount growth quantified|adjusted for|risk quantification (includes|table))')
    # quantitative fact words (numbers appearing as the load-bearing content)
    if q_verb.search(text) or re.search(r'\b(amount|spread|ratio|headcount|hhi|fee|acv|payout|probability|percentage|margin|bps)\b', t):
        # but exclude pure identification where number is incidental
        if re.search(r'\b(quantif|spread|ratio|headcount|hhi|fee of|acv|payout|probability|percentage|exposure of|reports .* (increase|share|fee|amount)|states .* fee of)\b', text) or 'quantified' in t:
            return 'QUANTIFICATION'

    # --- LINKAGE: cross-document / cross-provision connection ---
    link_phrases = [
        'links', 'link to', 'connects', 'connection', 'cross-referenced', 'consolidated or cross-referenced',
        'cumulative assessment', 'overlaps with', 'compounding issue', 'compounding',
        'dual character', 'dual role', 'simultaneously serves', 'tension (between|in)',
        'relationship between', 'between .* and', 'interaction', 'interrelated', 'connecting',
        'cross-document', 'link', 'cross-reference', 'inconsistency between', 'conflict with',
        'conduit concern', 'circular cash flow', 'implication for',
    ]
    if re.search(r'\b(links?|connects?|connection|cross-referenc|consolidated|cumulative assessment|overlap|compounding|compound|tension|dual (character|role)|simultaneous|interaction|between [a-z]|conflict with|inconsistency between)\b', text):
        # Only if the criterion is fundamentally about drawing the connection, not merely naming two things.
        if re.search(r'\b(links?|connects?|connection|cross-referenc|consolidated|cumulative|overlap|compounding|tension|dual (character|role)|simultaneous|inconsistency between|conflict with)\b', text):
            return 'LINKAGE'

    # --- COMPLETENESS: an issue must be addressed even if the underlying fact is absent ---
    if re.search(r'\b(absence|lacks?|missing|not (included|addressed|covered)|should (address|include|cover)|must (address|include|cover)|even if (absent|no|the)|does not (contain|address|include|cover)|gap|omission|omitted|excluded|not (contemplated|prepared|documented))\b', text):
        if re.search(r'\b(absence|lacks?|missing|not (included|addressed|covered|contemplated|prepared|documented)|should (address|include|cover)|must (address|include|cover)|gap|omission|omitted)\b', text):
            return 'COMPLETENESS'

    # --- PROCEDURE / ANALYSIS: reasoning step, recommendation, method, assessment ---
    if re.search(r'\b(recommend|analyz|assess|evaluat|methodolog|reasoning|basis for|explain|discusses?|applies?|test for|distinguishe?s?|characteriz|considers?|calculat|precedent|standard for|approach|framework|prong|safe harbor|arm.?s.?length|substance|prioritiz|rank|categoriz|severity|deficiency|viability|rationale)\b', text):
        return 'PROCEDURE_ANALYSIS'

    # --- IDENTIFICATION (residual): name a party/term/date/flag/document ---
    return 'IDENTIFICATION'


# Run classification
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
            cat = crit_info[cid]['cat']
            pooled_events[cat] += 1
            pooled_judge_events[r['judge']][cat] += 1
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
