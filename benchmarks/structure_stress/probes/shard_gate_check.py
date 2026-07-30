"""Pre-relaunch gates for the sharded sweep rewrite.

1. Derived-gate soundness: over a seeded reservoir sample, any doc where an
   entry's regex matches MUST pass that entry's gate (hand or derived) —
   zero tolerance, a gate miss silently undercounts sweep stats.
2. Gate coverage/cost: per-entry gated-away share and wall delta on the
   sample, so the speedup claim is a measured number.
3. Shard-vs-legacy equivalence: for two courts, the sharded worker path
   must reproduce the legacy parent-fed aggregation exactly (docs, chars,
   entry_matches, entry_docs, structure_kinds, fail_reasons).

    python -X utf8 probes/shard_gate_check.py
"""
from __future__ import annotations

import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import sweep  # noqa: E402

COURTS = ["CMAC", "CHRT"]


def sample_docs(con, per_court: int = 40) -> list[tuple[str, str, str, dict]]:
    jobs = []
    for pq_path in sorted((sweep.A2AJ / "cases").glob("*/train.parquet")):
        court = pq_path.parent.name
        for lang in ("en", "fr"):
            try:
                rows = con.execute(
                    f"""
                    select citation_{lang}, unofficial_text_{lang}
                    from read_parquet('{pq_path.as_posix()}')
                    where unofficial_text_{lang} is not null
                    using sample reservoir({per_court} rows) repeatable (47)
                    """
                ).fetchall()
            except Exception:
                continue
            jobs.extend(
                (f"{court}:{cite}:{lang}", "case", text, {"self_cite": cite})
                for cite, text in rows
            )
    return jobs


def check_gates(jobs) -> None:
    sweep._init_worker()
    entries = sweep._ENTRIES
    derived = [
        (eid, gate)
        for eid, _, gate in entries
        if gate is not None and eid not in sweep.PREFILTERS
    ]
    print(f"entries={len(entries)} hand-gated={sum(1 for e in entries if e[0] in sweep.PREFILTERS and e[2])} derived-gated={len(derived)}")
    for eid, gate in derived:
        print(f"  derived {eid:32s} {gate}")

    misses = 0
    gated_away: Counter = Counter()
    t_gated = t_ungated = 0.0
    for _id, _kind, text, _o in jobs:
        text = text[: sweep.MAX_DOC_CHARS]
        lower = text.lower()
        for eid, rx, gate in entries:
            t0 = time.perf_counter()
            n = sum(1 for _ in rx.finditer(text))
            t_ungated += time.perf_counter() - t0
            passes = gate is None or any(g in lower for g in gate)
            if not passes:
                gated_away[eid] += 1
                if n:
                    misses += 1
                    print(f"  GATE MISS: {eid} on {_id} (matches={n}, gate={gate})")
            t0 = time.perf_counter()
            if passes:
                for _ in rx.finditer(text):
                    pass
            t_gated += time.perf_counter() - t0
    mb = sum(len(j[2]) for j in jobs) / 1e6
    print(
        f"\nsoundness: {misses} gate misses over {len(jobs)} docs x {len(entries)} entries"
    )
    print(
        f"scan cost: ungated {t_ungated:.1f}s vs gated {t_gated:.1f}s "
        f"({t_ungated / max(t_gated, 1e-9):.2f}x) over {mb:.0f} MB"
    )
    top = gated_away.most_common(8)
    print("top gated-away:", {k: f"{v}/{len(jobs)}" for k, v in top})
    if misses:
        raise SystemExit("GATE MISSES — do not launch")


def legacy_court_agg(con, court: str) -> tuple[dict, list]:
    agg = sweep._empty_agg("legacy")
    recoveries: list[tuple[str, float]] = []
    failures: list[dict] = []
    pq = (sweep.A2AJ / "cases" / court / "train.parquet").as_posix()
    for lang in ("en", "fr"):
        rows = con.execute(
            f"""
            select citation_{lang}, unofficial_text_{lang},
                   len(cases_cited_{lang}) as cited
            from read_parquet('{pq}')
            where unofficial_text_{lang} is not null
            """
        )
        while True:
            batch = rows.fetchmany(200)
            if not batch:
                break
            for cite, text, cited in batch:
                rec = sweep.scan_doc(
                    (
                        f"{court}:{cite}:{lang}",
                        "case",
                        text,
                        {"self_cite": cite, "cited_count": cited or 0},
                    )
                )
                sweep._fold_record(
                    agg, rec, failures, recoveries, failure_cap=10**9
                )
    return agg, recoveries


def shard_court_agg(court: str) -> tuple[dict, list]:
    agg = sweep._empty_agg("shard")
    recoveries: list[tuple[str, float]] = []
    all_failures: list[dict] = []
    shards = [
        s
        for s in sweep._corpus_shards("a2aj_cases", ["en", "fr"])
        if s[1] == court
    ]
    for shard in shards:
        partial = sweep.scan_shard(shard)
        for key in ("docs", "chars", "fail_docs", "slow_docs"):
            agg[key] += partial[key]
        for key in ("fail_reasons", "entry_docs", "entry_matches",
                    "structure_kinds"):
            agg[key].update(partial[key])
        recoveries.extend(partial["recoveries"])
        all_failures.extend(partial["failures"])
    return agg, recoveries


def main() -> int:
    import duckdb

    con = duckdb.connect()
    jobs = sample_docs(con)
    print(f"sample: {len(jobs)} docs")
    check_gates(jobs)

    for court in COURTS:
        legacy, legacy_rec = legacy_court_agg(con, court)
        shard, shard_rec = shard_court_agg(court)
        keys = ["docs", "chars", "fail_docs", "slow_docs"]
        ok = all(legacy[k] == shard[k] for k in keys)
        for key in ("fail_reasons", "entry_docs", "entry_matches",
                    "structure_kinds"):
            if dict(legacy[key]) != dict(shard[key]):
                ok = False
                print(f"  {court} MISMATCH {key}:")
                l, s = dict(legacy[key]), dict(shard[key])
                for eid in sorted(set(l) | set(s)):
                    if l.get(eid) != s.get(eid):
                        print(f"    {eid}: legacy={l.get(eid)} shard={s.get(eid)}")
        if sorted(legacy_rec) != sorted(shard_rec):
            ok = False
            print(f"  {court} MISMATCH recoveries")
        print(
            f"{court}: legacy docs={legacy['docs']} chars={legacy['chars']} "
            f"| shard docs={shard['docs']} chars={shard['chars']} "
            f"| {'IDENTICAL' if ok else 'MISMATCH'}"
        )
        if not ok:
            raise SystemExit(1)
    print("\nshard path reproduces legacy aggregation exactly — safe to launch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
