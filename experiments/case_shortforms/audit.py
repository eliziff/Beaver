"""Differential coverage check: screened declarations versus the complete native pipeline."""
from collections import Counter
from contextlib import closing
import argparse
import json
from pathlib import Path
import random
import time

from mine import Engine, Scanner, data_root, extract_document, journal_path, normalize, readonly


def audit(output: Path, count=32):
    engine = Engine()
    scanner = Scanner(engine)
    totals = Counter()
    differences = []
    reference_differences = []
    started = time.monotonic()
    try:
        for provider, filename, table, field in [
            ("journal", journal_path(), "articles", "article_id"),
            ("a2aj", data_root() / "providers/a2aj/a2aj.sqlite", "document", "id"),
        ]:
            with closing(readonly(filename)) as connection:
                maximum = connection.execute(f"SELECT max({field}) FROM {table}").fetchone()[0]
                ids = random.Random(8439).sample(range(1, maximum + 1), min(count * 2, maximum))
                marks = ",".join("?" for _ in ids)
                query = (f"SELECT article_id,'en',text FROM articles WHERE article_id IN ({marks})"
                         if provider == "journal" else
                         f"SELECT id,unofficial_text_en,unofficial_text_fr FROM document WHERE id IN ({marks}) AND doc_type='cases'")
                used = 0
                for row in connection.execute(query, ids):
                    texts = [("en", row[2])] if provider == "journal" else [("en", row[1]), ("fr", row[2])]
                    for language, text in texts:
                        if not text or used >= count:
                            continue
                        used += 1
                        screened = scanner.scan(text)["citations"]
                        expected_refs = [m.span() for m in scanner.references.rx.finditer(text)]
                        actual_refs = [m.span() for m in scanner.references.finditer(text)]
                        totals["reference_matches"] += len(expected_refs)
                        if expected_refs != actual_refs:
                            reference_differences.append({"provider": provider, "local_id": row[0],
                                "language": language, "expected": expected_refs, "actual": actual_refs})
                        complete = extract_document(engine, text)
                        definitions = lambda hits: {(c["key"], normalize(c["explicit"]), c["core"]["start"])
                                                   for c in hits if c.get("explicit") and c.get("key") and c["authority"] == "case"}
                        expected, actual = definitions(complete), definitions(screened)
                        totals[f"{provider}_texts"] += 1
                        totals[f"{provider}_chars"] += len(text)
                        totals[f"{provider}_native_definitions"] += len(expected)
                        totals[f"{provider}_screened_definitions"] += len(actual)
                        totals[f"{provider}_matched_definitions"] += len(expected & actual)
                        if expected != actual:
                            differences.append({"provider": provider, "local_id": row[0], "language": language,
                                                "missing": sorted(expected - actual), "extra": sorted(actual - expected)})
                        if used % 8 == 0:
                            print(f"{provider}: {used}/{count}, {time.monotonic()-started:.1f}s", flush=True)
        result = {"kind": "parser differential, not independent human gold", "seed": 8439,
                  "engine": engine.metadata, "totals": dict(totals), "differences": differences,
                  "reference_window_differences": reference_differences,
                  "elapsed_seconds": round(time.monotonic() - started, 2)}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result["totals"], indent=2))
        if reference_differences or any(row["missing"] for row in differences):
            raise AssertionError("The screen lost native declarations or clipped reference matches; inspect the private audit.")
        return result
    finally:
        engine.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("benchmarks/local-data/case-shortforms/discovery-audit.json"))
    parser.add_argument("--count", type=int, default=32)
    args = parser.parse_args()
    audit(args.output, args.count)
