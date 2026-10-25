"""Paired span outcomes (stock vs candidate) with an exact two-sided sign test on discordant spans."""
import json, sys
from math import comb
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rapidfuzz.distance import Levenshtein
from ocr_ab import predictions
from markers import usable, is_target, offset_text, span_status
from screen import normalized

split, base, cand = sys.argv[1:4]
a, _ = predictions(split, base)
b, _ = predictions(split, cand)
keys = sorted(k for k in a if a[k][1] is not None and b[k][1] is not None and is_target(a[k][0]) and usable(a[k][0]))


def outcomes(preds, k):
    r, line, _ = preds[k]
    gold = offset_text(r['text'])
    ops = Levenshtein.opcodes(gold, normalized(line['text']))
    return [('reference', span_status(ops, s, e, gold) == 'ok') for s, e in r['refs']] + \
           [('marker', span_status(ops, s, e, gold) == 'ok') for s, e in r['markers'] if s == 0]


for kind in ['marker', 'reference']:
    fixed = broken = 0
    for k in keys:
        for (ka, oka), (kb, okb) in zip(outcomes(a, k), outcomes(b, k)):
            if ka != kind:
                continue
            fixed += (not oka) and okb
            broken += oka and not okb
    n = fixed + broken
    p = min(1.0, 2 * sum(comb(n, i) for i in range(0, min(fixed, broken) + 1)) / 2 ** n) if n else 1.0
    print(json.dumps({'split': split, 'candidate': cand, 'kind': kind, 'fixed': fixed, 'broken': broken, 'sign_test_p': p}))
