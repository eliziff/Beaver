"""Score sweep.py's naive ladder rule (v1) against ALR's real parser.

ALR-Quote-Verifier already solved paragraph structure over flat A2AJ text.
This probe imports its parser READ-ONLY from the reference checkout and never
copies or reimplements it:

    verifier_core.a2aj_structure.paragraph_index(text, min_run=5)

v1 IS copied here verbatim from sweep.py, so neither detector tests itself.

  python -X utf8 alr_probe.py score snap/full_bcca_texts.jsonl --out x.json
  python -X utf8 alr_probe.py explain snap/x.jsonl --id "BCCA:2006 BCCA 304:en"
  python -X utf8 alr_probe.py why snap/full_bcca_texts.jsonl   # rejection reasons
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALR = Path(r"C:\Users\elias\Desktop\Martys Qote Verifier\ALR-Quote-Verifier")
if str(ALR) not in sys.path:
    sys.path.insert(0, str(ALR))

from verifier_core.a2aj_structure import (  # noqa: E402
    PARAGRAPH_MARK_RE,
    _word_count,
    monotone_scopes,
    paragraph_index,
)

# ── v1, copied verbatim from benchmarks/structure_stress/sweep.py ─────
import re  # noqa: E402

BRACKET_PARA_RE = re.compile(r"^[ \t]*\[(\d{1,4})\][ \t]", re.M)


def v1(text: str) -> tuple[str, dict]:
    raw = [int(m.group(1)) for m in BRACKET_PARA_RE.finditer(text)]
    labels = [n for n in raw if not 1700 <= n <= 2199]
    breaks = sum(1 for a, b in zip(labels, labels[1:]) if b != a + 1)
    stats = {"count": len(labels), "max": max(labels) if labels else 0,
             "breaks": breaks, "duplicates": len(labels) - len(set(labels))}
    if not labels:
        return "no_paragraph_ladder", stats
    if breaks > max(2, len(labels) // 50):
        return "ladder_broken", stats
    return "ok", stats


# ── ALR verdict wrapper ──────────────────────────────────────────────


def alr(text: str) -> tuple[str, dict]:
    """usable/unavailable + the winning scope's shape."""
    out = paragraph_index(text)
    if not out:
        return "unavailable", {"count": 0}
    nums = [p[0] for p in out]
    gaps = [b - a for a, b in zip(nums, nums[1:]) if b != a + 1]
    return "usable", {
        "count": len(nums), "first": nums[0], "last": nums[-1],
        "span": nums[-1] - nums[0] + 1,
        "completeness": round(len(nums) / (nums[-1] - nums[0] + 1), 4),
        "gaps": len(gaps), "max_gap": max(gaps) if gaps else 0,
        "marker_span": round((out[-1][1] - out[0][1]) / max(1, len(text)), 4),
        "start_ratio": round(out[0][1] / max(1, len(text)), 4),
    }


# ── diagnostic: which of ALR's guards rejected every hypothesis? ──────
# Mirrors paragraph_index's own guard order so a rejection can be named.
# Diagnostic only; paragraph_index above remains the scored implementation.


def why_unavailable(text: str) -> list[str]:
    markers = []
    for m in PARAGRAPH_MARK_RE.finditer(text):
        b, d, bare = m.groups()
        markers.append((m.start(), int(b or d or bare),
                        "bracket" if b else "dot" if d else "bare"))
    if not markers:
        return ["no_markers_at_all"]
    reasons: list[str] = []
    hyp = []
    for style in ("bracket", "dot", "bare"):
        styled = [(o, n) for o, n, s in markers if s == style]
        scopes = monotone_scopes(styled)
        long = [s for s in scopes if len(s) >= 5]
        if styled and not long:
            reasons.append(f"{style}:no_scope_reaches_min_run5"
                           f"(markers={len(styled)},best={max((len(s) for s in scopes), default=0)})")
        for s in long:
            hyp.append((style, s))
    if not hyp:
        return reasons or ["no_hypothesis"]
    rank = {"bracket": 2, "dot": 1, "bare": 0}
    primary = [h for h in hyp if h[1][0][1] <= 5]
    if hyp and not primary:
        reasons.append("no_hypothesis_starts_at_or_below_5")
    ordered = sorted(primary or hyp,
                     key=lambda i: (len(i[1]), rank[i[0]], -i[1][0][1]), reverse=True)
    for style, cand in ordered:
        offs = [o for o, _n, s in markers if s == style]
        nxt = {o: offs[i + 1] if i + 1 < len(offs) else len(text)
               for i, o in enumerate(offs)}
        out = [(n, st, nxt[st], text[st:nxt[st]]) for st, n in cand]
        marker_span = (out[-1][1] - out[0][1]) / len(text)
        start_ratio = out[0][1] / len(text)
        bounded = out[:-1] or out
        med = statistics.median(_word_count(i[3]) for i in bounded)
        tag = f"{style}(n={len(out)},span={marker_span:.2f},start={start_ratio:.2f},med={med:.0f})"
        if med < 12:
            reasons.append(tag + ":median_words<12")
            continue
        if marker_span < 0.05:
            reasons.append(tag + ":marker_span<0.05")
            continue
        if style != "bracket" and sum(
            _word_count(i[3]) >= 12 for i in out) / len(out) < 0.70:
            reasons.append(tag + ":substantive_frac<0.70")
            continue
        if style == "bare" and (med < 20 or marker_span < 0.15 or start_ratio > 0.70):
            reasons.append(tag + ":bare_tail_guard")
            continue
        reasons.append(tag + ":ACCEPTED")
        break
    return reasons


# ── drivers ──────────────────────────────────────────────────────────


def _load(path: str):
    p = Path(path)
    if not p.is_absolute():
        p = HERE / p
    for line in open(p, encoding="utf-8"):
        yield json.loads(line)


def cmd_score(args) -> int:
    grid = Counter()
    rows = []
    for rec in _load(args.path):
        t = rec["text"]
        a, ai = v1(t)
        b, bi = alr(t)
        grid[(a, b)] += 1
        rows.append({"id": rec["id"],
                     "court": rec.get("court") or rec["id"].split(":", 1)[0],
                     "date": rec.get("date"), "chars": len(t),
                     "v1": a, "v1_stats": ai, "alr": b, "alr_info": bi})
    print(f"{'v1':22s} {'ALR':14s} n")
    for (a, b), n in grid.most_common():
        print(f"{a:22s} {b:14s} {n}")
    resolved = [r for r in rows if r["v1"] == "ladder_broken" and r["alr"] == "usable"]
    if resolved:
        comp = [r["alr_info"]["completeness"] for r in resolved]
        print(f"\nv1 ladder_broken -> ALR usable: {len(resolved)}")
        print(f"  scope completeness: median {statistics.median(comp):.4f}, "
              f"min {min(comp):.4f}, >=0.95: "
              f"{sum(1 for c in comp if c >= 0.95)}/{len(comp)}")
        print("  completeness buckets: " + str(sorted(
            Counter(round(c, 1) for c in comp).items())))
    if args.out:
        o = Path(args.out)
        if not o.is_absolute():
            o = HERE / o
        o.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {o}")
    return 0


def cmd_why(args) -> int:
    c = Counter()
    ex: dict[str, list[str]] = {}
    for rec in _load(args.path):
        if alr(rec["text"])[0] == "usable":
            continue
        rs = why_unavailable(rec["text"])
        key = ";".join(r.split("(")[0] for r in rs) or "none"
        c[key] += 1
        ex.setdefault(key, []).append(f"{rec['id']} :: {rs}")
    print("ALR-unavailable rejection signatures:")
    for k, n in c.most_common(20):
        print(f"  {n:5d}  {k}")
        for line in ex[k][:2]:
            print(f"           {line}")
    return 0


def cmd_explain(args) -> int:
    want = set(args.id or [])
    for rec in _load(args.path):
        if want and rec["id"] not in want:
            continue
        t = rec["text"]
        print("=" * 92)
        print(rec["id"], rec.get("date"), f"chars={len(t)}")
        print("v1 :", v1(t))
        print("ALR:", alr(t))
        out = paragraph_index(t)
        print("scope:", [p[0] for p in out])
        print("why :", why_unavailable(t))
        if want:
            want.discard(rec["id"])
            if not want:
                break
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("score", cmd_score), ("why", cmd_why), ("explain", cmd_explain)):
        s = sub.add_parser(name)
        s.add_argument("path")
        s.add_argument("--out")
        s.add_argument("--id", action="append")
        s.set_defaults(fn=fn)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
