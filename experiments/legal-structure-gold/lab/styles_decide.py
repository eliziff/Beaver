"""Headings by within-document style induction, prototyped in the lab.

Each document's candidate lines are grouped by style (look, column, placement in the column, case,
standing alone, enumerator family). A group is a heading style by its own evidence inside the
document: its lines stand alone, are set apart from their column neighbours, govern what follows
(a long line or a marker line next in the column), are not form labels, and where numbered run in
sequence. A member of a heading style is a heading when it governs something itself or is set apart
below. Headings the document's own outline placed stay. Measured as heading unit F1 against tier 0.

  python styles_decide.py ROWS_DIR GOLD_TYPES [show N]
"""
import collections
import json
import re
import sys

import numpy as np

import lab
from lab import R, RI
import styles
from styles import columns, case_class, enumerator_family

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root, types_path = sys.argv[1], sys.argv[2]
SHOW = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[3] == "show" else 0
types = json.load(open(types_path, encoding="utf-8"))
F = {name: k for k, name in enumerate(lab.NAMES)}
excluded = {RI["note"], RI["contents"], RI["line_label"], RI["page_label"], RI["furniture"], RI["note_quote"]}
LABEL = re.compile(r"(?i)^\W*(?:appearances?|comparutions?|counsel|solicitors?|whereas|between|among|and|et entre|entre|attention|attn|address|adresse|tel(?:ephone)?|phone|fax|e-?mail|courriel|(?:court )?file no\.?|per|by|name|title|date|dated|signature|signed|witness|re|to|from|cc|subject|citation|docket|registry|before|heard|coram|court|judge|plaintiff|defendant|applicant|respondent|appellant|petitioner|claimant|moving party|responding party)\s*:?\W*$")
KEEP = ("outline", "rules_promote")
ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7, "viii": 8, "ix": 9, "x": 10, "xi": 11, "xii": 12, "xiii": 13, "xiv": 14, "xv": 15, "xvi": 16, "xx": 20}


def ordinal(text):
    m = re.match(r"^\s*(?:(?:part|partie|article|section|schedule|chapter|chapitre|annexe?|division|title|titre|rule|book|livre)\s+)?[\[(]?([0-9]{1,3}|[ivxlcdm]{1,6}|[a-z])(?:\.[0-9]{1,3})*[.)\]]?(?:\s|$)", text, re.I)
    if not m:
        return None
    v = m.group(1).lower()
    if v.isdigit():
        return int(v)
    if v in ROMAN:
        return ROMAN[v]
    return ord(v) - 96 if len(v) == 1 else None


def evidence(doc):
    """Per piece: column-aware evidence for the style decision, or None where no candidate."""
    X, n, pages, text, look = doc["X"], len(doc["text"]), doc["pages"], doc["text"], doc["look"]
    cols = columns(doc)
    x0, y0, x1, y1 = X[:, F["x0"]], X[:, F["y0"]], X[:, F["x1"]], X[:, F["y1"]]
    out = [None] * n
    # Same-column neighbours by vertical order; a line in the margin beside its column (a marginal
    # note) is no neighbour of the column's lines.
    def margin(k):
        i, left, right, _ = cols[k]
        width = max(right - left, 0.05)
        return (x1[k] - x0[k]) / width < 0.3 and (x0[k] < left - 0.02 or x1[k] > right + 0.02)
    prev_in, next_in = [None] * n, [None] * n
    for p in np.unique(pages):
        ks = np.where(pages == p)[0]
        by_col = collections.defaultdict(list)
        for k in ks:
            by_col[(cols[k][0], margin(k))].append(k)
        for members in by_col.values():
            members.sort(key=lambda k: (y0[k] + y1[k]) / 2)
            for pos, k in enumerate(members):
                prev_in[k] = members[pos - 1] if pos > 0 else None
                next_in[k] = members[pos + 1] if pos + 1 < len(members) else None
    heights = y1 - y0
    unit = float(np.median(heights[heights > 0])) if (heights > 0).any() else 0.01
    # A heading wrapped onto the next line: the line right under in the column, in the same look
    # and case, with no blank between, the first ending no sentence and the second opening no
    # number. The pair reads as one line: its gap above is the first's, its gap below and what it
    # governs the last's, and its width the widest. `wrap_of[k]` names the head line of k's unit.
    wrap_of = list(range(n))
    for k in range(n):
        q = next_in[k]
        if q is None or q != k + 1 or wrap_of[k] != k and False:
            continue
        head = wrap_of[k]
        t, u = text[k].strip(), text[q].strip()
        same_look = look[q] == look[k] and case_class(t) == case_class(u)
        gap = (y0[q] - y1[k]) / unit
        if same_look and gap < 0.5 and not re.search(r"[.;:!?]\s*$", t) and enumerator_family(u) == "" \
                and (x1[k] - x0[k]) < 0.9 * max(cols[k][2] - cols[k][1], 0.05) and sum(c.isalpha() for c in u) >= 2:
            wrap_of[q] = head
    units = collections.defaultdict(list)
    for k in range(n):
        units[wrap_of[k]].append(k)
    for k in range(n):
        i, left, right, count = cols[k]
        width = max(right - left, 0.05)
        rel = (x1[k] - x0[k]) / width
        t = text[k].strip()
        centre = ((x0[k] + x1[k]) / 2 - (left + right) / 2) / width
        indent = (x0[k] - left) / width
        if abs(centre) < 0.04 and rel < 0.8:
            placement = "centred"
        elif indent < 0.03:
            placement = "flush"
        elif rel < 0.3 and (x0[k] < left - 0.02 or x1[k] > right + 0.02):
            placement = "margin"
        else:
            placement = "indented"
        # Evidence is read over the line's whole wrapped unit: from its head line to its last.
        head, last = wrap_of[k], units[wrap_of[k]][-1]
        p, q = prev_in[head], next_in[last]
        gap_above = (y0[head] - y1[p]) / unit if p is not None else 3.0
        gap_below = (y0[q] - y1[last]) / unit if q is not None else 3.0
        next_rel = (x1[q] - x0[q]) / width if q is not None else 0.0
        rel = max((x1[j] - x0[j]) / width for j in units[head])
        t = text[head].strip()
        # A line ending a clause or a list item's term (";", ":", "and", "or") heads nothing.
        clause_end = re.search(r"(?:[;:,.]|\b(?:and|or|et|ou))\s*$", t) is not None
        out[k] = {
            # A wrapped line's continuation is no candidate of its own: its head line carries the unit.
            "candidate": head == k and doc["rg"][k] >= 0 and doc["r0"][k] not in excluded and doc["region_type"][k] not in ("footnote", "header", "footer", "caption")
                         and sum(c.isalpha() for c in t) >= 2 and not clause_end and rel < 0.9,
            "unit": units[head],
            "long": rel >= 0.6 and len(t) >= 60,
            "key": (int(look[k]), i if count > 1 else 0, placement, case_class(t), rel < 0.6, enumerator_family(t)),
            "alone": rel < 0.6, "rel": rel, "placement": placement,
            "apart_above": gap_above > 0.5, "apart_below": gap_below > 0.5,
            "governs": q is not None and (next_rel >= 0.6 or X[q, F["marker"]] > 0 or enumerator_family(text[q]) != "")
                       and not (X[q, F["ends_period"]] == 0 and next_rel < 0.6 and look[q] == look[k]),
            "label": LABEL.match(t) is not None or (X[k, F["ends_colon"]] > 0 and len(t.split()) <= 3),
            # Over a provision's subsection: "(3) For the purposes", "7.1. (1) Any step" (a marginal note's place).
            "subsection_next": q is not None and re.match(r"^\s*(?:\d{1,4}(?:\.\d{1,3})*\.?\s*)?\(\s*(?:\d{1,3}|[a-z]{1,4})\s*\)\s+\S", text[q]) is not None,
            "bold": X[k, F["bold"]] > 0.5, "larger": X[k, F["size"]] >= 1.1, "caps": case_class(t) == "caps",
            "underlined": X[k, F["underlined"]] > 0.5, "ordinal": ordinal(t), "next": q, "prev": p,
            "prev_short_same": p is not None and look[p] == look[k] and (x1[p] - x0[p]) / width < 0.6 and X[p, F["ends_period"]] == 0,
        }
    return out


def decide(doc, why_out=None):
    ev = evidence(doc)
    n = len(ev)
    region, start = doc["r0"].copy(), doc["s0"].copy()
    if n == 0:
        return region, start
    # The document's type (the gold's, an oracle here for a detector): an instrument numbers its
    # provisions, so its arabic-numbered captions are provisions, not headings.
    kind = doc_type(doc)
    instrument = kind in ("contract", "legislation")
    groups = collections.defaultdict(list)
    for k in range(n):
        if ev[k]["candidate"]:
            groups[ev[k]["key"]].append(k)
    heads = np.zeros(n, dtype=bool)
    why = [""] * n
    for key, members in groups.items():
        look, col, placement, case, alone, family = key
        m = len(members)
        share = lambda name: sum(bool(ev[k][name]) for k in members) / m
        typed = share("bold") >= 0.5 or share("larger") >= 0.5 or share("underlined") >= 0.5 or case == "caps"
        # Numbered members run in sequence: each ordinal one more than the group's last, or 1.
        seq = 0
        last = None
        for k in members:
            o = ev[k]["ordinal"]
            if o is not None and (o == 1 or (last is not None and o == last + 1)):
                seq += 1
            last = o
        bracketed = family in ("bracket-arabic", "bracket-alpha", "bracket-square")
        sequence = family != "" and seq / m >= 0.5 and not bracketed
        apart = (share("apart_above") + share("apart_below")) / 2
        governs = share("governs")
        labels = share("label")
        if (not alone and family != "word") or labels > 0.3 or case == "sentence" and not typed and not sequence:
            continue
        # An instrument's arabic-numbered captions are its provisions' ("1.1 Definitions").
        if instrument and family.startswith("arabic"):
            continue
        # Lines standing over subsections are marginal notes, not headings, unless in capitals or numbered.
        if share("subsection_next") >= 0.5 and case != "caps" and family == "":
            continue
        style = None
        if sequence and (family == "word" or governs >= 0.3):
            style = "sequence"
        elif typed and apart >= 0.4 and governs >= 0.5:
            style = "typed"
        elif placement == "centred" and apart >= 0.4 and governs >= 0.4:
            style = "centred"
        elif case == "title" and apart >= 0.6 and governs >= 0.6 and m >= 2:
            style = "title-apart"
        if style is None:
            continue
        for k in members:
            e = ev[k]
            stands = e["governs"] if style == "typed" else (e["governs"] or (e["apart_below"] and e["apart_above"]) or (style == "sequence" and e["ordinal"] is not None))
            if stands and not e["label"]:
                heads[k] = True; why[k] = style
    # Tier 0's headings that stand: the document's own outline, a transcript's parts, and (KEEP
    # arms) the numbering ladder's and the typography reader's.
    for k in range(n):
        if doc["r0"][k] == RI["heading"] and doc["s0"][k] == 1 and any(mark in doc["trail"][k] for mark in KEEP) and not doc["trail"][k].endswith(("demote_wrapped", "demote_sentence", "demote_label", "demote_caption", "demote_caps_body", "demote_nearer_above", "marginal_note")):
            heads[k] = True; why[k] = why[k] or "placed"
    # The document's title: its first heading before its body opens (the first long line of prose),
    # set in capitals, centred or in larger type; a division word's ("PART 1") is a heading.
    opens = next((k for k in range(n) if ev[k]["long"]), n)
    first = next((k for k in range(n) if heads[k]), None)
    title = first is not None and first < opens and enumerator_family(doc["text"][first]) != "word" \
        and (ev[first]["caps"] or ev[first]["placement"] == "centred" or ev[first]["larger"])
    for k in range(n):
        if heads[k] and k == first and title:
            region[k] = RI["title"]; start[k] = 1; why[k] = "title"
            j = k
            while j + 1 < n and heads[j + 1] and ev[j + 1]["prev_short_same"] and not ev[j + 1]["apart_above"]:
                j += 1
                heads[j] = False; region[j] = RI["title"]; start[j] = 0; why[j] = "title"
            heads[k] = False
        elif heads[k]:
            region[k] = RI["heading"]; start[k] = 1
            for j in ev[k]["unit"][1:]:
                region[j] = RI["heading"]; start[j] = 0; why[j] = "wrapped"
        elif doc["r0"][k] == RI["heading"] and why[k] not in ("wrapped", "title"):
            region[k] = RI["text"]; start[k] = 1 if doc["s0"][k] != 0 else 0
    if why_out is not None:
        why_out.extend(why)
    return region, start


def doc_type(d):
    by = collections.Counter()
    for kind, _, lines in types.get(d["sha"], []):
        by[kind] += lines
    return by.most_common(1)[0][0] if by else "other"


if __name__ == "__main__":
    for split in ("development", "train"):
        docs = lab.load(root, split)
        lab.table(f"tier 0, {split}", lab.score(docs, lab.tier0, kinds=("heading", "body")), kinds=("heading", "body"))
        for arm, keep in (("styles + outline", ("outline", "rules_promote")), ("styles + outline + ladder", ("outline", "rules_promote", "native")),
                          ("styles + outline + ladder + styled", ("outline", "rules_promote", "native", "styled", "layout", "rules_lift"))):
            KEEP = keep
            lab.table(f"{arm}, {split}", lab.score(docs, decide, kinds=("heading", "body")), kinds=("heading", "body"))
        KEEP = ("outline", "rules_promote", "native")
        if split == "development":
            by_type = collections.defaultdict(list)
            for d in docs:
                by_type[doc_type(d)].append(d)
            print(f"\n  {'type':14} {'docs':>5} {'tier 0':>8} {'styles':>8}")
            for kind, ds in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
                t0 = lab.f1(lab.score(ds, lab.tier0, kinds=("heading",))[("heading", "all")])[0]
                st = lab.f1(lab.score(ds, decide, kinds=("heading",))[("heading", "all")])[0]
                print(f"  {kind:14} {len(ds):5} {t0:8.3f} {st:8.3f}")
            if SHOW:
                import random
                fp, fn = collections.defaultdict(list), collections.defaultdict(list)
                for d in docs:
                    why = []
                    region, start = decide(d, why)
                    for k in range(len(region)):
                        if d["rg"][k] < 0:
                            continue
                        g = d["rg"][k] == RI["heading"] and d["sg"][k] == 1
                        p = region[k] == RI["heading"] and start[k] == 1
                        if p and not g:
                            fp[(doc_type(d), why[k])].append((d["sha"][:8], d["pages"][k] + 1, R[d["rg"][k]], d["text"][k][:70]))
                        elif g and not p:
                            fn[(doc_type(d), why[k] or "-")].append((d["sha"][:8], d["pages"][k] + 1, R[d["r0"][k]], d["text"][k][:70]))
                random.seed(1)
                for name, groups in (("FALSE HEADINGS (gold region shown)", fp), ("MISSED HEADINGS (parser region shown)", fn)):
                    print(f"\n{name}")
                    for key, items in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:10]:
                        print(f"  {key}: {len(items)}")
                        for sha, page, other, t in random.sample(items, min(SHOW, len(items))):
                            print(f"     {sha} p{page:<3} {other:12} | {t}")
