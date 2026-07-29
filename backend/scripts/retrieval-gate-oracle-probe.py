"""Dump citation-key and exact-lookup oracle output for retrievalGate diffing.

The oracle is the ALR Quote Verifier's corpus store (local_a2aj), the
reference implementation whose _citation_lookup_key keys the corpus's
lookup.duckdb. Beaver never runtime-imports it; this probe is a TEST-TIME
oracle in the skeleton-oracle-probe.py pattern. It dumps:

  - citation_keys: oracle _citation_lookup_key output for every citation in
    the retrieval-gate set/slice plus a fixed edge-case battery (dashes,
    digit-bounded punctuation, NFKC forms), so the differential test in
    src/lib/__tests__/retrievalGate.test.ts can prove Beaver's ported
    citationLookupKey is equivalent;
  - exact_gold: for every gold document, the reference store's own exact
    lookup (LocalA2AJCorpus._exact_rows -> lookup.duckdb + query_cache) with
    the gold sections' texts, so the test can prove the benchmark's gold
    round-trips through the production reference lookup path.

Usage:
  python scripts/retrieval-gate-oracle-probe.py
      [--set ../benchmarks/retrieval_gate/set-v1.json]
      [--slice ../benchmarks/retrieval_gate/slice-v1.json]
      [--out src/lib/__tests__/fixtures/retrieval_gate/citation-key-oracle.json]
"""
from __future__ import annotations
import os

import argparse
import json
import sys
from datetime import date
from pathlib import Path

VERIFIER_ROOT = Path(
    os.environ.get("ALR_QUOTE_VERIFIER_ROOT", "")
)
sys.path.insert(0, str(VERIFIER_ROOT))

from local_a2aj import LocalA2AJCorpus, _citation_lookup_key  # noqa: E402

BACKEND = Path(__file__).resolve().parent.parent
GATE_DIR = BACKEND.parent / "benchmarks" / "retrieval_gate"

# Fixed inputs exercising every branch of the normalizer: digit-bounded
# ./-// markers, en/em dashes, non-breaking hyphen (NOT dash-marked — it is
# stripped), letter-bounded punctuation, NFKC ligature/fullwidth folding,
# casefold, accents, and emptiness.
EDGE_CASES = [
    "RSA 2000, c A-4.2",
    "R.S.O. 1990, c. A.13",
    "SOR/86-1078",
    "SOR/97-555",
    "SI/2019-25",
    "RSC 1985, c I-21",
    "RSC 1985, c I\u201121",
    "2019\u20132020 Interim Act",
    "2019\u20142020 Interim Act",
    "Loi de 2001, ch\u00a0 32",
    "Qu\u00e9bec Official Publisher Act",
    "\uff32\uff33\uff23 \uff11\uff19\uff18\uff15",
    "O\ufb03ce Consolidation Act",
    "Stra\u00dfe Act 2000",
    "  RSBC 1996,   c 37  ",
    "",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--set", default=str(GATE_DIR / "set-v1.json"))
    parser.add_argument("--slice", default=str(GATE_DIR / "slice-v1.json"))
    parser.add_argument(
        "--out",
        default=str(
            BACKEND
            / "src"
            / "lib"
            / "__tests__"
            / "fixtures"
            / "retrieval_gate"
            / "citation-key-oracle.json"
        ),
    )
    args = parser.parse_args()

    set_data = json.loads(Path(args.set).read_text(encoding="utf-8"))
    slice_data = json.loads(Path(args.slice).read_text(encoding="utf-8"))

    inputs = list(EDGE_CASES)
    inputs.extend(doc["citation"] for doc in slice_data["docs"])
    inputs.extend(item["corpus_ref"]["citation"] for item in set_data["items"])
    seen: set[str] = set()
    citation_keys = []
    for value in inputs:
        if value in seen:
            continue
        seen.add(value)
        citation_keys.append({"input": value, "oracle_key": _citation_lookup_key(value)})

    corpus = LocalA2AJCorpus()
    manifest = corpus._read_manifest("laws") or {}
    gold: dict[str, dict] = {}
    for item in set_data["items"]:
        citation = item["corpus_ref"]["citation"]
        entry = gold.setdefault(
            citation,
            {
                "citation": citation,
                "citation_key": _citation_lookup_key(citation),
                "found": False,
                "sections": {},
            },
        )
        rows = corpus._exact_rows("laws", citation=citation)
        row = next((r for r in rows if r.get("citation_en") == citation), None)
        if row is None:
            continue
        entry["found"] = True
        sections = json.loads(row.get("unofficial_sections_en") or "{}")
        for handle in item["gold_locators"]:
            label = handle[len("sec"):]
            if label in sections:
                entry["sections"][handle] = sections[label]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated": date.today().isoformat(),
        "oracle": "local_a2aj._citation_lookup_key + LocalA2AJCorpus._exact_rows",
        "corpus_revision": str(manifest.get("revision") or "unknown"),
        "citation_keys": citation_keys,
        "exact_gold": sorted(gold.values(), key=lambda item: item["citation"]),
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"oracle dump: {len(citation_keys)} citation keys, "
        f"{len(gold)} gold docs -> {out_path}"
    )


if __name__ == "__main__":
    main()
