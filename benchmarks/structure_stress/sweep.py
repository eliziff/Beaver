"""Structure stress sweep over every local corpus.

For each document: run every grammar-table entry (prefilter-gated) and
the structure detectors (paragraph ladder, page marks, law sections),
score against the corpus's own oracle where one exists, and aggregate.
Regex is the measured bottleneck, so the main process streams rows from
duckdb/sqlite and a worker pool does the pattern work.

  python -X utf8 sweep.py --tier smoke
  python -X utf8 sweep.py --tier full --source a2aj_laws --workers 10

Summaries: results/<tier>/<source>.summary.json (committed).
Failures:  results/<tier>/<source>.failures.jsonl (local, capped).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORK = HERE.parent.parent
ENGINE_SRC = FORK / "universal-legal-pdf-engine" / "src"
TABLES_DIR = FORK / "shared" / "grammar-tables"
A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
PUBLIC_ENDPOINT_DB = Path(
    r"C:\Users\elias\AppData\Local\ALR Quote Verifier\data\public_endpoint-424c9f516423.db"
)

# Literal gates: a doc whose lowercased text contains none of the entry's
# literals skips that entry. Harness-side only — tables stay pure. Keyed
# loosely; entries without a key always run.
PREFILTERS: dict[str, list[str]] = {
    "cite.statute.splitter": ["rsc", "rso", "rsa", "rss", "rsm", "rsq", "rsy",
                              "rsbc", "rsnl", "rsnb", "rsns", "rspei", "rsnwt",
                              "cqlr", "ccsm", "sc ", "so ", "sa ", "ss ", "sm ",
                              "sq ", "sy ", "sbc", "snl", "snb", "sns", "snwt"],
    "cite.statute.toa": ["rsc", "rso", "rsa", "rss", "rsm", "rsq", "rsy",
                         "rsbc", "rsnl", "rsnb", "rsns", "rspei", "rsnwt",
                         "cqlr", "ccsm", "sc ", "so ", "sa ", "ss ", "sm ",
                         "sq ", "sy ", "sbc", "snl", "snb", "sns", "snwt",
                         "reg", "oic", "sor", "si ", "cfr"],
    "cite.canlii": ["canlii"],
    "cite.url": ["http", "www.", "perma.cc", "doi:"],
    "cite.url.prefix": ["http", "www."],
    "ref.token": ["supra", "ibid"],
    "ref.pure.splitter": ["supra", "ibid"],
    "ref.pure.toa": ["supra", "ibid"],
    "ref.inline.toa": ["supra", "ibid"],
    "ref.supra-note.linking": ["supra"],
    "ref.cross-reference": ["supra", "ibid", "note"],
    "marker.inline-fn": ["\u27e6"],
    "trap.double-zero-width": ["\u200b"],
    "ref.history.toa": ["rev", "aff", "vari", "leave"],
    "ref.quoted-work-author": ['"', "\u201c"],
    "label.superscript": ["\u2070", "\u00b9", "\u00b2", "\u00b3", "\u2074",
                          "\u2075", "\u2076", "\u2077", "\u2078", "\u2079"],
    "title.legal.splitter": ["act", "code", "rule", "regulation",
                             "convention", "treaty"],
    "title.legal.toa": ["act", "code", "rule", "regulation",
                        "convention", "treaty"],
    "title.named-code": ["code", "rule"],
    "cite.quoted": ['"', "\u201c"],
    "cite.secondary": ["("],
    "frame.book": ["("],
    "cite.statute.judgment": ["r.s", "s.c", "s.o", "s.a", "s.s", "s.m",
                              "s.b", "s.n", "s.y", "s.p", "c.c.s.m", "rs",
                              "sc ", "sched"],
    "cite.statute.judgment.fr": ["l.r", "l.c", "l.o", "l.m", "c.p.l.m",
                                 "r.l.r.q", "c.q.l.r"],
}

# Grammars authored for SHORT STRINGS (a footnote, a label line, a locator)
# are semantically meaningless and often quadratic over whole documents \u2014
# they are exercised by the engine's grammar_differential over footnote
# corpora instead. The whole-document sweep skips them.
SHORT_STRING_ENTRIES = {
    "shortform.splitter",
    "shortform.toa",
    "signal.prefix.splitter",
    "signal.prefix.toa",
    "ref.pure.splitter",
    "ref.pure.toa",
    "label.pure",
    "label.line-start",
    "label.standalone",
    "attach.link",
    "bracket.editorial",
    "boundary.sentence.engine",
    "boundary.conjunction",
}

SLOW_DOC_SECONDS = 2.0

# Structure detection is ALR's corpus-proven machinery, ported with a
# 0-mismatch parity proof in structure_ref.py. The naive detectors that
# used to live here scored 43% presence accuracy and 31% flag precision
# against hand-verified gold; the port scores 95% / 93%.
from structure_ref import law_section_labels, structure_cascade  # noqa: E402

PILCROW_RE = re.compile(r"¶\s?\d")
PAGE_MARK_JOURNAL_RE = re.compile(r"^[ \t]*\[page\s+(\d{1,5})\][ \t]*$", re.I | re.M)
PAGE_MARK_TOA_RE = re.compile(
    r"^\s*(?:\[\s*)?(?:original\s+)?page\s+([A-Za-z]?\d{1,4})(?:\s*\])?\s*$",
    re.I | re.M,
)
ANY_BRACKET_LABEL_RE = re.compile(r"\[(\d{1,4})\]")

_ENTRIES: list[tuple[str, "re.Pattern[str]", list[str] | None]] = []


def _load_entries() -> list[tuple[str, "re.Pattern[str]", list[str] | None]]:
    sys.path.insert(0, str(ENGINE_SRC))
    from legalpdf.grammar_tables import compile_entry  # noqa: PLC0415

    entries = []
    for path in sorted(TABLES_DIR.glob("*.json")):
        table = json.loads(path.read_text(encoding="utf-8"))
        defs = table.get("defs") or {}
        for entry in table.get("entries", []):
            if entry["id"] in SHORT_STRING_ENTRIES:
                continue
            entries.append(
                (entry["id"], compile_entry(entry, defs), PREFILTERS.get(entry["id"]))
            )
    return entries


def _init_worker() -> None:
    global _ENTRIES
    _ENTRIES = _load_entries()




MAX_DOC_CHARS = 8_000_000


def scan_doc(job: tuple[str, str, str, dict]) -> dict:
    """(doc_id, kind, text, oracle) -> per-doc record."""
    doc_id, kind, text, oracle = job
    t0 = time.perf_counter()
    if len(text) > MAX_DOC_CHARS:
        # One giant document must never take a worker down; record and
        # scan the head only.
        oracle = dict(oracle)
        oracle["truncated_from"] = len(text)
        text = text[:MAX_DOC_CHARS]
    lower = text.lower()
    matches: dict[str, int] = {}
    for eid, rx, gates in _ENTRIES:
        if gates is not None and not any(g in lower for g in gates):
            continue
        n = sum(1 for _ in rx.finditer(text))
        if n:
            matches[eid] = n

    record: dict = {
        "id": doc_id,
        "kind": kind,
        "chars": len(text),
        "matches": matches,
        "pilcrows": len(PILCROW_RE.findall(text)),
        "fail": [],
    }

    if kind == "case":
        self_cite = oracle.get("self_cite") or ""
        window = text[:3000]
        record["self_cite_found"] = bool(self_cite) and self_cite in window
        record["cited_count"] = oracle.get("cited_count", 0)
        cite_hits = sum(
            matches.get(k, 0)
            for k in ("cite.neutral", "cite.neutral.tribunal", "cite.canlii",
                      "cite.reporter.splitter")
        )
        if record["cited_count"] > 0 and cite_hits == 0:
            record["fail"].append("cites_expected_none_found")
        # No structure detected is never a verdict: paragraphs, then
        # reporter-anchored pages, then endnote ladders, then heading
        # hints. Only all-empty lands in the close-inspection bucket.
        structure = structure_cascade(text, self_cite)
        record["structure"] = structure
        if structure["kind"] == "none":
            record["fail"].append("no_addressable_structure")
            lines = text.splitlines() or [""]
            mean_line = len(text) / max(1, len(lines))
            if mean_line > 600 and len(ANY_BRACKET_LABEL_RE.findall(text)) >= 8:
                # Labels exist but sit mid-line: a corpus defect (four
                # Sept-Oct 2003 BCCA rows found so far), not absence.
                record["fail"].append("line_collapsed")
        elif structure["kind"] == "paragraphs" and structure.get("span", 1.0) < 0.55:
            # Accepted scope covers under 55% of the document — the
            # host-vs-quote competition residual worth surfacing (2.2%
            # of accepted BCCA scopes).
            record["fail"].append("paragraph_scope_narrow")
    elif kind == "law":
        want = set(oracle.get("section_labels") or [])
        num = oracle.get("num_sections") or 0
        detected = law_section_labels(text)
        combined = (
            detected["alr_ext"] | detected["bold"] | detected["ranges"]
            | detected["named"]
        )
        def _rec(found: set) -> float | None:
            return len(want & found) / len(want) if want else None
        def _prec(found: set) -> float | None:
            return len(want & found) / len(found) if found else None
        record["sections"] = {
            "oracle": num,
            "recovery_combined": _rec(combined),
            "detectors": {
                name: {"rec": _rec(found), "prec": _prec(found)}
                for name, found in detected.items()
            },
        }
        best = record["sections"]["recovery_combined"] or 0.0
        if want and best < 0.5:
            record["fail"].append(f"section_recovery_{best:.2f}")
    elif kind == "journal":
        want = oracle.get("page_labels") or []
        found = {m.group(1) for m in PAGE_MARK_JOURNAL_RE.finditer(text)}
        found |= {m.group(1) for m in PAGE_MARK_TOA_RE.finditer(text)}
        wanted = [str(w) for w in want]
        rec = (
            sum(1 for w in wanted if w in found) / len(wanted) if wanted else None
        )
        record["pages"] = {"oracle": len(wanted), "recovery": rec}
        if wanted and rec is not None and rec < 0.8:
            record["fail"].append(f"page_recovery_{rec:.2f}")

    wall = time.perf_counter() - t0
    record["wall"] = round(wall, 4)
    if wall > SLOW_DOC_SECONDS:
        record["fail"].append("slow_doc")
    if oracle.get("truncated_from"):
        record["truncated_from"] = oracle["truncated_from"]
        record["fail"].append("oversize_doc")
    return record


# ── sources ──────────────────────────────────────────────────────────


def _cases_jobs(con, tier: str, langs: list[str]):
    per_court = {"smoke": 150, "dev": 2000, "full": 10**9}[tier]
    fr_cap = {"smoke": 50, "dev": 500, "full": 10**9}[tier]
    courts = sorted(
        p.parent.name for p in (A2AJ / "cases").glob("*/train.parquet")
    )
    for court in courts:
        pq = (A2AJ / "cases" / court / "train.parquet").as_posix()
        for lang in langs:
            cap = per_court if lang == "en" else fr_cap
            # Full tier takes everything: ordering would force duckdb to
            # sort whole parquets (BCSC is 916 MB) — that is what killed
            # the first full run. Sampled tiers keep the deterministic
            # order.
            order = "" if tier == "full" else f"order by citation_{lang}"
            print(f"[cases] {court}:{lang} start", flush=True)
            rows = con.execute(
                f"""
                select citation_{lang}, unofficial_text_{lang},
                       len(cases_cited_{lang}) as cited
                from read_parquet('{pq}')
                where unofficial_text_{lang} is not null
                {order}
                limit {cap}
                """
            )
            while True:
                batch = rows.fetchmany(200)
                if not batch:
                    break
                for cite, text, cited in batch:
                    yield (
                        f"{court}:{cite}:{lang}",
                        "case",
                        text,
                        {"self_cite": cite, "cited_count": cited or 0},
                    )


def _laws_jobs(con, tier: str, langs: list[str]):
    per_set = {"smoke": 100, "dev": 10**9, "full": 10**9}[tier]
    sets = sorted(p.parent.name for p in (A2AJ / "laws").glob("*/train.parquet"))
    for name in sets:
        pq = (A2AJ / "laws" / name / "train.parquet").as_posix()
        for lang in langs:
            order = "" if tier == "full" else f"order by citation_{lang}"
            print(f"[laws] {name}:{lang} start", flush=True)
            rows = con.execute(
                f"""
                select citation_{lang}, unofficial_text_{lang},
                       unofficial_sections_{lang}, num_sections_{lang}
                from read_parquet('{pq}')
                where unofficial_text_{lang} is not null
                {order}
                limit {per_set}
                """
            )
            while True:
                batch = rows.fetchmany(100)
                if not batch:
                    break
                for cite, text, sections_json, num in batch:
                    try:
                        labels = list(json.loads(sections_json or "{}").keys())
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        labels = []
                    yield (
                        f"{name}:{cite}:{lang}",
                        "law",
                        text,
                        {"section_labels": labels, "num_sections": num or 0},
                    )


def _journal_jobs(tier: str):
    cap = {"smoke": 100, "dev": 10**9, "full": 10**9}[tier]
    con = sqlite3.connect(PUBLIC_ENDPOINT_DB)
    rows = con.execute(
        """
        select a.article_id, a.text,
               (select json_group_array(p.page_label)
                from article_pages p where p.article_id = a.article_id
                order by p.page_order) as labels
        from articles a
        where a.text is not null and length(a.text) > 200
        order by a.article_id limit ?
        """,
        (cap,),
    )
    for article_id, text, labels_json in rows:
        labels = json.loads(labels_json or "[]")
        yield (f"journal:{article_id}", "journal", text, {"page_labels": labels})
    con.close()


# ── driver ───────────────────────────────────────────────────────────


def run_source(name: str, jobs, workers: int, out_dir: Path) -> dict:
    t0 = time.time()
    agg: dict = {
        "source": name,
        "docs": 0,
        "chars": 0,
        "fail_docs": 0,
        "fail_reasons": Counter(),
        "entry_docs": Counter(),
        "entry_matches": Counter(),
        "structure_kinds": Counter(),
        "slow_docs": 0,
    }
    recoveries: list[float] = []
    recovery_by_set: dict[str, list[float]] = {}
    failures_path = out_dir / f"{name}.failures.jsonl"
    failures_written = 0
    with mp.Pool(
        workers, initializer=_init_worker, maxtasksperchild=200
    ) as pool, open(
        failures_path, "w", encoding="utf-8"
    ) as fail_out:
        for rec in pool.imap_unordered(scan_doc, jobs, chunksize=16):
            agg["docs"] += 1
            agg["chars"] += rec["chars"]
            for eid, n in rec["matches"].items():
                agg["entry_docs"][eid] += 1
                agg["entry_matches"][eid] += n
            structure = rec.get("structure")
            if structure:
                agg["structure_kinds"][structure["kind"]] += 1
            for key in ("sections", "pages"):
                sub = rec.get(key)
                if sub:
                    vals = [
                        v
                        for k, v in sub.items()
                        if k.startswith("recovery") and v is not None
                    ]
                    if vals:
                        recoveries.append(max(vals))
                        prefix = rec["id"].split(":", 1)[0]
                        recovery_by_set.setdefault(prefix, []).append(max(vals))
            if rec["fail"]:
                agg["fail_docs"] += 1
                for reason in rec["fail"]:
                    agg["fail_reasons"][reason.split("_0")[0]] += 1
                if "slow_doc" in rec["fail"]:
                    agg["slow_docs"] += 1
                if failures_written < 2000:
                    fail_out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    failures_written += 1
    wall = time.time() - t0
    mb = agg["chars"] / 1e6
    summary = {
        **{k: v for k, v in agg.items() if not isinstance(v, Counter)},
        "fail_reasons": dict(agg["fail_reasons"].most_common()),
        "entry_docs": dict(agg["entry_docs"].most_common()),
        "entry_matches": dict(agg["entry_matches"].most_common()),
        "structure_kinds": dict(agg["structure_kinds"].most_common()),
        "mb": round(mb, 1),
        "wall_s": round(wall, 1),
        "mb_per_s": round(mb / wall, 2) if wall else None,
        "recovery_mean": round(sum(recoveries) / len(recoveries), 4)
        if recoveries
        else None,
        "recovery_n": len(recoveries),
        "recovery_by_set": {
            k: {"mean": round(sum(v) / len(v), 4), "n": len(v)}
            for k, v in sorted(recovery_by_set.items())
        },
    }
    (out_dir / f"{name}.summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", choices=["smoke", "dev", "full"], default="smoke")
    parser.add_argument(
        "--source",
        action="append",
        choices=["a2aj_cases", "a2aj_laws", "journals"],
        help="repeatable; default all",
    )
    parser.add_argument("--workers", type=int, default=max(2, mp.cpu_count() - 2))
    parser.add_argument("--langs", default="en,fr")
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    import duckdb  # noqa: PLC0415

    langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    out_dir = Path(args.out) if args.out else HERE / "results" / args.tier
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = args.source or ["a2aj_cases", "a2aj_laws", "journals"]
    con = duckdb.connect()

    for name in sources:
        if name == "a2aj_cases":
            jobs = _cases_jobs(con, args.tier, langs)
        elif name == "a2aj_laws":
            jobs = _laws_jobs(con, args.tier, langs)
        else:
            jobs = _journal_jobs(args.tier)
        summary = run_source(name, jobs, args.workers, out_dir)
        print(
            f"{name}: {summary['docs']} docs, {summary['mb']} MB, "
            f"{summary['wall_s']}s ({summary['mb_per_s']} MB/s), "
            f"{summary['fail_docs']} fail docs; "
            f"recovery_mean={summary['recovery_mean']}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
