"""Differential check: build_citator_graph.py ports vs the reference oracles.

Beaver's citator build script must not import the reference implementations
at runtime (they are read-only reference projects), so its citation grammar,
node-identity key, case-name capture, and paragraph indexing are PORTS. This
throwaway dev tool - the skeleton-oracle-probe pattern - imports BOTH sides
and proves the ports faithful over a real corpus slice:

  - anchor spans:      port.anchor_spans        vs toa_maker._anchor_spans
  - node identity:     port.citation_lookup_key vs local_a2aj._citation_lookup_key
  - case-name capture: port.case_name_start     vs toa_maker._case_name_start
  - paragraph index:   port.paragraph_index     vs a2aj_structure.paragraph_index

The deliberate deviation NOT diffed here: the build's pinpoint capture scans
a bounded window after each anchor (toa_maker scans a whole split part),
documented in build_citator_graph.py.

Usage:
  python scripts/citator-oracle-diff.py [--per-family 8] [--families SCC,FC]
      [--corpus-root PATH]

Exits 1 on any mismatch so it can gate a port change.
"""
from __future__ import annotations
import os

import argparse
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
TOA_ROOT = SCRIPTS_DIR.parents[1] / "TableOfAuthoritiesMaker"
VERIFIER_ROOT = Path(
    os.environ.get("ALR_QUOTE_VERIFIER_ROOT", "")
)
for root in (str(SCRIPTS_DIR), str(TOA_ROOT), str(VERIFIER_ROOT)):
    if root not in sys.path:
        sys.path.insert(0, root)

import build_citator_graph as port  # noqa: E402

import toa_maker  # noqa: E402  (reference oracle, read-only)
import local_a2aj  # noqa: E402  (reference oracle, read-only)
from verifier_core import a2aj_structure  # noqa: E402  (reference oracle)


def sample_texts(corpus_root: Path, families: list[str] | None, per_family: int):
    import duckdb

    connection = duckdb.connect()
    connection.execute("PRAGMA disable_progress_bar")
    for relative, path in port.corpus_parquet_files(corpus_root, families):
        family = relative.split("/", 1)[0]
        escaped = str(path).replace("'", "''")
        total = connection.execute(
            f"SELECT count(*) FROM read_parquet('{escaped}')"
        ).fetchone()[0]
        if not total:
            continue
        stride = max(1, total // per_family)
        rows = connection.execute(
            "SELECT citation_en, citation_fr, citation2_en, citation2_fr, "
            "       unofficial_text_en, unofficial_text_fr "
            f"FROM read_parquet('{escaped}', file_row_number=true) "
            f"WHERE file_row_number % {stride} = 0 "
            "  AND (unofficial_text_en IS NOT NULL OR unofficial_text_fr IS NOT NULL) "
            f"LIMIT {per_family}"
        ).fetchall()
        for citation_en, citation_fr, citation2_en, citation2_fr, en, fr in rows:
            text = en or fr or ""
            citations = [c for c in (citation_en, citation_fr, citation2_en, citation2_fr) if c]
            yield family, citations, text


def main() -> int:
    argument_parser = argparse.ArgumentParser(description=__doc__)
    argument_parser.add_argument("--per-family", type=int, default=8)
    argument_parser.add_argument("--families", default="")
    argument_parser.add_argument(
        "--corpus-root", default=str(port.default_corpus_root())
    )
    args = argument_parser.parse_args()
    families = [f.strip() for f in args.families.split(",") if f.strip()] or None

    texts = 0
    anchors_checked = 0
    keys_checked = 0
    mismatches: list[str] = []
    per_family_ok: dict[str, list[int]] = {}

    for family, citations, text in sample_texts(
        Path(args.corpus_root), families, args.per_family
    ):
        texts += 1
        ok = True

        oracle_spans = toa_maker._anchor_spans(text)
        ported_spans = port.anchor_spans(text)
        if ported_spans != oracle_spans:
            ok = False
            mismatches.append(
                f"{family}: anchor_spans diverges "
                f"(oracle {len(oracle_spans)}, port {len(ported_spans)})"
            )
        anchors_checked += len(oracle_spans)

        for value in citations + [text[s:e] for s, e, _k in oracle_spans]:
            keys_checked += 1
            if port.citation_lookup_key(value) != local_a2aj._citation_lookup_key(value):
                ok = False
                mismatches.append(f"{family}: key diverges for {value!r}")

        previous_end = 0
        for start, end, kind in oracle_spans:
            if kind in port.CASE_ANCHOR_KINDS:
                oracle_name = toa_maker._case_name_start(text, start, previous_end)
                ported_name = port.case_name_start(text, start, previous_end)
                if oracle_name != ported_name:
                    ok = False
                    mismatches.append(
                        f"{family}: case_name_start diverges at offset {start}"
                    )
                previous_end = end

        oracle_paragraphs = [
            (number, start, end)
            for number, start, end, _text in a2aj_structure.paragraph_index(text)
        ]
        ported_paragraphs = [
            (number, start, end)
            for number, start, end, _text in port.paragraph_index(text)
        ]
        if oracle_paragraphs != ported_paragraphs:
            ok = False
            mismatches.append(
                f"{family}: paragraph_index diverges "
                f"(oracle {len(oracle_paragraphs)}, port {len(ported_paragraphs)})"
            )

        bucket = per_family_ok.setdefault(family, [0, 0])
        bucket[0] += int(ok)
        bucket[1] += 1

    for family in sorted(per_family_ok):
        matched, total = per_family_ok[family]
        print(f"{family:<12} {matched}/{total} texts fully matched")
    print(
        f"TOTAL: {sum(b[0] for b in per_family_ok.values())}/{texts} texts, "
        f"{anchors_checked:,} anchor spans, {keys_checked:,} keys checked"
    )
    for line in mismatches[:20]:
        print(f"  MISMATCH {line}")
    if mismatches:
        print(f"{len(mismatches)} mismatch(es)")
        return 1
    print("ports match the reference oracles exactly")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
