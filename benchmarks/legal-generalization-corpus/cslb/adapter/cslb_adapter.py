#!/usr/bin/env python3
"""CSLB -> normalized deterministic-slice adapter.

Reads the Canadian Semantic LegalBench fixture
(repo/data/a2aj_benchmark.jsonl, pinned at e10e23c9) and emits normalized JSONL
rows the host tools can score with NO model call of any kind.

Every emitted row has the shape:

    {task_id, kind, input_text_or_ref, gold, source_provenance}

Deterministic kinds emitted (slice "a"):

  pinpoint_citation_parse      trailing pinpoint of a citation -> {anchor_kind, anchor_id}
  neutral_citation_parse       "2019 BCSC 1410" -> {year, court, number}
  reported_citation_parse      "[1998] 2 SCR 298" -> {year, reporter, page}
  tribunal_file_parse          "MB9-07757" / "C36988" -> {file_number}
  statute_citation_parse       "Motor Vehicle Act, RSBC 1996, c 318, s. 117"
                               -> {title, statute_series, chapter, section}
  prompt_anchor_resolution     NL prompt -> {anchor_kind, anchor_id, citation}
  anchor_quote_verification    reconstructed anchor text -> {anchor_sha256}

The model-required slice ("b") is written to a separate index file; those rows
need a generation call and are NOT scorable here.

Usage:
    python -X utf8 cslb_adapter.py                       # default paths
    python -X utf8 cslb_adapter.py --dataset ... --out ... --model-required-out ...
    python -X utf8 cslb_adapter.py --verify              # self-check gold vs fixture
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

HERE = Path(__file__).resolve().parent
CSLB_ROOT = HERE.parent
DEFAULT_DATASET = CSLB_ROOT / "repo" / "data" / "a2aj_benchmark.jsonl"
DEFAULT_OUT = CSLB_ROOT / "normalized" / "cslb_deterministic.jsonl"
DEFAULT_MODEL_OUT = CSLB_ROOT / "normalized" / "cslb_model_required.jsonl"

PINNED_COMMIT = "e10e23c929c16b5cc3e442c92f885eddb0412171"
UPSTREAM = "https://github.com/martinwrudolf/Canadian-Semantic-LegalBench"

# --- citation grammars -------------------------------------------------------

# trailing pinpoint, e.g. "..., para. 37" / "..., s. 16.8"
RE_PINPOINT = re.compile(r",\s*(para\.|paras\.|s\.|ss\.)\s*([0-9A-Za-z().\-]+)\s*$")
MARKER_TO_KIND = {"para.": "paragraph", "paras.": "paragraph", "s.": "section", "ss.": "section"}

# neutral citation, e.g. "2019 BCSC 1410"
RE_NEUTRAL = re.compile(r"\b(1[89]\d{2}|20\d{2})\s+([A-Z][A-Za-z]{1,9})\s+(\d+)\b")
# reported citation, e.g. "[1998] 2 SCR 298"
RE_REPORTED = re.compile(r"\[(1[89]\d{2}|20\d{2})\]\s+(\d+)\s+([A-Z][A-Za-z.]{1,8})\s+(\d+)")
# IRB-style file number, e.g. "MB9-07757" (leads the citation); ONCA docket,
# e.g. "R. v. Crawford, C36988, para. 6" (follows the style of cause).
RE_TRIBUNAL_FILE = re.compile(r"(?:^|,\s*)([A-Z]{2}\d-\d{5}|[A-Z]\d{5})(?=\s*,)")
# statute chapter token, e.g. "RSBC 1996, c 318" / "SC 2008, c 32".
# The statute title is everything BEFORE this match -- NOT cite.split(",")[0],
# because official titles legitimately contain commas ("Ontario Loan Act, 2026",
# "First Peoples' Heritage, Language and Culture Act", "... Act, No. 1").
RE_STATUTE = re.compile(r",\s*([A-Z]{1,4})\s+(1[89]\d{2}|20\d{2}),\s*c\.?\s*([\w.\-]+)")

# instruction suffix appended to sentence-completion prompts
RE_COMPLETE_INSTR = re.compile(r"\n*\[Complete the passage from the source text\.\]\s*$")
# "Clearly summarize paragraph 37 of <citation> for a non-lawyer."
RE_SUMMARIZE_PROMPT = re.compile(
    r"^Clearly summarize (paragraph|section)\s+([0-9A-Za-z().\-]+)\s+of\s+(.+?)\s+for a non-lawyer\.\s*$"
)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def strip_complete_instruction(text: str) -> str:
    return RE_COMPLETE_INSTR.sub("", text)


def reconstruct_anchor(row: Dict[str, Any]) -> str:
    """Rebuild the upstream A2AJ anchor text that anchor_sha256 was taken over.

    pinpoint_summarization_similarity: target_text IS the anchor text.
    sentence_completion_evaluation:    anchor = prompt prefix + ' ' + continuation.
    """
    if row["task"] == "sentence_completion_evaluation":
        prefix = strip_complete_instruction(row["input_context"]).strip()
        return f"{prefix} {row['target_text'].strip()}"
    return row["target_text"]


def provenance(row: Dict[str, Any]) -> Dict[str, Any]:
    md = row.get("metadata") or {}
    return {
        "corpus": "Canadian Semantic LegalBench (CSLB)",
        "upstream_repo": UPSTREAM,
        "pinned_commit": PINNED_COMMIT,
        "cslb_example_id": row["id"],
        "cslb_task": row["task"],
        "cslb_split": row["split"],
        "jurisdiction": row.get("jurisdiction", "CA"),
        "source_citation": row.get("source_citation", ""),
        "a2aj_dataset": md.get("a2aj_dataset"),
        "source_type": md.get("source_type"),
        "document_name": md.get("document_name"),
        "document_date": md.get("document_date"),
        "source_url": md.get("source_url"),
        "source_doc_key": md.get("source_doc_key"),
        "upstream_license": md.get("upstream_license"),
        "attribution": "Marty (Martin Rudolf); benchmark built on A2AJ open Canadian legal data",
    }


def emit(task_id: str, kind: str, ref: Any, gold: Dict[str, Any],
         row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "task_id": task_id,
        "kind": kind,
        "input_text_or_ref": ref,
        "gold": gold,
        "source_provenance": provenance(row),
    }


def derive_rows(row: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    """Yield every deterministically scorable row derived from one CSLB example."""
    md = row.get("metadata") or {}
    ex_id = row["id"]
    cite = (row.get("source_citation") or "").strip()
    anchor_kind = md.get("anchor_kind")
    anchor_id = md.get("anchor_id")

    # 1. pinpoint parse -- gold carried directly by the fixture
    m = RE_PINPOINT.search(cite)
    if m and anchor_kind and anchor_id is not None:
        yield emit(
            f"{ex_id}::pinpoint", "pinpoint_citation_parse", cite,
            {
                "anchor_kind": anchor_kind,
                "anchor_id": str(anchor_id),
                "pinpoint_marker": m.group(1),
            },
            row,
        )

    # 2/3/4. citation body parse -- court/year cross-validated against metadata
    if md.get("source_type") == "case_law":
        n = RE_NEUTRAL.search(cite)
        rep = RE_REPORTED.search(cite)
        if n:
            yield emit(
                f"{ex_id}::neutral", "neutral_citation_parse", cite,
                {
                    "year": n.group(1),
                    "court": n.group(2),
                    "number": n.group(3),
                    "court_matches_a2aj_dataset": n.group(2) == md.get("a2aj_dataset"),
                    "year_matches_document_date": n.group(1) == str(md.get("document_date"))[:4],
                },
                row,
            )
        elif rep:
            yield emit(
                f"{ex_id}::reported", "reported_citation_parse", cite,
                {
                    "year": rep.group(1),
                    "volume": rep.group(2),
                    "reporter": rep.group(3),
                    "page": rep.group(4),
                },
                row,
            )
        else:
            f = RE_TRIBUNAL_FILE.search(cite)
            if f:
                yield emit(
                    f"{ex_id}::file", "tribunal_file_parse", cite,
                    {"file_number": f.group(1), "tribunal": md.get("a2aj_dataset")},
                    row,
                )

    elif md.get("source_type") == "legislation":
        s = RE_STATUTE.search(cite)
        if s:
            title = cite[: s.start()].strip()
            doc_name = md.get("document_name") or ""
            yield emit(
                f"{ex_id}::statute", "statute_citation_parse", cite,
                {
                    "title": title,
                    "statute_series": s.group(1),
                    "series_year": s.group(2),
                    "chapter": s.group(3),
                    "section": str(anchor_id),
                    "title_matches_document_name": title == doc_name,
                },
                row,
            )

    # 5. natural-language prompt -> structured anchor (summarization prompts only)
    p = RE_SUMMARIZE_PROMPT.match((row.get("input_context") or "").strip())
    if p:
        yield emit(
            f"{ex_id}::prompt_anchor", "prompt_anchor_resolution", row["input_context"],
            {
                "anchor_kind": p.group(1),
                "anchor_id": p.group(2),
                "citation": p.group(3),
                "agrees_with_metadata": (p.group(1) == anchor_kind and p.group(2) == str(anchor_id)),
            },
            row,
        )

    # 6. quote verification against the upstream anchor hash
    if md.get("anchor_sha256"):
        text = reconstruct_anchor(row)
        yield emit(
            f"{ex_id}::quote", "anchor_quote_verification",
            {
                "anchor_text": text,
                "reconstruction": ("prompt_prefix + ' ' + target_text"
                                   if row["task"] == "sentence_completion_evaluation"
                                   else "target_text"),
                "anchor_kind": anchor_kind,
                "anchor_id": str(anchor_id),
            },
            {
                "anchor_sha256": md["anchor_sha256"],
                "self_verified": sha256(text) == md["anchor_sha256"],
            },
            row,
        )


def model_required_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Index entry for the generation-dependent slice (b)."""
    md = row.get("metadata") or {}
    return {
        "task_id": row["id"],
        "kind": row["task"] + ("__adversarial" if row.get("is_adversarial") else "__ordinary"),
        "input_text_or_ref": row["input_context"],
        "gold": {
            "target_text": row["target_text"],
            "is_adversarial": bool(row.get("is_adversarial")),
            "expected": md.get("expected"),
            "adversarial_kind": md.get("adversarial_kind"),
            "rationale": md.get("rationale"),
            "seed_example_id": md.get("seed_example_id"),
            "scoring": ("embedding-ensemble cosine vs target_text "
                        "(>=3 models) + refusal regex; requires a generation call"),
        },
        "source_provenance": provenance(row),
    }


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--model-required-out", type=Path, default=DEFAULT_MODEL_OUT)
    ap.add_argument("--verify", action="store_true",
                    help="report gold self-consistency instead of only counts")
    args = ap.parse_args(argv)

    rows = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines()
            if line.strip()]

    det: List[Dict[str, Any]] = []
    mod: List[Dict[str, Any]] = []
    for row in rows:
        det.extend(derive_rows(row))
        mod.append(model_required_row(row))

    for path, payload in ((args.out, det), (args.model_required_out, mod)):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8", newline="\n") as fh:
            for item in payload:
                fh.write(json.dumps(item, ensure_ascii=False) + "\n")

    kinds = Counter(r["kind"] for r in det)
    print(f"source fixture : {args.dataset}  ({len(rows)} examples, commit {PINNED_COMMIT[:8]})")
    print(f"deterministic  : {args.out}  ({len(det)} rows)")
    for kind, n in sorted(kinds.items(), key=lambda kv: -kv[1]):
        print(f"    {kind:<28} {n}")
    print(f"model-required : {args.model_required_out}  ({len(mod)} rows)")
    for kind, n in sorted(Counter(r['kind'] for r in mod).items()):
        print(f"    {kind:<40} {n}")

    if args.verify:
        print("\n-- gold self-consistency --")
        q = [r for r in det if r["kind"] == "anchor_quote_verification"]
        print(f"anchor_quote_verification self_verified : "
              f"{sum(1 for r in q if r['gold']['self_verified'])}/{len(q)} "
              f"(remainder = curator-edited target text; hash pins upstream A2AJ text)")
        pr = [r for r in det if r["kind"] == "prompt_anchor_resolution"]
        print(f"prompt_anchor_resolution agrees w/ metadata : "
              f"{sum(1 for r in pr if r['gold']['agrees_with_metadata'])}/{len(pr)}")
        nc = [r for r in det if r["kind"] == "neutral_citation_parse"]
        print(f"neutral_citation court == a2aj_dataset      : "
              f"{sum(1 for r in nc if r['gold']['court_matches_a2aj_dataset'])}/{len(nc)}")
        print(f"neutral_citation year == document_date year : "
              f"{sum(1 for r in nc if r['gold']['year_matches_document_date'])}/{len(nc)}")
        st = [r for r in det if r["kind"] == "statute_citation_parse"]
        print(f"statute title == document_name              : "
              f"{sum(1 for r in st if r['gold']['title_matches_document_name'])}/{len(st)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
