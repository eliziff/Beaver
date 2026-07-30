"""Retrieve the US sources cited by RegLab expert-labeled responses.

The RegLab legal_rag_hallucinations rows carry expert Groundedness
labels but NOT the cited source documents, so only source-free signals
were testable against them (and failed — see the research plan's
negative-result block). This script closes that gap so the
source-anchored features (claim vs its own purported source) can run
on expert labels:

  extract  eyecite over every labeled Response -> distinct case
           citations with volume/reporter/page (offline).
  resolve  TIER 1 (local first): the 5.5 GB CourtListener bulk sqlite
           (`courtlistenerLocalBulk.ts`'s database; 18.1M citations /
           10.1M clusters, 2026-06-30 dump) resolves citation ->
           cluster + case name + date_filed offline, INCLUDING LEXIS
           and post-2020 cites (78% of this set vs CAP's 65%). Its
           opinion table is only a head sample (no text overlap), so:
           TIER 2 (text): Caselaw Access Project static files
           (static.case.law — anonymous CDN): reporter short-name ->
           slug via ReportersMetadata.json, per-volume
           CasesMetadata.json matched on first_page.
           (CourtListener's citation-lookup API now requires an
           account token — probed 401 on 2026-07-30.)
  fetch    full casebody JSON per resolved case, cached one file per
           CAP case id with decision date and court.
  report   coverage: citations found / resolved / fetched, per-response
           coverage; manifest with hashes.

Cache layout (durable-receipts contract, outside git):
  %LOCALAPPDATA%/OpenLegalData/misgrounding-corpus/us_sources/
    citations.jsonl   one row per distinct citation with resolution
    volumes/<slug>-<vol>.json   cached CAP volume metadata
    opinions/<cap_id>.json
    manifest.json

    python -X utf8 scripts/fetch_reglab_sources.py all
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from eyecite import get_citations
from eyecite.models import FullCaseCitation


def local(*parts: str) -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base).joinpath(*parts)


RAW = local("OpenLegalData", "misgrounding-corpus", "raw", "reglab_rag_dataset.csv")
OUT_DIR = local("OpenLegalData", "misgrounding-corpus", "us_sources")
CITATIONS = OUT_DIR / "citations.jsonl"
VOLUMES = OUT_DIR / "volumes"
OPINIONS = OUT_DIR / "opinions"
MANIFEST = OUT_DIR / "manifest.json"

CAP = "https://static.case.law"
WORKERS = 8
LABELS = {"Grounded", "Ungrounded", "Misgrounded"}

csv.field_size_limit(10_000_000)


def get_json(url: str):
    req = urllib.request.Request(
        url, headers={"User-Agent": "beaver-research/1.0 (grounding validation)"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def labeled_rows():
    with open(RAW, encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            if (row.get("Groundedness") or "").strip() in LABELS:
                yield row


def extract() -> dict[str, dict]:
    """Distinct full case citations across labeled responses."""
    distinct: dict[str, dict] = {}
    per_response = Counter()
    for row in labeled_rows():
        response = row.get("Response") or ""
        found = [
            c for c in get_citations(response) if isinstance(c, FullCaseCitation)
        ]
        # Question IDs repeat across tools; the row key needs the model too.
        row_key = f"{row['Question ID']}::{row.get('Model')}"
        per_response[row_key] = len(found)
        for cite in found:
            key = cite.corrected_citation()
            entry = distinct.setdefault(
                key,
                {
                    "citation": key,
                    "volume": cite.groups.get("volume"),
                    "reporter": cite.corrected_reporter(),
                    "page": cite.groups.get("page"),
                    "year": cite.metadata.year,
                    "question_ids": [],
                },
            )
            if row_key not in entry["question_ids"]:
                entry["question_ids"].append(row_key)
    responses = len(per_response)
    bare = sum(1 for _, n in per_response.items() if n == 0)
    print(
        f"extract: {responses} labeled responses, {sum(per_response.values())} "
        f"case-citation mentions, {len(distinct)} distinct citations, "
        f"{bare} responses with zero case citations"
    )
    return distinct


def local_bulk_path() -> Path:
    configured = os.environ.get("MIKE_COURTLISTENER_BULK_DB", "").strip()
    if configured:
        return Path(configured)
    return local(
        "OpenLegalProducts", "LegalData", "providers", "courtlistener",
        "courtlistener.sqlite",
    )


def local_resolve() -> None:
    """Tier-1 resolution: annotate citations.jsonl rows with cl_clusters
    from the local CourtListener bulk (offline; covers LEXIS/new cites)."""
    import sqlite3

    bulk = local_bulk_path()
    if not bulk.exists():
        print(f"[skip] local bulk missing at {bulk}", file=sys.stderr)
        return
    rows = [json.loads(line) for line in open(CITATIONS, encoding="utf-8")]
    database = sqlite3.connect(f"file:{bulk}?mode=ro", uri=True)
    hits = 0
    for row in rows:
        found = database.execute(
            "select ct.cluster_id, cl.case_name_short, cl.date_filed "
            "from citation ct join cluster cl on cl.id = ct.cluster_id "
            "where ct.volume = ? and (ct.reporter = ? or ct.reporter_key = ?) "
            "and ct.page = ?",
            (row["volume"], row["reporter"], row["reporter"], row["page"]),
        ).fetchall()
        row["cl_clusters"] = [
            {"cluster_id": f[0], "name": f[1], "date_filed": f[2]} for f in found
        ]
        if found:
            hits += 1
    with open(CITATIONS, "w", encoding="utf-8") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    print(f"local_resolve: {hits}/{len(rows)} resolved against local CL bulk")


def slugify(reporter: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", reporter.lower())).strip("-")


def reporter_slugs() -> dict[str, str]:
    cache = OUT_DIR / "reporters_metadata.json"
    if cache.exists():
        reporters = json.loads(cache.read_text(encoding="utf-8"))
    else:
        reporters = get_json(f"{CAP}/ReportersMetadata.json")
        cache.write_text(json.dumps(reporters), encoding="utf-8")
    return {r["short_name"]: r["slug"] for r in reporters if r.get("short_name")}


def volume_metadata(slug: str, volume: str):
    VOLUMES.mkdir(parents=True, exist_ok=True)
    cache = VOLUMES / f"{slug}-{volume}.json"
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
        return None if data == "missing" else data
    try:
        data = get_json(f"{CAP}/{slug}/{volume}/CasesMetadata.json")
    except Exception:  # noqa: BLE001 — volume absent from CAP
        cache.write_text('"missing"', encoding="utf-8")
        return None
    cache.write_text(json.dumps(data), encoding="utf-8")
    return data


def resolve(distinct: dict[str, dict]) -> None:
    done: set[str] = set()
    if CITATIONS.exists():
        for line in open(CITATIONS, encoding="utf-8"):
            done.add(json.loads(line)["citation"])
    slugs = reporter_slugs()
    pending = [distinct[key] for key in distinct if key not in done]
    print(f"resolve: {len(done)} cached, {len(pending)} to resolve")

    def resolve_one(entry: dict) -> dict:
        row = dict(entry)
        slug = slugs.get(row["reporter"]) or slugify(row["reporter"] or "")
        row["cap_slug"] = slug
        row["cases"] = []
        if not (slug and row["volume"] and row["page"]):
            row["resolved"] = False
            return row
        cases = volume_metadata(slug, row["volume"])
        if cases:
            for case in cases:
                if str(case.get("first_page")) == str(row["page"]):
                    row["cases"].append(
                        {
                            "cap_id": case["id"],
                            "file_name": case["file_name"],
                            "name": case.get("name_abbreviation"),
                            "decision_date": case.get("decision_date"),
                            "court": (case.get("court") or {}).get("name"),
                        }
                    )
        row["resolved"] = bool(row["cases"])
        return row

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(resolve_one, pending))
    with open(CITATIONS, "a", encoding="utf-8") as out:
        for row in results:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    resolved = sum(1 for r in results if r["resolved"])
    print(f"resolve: {resolved}/{len(results)} newly resolved via CAP static")


def fetch() -> None:
    OPINIONS.mkdir(parents=True, exist_ok=True)
    wanted: dict[int, tuple[str, str, str]] = {}
    for line in open(CITATIONS, encoding="utf-8"):
        row = json.loads(line)
        for case in row.get("cases") or []:
            wanted[case["cap_id"]] = (
                row["cap_slug"],
                row["volume"],
                case["file_name"],
            )
    have = {int(p.stem) for p in OPINIONS.glob("*.json")}
    pending = [(cid, *meta) for cid, meta in wanted.items() if cid not in have]
    print(f"fetch: {len(have)} cached, {len(pending)} casebodies to fetch")

    def fetch_one(item: tuple) -> bool:
        cap_id, slug, volume, file_name = item
        try:
            case = get_json(f"{CAP}/{slug}/{volume}/cases/{file_name}.json")
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch error] {slug}/{volume}/{file_name}: {exc}", file=sys.stderr)
            return False
        opinions = [
            {
                "type": op.get("type"),
                "author": op.get("author"),
                "text": op.get("text") or "",
            }
            for op in (case.get("casebody") or {}).get("opinions") or []
        ]
        blob = json.dumps(
            {
                "cap_id": cap_id,
                "name": case.get("name_abbreviation"),
                "decision_date": case.get("decision_date"),
                "court": (case.get("court") or {}).get("name"),
                "opinions": opinions,
            },
            ensure_ascii=False,
        )
        (OPINIONS / f"{cap_id}.json").write_text(blob, encoding="utf-8")
        time.sleep(0.1)
        return True

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(fetch_one, pending))
    print(f"fetch: {sum(results)}/{len(pending)} fetched")


def report() -> None:
    rows = [json.loads(line) for line in open(CITATIONS, encoding="utf-8")]
    resolved = [r for r in rows if r.get("resolved")]
    cl_resolved = [r for r in rows if r.get("cl_clusters")]
    either = [r for r in rows if r.get("resolved") or r.get("cl_clusters")]
    print(
        f"report: resolution tiers — local CL bulk {len(cl_resolved)}, "
        f"CAP text {len(resolved)}, either {len(either)} "
        f"({len(either) / max(1, len(rows)):.0%})"
    )
    fetched = {int(p.stem) for p in OPINIONS.glob("*.json")}
    nonempty = 0
    for path in OPINIONS.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if any(op["text"] for op in data["opinions"]):
            nonempty += 1
    database_cites = sum(
        1 for r in rows if "LEXIS" in r["citation"] or " WL " in r["citation"]
    )
    coverage = Counter()
    for row in rows:
        state = (
            "fetched"
            if any(c["cap_id"] in fetched for c in row.get("cases") or [])
            else "resolved"
            if row.get("resolved")
            else "unresolved"
        )
        for response_key in row["question_ids"]:
            coverage[(response_key, state)] += 1
    response_keys = {q for q, _ in coverage}
    full = sum(
        1
        for q in response_keys
        if coverage[(q, "unresolved")] == 0 and coverage[(q, "resolved")] == 0
    )
    print(
        f"report: {len(rows)} distinct citations, {len(resolved)} resolved "
        f"({len(resolved) / max(1, len(rows)):.0%}), {len(fetched)} casebodies "
        f"({nonempty} with text), {database_cites} database cites (LEXIS/WL, "
        f"out of CAP corpus by construction)"
    )
    print(
        f"report: {len(response_keys)} responses with citations, "
        f"{full} fully covered ({full / max(1, len(response_keys)):.0%})"
    )
    manifest = {
        "distinct_citations": len(rows),
        "resolved": len(resolved),
        "cl_bulk_resolved": len(cl_resolved),
        "resolved_either_tier": len(either),
        "casebodies_fetched": len(fetched),
        "casebodies_with_text": nonempty,
        "database_citations": database_cites,
        "responses_with_citations": len(response_keys),
        "responses_fully_covered": full,
        "citations_sha256": hashlib.sha256(CITATIONS.read_bytes()).hexdigest(),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"manifest -> {MANIFEST}")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    if stage in ("extract", "resolve", "all"):
        distinct = extract()
        if stage != "extract":
            resolve(distinct)
            local_resolve()
    if stage == "localresolve":
        local_resolve()
    if stage in ("fetch", "all"):
        fetch()
    if stage in ("report", "all"):
        report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
