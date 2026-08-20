"""Structure stress sweep over every local corpus.

For each document: run every grammar-table entry (prefilter-gated), invoke
Beaver's shipping legal-structure engine through one persistent process per
worker, score its blocks against provider metadata where available, and
aggregate. This harness contains no structure detector or parser grammar.
Regex is the measured bottleneck. On the full tier, workers read their
own parquet row slices (pyarrow decodes ~500 MB/s) and return per-shard
aggregates, so the parent never touches document text — the first full
run fed whole documents from a single-threaded duckdb loop through IPC
and starved 4 workers down to a 4.6% duty cycle (~26 h projected).
Sampled tiers keep the legacy parent-fed path (deterministic order).

  python -X utf8 sweep.py --tier smoke
  python -X utf8 sweep.py --tier full --source a2aj_laws --workers 10

Summaries: results/<tier>/<source>.summary.json (committed).
Failures:  results/<tier>/<source>.failures.jsonl (local, capped).
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import random
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORK = HERE.parent.parent
ENGINE_SRC = FORK / "legal-pdf-parser" / "src"
TABLES_DIR = FORK / "shared" / "grammar-tables"
A2AJ = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\a2aj_corpus")
sys.path.insert(0, str(FORK / "backend" / "scripts"))


def _public_endpoint_db() -> Path:
    """Resolve the overlay-extracted journals DB by glob, never by its
    content-hash filename: overlay_store.db_path() re-derives the hash on
    every reference rebuild and sweeps stale copies, so the newest
    public_endpoint-*.db is the live one and a pinned name breaks silently
    (reinvention-ledger item 5)."""
    root = Path(r"C:\Users\elias\AppData\Local\ALR Quote Verifier\data")
    candidates = sorted(root.glob("public_endpoint*.db"),
                        key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise FileNotFoundError(f"no public_endpoint*.db under {root}")
    return candidates[0]

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
    # Dotless heads (LRC/LC/CQLR/LRTFP...) shipped real matches the dotted
    # list missed — probes/shard_gate_check.py caught three in sample; the
    # 2-char members are deliberately broad, a gate may only over-pass.
    "cite.statute.judgment.fr": ["l.r", "l.c", "l.o", "l.m", "c.p.l.m",
                                 "r.l.r.q", "c.q.l.r", "lr", "lc ", "lo ",
                                 "lm ", "cqlr", "rlrq", "cplm"],
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

from sourcedoc_client import compile_document  # noqa: E402

PILCROW_RE = re.compile(r"¶\s?\d")

# The anchored-scan machinery (derived gates, anchor windows with the
# clip-guard and coverage bailout) lives in the engine now — the private
# copy that used to sit here was extracted to legalpdf/anchored_scan.py
# (engine 2821387) and its consumers adopted it (engine 9e72346). The
# sweep keeps only its consumer obligations: the hand anchor sets below,
# PREFILTER gate precedence, and probes/shard_gate_check.py's zero-
# tolerance windowed-vs-full reservoir differential before every launch.
# Entries are (id, AnchoredPattern, gate).
_ENTRIES: list[tuple[str, object, list[str] | None]] = []

# Per-match-mandatory literal sets read off the pattern alternations by
# hand where the AST walk bottoms out (heads hidden behind expanded
# (?<!\w) lookbehinds). Same contract as derived anchors: every match's
# text contains at least one literal; proven by the probe's windowed-vs-
# full differential before every launch.
_HAND_ANCHORS: dict[str, list[str]] = {
    "pinpoint.para.splitter": ["para", "¶"],
    "signal.aggressive": [
        "citing", "cited", "quoting", "quoted", "discussing", "discussed",
        "applying", "applied", "relying", "relied", "following",
        "followed", "adopting", "adopted", "amended", "amending",
        "adding", "rev", "aff", "penalty", "republished", "accord",
        "contra", "compare", "cf", "see",
    ],
    "signal.citation.toa": [
        "see", "cf", "compare", "contra", "citing", "cited", "quoting",
        "quoted", "discussing", "discussed", "applying", "applied",
        "relying", "relied", "following", "followed", "rev", "aff",
    ],
    # signal.source has TWO branches: the sentence-start signals AND an
    # inline branch (citing/quoting/rev'd/aff'd/...). The anchor set must
    # cover both — the first cut covered only the sentence branch and the
    # reservoir differential flagged 131 undercounts.
    "signal.source": [
        "see", "cf", "compare", "contra", "citing", "cited", "quoting",
        "quoted", "discussing", "discussed", "applying", "applied",
        "relying", "relied", "following", "followed", "rev", "aff",
    ],
}


def _load_entries() -> list[tuple[str, object, list[str] | None]]:
    sys.path.insert(0, str(ENGINE_SRC))
    from legalpdf.anchored_scan import AnchoredPattern  # noqa: PLC0415
    from legalpdf.grammar_tables import compile_entry  # noqa: PLC0415

    entries = []
    for path in sorted(TABLES_DIR.glob("*.json")):
        table = json.loads(path.read_text(encoding="utf-8"))
        defs = table.get("defs") or {}
        for entry in table.get("entries", []):
            if entry["id"] in SHORT_STRING_ENTRIES:
                continue
            rx = compile_entry(entry, defs)
            hand = _HAND_ANCHORS.get(entry["id"]) or PREFILTERS.get(entry["id"])
            pattern = AnchoredPattern(rx, hand)
            # Hand gates keep precedence over derived ones: PREFILTER
            # literals were tuned per-DOC and gate more away.
            gate = PREFILTERS.get(entry["id"]) or pattern.gate
            entries.append((entry["id"], pattern, gate))
    return entries


def _init_worker() -> None:
    global _ENTRIES
    _ENTRIES = _load_entries()




MAX_DOC_CHARS = 8_000_000


def scan_doc(job: tuple[str, str, str, dict]) -> dict:
    """(doc_id, kind, text, provider metadata) -> per-doc record."""
    doc_id, kind, text, metadata = job
    t0 = time.perf_counter()
    if len(text) > MAX_DOC_CHARS:
        # One giant document must never take a worker down; record and
        # scan the head only.
        metadata = dict(metadata)
        metadata["truncated_from"] = len(text)
        text = text[:MAX_DOC_CHARS]
    lower = text.lower()
    matches: dict[str, int] = {}
    for eid, pattern, gates in _ENTRIES:
        if gates is not None and not any(g in lower for g in gates):
            continue
        # The engine handle windows around anchor hits and falls back to
        # a full scan itself (small text, .lower() length drift, dense
        # anchors, window-edge clip) — same counts as a bare finditer.
        n = sum(1 for _ in pattern.finditer(text, lower))
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
        self_cite = metadata.get("self_cite") or ""
        window = text[:3000]
        record["self_cite_found"] = bool(self_cite) and self_cite in window
        record["cited_count"] = metadata.get("cited_count", 0)
        cite_hits = sum(
            matches.get(k, 0)
            for k in ("cite.neutral", "cite.neutral.tribunal", "cite.canlii",
                      "cite.reporter.splitter")
        )
        if record["cited_count"] > 0 and cite_hits == 0:
            record["fail"].append("cites_expected_none_found")
        compiled = compile_document({
            "id": doc_id,
            "docType": "cases",
            "citation": self_cite,
            "alternateCitation": metadata.get("alternate_citation") or "",
            "dataset": metadata.get("dataset") or doc_id.split(":", 1)[0],
            "text": text,
        })
        structure = {**compiled["summary"], "engine": compiled["compiler"]}
        record["structure"] = structure
        record["source_doc_ms"] = compiled["elapsedMs"]
        if structure["kind"] == "none":
            record["fail"].append("no_addressable_structure")
        elif structure["kind"] == "paragraphs" and structure.get("span", 1.0) < 0.55:
            # Accepted scope covers under 55% of the document — the
            # host-vs-quote competition residual worth surfacing. In
            # short docs (<4KB) the header+signature share mechanically
            # dominates, so only flag them at a harsher threshold
            # (bucket vet 2026-07-30: 6/12 sampled flags were exactly
            # this noise; every true mis-selection sat below 0.48).
            if len(text) >= 4000 or structure.get("span", 1.0) < 0.30:
                record["fail"].append("paragraph_scope_narrow")
    elif kind == "law":
        want = set(metadata.get("section_labels") or [])
        expected_count = len(want) or metadata.get("num_sections") or 0
        compiled = compile_document({
            "id": doc_id,
            "docType": "laws",
            "citation": metadata.get("citation") or "",
            "alternateCitation": metadata.get("alternate_citation") or "",
            "dataset": metadata.get("dataset") or doc_id.split(":", 1)[0],
            "name": metadata.get("name") or "",
            "text": text,
        })
        record["source_doc_ms"] = compiled["elapsedMs"]
        if len(want) == 1 and next(iter(want)).lower() in {
            "order", "ordonnance", "proclamation",
        }:
            # Provider convention for unsectioned instruments: the section
            # map's single pseudo-label names the instrument KIND and is
            # usually absent as any heading (1,218 REG-FED + 582 REG-NL
            # docs; laws vet 2026-07-30). The structure is "whole
            # document" — a scoring convention, not a recovery target.
            record["sections"] = {
                "expected_count": expected_count,
                "single_instrument": True,
                "engine": compiled["compiler"],
            }
        else:
            found = {
                label[3:]
                for block in compiled["blocks"]["section"]
                for label in [block["label"], *block.get("aliases", [])]
            }
            recovery = len(want & found) / len(want) if want else None
            precision = len(want & found) / len(found) if found else None
            record["sections"] = {
                "expected_count": expected_count,
                "recovery_production": recovery,
                "precision_production": precision,
                "actual": len(found),
                "engine": compiled["compiler"],
            }
            best = recovery or 0.0
            if want and best < 0.5:
                record["fail"].append(f"section_recovery_{best:.2f}")
    elif kind == "journal":
        # Journal page structure IS database metadata (article_pages /
        # page_map_json in Eli's own public_endpoint.db); the [page N]
        # markers in the text are rendered FROM it by our pipeline.
        # Nothing to detect, recover, or validate — journals are scanned
        # for grammar-entry rates only.
        record["structure"] = {
            "kind": "provider_metadata",
            "pages": len(metadata.get("page_labels") or []),
        }

    wall = time.perf_counter() - t0
    record["wall"] = round(wall, 4)
    if wall > SLOW_DOC_SECONDS:
        record["fail"].append("slow_doc")
    if metadata.get("truncated_from"):
        record["truncated_from"] = metadata["truncated_from"]
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
                select citation_{lang}, citation2_{lang}, unofficial_text_{lang},
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
                for cite, alternate, text, cited in batch:
                    yield (
                        f"{court}:{cite}:{lang}",
                        "case",
                        text,
                        {
                            "self_cite": cite,
                            "alternate_citation": alternate,
                            "dataset": court,
                            "cited_count": cited or 0,
                        },
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
                select citation_{lang}, citation2_{lang}, name_{lang},
                       unofficial_text_{lang},
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
                for cite, alternate, instrument, text, sections_json, num in batch:
                    try:
                        sections = json.loads(sections_json or "{}")
                        labels = [
                            label
                            for label, value in sections.items()
                            if (
                                isinstance(value, str)
                                and value.strip()
                                and value.strip().casefold() != "[blank]"
                            )
                        ]
                    except (json.JSONDecodeError, TypeError, AttributeError):
                        labels = []
                    yield (
                        f"{name}:{cite}:{lang}",
                        "law",
                        text,
                        {
                            "citation": cite,
                            "alternate_citation": alternate,
                            "dataset": name,
                            "name": instrument,
                            "section_labels": labels,
                            "num_sections": num or 0,
                        },
                    )


def _journal_jobs(tier: str):
    cap = {"smoke": 100, "dev": 10**9, "full": 10**9}[tier]
    con = sqlite3.connect(_public_endpoint_db())
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


def _empty_agg(name: str) -> dict:
    return {
        "source": name,
        "docs": 0,
        "chars": 0,
        "fail_docs": 0,
        "fail_reasons": Counter(),
        "entry_docs": Counter(),
        "entry_matches": Counter(),
        "structure_kinds": Counter(),
        "structure_engines": Counter(),
        "slow_docs": 0,
    }


def _fold_record(
    agg: dict,
    rec: dict,
    failures: list[dict],
    recoveries: list[tuple[str, float]],
    *,
    failure_cap: int,
) -> None:
    """One doc record into an aggregate — shared by both pool shapes so the
    parent-fed and shard-fed paths cannot drift."""
    agg["docs"] += 1
    agg["chars"] += rec["chars"]
    for eid, n in rec["matches"].items():
        agg["entry_docs"][eid] += 1
        agg["entry_matches"][eid] += n
    structure = rec.get("structure")
    if structure:
        agg["structure_kinds"][structure["kind"]] += 1
        if structure.get("engine"):
            agg["structure_engines"][structure["engine"]] += 1
    for key in ("sections", "pages"):
        sub = rec.get(key)
        if sub:
            if sub.get("engine"):
                agg["structure_engines"][sub["engine"]] += 1
            vals = [
                v
                for k, v in sub.items()
                if k.startswith("recovery") and v is not None
            ]
            if vals:
                recoveries.append((rec["id"].split(":", 1)[0], max(vals)))
    if rec["fail"]:
        agg["fail_docs"] += 1
        for reason in rec["fail"]:
            agg["fail_reasons"][reason.split("_0")[0]] += 1
        if "slow_doc" in rec["fail"]:
            agg["slow_docs"] += 1
        # Reservoir sample (Vitter's R) over this aggregate's failure
        # stream: the failures file is a uniform sample of ALL failures.
        # The old head-cap froze the first `failure_cap` in scan order,
        # so the vet queue only ever showed the earliest courts.
        if len(failures) < failure_cap:
            failures.append(rec)
        else:
            slot = _FAILURE_RNG.randrange(agg["fail_docs"])
            if slot < failure_cap:
                failures[slot] = rec


def _summarize(
    agg: dict,
    recoveries: list[tuple[str, float]],
    wall: float,
    out_dir: Path,
    name: str,
) -> dict:
    mb = agg["chars"] / 1e6
    values = [value for _, value in recoveries]
    recovery_by_set: dict[str, list[float]] = {}
    for prefix, value in recoveries:
        recovery_by_set.setdefault(prefix, []).append(value)
    summary = {
        **{k: v for k, v in agg.items() if not isinstance(v, Counter)},
        "fail_reasons": dict(agg["fail_reasons"].most_common()),
        "entry_docs": dict(agg["entry_docs"].most_common()),
        "entry_matches": dict(agg["entry_matches"].most_common()),
        "structure_kinds": dict(agg["structure_kinds"].most_common()),
        "structure_engines": dict(agg["structure_engines"].most_common()),
        "mb": round(mb, 1),
        "wall_s": round(wall, 1),
        "mb_per_s": round(mb / wall, 2) if wall else None,
        "recovery_mean": round(sum(values) / len(values), 4) if values else None,
        "recovery_n": len(values),
        "recovery_by_set": {
            k: {"mean": round(sum(v) / len(v), 4), "n": len(v)}
            for k, v in sorted(recovery_by_set.items())
        },
    }
    (out_dir / f"{name}.summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary


def run_source(name: str, jobs, workers: int, out_dir: Path) -> dict:
    t0 = time.time()
    agg = _empty_agg(name)
    recoveries: list[tuple[str, float]] = []
    failures: list[dict] = []
    with mp.Pool(
        workers, initializer=_init_worker, maxtasksperchild=200
    ) as pool:
        for rec in pool.imap_unordered(scan_doc, jobs, chunksize=16):
            _fold_record(agg, rec, failures, recoveries, failure_cap=2000)
    with open(out_dir / f"{name}.failures.jsonl", "w", encoding="utf-8") as out:
        for rec in failures:
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return _summarize(agg, recoveries, time.time() - t0, out_dir, name)


# ── sharded full tier ────────────────────────────────────────────────

SLICE_ROWS = 4000
SHARD_FAILURE_CAP = 2000
# Seeded once per process: parent-fed aggregates sample with it directly;
# each pool worker re-seeds at spawn and samples its own shards' streams.
_FAILURE_RNG = random.Random(47)


def _corpus_shards(source: str, langs: list[str]):
    """Tiny (path, set, kind, lang, row range) jobs; each worker reads its
    own rows so the parent never holds document text."""
    import pyarrow.parquet as pq  # noqa: PLC0415

    base = A2AJ / ("cases" if source == "a2aj_cases" else "laws")
    kind = "case" if source == "a2aj_cases" else "law"
    shards = []
    for path in sorted(base.glob("*/train.parquet")):
        rows = pq.ParquetFile(path).metadata.num_rows
        for lang in langs:
            for start in range(0, rows, SLICE_ROWS):
                shards.append(
                    (
                        path.as_posix(),
                        path.parent.name,
                        kind,
                        lang,
                        start,
                        min(start + SLICE_ROWS, rows),
                    )
                )
    return shards


_WORKER_CON = None


def _worker_con():
    """One single-threaded duckdb connection per worker. threads=1 keeps the
    parquet scan in file order (offset/limit slices stay exact and disjoint)
    and streams pages instead of decoding whole row groups — these corpora
    are single-row-group files, so a pyarrow iter_batches reader held the
    ENTIRE decoded column chunk (~2.5 GB for BCSC) per worker and six
    workers OOMed the machine (MemoryError, first sharded launch)."""
    global _WORKER_CON
    if _WORKER_CON is None:
        import duckdb  # noqa: PLC0415

        _WORKER_CON = duckdb.connect()
        _WORKER_CON.execute("set threads=1")
    return _WORKER_CON


def scan_shard(shard: tuple[str, str, str, str, int, int]) -> dict:
    """Worker: read own parquet row slice (streaming duckdb), scan each doc,
    return a partial aggregate + capped failures instead of per-doc records."""
    pq_path, name, kind, lang, start, stop = shard
    con = _worker_con()
    if kind == "case":
        query = f"""
            select citation_{lang}, citation2_{lang}, unofficial_text_{lang},
                   len(cases_cited_{lang}) as cited
            from read_parquet('{pq_path}')
            limit {stop - start} offset {start}
        """
    else:
        query = f"""
            select citation_{lang}, citation2_{lang}, name_{lang},
                   unofficial_text_{lang},
                   unofficial_sections_{lang}, num_sections_{lang}
            from read_parquet('{pq_path}')
            limit {stop - start} offset {start}
        """
    agg = _empty_agg(kind)
    failures: list[dict] = []
    recoveries: list[tuple[str, float]] = []
    rows = con.execute(query)
    while True:
        batch = rows.fetchmany(100)
        if not batch:
            break
        for row in batch:
            cite = row[0]
            text = row[2] if kind == "case" else row[3]
            if not text:
                continue
            if kind == "case":
                metadata = {
                    "self_cite": cite,
                    "alternate_citation": row[1],
                    "dataset": name,
                    "cited_count": row[3] or 0,
                }
            else:
                try:
                    sections = json.loads(row[4] or "{}")
                    labels = [
                        label
                        for label, value in sections.items()
                        if (
                            isinstance(value, str)
                            and value.strip()
                            and value.strip().casefold() != "[blank]"
                        )
                    ]
                except (json.JSONDecodeError, TypeError, AttributeError):
                    labels = []
                metadata = {
                    "citation": cite,
                    "alternate_citation": row[1],
                    "dataset": name,
                    "name": row[2],
                    "section_labels": labels,
                    "num_sections": row[5] or 0,
                }
            rec = scan_doc((f"{name}:{cite}:{lang}", kind, text, metadata))
            _fold_record(
                agg, rec, failures, recoveries, failure_cap=SHARD_FAILURE_CAP
            )
    agg["failures"] = failures
    agg["recoveries"] = recoveries
    return agg


def run_source_sharded(
    name: str, shards: list, workers: int, out_dir: Path
) -> dict:
    t0 = time.time()
    agg = _empty_agg(name)
    recoveries: list[tuple[str, float]] = []
    shard_failures: list[tuple[int, list[dict]]] = []
    done = 0
    with mp.Pool(workers, initializer=_init_worker) as pool:
        for partial in pool.imap_unordered(scan_shard, shards, chunksize=1):
            for key in ("docs", "chars", "fail_docs", "slow_docs"):
                agg[key] += partial[key]
            for key in ("fail_reasons", "entry_docs", "entry_matches",
                        "structure_kinds", "structure_engines"):
                agg[key].update(partial[key])
            recoveries.extend(partial["recoveries"])
            shard_failures.append((partial["fail_docs"], partial["failures"]))
            done += 1
            print(
                f"[{name}] shard {done}/{len(shards)} "
                f"docs={agg['docs']} mb={agg['chars'] / 1e6:.0f}",
                flush=True,
            )
    # Each shard reservoir is uniform WITHIN its shard, so drawing
    # floor(cap * n_i / N) from each (largest remainders fill the slack)
    # yields a uniform sample over all N failures. The old merge kept
    # whatever the first shards to FINISH had head-capped.
    total_fail = sum(n for n, _ in shard_failures)
    if total_fail <= SHARD_FAILURE_CAP:
        failures = [rec for _, sample in shard_failures for rec in sample]
    else:
        rng = random.Random(47)
        quotas = [
            SHARD_FAILURE_CAP * n / total_fail for n, _ in shard_failures
        ]
        take = [int(q) for q in quotas]
        by_remainder = sorted(
            range(len(quotas)), key=lambda i: quotas[i] - take[i], reverse=True
        )
        for index in by_remainder:
            if sum(take) >= SHARD_FAILURE_CAP:
                break
            take[index] += 1
        failures = []
        for (_, sample), quota in zip(shard_failures, take):
            failures.extend(rng.sample(sample, min(quota, len(sample))))
    with open(out_dir / f"{name}.failures.jsonl", "w", encoding="utf-8") as out:
        for rec in failures:
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return _summarize(agg, recoveries, time.time() - t0, out_dir, name)


def _below_normal_priority() -> None:
    """Throttle rule: corpus-scale runs must not fight the foreground.
    Workers inherit the parent's priority class at spawn."""
    if sys.platform == "win32":
        import ctypes  # noqa: PLC0415
        from ctypes import wintypes  # noqa: PLC0415

        kernel32 = ctypes.windll.kernel32
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x00004000)


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
    _below_normal_priority()

    import duckdb  # noqa: PLC0415

    langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    out_dir = Path(args.out) if args.out else HERE / "results" / args.tier
    out_dir.mkdir(parents=True, exist_ok=True)
    sources = args.source or ["a2aj_cases", "a2aj_laws", "journals"]
    con = duckdb.connect()

    for name in sources:
        if args.tier == "full" and name in {"a2aj_cases", "a2aj_laws"}:
            shards = _corpus_shards(name, langs)
            summary = run_source_sharded(name, shards, args.workers, out_dir)
            print(
                f"{name}: {summary['docs']} docs, {summary['mb']} MB, "
                f"{summary['wall_s']}s ({summary['mb_per_s']} MB/s), "
                f"{summary['fail_docs']} fail docs; "
                f"recovery_mean={summary['recovery_mean']}"
            )
            continue
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
