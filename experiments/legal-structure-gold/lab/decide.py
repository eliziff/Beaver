"""One heading decision over the evidence table, prototyped in the lab: each piece's own evidence
(type against the document's body, case, length, place against its neighbours) and its neighbours',
combined once by named rules, measured as heading unit F1 against tier 0.

  python decide.py ROWS_DIR [show N]
"""
import collections
import re
import sys

import numpy as np

import lab
from lab import R, RI

ROOT = sys.argv[1]
SHOW = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[2] == "show" else 0

F = None
LABEL = re.compile(r"(?i)^\W*(?:appearances?|comparutions?|counsel|solicitors?|whereas|between|and|et entre|entre|attention|attn|address|adresse|tel(?:ephone)?|phone|fax|e-?mail|courriel|(?:court )?file no\.?|per|by|name|title|date|signature|witness|re)\s*:?\W*$")
PARAGRAPH = re.compile(r"^\s*(?:\[\d{1,4}\]|\(\d{1,3}\)|\([a-z]{1,4}\)|\d{1,4}\s*\(\d{1,3}\))")
ENUMERATED = re.compile(r"^\s*(?:(?:part|partie|section|article|chapter|chapitre|schedule|annexe?|appendix|division|title|titre|book|livre|rule|règle|form)\s+\S|(?:\d{1,3}(?:\.\d{1,3})*|[A-Z]|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})[.)]?\s+\S|\(?[A-Za-z0-9]{1,3}\)\s+\S)", re.I)
SUBSECTION = re.compile(r"^\s*(?:\d{1,4}(?:\.\d{1,3})*\s*)?\((?:\d{1,3}|[a-z]{1,4})\)\s+\S")


def titlecase(text):
    words = [w for w in re.findall(r"[^\W\d_]+", text) if len(w) >= 2]
    if not words:
        return 0.0
    return sum(w[0].isupper() for w in words) / len(words)


def decide(doc):
    """(region, start) for every piece: tier 0's, with the heading decision made over again."""
    X, text, n = doc["X"], doc["text"], len(doc["text"])
    region, start = doc["r0"].copy(), doc["s0"].copy()
    if n == 0:
        return region, start, []
    r0, s0, pages, look, trail = doc["r0"], doc["s0"], doc["pages"], doc["look"], doc["trail"]
    col = lambda name: X[:, F[name]]
    width, length, gap_above, gap_below = col("width"), col("length"), col("gap_above"), col("gap_below")
    bold, underlined, italic, size, upper = col("bold"), col("underlined"), col("italic"), col("size"), col("upper")
    look_share, body_style, centre = col("look_share"), col("body_style"), col("centre")
    first_on_page, last_on_page = col("first_on_page"), col("last_on_page")
    ends_period, ends_comma, ends_colon, starts_lower, starts_mark = col("ends_period"), col("ends_comma"), col("ends_colon"), col("starts_lower"), col("starts_mark")
    excluded = {RI["note"], RI["contents"], RI["line_label"], RI["page_label"], RI["furniture"], RI["quote"], RI["note_quote"]}
    # The decisions, in order; a heading's wrapped line joins it.
    heads = np.zeros(n, dtype=bool)
    why = [""] * n
    for k in range(n):
        if r0[k] in excluded or doc["region_type"][k] in ("footnote", "footer", "header"):
            continue
        t = text[k].strip()
        letters = sum(c.isalpha() for c in t)
        if letters < 2:
            continue
        same_page_prev = k > 0 and pages[k - 1] == pages[k]
        same_page_next = k + 1 < n and pages[k + 1] == pages[k]
        # Named evidence.
        short = width[k] < 0.6
        brief = length[k] < 0.9                       # under ~90 characters
        sentence = ends_period[k] > 0 or ends_comma[k] > 0
        caps = upper[k] >= 0.9 and letters >= 3
        cased = caps or titlecase(t) >= 0.6
        typed = bold[k] > 0.5 or underlined[k] > 0.5 or size[k] >= 1.1 or (italic[k] > 0.5 and body_style[k] == 0)
        rare = look_share[k] < 0.3
        apart_above = gap_above[k] > 0.5 or first_on_page[k] > 0 or not same_page_prev or (same_page_prev and heads[k - 1])
        next_long = same_page_next and width[k + 1] >= 0.6
        next_paragraph = same_page_next and PARAGRAPH.match(text[k + 1]) is not None
        apart_below = gap_below[k] > 0.5 or last_on_page[k] > 0 or next_long or next_paragraph
        own_block = s0[k] != 0
        label = LABEL.match(t) is not None or (ends_colon[k] > 0 and len(t.split()) <= 3)
        paragraph = PARAGRAPH.match(t) is not None or (starts_lower[k] > 0) or starts_mark[k] > 0
        subsection_next = same_page_next and SUBSECTION.match(text[k + 1]) is not None and not ENUMERATED.match(t)
        placed = r0[k] == RI["heading"] and s0[k] == 1 and ("outline" in trail[k] or "rules_promote" in trail[k])
        if placed:
            heads[k] = True; why[k] = "placed"
        elif not (short and brief and not sentence and not label and not paragraph):
            continue
        elif subsection_next and not caps and not typed:
            continue                                  # a marginal note over its subsection
        elif typed and (apart_above or apart_below) and (cased or caps):
            heads[k] = True; why[k] = "typed"
        elif typed and apart_above and apart_below:
            heads[k] = True; why[k] = "typed-apart"
        elif not typed and cased and rare and apart_above and apart_below and own_block:
            heads[k] = True; why[k] = "set-apart"
    # Headings, with wrapped lines joined: a line of the same look right under a heading that ends
    # no sentence, opening no number of its own, continues it.
    for k in range(n):
        if heads[k]:
            region[k] = RI["heading"]; start[k] = 1
            j = k
            while j + 1 < n and pages[j + 1] == pages[j] and look[j + 1] == look[j] and look[j] >= 0 and gap_above[j + 1] < 0.5 \
                    and ends_period[j] == 0 and not heads[j + 1] and width[j + 1] < 0.6 and not ENUMERATED.match(text[j + 1]) and r0[j + 1] not in excluded:
                j += 1
                region[j] = RI["heading"]; start[j] = 0; why[j] = "wrapped"
        elif r0[k] == RI["heading"]:
            # A heading tier 0 read that the decision does not: back to text, its own unit.
            region[k] = RI["text"]; start[k] = 1 if s0[k] != 0 else 0
    return region, start, why


if __name__ == "__main__":
    for split in ("train", "development"):
        docs = lab.load(ROOT, split)
        F = {name: k for k, name in enumerate(lab.NAMES)}
        lab.table(f"tier 0, {split}", lab.score(docs, lab.tier0, kinds=("heading", "body")), kinds=("heading", "body"))
        lab.table(f"decision, {split}", lab.score(docs, lambda d: decide(d)[:2], kinds=("heading", "body")), kinds=("heading", "body"))
        if split == "development" and SHOW:
            fp, fn = collections.defaultdict(list), collections.defaultdict(list)
            for doc in docs:
                region, start, why = decide(doc)
                for k in range(len(region)):
                    if doc["rg"][k] < 0:
                        continue
                    g = doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1
                    p = region[k] == RI["heading"] and start[k] == 1
                    if p and not g:
                        fp[(doc["mode"], why[k])].append((doc["sha"][:8], doc["pages"][k] + 1, R[doc["rg"][k]], doc["text"][k][:80]))
                    elif g and not p:
                        fn[(doc["mode"], why[k] or "-")].append((doc["sha"][:8], doc["pages"][k] + 1, R[doc["r0"][k]], doc["text"][k][:80]))
            import random
            random.seed(1)
            for name, groups in (("FALSE HEADINGS by rule (gold region shown)", fp), ("MISSED HEADINGS (parser region shown)", fn)):
                print(f"\n{name}")
                for key, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
                    print(f"  {key}: {len(items)}")
                    for sha, page, other, t in random.sample(items, min(SHOW, len(items))):
                        print(f"     {sha} p{page:<3} {other:12} | {t}")
