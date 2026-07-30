"""Retrieve the US sources cited by RegLab expert-labeled responses.

The RegLab legal_rag_hallucinations rows carry expert Groundedness
labels but NOT the cited source documents, so only source-free signals
were testable against them (and failed — see the research plan's
negative-result block). This script closes that gap so the
source-anchored features (claim vs its own purported source) can run
on expert labels:

  extract  eyecite over every labeled Response -> distinct case
           citations (offline, no network).
  resolve  CourtListener /api/rest/v4/citation-lookup/ in throttled
           batches -> citation -> cluster id(s). eyecite is CL's own
           parser, so extraction and resolution agree.
  fetch    opinion text per resolved cluster (plain_text, else
           stripped HTML), cached one file per cluster with sha256.
  report   coverage table: citations found / resolved / fetched, and
           per-response source coverage.

Cache layout (durable-receipts contract, outside git):
  %LOCALAPPDATA%/OpenLegalData/misgrounding-corpus/us_sources/
    citations.jsonl   one row per distinct citation with resolution
    opinions/<cluster_id>.json
    manifest.json     counts + hashes

Free API, no key required; COURTLISTENER_API_TOKEN honored if set.
Throttled to stay well inside CourtListener's documented limits.

    python -X utf8 scripts/fetch_reglab_sources.py all
"""
from __future__ import annotations

import csv
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

from eyecite import get_citations
from eyecite.models import FullCaseCitation


def local(*parts: str) -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base).joinpath(*parts)


RAW = local("OpenLegalData", "misgrounding-corpus", "raw", "reglab_rag_dataset.csv")
OUT_DIR = local("OpenLegalData", "misgrounding-corpus", "us_sources")
CITATIONS = OUT_DIR / "citations.jsonl"
OPINIONS = OUT_DIR / "opinions"
MANIFEST = OUT_DIR / "manifest.json"

API = "https://www.courtlistener.com/api/rest/v4"
LOOKUP_BATCH = 40          # citations per lookup POST
LOOKUP_PAUSE = 65.0        # seconds between lookup batches (limit: 60/min)
FETCH_PAUSE = 1.2          # seconds between opinion fetches
LABELS = {"Grounded", "Ungrounded", "Misgrounded"}

csv.field_size_limit(10_000_000)


def request(url: str, data: bytes | None = None) -> dict | list:
    headers = {"User-Agent": "beaver-research/1.0 (grounding validation)"}
    token = os.environ.get("COURTLISTENER_API_TOKEN")
    if token:
        headers["Authorization"] = f"Token {token}"
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp:
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
                    "matched_text": cite.matched_text(),
                    "case_name": (cite.metadata.plaintiff or "")
                    + (" v. " + cite.metadata.defendant if cite.metadata.defendant else ""),
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


def resolve(distinct: dict[str, dict]) -> None:
    """citation-lookup in batches; annotates entries with clusters."""
    done: dict[str, dict] = {}
    if CITATIONS.exists():
        for line in open(CITATIONS, encoding="utf-8"):
            row = json.loads(line)
            done[row["citation"]] = row
    pending = [key for key in distinct if key not in done]
    print(f"resolve: {len(done)} cached, {len(pending)} to look up")
    for start in range(0, len(pending), LOOKUP_BATCH):
        batch = pending[start : start + LOOKUP_BATCH]
        text = "\n".join(batch)
        payload = urllib.parse.urlencode({"text": text}).encode("utf-8")
        try:
            results = request(f"{API}/citation-lookup/", payload)
        except Exception as exc:  # noqa: BLE001 — record and continue
            print(f"[lookup error] batch at {start}: {exc}", file=sys.stderr)
            time.sleep(LOOKUP_PAUSE)
            continue
        matched: dict[str, list] = {}
        for item in results:
            for key in item.get("normalized_citations") or [item.get("citation")]:
                matched.setdefault(item["citation"], []).extend(
                    {
                        "cluster_id": c["id"],
                        "case_name": c.get("case_name"),
                        "court": (c.get("docket") or {}).get("court_id")
                        if isinstance(c.get("docket"), dict)
                        else None,
                        "date_filed": c.get("date_filed"),
                    }
                    for c in item.get("clusters") or []
                )
        with open(CITATIONS, "a", encoding="utf-8") as out:
            for key in batch:
                # citation-lookup echoes the input line as `citation`
                clusters = matched.get(key, [])
                row = dict(distinct[key])
                row["clusters"] = clusters
                row["resolved"] = bool(clusters)
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(
            f"resolve: batch {start // LOOKUP_BATCH + 1} "
            f"({start + len(batch)}/{len(pending)}) done"
        )
        if start + LOOKUP_BATCH < len(pending):
            time.sleep(LOOKUP_PAUSE)


TAG = re.compile(r"<[^>]+>")


def fetch() -> None:
    OPINIONS.mkdir(parents=True, exist_ok=True)
    wanted: set[int] = set()
    for line in open(CITATIONS, encoding="utf-8"):
        row = json.loads(line)
        for cluster in row.get("clusters") or []:
            wanted.add(cluster["cluster_id"])
    have = {int(p.stem) for p in OPINIONS.glob("*.json")}
    pending = sorted(wanted - have)
    print(f"fetch: {len(have)} cached, {len(pending)} opinions to fetch")
    for index, cluster_id in enumerate(pending):
        try:
            data = request(f"{API}/opinions/?cluster__id={cluster_id}")
        except Exception as exc:  # noqa: BLE001
            print(f"[fetch error] cluster {cluster_id}: {exc}", file=sys.stderr)
            time.sleep(FETCH_PAUSE)
            continue
        texts = []
        for opinion in data.get("results", []):
            text = opinion.get("plain_text") or ""
            if not text.strip():
                markup = (
                    opinion.get("html_with_citations")
                    or opinion.get("html")
                    or opinion.get("xml_harvard")
                    or ""
                )
                text = html.unescape(TAG.sub(" ", markup))
            texts.append(
                {
                    "opinion_id": opinion.get("id"),
                    "type": opinion.get("type"),
                    "text": re.sub(r"[ \t]+", " ", text).strip(),
                }
            )
        blob = json.dumps(
            {"cluster_id": cluster_id, "opinions": texts}, ensure_ascii=False
        )
        path = OPINIONS / f"{cluster_id}.json"
        path.write_text(blob, encoding="utf-8")
        if (index + 1) % 25 == 0:
            print(f"fetch: {index + 1}/{len(pending)}")
        time.sleep(FETCH_PAUSE)


def report() -> None:
    rows = [json.loads(line) for line in open(CITATIONS, encoding="utf-8")]
    resolved = [r for r in rows if r.get("resolved")]
    fetched = {int(p.stem) for p in OPINIONS.glob("*.json")}
    nonempty = 0
    for path in OPINIONS.glob("*.json"):
        data = json.loads(path.read_text(encoding="utf-8"))
        if any(op["text"] for op in data["opinions"]):
            nonempty += 1
    coverage = Counter()
    for row in rows:
        state = (
            "fetched"
            if any(c["cluster_id"] in fetched for c in row.get("clusters") or [])
            else "resolved"
            if row.get("resolved")
            else "unresolved"
        )
        for question_id in row["question_ids"]:
            coverage[(question_id, state)] += 1
    question_ids = {q for q, _ in coverage}
    full = sum(
        1
        for q in question_ids
        if coverage[(q, "unresolved")] == 0 and coverage[(q, "resolved")] == 0
    )
    print(
        f"report: {len(rows)} distinct citations, {len(resolved)} resolved "
        f"({len(resolved) / max(1, len(rows)):.0%}), {len(fetched)} clusters fetched "
        f"({nonempty} with text)"
    )
    print(
        f"report: {len(question_ids)} responses with citations, "
        f"{full} fully covered ({full / max(1, len(question_ids)):.0%})"
    )
    manifest = {
        "distinct_citations": len(rows),
        "resolved": len(resolved),
        "clusters_fetched": len(fetched),
        "clusters_with_text": nonempty,
        "responses_with_citations": len(question_ids),
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
    if stage in ("fetch", "all"):
        fetch()
    if stage in ("report", "all"):
        report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
