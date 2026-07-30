"""Show, for a document, the bracket-label sequence and the lines at each
adjacent break — the raw evidence for classifying WHY v1's ladder breaks.

  python -X utf8 inspect_ladder.py snap/full_bcca_texts.jsonl --n 5
  python -X utf8 inspect_ladder.py snap/full_bcca_texts.jsonl --id "BCCA:1999 BCCA 149:en"
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRACKET_PARA_RE = re.compile(r"^[ \t]*\[(\d{1,4})\][ \t]", re.M)


def label_hits(text: str):
    """[(label, line_no, line_text)] for every v1 bracket hit."""
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    out = []
    for m in BRACKET_PARA_RE.finditer(text):
        # binary-search the line
        lo, hi = 0, len(starts) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if starts[mid] <= m.start():
                lo = mid
            else:
                hi = mid - 1
        line_end = text.find("\n", m.start())
        line = text[starts[lo]:line_end if line_end != -1 else len(text)]
        out.append((int(m.group(1)), lo + 1, line))
    return out


def show(rec: dict, ctx: int = 1) -> None:
    text = rec["text"]
    hits = label_hits(text)
    labels = [h[0] for h in hits]
    filt = [h for h in hits if not 1700 <= h[0] <= 2199]
    print("=" * 100)
    print(f"{rec['id']}  date={rec.get('date')}  chars={len(text)}")
    print(f"name={(rec.get('name') or '')[:110]}")
    print(f"raw labels ({len(labels)}): {labels[:80]}")
    fl = [h[0] for h in filt]
    print(f"filtered  ({len(fl)}): {fl[:80]}")
    breaks = [(a, b) for (a, b) in zip(fl, fl[1:]) if b != a + 1]
    print(f"breaks={len(breaks)} -> {breaks[:25]}")
    print("-" * 100)
    prev = None
    for lab, ln, line in filt:
        mark = " "
        if prev is not None and lab != prev + 1:
            mark = "!"
        print(f"{mark} L{ln:<6} [{lab}] :: {line[:150]}")
        prev = lab


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--id", action="append")
    ap.add_argument("--skip", type=int, default=0)
    args = ap.parse_args()
    p = Path(args.path)
    if not p.is_absolute():
        p = HERE / p
    want = set(args.id or [])
    seen = 0
    shown = 0
    for line in open(p, encoding="utf-8"):
        rec = json.loads(line)
        if want:
            if rec["id"] in want:
                show(rec)
                shown += 1
                if shown == len(want):
                    break
            continue
        seen += 1
        if seen <= args.skip:
            continue
        show(rec)
        shown += 1
        if shown >= args.n:
            break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
