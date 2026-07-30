#!/usr/bin/env python
"""Bounded sampler: judgment paragraphs + the footnote corpus, cached to JSON.

Throttle contract: single-threaded, per-court `LIMIT` queries (one row group
each), never a whole-corpus scan, and text columns pulled one court at a time.
Deterministic: fixed court order, fixed LIMIT, first-N paragraphs per doc.

Outputs one JSON:
  {"paragraphs": [{"court","lang","doc","text"}...],
   "footnotes":  ["...", ...]}

Run:
  python -X utf8 benchmarks/structure_stress/probes/cite_sample_texts.py \
      --out <scratch>/cite_samples.json
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

CORPUS = Path.home() / "AppData" / "Local" / "ALR Quote Verifier" / "a2aj_corpus"
FOOTNOTES = (
    Path(__file__).resolve().parents[3]
    / "benchmarks" / "docx_corpus" / "private_results" / "local" / "cases.private.jsonl"
)
# >=6 courts, EN+FR, mixed appellate/trial/tribunal.
COURTS = ["SCC", "FCA", "FC", "TCC", "ONCA", "BCCA", "NSCA", "CT", "CITT", "CHRT"]
# A2AJ `unofficial_text_*` is one-line-per-paragraph markdown (blank lines are
# rare), so the paragraph unit is the newline-delimited line. Verified on
# SCC/[1936] SCR 551: splitting on \n\s*\n returns the whole 19 kB document.
PARA_SPLIT = re.compile(r"\n")


def sample(corpus: Path, courts: list[str], langs: list[str], docs: int,
           paras_per_doc: int) -> list[dict]:
    import duckdb

    con = duckdb.connect()
    out: list[dict] = []
    for court in courts:
        parquet = corpus / "cases" / court / "train.parquet"
        if not parquet.is_file():
            continue
        for lang in langs:
            col = f"unofficial_text_{lang}"
            rows = con.execute(
                f"SELECT citation_{lang}, {col} FROM read_parquet"
                f"('{parquet.as_posix()}') WHERE {col} IS NOT NULL "
                f"AND length({col}) > 2000 LIMIT {int(docs)}"
            ).fetchall()
            for cite, text in rows:
                chunks = [p.strip() for p in PARA_SPLIT.split(text) if len(p.strip()) > 80]
                for para in chunks[:paras_per_doc]:
                    out.append({"court": court, "lang": lang,
                                "doc": cite or "", "text": para})
    con.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--footnotes", type=Path, default=FOOTNOTES)
    ap.add_argument("--docs", type=int, default=12, help="docs per court per lang")
    ap.add_argument("--paras", type=int, default=12, help="paragraphs per doc")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    paragraphs = sample(args.corpus, COURTS, ["en", "fr"], args.docs, args.paras)
    footnotes: list[str] = []
    if args.footnotes.is_file():
        seen: set[str] = set()
        for line in args.footnotes.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            txt = (json.loads(line).get("footnote_text") or "").strip()
            if txt and txt not in seen:
                seen.add(txt)
                footnotes.append(txt)
    payload = {"paragraphs": paragraphs, "footnotes": footnotes}
    args.out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    langs = {}
    for p in paragraphs:
        langs[(p["court"], p["lang"])] = langs.get((p["court"], p["lang"]), 0) + 1
    print(f"paragraphs={len(paragraphs)} footnotes={len(footnotes)}")
    print("per court/lang:", sorted((f"{k[0]}/{k[1]}", v) for k, v in langs.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
