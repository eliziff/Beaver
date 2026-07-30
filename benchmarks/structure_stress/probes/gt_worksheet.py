"""Ground-truth worksheet: pick a stratified sample and print a digest of each
document so a human can decide, by READING, whether it has numbered paragraphs
and what the true last number is.

  python -X utf8 gt_worksheet.py pick --out snap/gt_ids.json
  python -X utf8 gt_worksheet.py digest snap/gt_ids.json --batch 0
  python -X utf8 gt_worksheet.py grade snap/gt_ids.json snap/gt_truth.json
"""

from __future__ import annotations

import argparse
import glob
import json
import random
import re
from collections import Counter, defaultdict
from pathlib import Path

from alr_probe import alr, paragraph_index, v1

HERE = Path(__file__).resolve().parent
LS_NUM = re.compile(r"^[ \t]*(?:\[(\d{1,4})\]|(\d{1,4})\.(?=\s)|(\d{1,4})(?=\s))")


def load_all() -> list[dict]:
    out = []
    for p in sorted(glob.glob(str(HERE / "snap" / "s_*.jsonl"))):
        for line in open(p, encoding="utf-8"):
            out.append(json.loads(line))
    bc = HERE / "snap" / "full_bcca_texts.jsonl"
    if bc.exists():
        for line in open(bc, encoding="utf-8"):
            r = json.loads(line)
            r["from_full_failures"] = True
            out.append(r)
    return out


def cmd_pick(args) -> int:
    recs = load_all()
    rnd = random.Random(20260729)
    # stratify on (v1 verdict, in-sample BCCA vs held-out court)
    buckets: dict[tuple, list[dict]] = defaultdict(list)
    for r in recs:
        v = r.get("v1") or v1(r["text"])[0]
        r["v1"] = v
        held = "BCCA" if r["court"] == "BCCA" else "HELDOUT"
        buckets[(v, held)].append(r)
    quota = {
        ("ladder_broken", "BCCA"): 16,
        ("ladder_broken", "HELDOUT"): 14,
        ("no_paragraph_ladder", "BCCA"): 4,
        ("no_paragraph_ladder", "HELDOUT"): 14,
        ("ok", "BCCA"): 4,
        ("ok", "HELDOUT"): 8,
    }
    chosen = []
    for key, k in quota.items():
        pool = buckets.get(key, [])
        # spread held-out picks over as many courts as possible
        if key[1] == "HELDOUT":
            by_court = defaultdict(list)
            for r in pool:
                by_court[r["court"] + ":" + r["lang"]].append(r)
            courts = sorted(by_court)
            rnd.shuffle(courts)
            picked = []
            i = 0
            while len(picked) < k and courts:
                c = courts[i % len(courts)]
                if by_court[c]:
                    picked.append(by_court[c].pop(rnd.randrange(len(by_court[c]))))
                else:
                    courts.remove(c)
                    continue
                i += 1
            chosen.extend(picked)
        else:
            chosen.extend(rnd.sample(pool, min(k, len(pool))))
    print(f"picked {len(chosen)}")
    print(Counter((r['v1'], r['court']) for r in chosen).most_common())
    out = Path(args.out)
    if not out.is_absolute():
        out = HERE / out
    out.write_text(json.dumps([r["id"] for r in chosen], indent=1), encoding="utf-8")
    print(f"wrote {out}")
    return 0


def digest(rec: dict, body_from: int = 0) -> None:
    t = rec["text"]
    lines = t.split("\n")
    ne = [(i, ln) for i, ln in enumerate(lines) if ln.strip()]
    print("=" * 104)
    print(f"ID {rec['id']}   date={rec.get('date')}  chars={len(t)}  "
          f"v1={rec.get('v1')}  alr={alr(t)[0]}")
    a = alr(t)[1]
    if a.get("count"):
        pi = paragraph_index(t)
        head = t[pi[0][1]:pi[0][1] + 26].replace("\n", " ")
        print(f"   ALR scope: n={a['count']} {a['first']}..{a['last']} "
              f"complete={a['completeness']} marker0={head!r}")
    # every line-start numbered line, compressed
    marks = []
    for i, ln in enumerate(lines):
        m = LS_NUM.match(ln)
        if m:
            style = "[]" if m.group(1) else "." if m.group(2) else "_"
            marks.append((i, int(m.group(1) or m.group(2) or m.group(3)), style,
                          len(ln)))
    print(f"   line-start numbered lines: {len(marks)}")
    print("   " + " ".join(f"{v}{s}" for _i, v, s, _l in marks[:70]))
    if len(marks) > 70:
        print("   ... " + " ".join(f"{v}{s}" for _i, v, s, _l in marks[-20:]))
    print("   --- body sample ---")
    for i, ln in ne[body_from:body_from + 10]:
        print(f"   {i:5d}| {ln[:150]}")
    mid = len(ne) // 2
    print("   --- middle ---")
    for i, ln in ne[mid:mid + 5]:
        print(f"   {i:5d}| {ln[:150]}")
    print("   --- tail ---")
    for i, ln in ne[-6:]:
        print(f"   {i:5d}| {ln[:150]}")


def cmd_digest(args) -> int:
    idp = Path(args.ids)
    if not idp.is_absolute():
        idp = HERE / idp
    ids = json.loads(idp.read_text(encoding="utf-8"))
    lo = args.batch * args.size
    want = set(ids[lo:lo + args.size])
    if not want:
        print("empty batch")
        return 0
    seen = {}
    for r in load_all():
        if r["id"] in want and r["id"] not in seen:
            seen[r["id"]] = r
    for i in ids[lo:lo + args.size]:
        if i in seen:
            digest(seen[i], args.body_from)
        else:
            print(f"MISSING {i}")
    return 0


def cmd_grade(args) -> int:
    """Score v1 and ALR against hand-recorded ground truth."""
    tp = Path(args.truth)
    if not tp.is_absolute():
        tp = HERE / tp
    truth = {k: v for k, v in json.loads(tp.read_text(encoding="utf-8")).items()
              if not k.startswith("_")}
    recs = {}
    for r in load_all():
        recs.setdefault(r["id"], r)
    rows = []
    for doc_id, g in truth.items():
        r = recs.get(doc_id)
        if not r:
            print(f"MISSING TEXT {doc_id}")
            continue
        t = r["text"]
        v1v = v1(t)[0]
        av, ai = alr(t)
        has = bool(g["numbered"])
        # v1 asserts a usable paragraph ladder only when it says "ok"
        v1_has = v1v == "ok"
        alr_has = av == "usable"
        v1_max = v1(t)[1]["max"] if v1_has else None
        alr_max = ai.get("last") if alr_has else None
        rows.append({
            "id": doc_id, "court": r["court"], "lang": r["lang"],
            "date": r.get("date"), "truth_numbered": has,
            "truth_max": g.get("max"), "truth_style": g.get("style"),
            "note": g.get("note", ""),
            "v1": v1v, "v1_has": v1_has, "v1_max": v1_max,
            "alr": av, "alr_has": alr_has, "alr_max": alr_max,
        })

    def score(rows, key_has, key_max, label):
        n = len(rows)
        pres = sum(1 for r in rows if r[key_has] == r["truth_numbered"])
        fp = sum(1 for r in rows if r[key_has] and not r["truth_numbered"])
        fn = sum(1 for r in rows if not r[key_has] and r["truth_numbered"])
        both = [r for r in rows if r[key_has] and r["truth_numbered"]]
        exact = sum(1 for r in both if r[key_max] == r["truth_max"])
        near = sum(1 for r in both
                   if r[key_max] is not None and r["truth_max"] is not None
                   and abs(r[key_max] - r["truth_max"]) <= 1)
        print(f"{label:10s} presence {pres}/{n} = {100*pres/n:5.1f}%  "
              f"(FP {fp}, FN {fn})   last-number exact {exact}/{len(both)}"
              f"  within1 {near}/{len(both)}")

    print(f"hand-verified docs: {len(rows)}   "
          f"numbered={sum(1 for r in rows if r['truth_numbered'])}")
    print()
    score(rows, "v1_has", "v1_max", "v1")
    score(rows, "alr_has", "alr_max", "ALR")
    print()
    for scope, sel in (("BCCA (in-sample)", [r for r in rows if r["court"] == "BCCA"]),
                       ("held-out courts", [r for r in rows if r["court"] != "BCCA"])):
        if sel:
            print(f"-- {scope}: n={len(sel)}, courts="
                  f"{sorted({r['court'] for r in sel})}")
            score(sel, "v1_has", "v1_max", "  v1")
            score(sel, "alr_has", "alr_max", "  ALR")
    print("\nDISAGREEMENTS (v1 vs truth, or ALR vs truth):")
    for r in rows:
        bad = []
        if r["v1_has"] != r["truth_numbered"]:
            bad.append(f"v1={r['v1']}")
        if r["alr_has"] != r["truth_numbered"]:
            bad.append(f"alr={r['alr']}")
        elif r["alr_has"] and r["truth_max"] and r["alr_max"] != r["truth_max"]:
            bad.append(f"alr_max={r['alr_max']}!={r['truth_max']}")
        if bad:
            print(f"  {r['id']:36s} truth(numbered={r['truth_numbered']},"
                  f"max={r['truth_max']},{r['truth_style']}) {' '.join(bad)}"
                  f"  {r['note'][:60]}")
    if args.out:
        o = Path(args.out)
        if not o.is_absolute():
            o = HERE / o
        o.write_text(json.dumps(rows, ensure_ascii=False, indent=1),
                     encoding="utf-8")
        print(f"\nwrote {o}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("pick")
    p.add_argument("--out", default="snap/gt_ids.json")
    p.set_defaults(fn=cmd_pick)
    d = sub.add_parser("digest")
    d.add_argument("ids")
    d.add_argument("--batch", type=int, default=0)
    d.add_argument("--size", type=int, default=10)
    d.add_argument("--body-from", type=int, default=0)
    d.set_defaults(fn=cmd_digest)
    g = sub.add_parser("grade")
    g.add_argument("ids")
    g.add_argument("truth")
    g.add_argument("--out")
    g.set_defaults(fn=cmd_grade)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
