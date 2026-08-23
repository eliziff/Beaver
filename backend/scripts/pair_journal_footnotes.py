"""Build journal_commentary.sqlite from Rust pairs; own only SQLite and citation joins."""
from __future__ import annotations
import argparse
import hashlib
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_citator_graph import case_occurrences  # noqa: E402
from legal_structure import pair_journal_footnotes  # noqa: E402
LOCAL_BASE = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
SOURCE_DB = Path((os.environ.get("MIKE_PUBLIC_ENDPOINT_DB") or "").strip() or
                 LOCAL_BASE / "OpenLegalProducts" / "LegalData" / "providers" / "journals" / "public_endpoint.db")
DEFAULT_OUTPUT = LOCAL_BASE / "ALR Quote Verifier" / "citator" / "journal_commentary.sqlite"
# Count only the known access-date and volume/issue reporter noise.
DATE_SHAPED_RE = re.compile(
    r"^\d{1,2}\s+(?:January|February|March|April|May|June|July|August|"
    r"September|October|November|December|janvier|février|mars|avril|mai|"
    r"juin|juillet|août|septembre|octobre|novembre|décembre)\s+\d{4}$",
    re.IGNORECASE)
ISSUE_SHAPED_RE = re.compile(r"^\d{1,4}\s+No\.?\s+\d+$", re.IGNORECASE)
OUTPUT_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE article (article_id INTEGER PRIMARY KEY, dataset TEXT, citation TEXT, name TEXT, date TEXT, journal_name TEXT, authors TEXT, url TEXT, pages INTEGER, labels_candidates INTEGER, labels_selected INTEGER, refs_assigned INTEGER, ambiguous_sites INTEGER, footnote_mode INTEGER, crossrefs INTEGER, crossrefs_unresolved INTEGER);
CREATE TABLE note (id INTEGER PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES article(article_id), label TEXT NOT NULL, restart_sequence INTEGER NOT NULL, pair_status TEXT NOT NULL, note_page_label TEXT, ref_page_label TEXT, body TEXT NOT NULL, body_sha256 TEXT NOT NULL, truncated_at_page_end INTEGER NOT NULL, proposition TEXT, proposition_sha256 TEXT, passage TEXT);
CREATE TABLE note_citation (note_id INTEGER NOT NULL REFERENCES note(id), rank INTEGER NOT NULL, kind TEXT NOT NULL, citation TEXT NOT NULL, cited_key TEXT NOT NULL, case_short TEXT, pinpoints TEXT);
CREATE INDEX note_citation_key ON note_citation(cited_key);
CREATE INDEX note_article ON note(article_id);
"""
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=SOURCE_DB)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    if not args.db.is_file():
        raise SystemExit(f"source not found: {args.db}")
    source = sqlite3.connect(f"file:{args.db.as_posix()}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    args.output.parent.mkdir(parents=True, exist_ok=True)
    building = args.output.with_suffix(".building.sqlite")
    if building.exists():
        building.unlink()
    out = sqlite3.connect(building)
    out.executescript(OUTPUT_SCHEMA)
    where = "text IS NOT NULL AND length(text) > 0"
    total = source.execute(f"SELECT count(*) FROM articles WHERE {where}").fetchone()[0]
    limit_sql = f" LIMIT {int(args.limit)}" if args.limit else ""
    started = time.time()
    stats = dict.fromkeys(("articles", "notes", "paired", "citations", "no_labels",
                           "truncated", "symbol_labels_dropped",
                           "citations_dropped_dateshaped"), 0)
    for row in source.execute(
        f"SELECT article_id, dataset, citation_en, name_en, document_date_en,"
        f" journal_name, authors, galley_url, url_en, text FROM articles"
        f" WHERE {where} ORDER BY article_id{limit_sql}"
    ):
        page_labels = [str(page[0] or "").strip() for page in source.execute(
            "SELECT page_label FROM article_pages WHERE article_id = ? ORDER BY page_order",
            (row["article_id"],))]
        result = pair_journal_footnotes(row["text"], page_labels)
        stats["articles"] += 1
        stats["symbol_labels_dropped"] += int(result["symbol_labels_dropped"])
        if not result["labels_selected"]:
            stats["no_labels"] += 1
        out.execute(
            "INSERT INTO article VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (row["article_id"], row["dataset"], row["citation_en"], row["name_en"],
             row["document_date_en"], row["journal_name"], row["authors"], row["galley_url"] or row["url_en"],
             result["pages"], result["labels_candidates"], result["labels_selected"], result["refs_assigned"],
             result["ambiguous_sites"], int(result["footnote_mode"]), result["crossrefs"], result["crossrefs_unresolved"]),
        )
        for note in result["notes"]:
            stats["notes"] += 1
            body = note["body"]
            proposition = note["proposition"]
            pair_status = "paired" if note["ref_page_index"] is not None else "label_only"
            stats["paired"] += int(pair_status == "paired")
            stats["truncated"] += int(note["truncated"])
            cursor = out.execute(
                "INSERT INTO note (article_id, label, restart_sequence, pair_status,"
                " note_page_label, ref_page_label, body, body_sha256,"
                " truncated_at_page_end, proposition, proposition_sha256, passage)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (row["article_id"], note["label"], note["restart_sequence"], pair_status,
                 str(note["note_page_index"]),
                 str(note["ref_page_index"]) if note["ref_page_index"] is not None else None,
                 body, hashlib.sha256(body.encode("utf8")).hexdigest(), int(note["truncated"]), proposition,
                 hashlib.sha256(proposition.encode("utf8")).hexdigest() if proposition else None, note["passage"]),
            )
            occurrences, _kinds = case_occurrences(body)
            kept = [occurrence for occurrence in occurrences if not (
                occurrence["kind"] == "reporter" and
                (DATE_SHAPED_RE.match(occurrence["citation"]) or
                 ISSUE_SHAPED_RE.match(occurrence["citation"])))]
            stats["citations_dropped_dateshaped"] += len(occurrences) - len(kept)
            for rank, occurrence in enumerate(kept, start=1):
                stats["citations"] += 1
                out.execute(
                    "INSERT INTO note_citation VALUES (?,?,?,?,?,?,?)",
                    (cursor.lastrowid, rank, occurrence["kind"], occurrence["citation"],
                     occurrence["key"], occurrence["short"], occurrence["pinpoints"]),
                )
        if stats["articles"] % 500 == 0:
            out.commit()
            print(f"[pair] {stats['articles']}/{args.limit or total} articles, {stats['paired']}/"
                  f"{stats['notes']} notes paired, {stats['citations']} citations", flush=True)
    source.close()
    source_stat = args.db.stat()
    meta = {
        "schema_version": "beaver.journal_commentary.v1", "engine": "legal-structure/journal.rs",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_path": str(args.db), "source_size": str(source_stat.st_size),
        "source_mtime_ms": str(int(source_stat.st_mtime * 1000)), **{
            f"count_{key}": str(value) for key, value in stats.items()},
    }
    out.executemany("INSERT INTO meta VALUES (?,?)", sorted(meta.items()))
    out.commit()
    out.close()
    if args.output.exists():
        args.output.unlink()
    building.rename(args.output)
    print(f"[pair] done in {time.time() - started:.0f}s -> {args.output}")
    for key, value in stats.items():
        print(f"  {key}: {value}")
if __name__ == "__main__":
    main()
