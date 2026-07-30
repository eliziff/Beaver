"""WHY does sweep.py's v1 paragraph ladder break? Cause classification with
verbatim snippets.

Host = the scope ALR's paragraph_index() selects (the best available proxy for
the document's own numbering; hand-verified at 95% presence / 41-of-43 exact
last-number on the 60-doc sample). Residue = every line-start bracket hit that
v1 counts but that is NOT on that host scope, grouped into maximal contiguous
blocks. Each block is classified from its arithmetic plus the lexical context
of the line that introduces it.

  python -X utf8 taxonomy.py snap/full_bcca_texts.jsonl --out snap/tax.json
  python -X utf8 taxonomy.py snap/full_bcca_texts.jsonl --snippets QUOTED_HIGH
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path

from alr_probe import paragraph_index, v1

HERE = Path(__file__).resolve().parent

# v1's regex, copied from sweep.py
BRACKET_PARA_RE = re.compile(r"^[ \t]*\[(\d{1,4})\][ \t]", re.M)

COLON_END = re.compile(r"[:;]\s*$")
PARA_XREF = re.compile(r"\b(?:at\s+)?(?:para|paras|paragraph|paragraphs|¶)\b\.?\s*\d",
                       re.I)
QUOTE_VERB = re.compile(
    r"\b(?:said|stated|held|wrote|observed|noted|reasons|as follows|follows|quote"
    r"|quoting|citing|excerpt|reproduce|set out|says|submits|concluded|remarked"
    r"|motifs|suit|dit|conclu)\b", re.I)
WORDS = re.compile(r"[^\W_]+", re.UNICODE)


def hits(text: str) -> list[dict]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    lines = text.split("\n")
    out = []
    for m in BRACKET_PARA_RE.finditer(text):
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= m.start():
                lo = mid
            else:
                hi = mid - 1
        k = lo - 1
        while k >= 0 and not lines[k].strip():
            k -= 1
        out.append({"off": m.start(), "label": int(m.group(1)), "line_no": lo,
                    "line": lines[lo], "prev": lines[k] if k >= 0 else "",
                    "is_year": 1700 <= int(m.group(1)) <= 2199})
    return out


def classify(block: list[dict], host_at: int | None, doc_len: int) -> str:
    vals = [h["label"] for h in block]
    first = block[0]
    intro = first["prev"]
    med_words = statistics.median(len(WORDS.findall(h["line"])) for h in block)
    tail = first["off"] / max(1, doc_len) > 0.70
    ascending = all(b > a for a, b in zip(vals, vals[1:]))

    if all(h["is_year"] for h in block):
        return "YEAR_BRACKET_CITATION"
    # endnote / authority list: short lines, ascending, in the tail
    if len(block) >= 3 and ascending and med_words < 12 and tail:
        return "ENDNOTE_LIST"
    if len(block) == 1 and med_words < 12:
        return "SHORT_STUB"
    cue = bool(COLON_END.search(intro) or QUOTE_VERB.search(intro))
    xref = bool(PARA_XREF.search(intro))
    if host_at is None:
        return "BEFORE_HOST_START"
    if vals[0] <= host_at:
        if len(block) >= 8 and ascending:
            return "QUOTED_LOW_LONG"
        return "QUOTED_LOW_XREF" if xref else ("QUOTED_LOW" if cue
                                              else "QUOTED_LOW_BARE")
    if len(block) >= 8 and ascending:
        return "QUOTED_HIGH_LONG"
    return "QUOTED_HIGH_XREF" if xref else ("QUOTED_HIGH" if cue
                                           else "QUOTED_HIGH_BARE")


def analyse(rec: dict) -> dict:
    text = rec["text"]
    H = hits(text)
    verdict, stats = v1(text)
    scope = paragraph_index(text)
    host_offs = {p[1] for p in scope}
    out = {"id": rec["id"], "court": rec.get("court"), "lang": rec.get("lang"),
           "date": rec.get("date"), "chars": len(text), "v1": verdict,
           "v1_stats": stats, "host_len": len(scope),
           "host_first": scope[0][0] if scope else None,
           "host_last": scope[-1][0] if scope else None,
           "causes": {}, "examples": {}, "dropout": {}}
    if not H:
        return out
    kept = [h for h in H if not h["is_year"]]
    # host value in effect at each hit
    host_at: dict[int, int | None] = {}
    cur = None
    for h in H:
        if h["off"] in host_offs:
            cur = h["label"]
        host_at[h["off"]] = cur
    resid = [h for h in kept if h["off"] not in host_offs]
    blocks: list[list[dict]] = []
    prev_i = None
    idx = {h["off"]: i for i, h in enumerate(kept)}
    for h in resid:
        i = idx[h["off"]]
        if blocks and prev_i is not None and i == prev_i + 1:
            blocks[-1].append(h)
        else:
            blocks.append([h])
        prev_i = i
    causes = Counter()
    for blk in blocks:
        c = classify(blk, host_at[blk[0]["off"]], len(text))
        causes[c] += 1
        out["examples"].setdefault(c, []).append(
            {"labels": [h["label"] for h in blk],
             "intro": blk[0]["prev"][:210], "first": blk[0]["line"][:210]})
    out["causes"] = dict(causes)
    out["residue_hits"] = len(resid)
    # dropouts INSIDE the host scope: is the missing "[n]" present mid-line?
    ev = Counter()
    lines = text.split("\n")
    for (a, sa, _ea, _ta), (b, sb, _eb, _tb) in zip(scope, scope[1:]):
        if not (a + 1 < b <= a + 8):
            continue
        span = text[sa:sb]
        for miss in range(a + 1, b):
            ev["glued_midline" if f"[{miss}]" in span else "truly_absent"] += 1
    out["dropout"] = dict(ev)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--out")
    ap.add_argument("--snippets")
    ap.add_argument("--n-snippets", type=int, default=3)
    args = ap.parse_args()
    p = Path(args.path)
    if not p.is_absolute():
        p = HERE / p
    recs = [analyse(json.loads(line)) for line in open(p, encoding="utf-8")]

    doc_c, blk_c, drop = Counter(), Counter(), Counter()
    for r in recs:
        for c, n in r["causes"].items():
            blk_c[c] += n
            doc_c[c] += 1
        for k, v in r["dropout"].items():
            drop[k] += v
    n = len(recs)
    print(f"docs analysed: {n}  v1={dict(Counter(r['v1'] for r in recs))}")
    print(f"\n{'cause':24s} {'blocks':>7s} {'docs':>6s} {'%docs':>6s}")
    for c, k in blk_c.most_common():
        print(f"{c:24s} {k:7d} {doc_c[c]:6d} {100*doc_c[c]/n:5.1f}%")
    print(f"\ntotal residue blocks: {sum(blk_c.values())}")
    print(f"dropouts inside the host scope: {dict(drop)}")

    if args.snippets:
        print(f"\n=== verbatim {args.snippets} ===")
        shown = 0
        for r in recs:
            for ex in r["examples"].get(args.snippets, []):
                print(f"\n[{r['id']}] off-scope labels={ex['labels']}")
                print(f"  introduced by> {ex['intro']}")
                print(f"  off-scope line> {ex['first']}")
                shown += 1
                if shown >= args.n_snippets:
                    return 0
    if args.out:
        o = Path(args.out)
        if not o.is_absolute():
            o = HERE / o
        o.write_text(json.dumps(
            [{k: v for k, v in r.items() if k != "examples"} for r in recs],
            ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {o}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
