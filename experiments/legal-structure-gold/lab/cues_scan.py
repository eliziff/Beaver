"""On recognized (OCR) documents, among body pieces that follow another body piece on the same page:
how each cue separates the pieces that open a gold text unit from the ones that continue one, and
how tier 0 reads them (merged = gold opens, parser continues; split = the reverse).

  python cues_scan.py ROWS_DIR [mode]
"""
import collections
import re
import sys

import numpy as np

import lab
from lab import RI

root = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "ocr"
docs = [d for d in lab.load(root, "train") if d["mode"] == mode]
F = {name: k for k, name in enumerate(lab.NAMES)}
BODY = {RI["text"], RI["provision"], RI["list_item"]}
items = []
for doc in docs:
    X, text, n = doc["X"], doc["text"], len(doc["text"])
    if n < 2:
        continue
    r0, s0, rg, sg, pages = doc["r0"], doc["s0"], doc["rg"], doc["sg"], doc["pages"]
    c = lambda name, k: X[k, F[name]]
    for k in range(1, n):
        if rg[k] not in BODY or rg[k - 1] not in BODY or pages[k] != pages[k - 1] or r0[k] not in BODY or r0[k - 1] not in BODY:
            continue
        opens = sg[k] == 1
        parser_opens = s0[k] == 1
        prev = text[k - 1].rstrip()
        t = text[k].strip()
        cues = {
            "gap_above>0.3": c("gap_above", k) > 0.3, "gap_above>0.5": c("gap_above", k) > 0.5, "gap_above>0.8": c("gap_above", k) > 0.8,
            "gap_above>1.2": c("gap_above", k) > 1.2,
            "indent>0.01": c("indent", k) > 0.01, "indent>0.02": c("indent", k) > 0.02, "indent>0.04": c("indent", k) > 0.04,
            "indent_vs_prev>0.01": c("indent", k) - c("indent", k - 1) > 0.01,
            "prev_ends_period": c("ends_period", k - 1) > 0, "prev_ends_colon": c("ends_colon", k - 1) > 0,
            "prev_short(<0.6)": c("width", k - 1) < 0.6, "prev_short(<0.8)": c("width", k - 1) < 0.8,
            "prev_ends_hyphen": c("ends_hyphen", k - 1) > 0,
            "starts_upper": c("starts_upper", k) > 0, "starts_lower": c("starts_lower", k) > 0, "starts_digit": c("starts_digit", k) > 0,
            "starts_mark": c("starts_mark", k) > 0, "marker": c("marker", k) > 0,
            "enumerated": re.match(r"^\s*(?:\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivxlc]{1,6}\)|\[\d{1,4}\]|\d{1,3}(\.\d{1,3})+)\s", t) is not None,
            "short_line(<0.6)": c("width", k) < 0.6, "both_short": c("width", k) < 0.6 and c("width", k - 1) < 0.6,
            "size_change": abs(c("size_change", k) - 1) > 0.1, "font_change": c("font_change", k) > 0,
            "bold_change": abs(c("bold", k) - c("bold", k - 1)) > 0.5,
            "prev_ends_period&indent": c("ends_period", k - 1) > 0 and c("indent", k) > 0.01,
            "prev_ends_period&gap>0.3": c("ends_period", k - 1) > 0 and c("gap_above", k) > 0.3,
            "prev_short&starts_upper": c("width", k - 1) < 0.8 and c("starts_upper", k) > 0,
            "x0_vs_prev>0.01": c("x0", k) - c("x0", k - 1) > 0.01, "x0_vs_prev<-0.01": c("x0", k) - c("x0", k - 1) < -0.01,
            "prose: prev<0.75 & cur>=0.6 & upper": c("width", k - 1) < 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0,
            "prose: ... & prev ends period": c("width", k - 1) < 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0 and c("ends_period", k - 1) > 0,
            "prose: ... & prev no period": c("width", k - 1) < 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0 and c("ends_period", k - 1) == 0,
            "prose: ... & no period & gap>0.3": c("width", k - 1) < 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0 and c("ends_period", k - 1) == 0 and c("gap_above", k) > 0.3,
            "prose: prev>=0.75 & cur>=0.6 & upper": c("width", k - 1) >= 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0,
            "prose: prev>=0.75 & upper & indent>0.01": c("width", k - 1) >= 0.75 and c("width", k) >= 0.6 and c("starts_upper", k) > 0 and c("indent", k) - c("indent", k - 1) > 0.01,
            "short block: both<0.6 & upper": c("width", k - 1) < 0.6 and c("width", k) < 0.6 and c("starts_upper", k) > 0,
        }
        items.append((opens, parser_opens, cues))
total = len(items)
opens = sum(o for o, _, _ in items)
merged = sum(1 for o, p, _ in items if o and not p)
split = sum(1 for o, p, _ in items if p and not o)
print(f"{mode}: {total} body pieces after a body piece; gold opens {opens} ({opens / total:.2f}); parser opens {sum(p for _, p, _ in items)}; merged {merged}, split {split}")
print(f"  {'cue':26} {'n':>7} {'P(opens|cue)':>13} {'share of opens':>15} {'P(opens|not)':>13} {'parser P(opens|cue)':>20}")
for cue in items[0][2]:
    w = [(o, p) for o, p, c in items if c[cue]]
    wo = [o for o, p, c in items if not c[cue]]
    print(f"  {cue:26} {len(w):7} {sum(o for o, _ in w) / max(len(w), 1):13.2f} {sum(o for o, _ in w) / max(opens, 1):15.2f} {sum(wo) / max(len(wo), 1):13.2f} {sum(p for _, p in w) / max(len(w), 1):20.2f}")
