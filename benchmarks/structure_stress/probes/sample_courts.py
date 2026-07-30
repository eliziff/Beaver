"""Decade-stratified sample of one court, with v1/v2 verdicts and the
alternate-numbering diagnostics that answer "is no_paragraph_ladder genuine?".

One court per invocation, single-threaded, two columns + text only.

  python -X utf8 sample_courts.py NSCA en --per-decade 12 --out snap/s_NSCA_en.jsonl
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from alr_probe import alr, v1

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
HERE = Path(__file__).resolve().parent

# alternate paragraph-numbering conventions, measured one by one
CONV = {
    "bracket": re.compile(r"^[ \t]*\[(\d{1,4})\][ \t]", re.M),
    "pilcrow": re.compile(r"^[ \t]*¶[ \t]*(\d{1,4})\b", re.M),
    "pilcrow_inline": re.compile(r"¶[ \t]*(\d{1,4})\b"),
    "para_word": re.compile(r"^[ \t]*para(?:graph)?\.?[ \t]*(\d{1,4})\b", re.I | re.M),
    "dotted": re.compile(r"^[ \t]*(\d{1,4})\.[ \t]+(?=[A-Z\"'\u201c])", re.M),
    "bare_num": re.compile(r"^[ \t]*(\d{1,4})[ \t]+(?=[A-Z\"'\u201c])", re.M),
    "paren": re.compile(r"^[ \t]*\((\d{1,4})\)[ \t]+(?=[A-Z\"'\u201c])", re.M),
    "dash_num": re.compile(r"^[ \t]*(\d{1,4})[ \t]*[-\u2013\u2014][ \t]+", re.M),
}


def longest_run(vals: list[int]) -> int:
    if not vals:
        return 0
    run = best = 1
    for a, b in zip(vals, vals[1:]):
        run = run + 1 if b == a + 1 else 1
        best = max(best, run)
    return best


def conv_report(text: str) -> dict:
    out = {}
    for name, rx in CONV.items():
        vals = [int(m.group(1)) for m in rx.finditer(text)]
        if vals:
            out[name] = {"n": len(vals), "run": longest_run(vals),
                         "max": max(vals), "starts_at_1": vals[0] == 1}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("court")
    ap.add_argument("lang", nargs="?", default="en")
    ap.add_argument("--per-decade", type=int, default=12)
    ap.add_argument("--flat", type=int, default=0, help="plain LIMIT instead")
    ap.add_argument("--out", required=True)
    ap.add_argument("--keep-text", action="store_true")
    args = ap.parse_args()

    import duckdb

    lang = args.lang
    pq = (A2AJ / "cases" / args.court / "train.parquet").as_posix()
    if args.flat:
        sql = f"""
          select citation_{lang}, unofficial_text_{lang}, document_date_{lang},
                 name_{lang}
          from read_parquet('{pq}')
          where unofficial_text_{lang} is not null
          limit {args.flat}
        """
    else:
        sql = f"""
          select citation_{lang}, unofficial_text_{lang}, document_date_{lang},
                 name_{lang}
          from read_parquet('{pq}')
          where unofficial_text_{lang} is not null
                and document_date_{lang} is not null
          qualify row_number() over (
            partition by (year(document_date_{lang}) / 10)::int
            order by citation_{lang}
          ) <= {args.per_decade}
        """
    con = duckdb.connect()
    rows = con.execute(sql).fetchall()
    out = Path(args.out)
    if not out.is_absolute():
        out = HERE / out
    n = 0
    with open(out, "w", encoding="utf-8") as fh:
        for cite, text, date, name in rows:
            a, ai = v1(text)
            b, bi = alr(text)
            rec = {
                "id": f"{args.court}:{cite}:{lang}",
                "court": args.court, "lang": lang, "citation": cite,
                "date": str(date)[:10] if date else None,
                "decade": (str(date)[:3] + "0s") if date else "unknown",
                "name": name, "chars": len(text),
                "v1": a, "v1_stats": ai, "alr": b, "alr_info": bi,
                "conventions": conv_report(text),
            }
            if args.keep_text:
                rec["text"] = text
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    print(f"{args.court}:{lang} -> {n} rows -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
