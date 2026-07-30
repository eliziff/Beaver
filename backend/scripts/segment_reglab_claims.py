"""Segment RegLab labeled responses into claim rows with cited sources.

Fixes the unit mismatch from the first (negative) external validation:
signals calibrated on CLAIMS were scored on full RESPONSES. This
produces claim-level rows, each with the case citation(s) it actually
cites, so the source-anchored features can run claim-vs-source.

Method (deterministic): eyecite spans for every citation are masked
with placeholder tokens BEFORE sentence splitting — citations are
where the abbreviation periods live, so masking them first makes a
plain sentence splitter reliable. After splitting, placeholders map
each sentence to its citations. Sentences with no citation of their
own inherit the nearest following citation group within the same
paragraph (legal prose cites at the end of a run of sentences); the
inheritance is recorded, never silent.

Output: %LOCALAPPDATA%/OpenLegalData/misgrounding-corpus/reglab_claims.jsonl
  {row_key, question_id, model, label, question, claim, sentence_index,
   citations: [corrected citation], citation_inherited: bool}

    python -X utf8 scripts/segment_reglab_claims.py
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

from eyecite import get_citations
from eyecite.models import FullCaseCitation


def local(*parts: str) -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base).joinpath(*parts)


RAW = local("OpenLegalData", "misgrounding-corpus", "raw", "reglab_rag_dataset.csv")
OUT = local("OpenLegalData", "misgrounding-corpus", "reglab_claims.jsonl")
LABELS = {"Grounded", "Ungrounded", "Misgrounded"}
SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(\[@])")
MIN_CLAIM = 40  # chars; drops headers/fragments

csv.field_size_limit(10_000_000)


def mask_citations(text: str):
    """Replace each citation's FULL span (case name + cite + year) with
    @CITn@ placeholders; return masked text + map. full_span() is what
    keeps 'U.S. v.' fragments out of the sentence splitter; overlapping
    spans (parallel citations sharing a case name) are merged first."""
    citations = [
        c for c in get_citations(text) if isinstance(c, FullCaseCitation)
    ]
    spans = []
    for index, cite in enumerate(citations):
        start, end = cite.full_span() if hasattr(cite, "full_span") else cite.span()
        spans.append((start, end, index))
    spans.sort()
    merged: list[list] = []
    for start, end, index in spans:
        if merged and start <= merged[-1][1] + 3:
            merged[-1][1] = max(merged[-1][1], end)
            merged[-1][2].append(index)
        else:
            merged.append([start, end, [index]])
    masked = text
    for start, end, indexes in reversed(merged):
        tokens = " ".join(f"@CIT{i}@" for i in indexes)
        masked = masked[:start] + f" {tokens} " + masked[end:]
    mapping = {i: c.corrected_citation() for i, c in enumerate(citations)}
    return masked, mapping


PLACEHOLDER = re.compile(r"@CIT(\d+)@")


def segment(response: str):
    masked, mapping = mask_citations(response)
    for paragraph in re.split(r"\n\s*\n|\n(?=[A-Z@])", masked):
        sentences = [s.strip() for s in SENTENCE.split(paragraph) if s.strip()]
        parsed = []
        for sentence in sentences:
            cited = [mapping[int(m)] for m in PLACEHOLDER.findall(sentence)]
            clean = PLACEHOLDER.sub("", sentence)
            clean = re.sub(r"\(\s*,?\s*\)|\[\d+\]", "", clean)  # empty cite parens, [n]
            clean = re.sub(r"\s+", " ", clean).strip(" ,;")
            parsed.append({"claim": clean, "citations": cited, "inherited": False})
        # Inherit the nearest FOLLOWING citation group within the paragraph.
        next_cites: list[str] = []
        for item in reversed(parsed):
            if item["citations"]:
                next_cites = item["citations"]
            elif next_cites:
                item["citations"] = list(next_cites)
                item["inherited"] = True
        yield from parsed


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    stats: Counter = Counter()
    with open(OUT, "w", encoding="utf-8") as out, open(RAW, encoding="utf-8") as raw:
        for row in csv.DictReader(raw):
            label = (row.get("Groundedness") or "").strip()
            if label not in LABELS:
                continue
            row_key = f"{row['Question ID']}::{row.get('Model')}"
            for index, item in enumerate(segment(row.get("Response") or "")):
                if len(item["claim"]) < MIN_CLAIM:
                    stats["dropped_short"] += 1
                    continue
                if len(re.findall(r"[A-Za-z]{2,}", item["claim"])) < 5:
                    stats["dropped_residue"] += 1
                    continue
                out.write(
                    json.dumps(
                        {
                            "row_key": row_key,
                            "question_id": row["Question ID"],
                            "model": row.get("Model"),
                            "label": label.lower(),
                            "question": row.get("Question"),
                            "claim": item["claim"],
                            "sentence_index": index,
                            "citations": item["citations"],
                            "citation_inherited": item["inherited"],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                stats[f"claims_{label.lower()}"] += 1
                if item["citations"]:
                    stats["claims_with_citations"] += 1
    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
    total = sum(v for k, v in stats.items() if k.startswith("claims_") and not k.endswith("citations"))
    print(f"claims: {total} -> {OUT}")
    print(f"sha256: {digest}")
    for key, value in sorted(stats.items()):
        print(f"  {key}: {value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
