"""Assemble the Beaver misgrounding corpus (research plan workstream B2).

Unifies claim/response-level rows about grounded vs misgrounded legal
framing from four provenance classes, WITHOUT ever promoting a label
beyond its provenance:

  expert_annotated   RegLab legal_rag_hallucinations (Magesh et al.,
                     CC-BY-4.0): full tool responses with Groundedness
                     labels incl. the canonical "Misgrounded".
  court_described    Charlotin AI Hallucination Cases CSV: per-item
                     categories (Fabricated / Misrepresented / False
                     Quotes / Outdated Advice) with the court's or
                     curator's description — PARAPHRASES of the
                     offending claim, not the model's own text, and
                     flagged as such.
  checker_derived    our archived experiment receipts: accepted claims
                     from supported answers; rejected = single-claim
                     non-supported answers (exact spans included).
  benchmark_adversarial  CSLB adversarial rows: false-premise inputs
                     with corrected targets.

Output: %LOCALAPPDATA%/OpenLegalData/misgrounding-corpus/corpus-v1.jsonl
plus printed aggregate stats. The repo keeps this builder and aggregate
numbers only; row data stays outside git per the durable-receipts
contract.

    python -X utf8 scripts/build_misgrounding_corpus.py
"""
from __future__ import annotations

import csv
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path


def local(*parts: str) -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base).joinpath(*parts)


RAW = local("OpenLegalData", "misgrounding-corpus", "raw")
OUT = local("OpenLegalData", "misgrounding-corpus", "corpus-v1.jsonl")
ARCHIVE = local("OpenLegalData", "experiments", "legal-grounding", "2026-07-30")
CSLB = (
    Path(__file__).resolve().parents[2]
    / "benchmarks/legal-generalization-corpus/cslb/repo/data/a2aj_benchmark.jsonl"
)
CHARLOTIN_CANDIDATES = [
    RAW / "charlotin.csv",
    Path(os.environ.get("TEMP", "")) / "claude"
    / "C--Users-elias-Desktop-MikeOSS-Fork"
    / "aa4aa4db-e5ce-4bf0-adb6-a956d80fc3ca" / "scratchpad" / "charlotin.csv",
]

csv.field_size_limit(10_000_000)


def rows_reglab():
    path = RAW / "reglab_rag_dataset.csv"
    if not path.exists():
        print(f"[skip] {path} missing", file=sys.stderr)
        return
    with open(path, encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            groundedness = (row.get("Groundedness") or "").strip()
            if groundedness not in {"Grounded", "Ungrounded", "Misgrounded"}:
                continue
            yield {
                "text": row.get("Response") or "",
                "question": row.get("Question") or None,
                "spans": None,
                "label": groundedness.lower(),
                "label_provenance": "expert_annotated",
                "origin": "reglab_rag_hallucinations",
                "origin_id": row.get("Question ID"),
                "jurisdiction": "US",
                "source_class": None,
                "court_level": None,
                "model_family": row.get("Model"),
                "area_of_law": row.get("Question Category"),
                "text_is_paraphrase": False,
            }


def rows_charlotin():
    path = next((p for p in CHARLOTIN_CANDIDATES if p.exists()), None)
    if path is None:
        print("[skip] charlotin.csv missing", file=sys.stderr)
        return
    with open(path, encoding="utf-8", errors="replace") as handle:
        for row in csv.DictReader(handle):
            items = (row.get("Hallucination Items") or "").split("||")
            for item in items:
                item = item.strip()
                if not item:
                    continue
                match = re.match(
                    r"(?P<category>[^:|]+?)\s*:\s*(?P<sub>[^|]+?)\s*\|\s*(?P<desc>.+)",
                    item,
                    re.S,
                )
                if match:
                    category = match.group("category").strip()
                    sub = match.group("sub").strip()
                    description = match.group("desc").strip()
                else:
                    category, sub, description = "Uncategorized", "", item
                yield {
                    "text": description,
                    "question": None,
                    "spans": None,
                    "label": category.lower().replace(" ", "_"),
                    "label_provenance": "court_described",
                    "origin": "charlotin_hallucination_cases",
                    "origin_id": row.get("Case Name"),
                    "jurisdiction": row.get("State(s)") or row.get("Court"),
                    "source_class": sub.lower().replace(" ", "_") or None,
                    "court_level": row.get("Court"),
                    "model_family": row.get("AI Tool") or None,
                    "area_of_law": row.get("Legal Field Primary") or None,
                    "text_is_paraphrase": True,
                }


def rows_receipts():
    stage6 = Path(os.environ.get("TEMP", "")) / "beaver-legal-grounding" / "stage6-h6.jsonl"
    files = glob.glob(str(ARCHIVE / "*.jsonl"))
    if stage6.exists():
        files.append(str(stage6))
    for file in files:
        for line in open(file, encoding="utf-8"):
            if not line.strip():
                continue
            row = json.loads(line)
            rec = row.get("legal_evidence_receipt") or row.get("receipt")
            if not rec:
                continue
            verdict = (rec.get("verification") or {}).get("holistic")
            if verdict in (None, "not_run"):
                continue
            claims = rec.get("claims") or []
            if verdict == "supported":
                label = "grounded"
            elif len(claims) == 1:
                label = "misgrounded"
            else:
                continue
            spans = {
                e["evidence_id"]: e.get("span_text") or ""
                for e in rec.get("evidence") or []
            }
            for claim in claims:
                if claim.get("deterministic_support"):
                    continue
                text = (claim.get("text") or "").strip()
                claim_spans = [
                    spans[i] for i in claim.get("evidence_ids", []) if spans.get(i)
                ]
                if not text or not claim_spans:
                    continue
                yield {
                    "text": text,
                    "question": None,
                    "spans": claim_spans,
                    "label": label,
                    "label_provenance": "checker_derived",
                    "origin": "beaver_receipts",
                    "origin_id": row.get("case_id") or row.get("probe_id"),
                    "jurisdiction": (rec.get("evidence") or [{}])[0].get("jurisdiction"),
                    "source_class": (rec.get("evidence") or [{}])[0].get("source_class"),
                    "court_level": None,
                    "model_family": (row.get("model") or "").split(":")[0] or None,
                    "area_of_law": None,
                    "text_is_paraphrase": False,
                }


def rows_cslb():
    if not CSLB.exists():
        print(f"[skip] {CSLB} missing", file=sys.stderr)
        return
    for line in open(CSLB, encoding="utf-8"):
        row = json.loads(line)
        if not row.get("is_adversarial"):
            continue
        yield {
            "text": row.get("input_context") or "",
            "question": None,
            "spans": [row.get("target_text") or ""],
            "label": "adversarial_premise",
            "label_provenance": "benchmark_adversarial",
            "origin": "cslb",
            "origin_id": row.get("id"),
            "jurisdiction": "CA",
            "source_class": (row.get("metadata") or {}).get("source_type"),
            "court_level": None,
            "model_family": None,
            "area_of_law": None,
            "text_is_paraphrase": False,
        }


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    stats: Counter = Counter()
    breadth: dict[str, Counter] = {
        "jurisdiction": Counter(),
        "source_class": Counter(),
        "model_family": Counter(),
        "area_of_law": Counter(),
    }
    with open(OUT, "w", encoding="utf-8") as out:
        for source in (rows_reglab, rows_charlotin, rows_receipts, rows_cslb):
            for row in source():
                row["schema_version"] = 1
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                stats[(row["origin"], row["label"])] += 1
                for axis in breadth:
                    value = row.get(axis)
                    if value:
                        breadth[axis][str(value)] += 1
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    total = sum(stats.values())
    print(f"corpus-v1: {total} rows -> {OUT}")
    print(f"sha256: {digest}")
    for (origin, label), count in sorted(stats.items()):
        print(f"  {origin:32s} {label:22s} {count}")
    for axis, counter in breadth.items():
        top = ", ".join(f"{k}:{v}" for k, v in counter.most_common(6))
        print(f"  breadth {axis:14s} ({len(counter)} distinct): {top}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
