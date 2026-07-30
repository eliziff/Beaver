"""Endnote / footnote MARKERS colliding with paragraph labels.

Two distinct collisions, measured separately:

  A. TAIL ENDNOTE BLOCK — a contiguous run of short line-start "[n]" (or bare
     "n") lines in the tail of the document: the authorities/notes list. It is
     a perfect 1..N ladder, so sweep.py's v1 rule can report a CLEAN ladder for
     a document that has no numbered paragraphs at all (a false PASS, not a
     false fail).

  B. INLINE NOTE MARKER — the same number appears glued to a word in the body
     ("...Court of Appeal for Ontario[1] affirming..."), which is the reference
     that the tail block resolves. When a line break lands before such a
     marker, it becomes a line-start "[n]" and pollutes the ladder.

  python -X utf8 endnotes.py snap/full_bcca_texts.jsonl
  python -X utf8 endnotes.py "snap/s_*.jsonl" --by-court
"""

from __future__ import annotations

import argparse
import glob
import json
import re
import statistics
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent

LS_BRACKET = re.compile(r"^[ \t]*\[(\d{1,4})\][ \t]*(.*)$", re.M)
LS_BARE = re.compile(r"^[ \t]*(\d{1,4})[ \t]+(\S.*)$", re.M)
# a note marker glued to the end of a word / punctuation, not at line start
INLINE_MARKER = re.compile(r"(?<=[A-Za-z0-9.,;:)’”])\[(\d{1,4})\]")
WORDS = re.compile(r"[^\W_]+", re.UNICODE)


def tail_block(text: str, rx=LS_BRACKET) -> dict | None:
    """Longest contiguous ascending run of short line-start numbered lines
    sitting in the tail of the document."""
    hits = [(m.start(), int(m.group(1)), m.group(2)) for m in rx.finditer(text)]
    if len(hits) < 3:
        return None
    best: list[tuple[int, int, str]] = []
    cur: list[tuple[int, int, str]] = []
    for h in hits:
        if cur and h[1] == cur[-1][1] + 1:
            cur.append(h)
        else:
            cur = [h]
        if len(cur) > len(best):
            best = list(cur)
    if len(best) < 3:
        return None
    n = len(text)
    start_ratio = best[0][0] / n
    span = (best[-1][0] - best[0][0]) / n
    med_words = statistics.median(len(WORDS.findall(h[2])) for h in best)
    return {
        "run": len(best), "first": best[0][1], "last": best[-1][1],
        "start_ratio": round(start_ratio, 4), "span": round(span, 4),
        "median_words": med_words,
        "is_tail_endnote": start_ratio > 0.70 and span < 0.25 and med_words < 12,
        "sample": [f"[{h[1]}] {h[2][:70]}" for h in best[:4]],
    }


def analyse(text: str) -> dict:
    tb = tail_block(text)
    inline = [int(m.group(1)) for m in INLINE_MARKER.finditer(text)]
    inline_set = set(inline)
    out = {
        "tail_block": tb,
        "inline_markers": len(inline),
        "inline_distinct": len(inline_set),
    }
    if tb:
        labels = set(range(tb["first"], tb["last"] + 1))
        out["tail_labels_seen_inline"] = len(labels & inline_set)
        out["tail_label_inline_frac"] = round(
            len(labels & inline_set) / len(labels), 3)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--by-court", action="store_true")
    ap.add_argument("--show", type=int, default=4)
    args = ap.parse_args()
    paths = [Path(p) for p in glob.glob(str(HERE / args.path))] or [
        Path(args.path) if Path(args.path).is_absolute() else HERE / args.path]

    c = Counter()
    per = {}
    shown = 0
    for p in paths:
        for line in open(p, encoding="utf-8"):
            rec = json.loads(line)
            if "text" not in rec:
                continue
            a = analyse(rec["text"])
            c["docs"] += 1
            key = (rec.get("court") or rec["id"].split(":", 1)[0]) + ":" + \
                  (rec.get("lang") or "?")
            pc = per.setdefault(key, Counter())
            pc["docs"] += 1
            tb = a["tail_block"]
            if tb and tb["is_tail_endnote"]:
                c["tail_endnote_block"] += 1
                pc["tail_endnote_block"] += 1
                if a.get("tail_label_inline_frac", 0) >= 0.5:
                    c["endnote_block_with_inline_refs"] += 1
                    pc["endnote_inline"] += 1
                if rec.get("v1") == "ok":
                    c["endnote_block_AND_v1_ok"] += 1
                    pc["v1_ok_false_pass"] += 1
                if rec.get("alr") == "usable":
                    c["endnote_block_AND_alr_usable"] += 1
                    pc["alr_usable"] += 1
                if shown < args.show:
                    print(f"--- {rec['id']} {rec.get('date')} v1={rec.get('v1')} "
                          f"alr={rec.get('alr')} run={tb['run']} "
                          f"start={tb['start_ratio']} med_words={tb['median_words']} "
                          f"inline_frac={a.get('tail_label_inline_frac')}")
                    for s in tb["sample"]:
                        print("      " + s)
                    shown += 1
            if a["inline_markers"] >= 3:
                c["has_inline_note_markers"] += 1
                pc["has_inline_note_markers"] += 1
    print()
    for k, v in c.most_common():
        print(f"{k:34s} {v:6d}  {100*v/max(1,c['docs']):5.1f}%")
    if args.by_court:
        print()
        print(f"{'court':12s} {'docs':>5s} {'endnote_blk':>11s} {'w/inline':>9s} "
              f"{'v1_false_pass':>13s} {'inline_marks':>12s}")
        for k in sorted(per):
            p = per[k]
            print(f"{k:12s} {p['docs']:5d} {p['tail_endnote_block']:11d} "
                  f"{p['endnote_inline']:9d} {p['v1_ok_false_pass']:13d} "
                  f"{p['has_inline_note_markers']:12d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
