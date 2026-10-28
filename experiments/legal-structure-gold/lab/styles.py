"""Within-document style groups and how purely they separate gold heading starts from the rest.

A style key is tried at several grains: the look alone (font, size, bold, italic, caps, as the rows
carry it), then with the line's column, its placement in the column (centred, flush, indented,
margin), its case (caps, title, sentence) and whether it stands alone on its line (short in its
column). For each key: over development documents, the share of candidate lines whose group's
majority label is their own (purity), the share of heading starts in groups that are mostly
headings (coverable recall), and the number of groups per document. Candidate lines: pieces
outside notes, contents and furniture that end no sentence, with letters.

  python styles.py ROWS_DIR [GOLD_TYPES]
"""
import collections
import json
import re
import sys

import numpy as np

import lab
from lab import RI

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
root = sys.argv[1]
types = json.load(open(sys.argv[2], encoding="utf-8")) if len(sys.argv) > 2 else {}
docs = lab.load(root, "development")
F = {name: k for k, name in enumerate(lab.NAMES)}
excluded = {RI["note"], RI["contents"], RI["line_label"], RI["page_label"], RI["furniture"], RI["note_quote"]}


def columns(doc):
    """Per piece: its column's (left, right) on its page, from clusters of left edges."""
    X, n, pages = doc["X"], len(doc["text"]), doc["pages"]
    out = [None] * n
    if n == 0:
        return out
    x0, x1 = X[:, F["x0"]], X[:, F["x1"]]
    for p in np.unique(pages):
        ks = np.where(pages == p)[0]
        order = ks[np.argsort(x0[ks])]
        clusters, current = [], [order[0]]
        for k in order[1:]:
            if x0[k] - x0[current[-1]] > 0.06:
                clusters.append(current); current = [k]
            else:
                current.append(k)
        clusters.append(current)
        cols = []
        for c in clusters:
            if len(c) >= 3:
                left = float(np.median(x0[c])); right = float(np.percentile(x1[c], 90))
                if right - left > 0.15:
                    cols.append((left, right))
        if not cols:
            cols = [(float(np.min(x0[ks])), max(float(np.max(x1[ks])), float(np.min(x0[ks])) + 0.1))]
        cols.sort()
        for k in ks:
            mid = (x0[k] + x1[k]) / 2
            inside = [i for i, (l, r) in enumerate(cols) if l - 0.03 <= mid <= r + 0.03]
            i = inside[0] if inside else int(np.argmin([abs(l - x0[k]) for l, _ in cols]))
            out[k] = (i, cols[i][0], cols[i][1], len(cols))
    return out


def case_class(text):
    letters = [c for c in text if c.isalpha()]
    if len(letters) >= 3 and sum(c.isupper() for c in letters) >= 0.9 * len(letters):
        return "caps"
    words = [w for w in re.findall(r"[^\W\d_]+", text) if len(w) >= 2]
    if words and sum(w[0].isupper() for w in words) / len(words) >= 0.6:
        return "title"
    return "sentence"


def keys(doc):
    """Each candidate piece's style keys at every grain, else None."""
    X, n = doc["X"], len(doc["text"])
    cols = columns(doc)
    out = [None] * n
    for k in range(n):
        if doc["rg"][k] < 0 or doc["r0"][k] in excluded:
            continue
        t = doc["text"][k].strip()
        if sum(c.isalpha() for c in t) < 2 or X[k, F["ends_period"]] > 0 or X[k, F["ends_comma"]] > 0:
            continue
        i, left, right, count = cols[k]
        width = max(right - left, 0.05)
        x0, x1 = X[k, F["x0"]], X[k, F["x1"]]
        rel = (x1 - x0) / width
        centre = ((x0 + x1) / 2 - (left + right) / 2) / width
        indent = (x0 - left) / width
        if abs(centre) < 0.04 and rel < 0.8:
            placement = "centred"
        elif indent < 0.03:
            placement = "flush"
        elif rel < 0.3 and (x0 < left - 0.02 or x1 > right + 0.02):
            placement = "margin"
        else:
            placement = "indented"
        alone = rel < 0.6
        look = int(doc["look"][k])
        case = case_class(t)
        numbered = re.match(r"^\s*(?:[\[(]?\d{1,3}[.)\]]?|[A-Za-z][.)]|\([a-z0-9]{1,4}\)|[ivxlcdm]{1,6}[.)]|(?:part|partie|article|section|schedule|chapter|chapitre|annexe?|division|title|titre|rule)\s+\S)\s", t, re.I) is not None
        family = enumerator_family(t)
        out[k] = {
            "look": (look,),
            "look+place": (look, placement),
            "look+place+case": (look, placement, case),
            "look+place+case+alone": (look, placement, case, alone),
            "place+case+alone": (placement, case, alone),
            "look+place+case+alone+num": (look, placement, case, alone, numbered),
            "look+col+place+case+alone+num": (look, i if count > 1 else 0, placement, case, alone, numbered),
            "look+col+place+case+alone+family": (look, i if count > 1 else 0, placement, case, alone, family),
        }
    return out


def enumerator_family(text):
    """The family and depth of a line's opening enumerator: 'word' (PART 3), 'arabic-1' (4.), 'arabic-2'
    (4.1), 'bracket-arabic' ([12], (3)), 'alpha', 'roman', 'bracket-alpha', or '' for none."""
    m = re.match(r"^\s*(?:(part|partie|article|section|schedule|chapter|chapitre|annexe?|division|title|titre|rule|book|livre)\s+\S"
                 r"|\[(\d{1,4})\]|\((\d{1,3})\)|(\d{1,3}(?:\.\d{1,3})*)[.)]?\s|\(([a-z]{1,4})\)|([A-Za-z])[.)]\s|([ivxlcdmIVXLCDM]{1,6})[.)]\s)", text, re.I)
    if not m:
        return ""
    if m.group(1):
        return "word"
    if m.group(2):
        return "bracket-square"
    if m.group(3):
        return "bracket-arabic"
    if m.group(4):
        return f"arabic-{m.group(4).count('.') + 1}"
    if m.group(5):
        return "bracket-alpha"
    if m.group(6):
        return "alpha"
    return "roman"


def doc_type(d):
    by = collections.Counter()
    for kind, _, lines in types.get(d["sha"], []):
        by[kind] += lines
    return by.most_common(1)[0][0] if by else "other"



if __name__ == "__main__":
    grains = ["look", "look+place", "look+place+case", "look+place+case+alone", "place+case+alone", "look+place+case+alone+num", "look+col+place+case+alone+num", "look+col+place+case+alone+family"]
    tally = {g: collections.defaultdict(lambda: [0, 0, 0, 0, 0]) for g in grains}  # (type) -> candidates, pure, heads, coverable heads, groups
    uncovered = collections.defaultdict(list)
    for doc in docs:
        ks = keys(doc)
        kind = doc_type(doc)
        heads = {k for k in range(len(ks)) if ks[k] is not None and doc["rg"][k] == RI["heading"] and doc["sg"][k] == 1}
        for g in grains:
            groups = collections.defaultdict(list)
            for k, key in enumerate(ks):
                if key is not None:
                    groups[key[g]].append(k)
            for key, members in groups.items():
                h = sum(k in heads for k in members)
                n = len(members)
                majority_heads = h * 2 > n
                for t in (kind, "all"):
                    row = tally[g][t]
                    row[0] += n; row[1] += max(h, n - h); row[2] += h; row[3] += h if majority_heads else 0; row[4] += 1
                if g == grains[-1] and not majority_heads and h:
                    for k in members:
                        if k in heads:
                            others = [doc["text"][j][:40] for j in members if j not in heads][:3]
                            uncovered[kind].append((doc["sha"][:8], doc["pages"][k] + 1, key, n, h, doc["text"][k][:50], others))
    import random
    random.seed(2)
    print("\nUNCOVERED heading starts (minority in their group), by type: sha page key n heads | text | other members")
    for kind, items in sorted(uncovered.items(), key=lambda kv: -len(kv[1]))[:6]:
        print(f"\n  {kind}: {len(items)}")
        for sha, page, key, n, h, text, others in random.sample(items, min(8, len(items))):
            print(f"    {sha} p{page:<3} {str(key[1:]):44} n{n:<4} h{h:<3} | {text!r} | {others}")
    print(f"{len(docs)} development documents; candidate lines = short-or-long lines ending no sentence outside notes/contents/furniture")
    for t in ["all"] + sorted({k for g in grains for k in tally[g] if k != "all"}, key=lambda k: -tally[grains[0]][k][0]):
        if tally[grains[0]][t][2] < 100:
            continue
        print(f"\n{t}: {tally[grains[0]][t][0]} candidate lines, {tally[grains[0]][t][2]} heading starts")
        print(f"  {'style key':34} {'purity':>7} {'coverable R':>12} {'groups/doc':>11}")
        for g in grains:
            c, pure, h, cov, groups = tally[g][t]
            n_docs = sum(1 for d in docs if (doc_type(d) == t or t == "all"))
            print(f"  {g:34} {pure / max(c, 1):7.3f} {cov / max(h, 1):12.3f} {groups / max(n_docs, 1):11.1f}")
