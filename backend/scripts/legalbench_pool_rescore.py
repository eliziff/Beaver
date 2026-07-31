"""Re-score a raw-coordinate LegalBench-RAG pool sidecar on the corrected
instrument (Stage 18 instrument fix). Stdlib only, zero model calls.

Every pool/receipt this program wrote before the corpus-normalization fix
holds RAW CRLF offsets, because the 17 maud corpus files ship CRLF while
upstream gold spans are LF coordinates. Those files cannot be re-run for
free (a fused pool costs an embedding pass), so they are corrected at
SCORE time by mapping each offset:

    lf_offset  = raw_offset - (number of "\\r\\n" in the raw text before it)
    raw_offset = lf_offset  + (number of "\\r\\n" in the LF text before it)

Prints pool recall three ways so the two defects stay separable:
  A  as recorded   raw spans vs LF gold, upstream pairwise-sum overlap
  B  lf-map only   coordinates corrected, still pairwise-sum (D2 present)
  C  corrected     coordinates + union-merged credit, clipped at 1.0

Usage (from backend/):
  python scripts/legalbench_pool_rescore.py <pool.jsonl> [--json out.json]

Pool sidecar format: one JSON object per line,
  {"test_id": "maud:007", "source": "maud",
   "pool": [{"citation": <upstream path>, "start": int, "end": int}, ...]}
"""
import json
import os
import re
import sys
from bisect import bisect_right

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = os.path.join(REPO_ROOT, "benchmarks", "legalbench_rag", "data")
SOURCES = ("contractnli", "cuad", "maud", "privacy_qa")


def sanitize(upstream_path):
    """Windows-safe local corpus name (mirrors sanitizeCorpusPath)."""
    return "/".join(re.sub(r'[<>:"|?*]', "_", part) for part in upstream_path.split("/"))


_raw_text = {}
_crlf_at = {}


def raw_text(upstream_path):
    if upstream_path not in _raw_text:
        with open(os.path.join(DATA, "mini", "corpus", sanitize(upstream_path)), "rb") as fh:
            _raw_text[upstream_path] = fh.read().decode("utf8")
    return _raw_text[upstream_path]


def raw_to_lf(upstream_path, offset):
    if upstream_path not in _crlf_at:
        _crlf_at[upstream_path] = [m.start() for m in re.finditer("\r\n", raw_text(upstream_path))]
    return offset - bisect_right(_crlf_at[upstream_path], offset - 1)


def union_length(spans):
    """Total characters covered by (path, start, end) triples, counted once."""
    by_path = {}
    for path, start, end in spans:
        by_path.setdefault(path, []).append((start, end))
    total = 0
    for items in by_path.values():
        items.sort()
        current_start, current_end = items[0]
        for start, end in items[1:]:
            if start > current_end:
                total += current_end - current_start
                current_start, current_end = start, end
            elif end > current_end:
                current_end = end
        total += current_end - current_start
    return total


def load_gold():
    gold = {}
    for source in SOURCES:
        with open(os.path.join(DATA, "mini", "benchmarks", source + ".json"), encoding="utf8") as fh:
            tests = json.load(fh)["tests"]
        for index, test in enumerate(tests):
            gold["%s:%03d" % (source, index)] = [
                (s["file_path"], s["span"][0], s["span"][1]) for s in test["snippets"]
            ]
    return gold


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pool_path = sys.argv[1]
    json_out = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
    gold = load_gold()
    per_source = {}

    for line in open(pool_path, encoding="utf8"):
        if not line.strip():
            continue
        row = json.loads(line)
        gold_spans = gold[row["test_id"]]
        gold_length = sum(end - start for _, start, end in gold_spans)
        pool_raw = [(p["citation"], p["start"], p["end"]) for p in row["pool"]]
        pool_lf = [(c, raw_to_lf(c, a), raw_to_lf(c, b)) for c, a, b in pool_raw]

        def pairwise(pool):
            common = 0
            for pool_path_, pool_start, pool_end in pool:
                for gold_path, gold_start, gold_end in gold_spans:
                    if pool_path_ == gold_path:
                        common += max(0, min(pool_end, gold_end) - max(pool_start, gold_start))
            return common

        def merged(pool):
            credited = []
            for pool_path_, pool_start, pool_end in pool:
                for gold_path, gold_start, gold_end in gold_spans:
                    if pool_path_ == gold_path and min(pool_end, gold_end) > max(pool_start, gold_start):
                        credited.append(
                            (pool_path_, max(pool_start, gold_start), min(pool_end, gold_end))
                        )
            return union_length(credited)

        entry = per_source.setdefault(row["source"], {"recorded": [], "lf_map": [], "corrected": []})
        entry["recorded"].append(pairwise(pool_raw) / gold_length)
        entry["lf_map"].append(pairwise(pool_lf) / gold_length)
        entry["corrected"].append(min(1.0, merged(pool_lf) / gold_length))

    def mean(values):
        return sum(values) / len(values) if values else 0.0

    overall = {"recorded": [], "lf_map": [], "corrected": []}
    report = {"pool": os.path.basename(pool_path), "per_source": {}}
    print("%-12s %11s %9s %12s   n" % ("source", "A recorded", "B lf-map", "C corrected"))
    for source in sorted(per_source):
        entry = per_source[source]
        for key in overall:
            overall[key].extend(entry[key])
        report["per_source"][source] = {key: mean(entry[key]) for key in entry}
        report["per_source"][source]["n"] = len(entry["recorded"])
        print(
            "%-12s %11.4f %9.4f %12.4f   %d"
            % (
                source,
                mean(entry["recorded"]),
                mean(entry["lf_map"]),
                mean(entry["corrected"]),
                len(entry["recorded"]),
            )
        )
    report["overall"] = {key: mean(values) for key, values in overall.items()}
    report["overall"]["n"] = len(overall["recorded"])
    print(
        "%-12s %11.4f %9.4f %12.4f   %d"
        % (
            "ALL",
            mean(overall["recorded"]),
            mean(overall["lf_map"]),
            mean(overall["corrected"]),
            len(overall["recorded"]),
        )
    )
    if json_out:
        with open(json_out, "w", encoding="utf8") as fh:
            json.dump(report, fh, indent=2)
        print("wrote " + json_out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
