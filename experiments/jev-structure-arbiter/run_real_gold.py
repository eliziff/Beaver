"""Evaluate Jev on real primary-spine versus quoted-numbering decisions."""

import hashlib
import argparse
import json
import os
import random
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GOLD = ROOT / "benchmarks/legal-generalization-corpus/canadian/structure-gold/decisions"
MODEL = "jev-1.13.0"
URL = "https://api.typesafe.ai/v1/systemone"
SEED = 20260920
PER_ROLE = 8


def sample_cases(path: Path, context: str) -> tuple[dict, list[dict]]:
    record = json.loads(path.read_text(encoding="utf-8"))
    paragraphs = record["structure"]["paragraphs"]
    rng = random.Random(f"{SEED}:{record['artifact_id']}")
    selected = []
    for role in ("spine", "quoted_or_foreign"):
        candidates = [item for item in paragraphs if item["role"] == role]
        selected.extend(rng.sample(candidates, min(PER_ROLE, len(candidates))))
    rng.shuffle(selected)
    cases = []
    for index, item in enumerate(selected, 1):
        body = item["body"].strip().replace("\u0000", "")
        position = paragraphs.index(item)
        neighbors = []
        if context in ("neighbors", "structural"):
            radius = 1 if context == "neighbors" else 3
            for peer_index in range(max(0, position - radius), min(len(paragraphs), position + radius + 1)):
                peer = paragraphs[peer_index]
                peer_body = peer["body"].strip().replace("\u0000", "")[:500]
                neighbors.append(f"[{peer['label']}] {peer_body}")
        prior_primary = (
            next((peer["label"] for peer in reversed(paragraphs[:position]) if peer["role"] == "spine"), "none")
            if context == "structural" else ""
        )
        cases.append({
            "id": f"p{index:02d}",
            "expected": "primary" if item["role"] == "spine" else "quoted_or_foreign",
            "label": item["label"],
            "text": body[:1400],
            "context": "\n".join(neighbors),
            "prior_primary": prior_primary,
            "marker_order": item["marker_order"],
        })
    return record, cases


def call(key: str, record: dict, cases: list[dict]) -> tuple[dict, float]:
    passages = "\n\n".join(
        f"PASSAGE {case['id']}\nMARKER: [{case['label']}]\nTEXT: {case['text']}"
        + (f"\nLOCAL NUMBERED CONTEXT:\n{case['context']}" if case["context"] else "")
        + (
            f"\nLAST ALREADY ESTABLISHED PRIMARY MARKER: [{case['prior_primary']}]"
            if case.get("prior_primary") and case["prior_primary"] != "none" else ""
        )
        for case in cases
    )
    state = (
        f"These numbered passages were extracted from {record['citation']}, {record['name']}. "
        "Some are paragraphs in this court's own main reasons. Others are numbered material quoted "
        "from another decision, pleading, statute, judgment under appeal, or other embedded source.\n\n"
        + passages
    )
    questions = {
        case["id"]: {
            "type": "choice",
            "instructions": (
                f"Classify PASSAGE {case['id']}. Whose structural numbering does its marker belong to? "
                "Judge the supplied language and attribution, not whether its proposition is legally correct."
            ),
            "criteria": {
                "primary": "The marker belongs to this court's own primary paragraph sequence.",
                "quoted_or_foreign": "The marker belongs to quoted or embedded material from another source."
            },
        }
        for case in cases
    }
    body = json.dumps({"state": state, "model": MODEL, "questions": questions}).encode()
    request = urllib.request.Request(
        URL, data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"}, method="POST",
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode(errors='replace')}") from error
    return payload, time.perf_counter() - started


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", choices=("passage", "neighbors", "structural"), default="passage")
    args = parser.parse_args()
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        raise SystemExit("TYPESAFE_API_KEY is not set")
    results = []
    source_hash = hashlib.sha256()
    for path in sorted(GOLD.glob("*.structure.json")):
        source_hash.update(path.name.encode())
        source_hash.update(path.read_bytes())
        record, cases = sample_cases(path, args.context)
        payload, elapsed = call(key, record, cases)
        rows = []
        for case in cases:
            answer = payload["answers"][case["id"]]
            choice = answer["choice"]
            rows.append({
                **case, "choice": choice, "correct": choice == case["expected"],
                "answer": answer,
            })
        result = {
            "artifact_id": record["artifact_id"], "citation": record["citation"],
            "elapsed_seconds": elapsed, "usage": payload.get("usage"), "rows": rows,
        }
        results.append(result)
        print(f"{record['citation']}: {sum(row['correct'] for row in rows)}/{len(rows)} {elapsed:.3f}s")
    rows = [row for result in results for row in result["rows"]]
    by_expected = {
        role: {
            "cases": sum(row["expected"] == role for row in rows),
            "correct": sum(row["expected"] == role and row["correct"] for row in rows),
        }
        for role in ("primary", "quoted_or_foreign")
    }
    summary = {
        "schema": "jev-real-structure-probe.v1", "model": MODEL, "seed": SEED,
        "context": args.context,
        "source_sha256": source_hash.hexdigest(), "documents": len(results), "cases": len(rows),
        "correct": sum(row["correct"] for row in rows),
        "accuracy": sum(row["correct"] for row in rows) / len(rows),
        "by_expected": by_expected,
        "median_document_seconds": statistics.median(result["elapsed_seconds"] for result in results),
        "input_tokens": sum((result["usage"] or {}).get("input_tokens", 0) for result in results),
        "output_tokens": sum((result["usage"] or {}).get("output_tokens", 0) for result in results),
        "results": results,
    }
    output = Path(__file__).parent / f"receipts/real-gold-{args.context}.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: summary[key] for key in (
        "model", "documents", "cases", "correct", "accuracy", "by_expected",
        "median_document_seconds", "input_tokens", "output_tokens")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
