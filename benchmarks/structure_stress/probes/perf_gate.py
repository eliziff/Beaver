"""Gate (2): prove sweep performance before any corpus-scale run.

Doctrine (Eli, 2026-07-29): "made sure the full sweep is highly
performant so we don't wait for nothing." This probe runs the REAL
per-doc scorer (sweep.scan_doc, same entries, same prefilters, same
cascade) over a seeded reservoir sample, then:

  1. per-doc wall stats by source and size decile;
  2. a per-entry cost table (ms/MB, gated-share) to expose the regexes
     worth new prefilters;
  3. a corpus-scale wall-clock projection from parquet row counts x
     sampled mean doc size / measured throughput, at several worker
     counts.

Single-threaded by design (throttle rules): the projection scales the
measured single-core rate rather than launching workers.

    python -X utf8 probes/perf_gate.py [--cases-per-court 3] [--laws-per-set 3]
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import sweep  # noqa: E402
from structure_ref import law_section_labels, structure_cascade  # noqa: E402

A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")


def sample_cases(con, per_court: int):
    jobs = []
    for pq_path in sorted((A2AJ / "cases").glob("*/train.parquet")):
        court = pq_path.parent.name
        pq = pq_path.as_posix()
        for lang in ("en", "fr"):
            try:
                rows = con.execute(
                    f"""
                    select citation_{lang}, unofficial_text_{lang}
                    from read_parquet('{pq}')
                    where unofficial_text_{lang} is not null
                    using sample reservoir({per_court} rows) repeatable (43)
                    """
                ).fetchall()
            except Exception:
                continue
            for cite, text in rows:
                jobs.append((f"{court}:{cite}:{lang}", "case", text or "",
                             {"self_cite": cite, "cited_count": 0}))
    return jobs


def sample_laws(con, per_set: int):
    jobs = []
    for pq_path in sorted((A2AJ / "laws").glob("*/train.parquet")):
        name = pq_path.parent.name
        pq = pq_path.as_posix()
        for lang in ("en", "fr"):
            try:
                rows = con.execute(
                    f"""
                    select citation_{lang}, unofficial_text_{lang},
                           unofficial_sections_{lang}, num_sections_{lang}
                    from read_parquet('{pq}')
                    where unofficial_text_{lang} is not null
                    using sample reservoir({per_set} rows) repeatable (43)
                    """
                ).fetchall()
            except Exception:
                continue
            for cite, text, sections_json, num in rows:
                try:
                    labels = list(json.loads(sections_json or "{}").keys())
                except (json.JSONDecodeError, TypeError, AttributeError):
                    labels = []
                jobs.append((f"{name}:{cite}:{lang}", "law", text or "",
                             {"section_labels": labels, "num_sections": num or 0}))
    return jobs


def corpus_totals(con) -> dict[str, tuple[int, int]]:
    """source -> (doc rows, rows with en/fr text) via parquet metadata."""
    totals = {}
    for source in ("cases", "laws"):
        docs = 0
        for pq_path in sorted((A2AJ / source).glob("*/train.parquet")):
            pq = pq_path.as_posix()
            for lang in ("en", "fr"):
                try:
                    (n,), = con.execute(
                        f"select count(*) from read_parquet('{pq}') "
                        f"where unofficial_text_{lang} is not null"
                    ).fetchall()
                except Exception:
                    continue
                docs += n
        totals[source] = docs
    return totals


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases-per-court", type=int, default=3)
    parser.add_argument("--laws-per-set", type=int, default=3)
    args = parser.parse_args()

    import duckdb

    con = duckdb.connect()
    t_sample = time.perf_counter()
    case_jobs = sample_cases(con, args.cases_per_court)
    law_jobs = sample_laws(con, args.laws_per_set)
    print(f"sampled {len(case_jobs)} cases, {len(law_jobs)} laws "
          f"in {time.perf_counter() - t_sample:.1f}s", flush=True)

    sweep._init_worker()

    walls: dict[str, list[tuple[int, float]]] = defaultdict(list)
    fails = 0
    for job in case_jobs + law_jobs:
        rec = sweep.scan_doc(job)
        walls[rec["kind"]].append((rec["chars"], rec["wall"]))
        fails += bool(rec["fail"])
    for kind, rows in walls.items():
        chars = sum(c for c, _ in rows)
        secs = sum(w for _, w in rows)
        per_doc = [w for _, w in rows]
        print(f"\n== {kind}: {len(rows)} docs, {chars / 1e6:.1f} MB, "
              f"{secs:.1f}s total -> {chars / max(secs, 1e-9) / 1e6:.2f} MB/s/core")
        print(f"   wall/doc ms: median={statistics.median(per_doc) * 1e3:.1f} "
              f"p90={sorted(per_doc)[int(len(per_doc) * 0.9)] * 1e3:.1f} "
              f"max={max(per_doc) * 1e3:.0f}")

    # Per-entry cost over a size-spread case+law subset.
    subset = sorted(case_jobs, key=lambda j: len(j[2]))[:: max(1, len(case_jobs) // 40)]
    subset += sorted(law_jobs, key=lambda j: len(j[2]))[:: max(1, len(law_jobs) // 15)]
    subset_mb = sum(len(j[2]) for j in subset) / 1e6
    print(f"\n== per-entry cost over {len(subset)} docs, {subset_mb:.1f} MB")
    rows = []
    for eid, pattern, gates in sweep._ENTRIES:
        secs = 0.0
        gated_away = 0
        for _id, _kind, text, _o in subset:
            text = text[:sweep.MAX_DOC_CHARS]
            if gates is not None and not any(g in text.lower() for g in gates):
                gated_away += 1
                continue
            t0 = time.perf_counter()
            for _ in pattern.finditer(text):
                pass
            secs += time.perf_counter() - t0
        rows.append((secs * 1e3 / subset_mb, eid, gated_away))
    rows.sort(reverse=True)
    for ms_mb, eid, gated_away in rows[:12]:
        print(f"   {eid:32s} {ms_mb:7.1f} ms/MB  gated_away={gated_away}/{len(subset)}")
    cheap = sum(1 for ms_mb, *_ in rows if ms_mb < 5)
    print(f"   (+{len(rows) - 12} more; {cheap}/{len(rows)} entries under 5 ms/MB)")

    # Structure cost isolated.
    t0 = time.perf_counter()
    for _id, _k, text, oracle in case_jobs:
        structure_cascade(text[:sweep.MAX_DOC_CHARS], oracle.get("self_cite") or "")
    cascade_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    for _id, _k, text, _o in law_jobs:
        law_section_labels(text[:sweep.MAX_DOC_CHARS])
    law_s = time.perf_counter() - t0
    case_mb = sum(len(j[2]) for j in case_jobs) / 1e6
    law_mb = sum(len(j[2]) for j in law_jobs) / 1e6
    print(f"\n== structure cost: cascade {cascade_s * 1e3 / max(case_mb, 1e-9):.1f} ms/MB, "
          f"law_section_labels {law_s * 1e3 / max(law_mb, 1e-9):.1f} ms/MB")

    totals = corpus_totals(con)
    print("\n== projection (from parquet counts x sampled mean size / measured rate)")
    for source, kind in (("cases", "case"), ("laws", "law")):
        rows = walls[kind]
        mean_chars = statistics.mean(c for c, _ in rows)
        mean_wall = statistics.mean(w for _, w in rows)
        docs = totals[source]
        single = docs * mean_wall
        print(f"   {source}: {docs:,} docs x {mean_chars / 1e3:.0f} KB avg, "
              f"single-core {single / 3600:.1f} h", end="")
        for workers in (4, 6):
            print(f"  | {workers}w ~{single / workers / 3600 / 0.8:.1f} h", end="")
        print("  (0.8 pool efficiency)")
    print(f"\nsample fail-rate sanity: {fails}/{len(case_jobs) + len(law_jobs)} "
          f"docs flagged")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
