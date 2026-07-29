"""Dump corpus law texts with oracle section labels for skeleton diffing.

The oracle is the quote verifier's corpus-proven grammar
(verifier_core.a2aj_structure.section_structure) applied to the same
normalized text the verifier itself reads. Each JSONL row carries the
normalized text so the TypeScript side diffs against identical input.

Usage:
  python skeleton-oracle-probe.py --root "<laws dir>" --out probe.jsonl \
      --per-dataset 12
"""
from __future__ import annotations
import os

import argparse
import json
import sys
from pathlib import Path

import pyarrow.parquet as pq

VERIFIER_ROOT = Path(
    os.environ.get("ALR_QUOTE_VERIFIER_ROOT", "")
)
sys.path.insert(0, str(VERIFIER_ROOT))

import alr_quote_verifier as verifier  # noqa: E402
from verifier_core import a2aj_structure  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--per-dataset", type=int, default=12)
    args = parser.parse_args()

    paths = sorted(Path(args.root).glob("*/train.parquet"))
    texts = 0
    with_sections = 0
    with Path(args.out).open("w", encoding="utf-8") as out:
        for path in paths:
            dataset = path.parent.name
            schema = set(pq.ParquetFile(path).schema.names)
            wanted = [
                name
                for name in (
                    "citation_en", "citation_fr", "name_en", "name_fr",
                    "unofficial_text_en", "unofficial_text_fr",
                )
                if name in schema
            ]
            rows = pq.read_table(path, columns=wanted).to_pylist()
            count = min(args.per_dataset, len(rows))
            if count == 0:
                continue
            stride = max(1, len(rows) // count)
            picked = rows[::stride][:count]
            for row in picked:
                for language in ("en", "fr"):
                    raw = str(row.get(f"unofficial_text_{language}") or "")
                    if not raw.strip():
                        continue
                    text = verifier._normalize_a2aj_source_text(raw)
                    name = str(
                        row.get(f"name_{language}") or row.get("name_en") or ""
                    )
                    sections = a2aj_structure.section_structure(
                        text,
                        allow_hyphen=a2aj_structure.allows_hyphenated_provisions(
                            name
                        ),
                    )
                    texts += 1
                    if sections:
                        with_sections += 1
                    out.write(
                        json.dumps(
                            {
                                "dataset": dataset,
                                "language": language,
                                "citation": row.get(f"citation_{language}")
                                or row.get("citation_en")
                                or "",
                                "name": name,
                                "chars": len(text),
                                "oracle": [item[0] for item in sections],
                                "text": text,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
            print(f"{dataset}: {len(picked)} docs", flush=True)
    print(
        f"texts={texts} oracle_with_sections={with_sections}",
        flush=True,
    )


if __name__ == "__main__":
    main()
