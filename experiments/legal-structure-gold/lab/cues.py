"""Among the candidate pool (short lines ending no sentence, with letters, outside notes and
contents), how well each named cue separates gold heading starts from the rest, by mode: the cue's
count, the share of its lines that are heading starts, and the share of all heading starts it holds.

  python cues.py ROWS_DIR
"""
import collections
import re
import sys

import numpy as np

import lab
from lab import RI
from decide import LABEL, PARAGRAPH, ENUMERATED, SUBSECTION, titlecase

root = sys.argv[1]
docs = lab.load(root, "train")
F = {name: k for k, name in enumerate(lab.NAMES)}
excluded = {RI["note"], RI["contents"], RI["line_label"], RI["page_label"], RI["furniture"], RI["note_quote"]}
rows = collections.defaultdict(list)   # mode -> list of (is_heading, {cue: bool})
for doc in docs:
    X, text, n = doc["X"], doc["text"], len(doc["text"])
    if n == 0:
        continue
    r0, s0, pages, look = doc["r0"], doc["s0"], doc["pages"], doc["look"]
    c = lambda name, k: X[k, F[name]]
    for k in range(n):
        if doc["rg"][k] < 0 or r0[k] in excluded:
            continue
        t = text[k].strip()
        letters = sum(ch.isalpha() for ch in t)
        if letters < 2 or c("width", k) >= 0.6 or c("ends_period", k) > 0 or c("ends_comma", k) > 0 or c("length", k) >= 0.9:
            continue
        g = doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1
        prev_ok = k > 0 and pages[k - 1] == pages[k]
        next_ok = k + 1 < n and pages[k + 1] == pages[k]
        caps = c("upper", k) >= 0.9 and letters >= 3
        cues = {
            "bold": c("bold", k) > 0.5, "underlined": c("underlined", k) > 0.5, "larger": c("size", k) >= 1.1,
            "italic": c("italic", k) > 0.5, "caps": caps, "titlecase": titlecase(t) >= 0.6 and not caps,
            "rare_look": c("look_share", k) < 0.3, "body_style": c("body_style", k) > 0.5,
            "gap_above": c("gap_above", k) > 0.5, "gap_below": c("gap_below", k) > 0.5,
            "first_on_page": c("first_on_page", k) > 0, "own_block": s0[k] != 0,
            "next_long": next_ok and c("width", k + 1) >= 0.6, "next_paragraph": next_ok and PARAGRAPH.match(text[k + 1]) is not None,
            "next_short_same_look": next_ok and c("width", k + 1) < 0.6 and look[k + 1] == look[k],
            "prev_short_same_look": prev_ok and c("width", k - 1) < 0.6 and look[k - 1] == look[k],
            "prev_long": prev_ok and c("width", k - 1) >= 0.6,
            "enumerated": ENUMERATED.match(t) is not None, "paragraph_number": PARAGRAPH.match(t) is not None,
            "label": LABEL.match(t) is not None, "ends_colon": c("ends_colon", k) > 0,
            "subsection_next": next_ok and SUBSECTION.match(text[k + 1]) is not None,
            "centred": abs(c("centre", k)) < 0.04, "indented": c("indent", k) > 0.03,
            "region_caption": doc["region_type"][k] == "caption", "region_heading": doc["region_type"][k] == "heading",
            "tier0_heading": r0[k] == RI["heading"] and s0[k] == 1, "tier0_list": r0[k] == RI["list_item"],
            "tier0_table": r0[k] == RI["table"],
            "very_short": c("length", k) < 0.6, "one_word": len(t.split()) == 1,
            "starts_digit": c("starts_digit", k) > 0, "ocr_line": c("ocr", k) > 0,
        }
        rows[doc["mode"]].append((g, cues))
for mode, items in rows.items():
    total = len(items)
    heads = sum(g for g, _ in items)
    print(f"\n{mode}: candidate pool {total} lines, {heads} heading starts ({heads / total:.2f})")
    print(f"  {'cue':22} {'n':>7} {'P(heading|cue)':>15} {'share of headings':>18} {'P(heading|not cue)':>19}")
    for cue in items[0][1]:
        with_ = [g for g, c in items if c[cue]]
        without = [g for g, c in items if not c[cue]]
        print(f"  {cue:22} {len(with_):7} {sum(with_) / max(len(with_), 1):15.2f} {sum(with_) / max(heads, 1):18.2f} {sum(without) / max(len(without), 1):19.2f}")
