#!/usr/bin/env python3
"""Consolidate installed A2AJ SQLite snapshots, preserving primary document IDs.

Run with the provider directory. Secondary files are retained: remove them only
after checking consumers and the resulting corpus/index. This maintenance tool
does not download data or create another corpus copy.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3


def identity(row):
    return tuple(row[1:7])


def content_hash(row):
    return hashlib.sha256(json.dumps(
        [value for index, value in enumerate(row) if index not in (0, 9, 10)],
        ensure_ascii=False, separators=(",", ":"),
    ).encode()).digest()


def normalized_date(value):
    if not value:
        return value
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo:
            date = date.astimezone(timezone.utc).replace(tzinfo=None)
        return date.isoformat()
    except ValueError:
        return value


def consolidate(directory):
    primary = directory / "a2aj.sqlite"
    database = sqlite3.connect(primary, timeout=30)
    database.execute("PRAGMA cache_size=-32768")
    database.execute("PRAGMA temp_store=FILE")
    identities = defaultdict(list)
    for row in database.execute("SELECT id,doc_type,dataset,citation_en,citation_fr,citation2_en,citation2_fr FROM document"):
        identities[identity(row)].append(row[0])
    report = {"primary_before": database.execute("SELECT COUNT(*) FROM document").fetchone()[0], "snapshots": []}
    try:
        for kind in ("cases", "laws"):
            filename = directory / f"a2aj-{kind}-fulltext.sqlite"
            source = sqlite3.connect(filename.as_uri() + "?mode=ro", uri=True)
            source.execute("PRAGMA cache_size=-32768")
            metadata = dict(source.execute("SELECT key,value FROM meta"))
            summary = {"filename": filename.name, "metadata": metadata, "matched": 0, "added": 0, "newer_updated": 0}
            newer = metadata["imported_at"] > dict(database.execute("SELECT key,value FROM meta")).get("imported_at", "")
            mapping = []
            projection = "*" if newer else "id,doc_type,dataset,citation_en,citation_fr,citation2_en,citation2_fr"
            for number, row in enumerate(source.execute(f"SELECT {projection} FROM document"), 1):
                candidates = identities.get(identity(row), [])
                target = candidates[0] if len(candidates) == 1 else None
                if len(candidates) > 1:
                    if not newer:
                        row = source.execute("SELECT * FROM document WHERE id=?", (row[0],)).fetchone()
                    digest = content_hash(row)
                    matches = [ident for ident in candidates if content_hash(database.execute(
                        "SELECT * FROM document WHERE id=?", (ident,),
                    ).fetchone()) == digest]
                    # Same citation can identify distinct regulations. Never collapse them.
                    if matches:
                        target = matches[0]
                    else:
                        raise RuntimeError(f"Ambiguous changed {kind} identity at source row {row[0]}; review before proceeding")
                if target is None:
                    if not newer and len(row) == 7:
                        row = source.execute("SELECT * FROM document WHERE id=?", (row[0],)).fetchone()
                    target = database.execute("SELECT COALESCE(MAX(id),0)+1 FROM document").fetchone()[0]
                    database.execute("INSERT INTO document VALUES (" + ",".join("?" for _ in row) + ")", (target, *row[1:]))
                    identities[identity(row)].append(target)
                    summary["added"] += 1
                else:
                    summary["matched"] += 1
                    if newer:
                        existing = database.execute("SELECT * FROM document WHERE id=?", (target,)).fetchone()
                        replacement = list(row)
                        replacement[0] = target
                        replacement[9:11] = [normalized_date(value) for value in row[9:11]]
                        if tuple(replacement) != tuple(existing):
                            columns = [column[1] for column in database.execute("PRAGMA table_info(document)")][1:]
                            database.execute("UPDATE document SET " + ",".join(f"{column}=?" for column in columns) + " WHERE id=?", (*replacement[1:], target))
                            summary["newer_updated"] += 1
                mapping.append((row[0], target))
                if number % 25000 == 0:
                    print(kind, number, summary["added"], summary["newer_updated"], flush=True)
            source.close()
            database.execute("ATTACH DATABASE ? AS snapshot", (str(filename),))
            database.execute("CREATE TEMP TABLE remap(source_id INTEGER PRIMARY KEY,target_id INTEGER)")
            database.executemany("INSERT INTO remap VALUES (?,?)", mapping)
            for table, key in (("citation_lookup", "citation_key"), ("name_lookup", "name_key")):
                database.execute(f"INSERT OR IGNORE INTO {table} SELECT s.{key},r.target_id FROM snapshot.{table} s JOIN remap r ON r.source_id=s.document_id")
            database.execute("DROP TABLE remap")
            database.commit()
            database.execute("DETACH DATABASE snapshot")
            report["snapshots"].append(summary)
        # Commit the merged corpus before indexing. A failed index can be rebuilt
        # without repeating imports; the source snapshots remain intact.
        database.commit()
        database.executescript("""
            CREATE INDEX IF NOT EXISTS document_date_en_idx ON document(document_date_en);
            CREATE INDEX IF NOT EXISTS document_date_fr_idx ON document(document_date_fr);
            CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
                citation_en,citation_fr,citation2_en,citation2_fr,name_en,name_fr,
                unofficial_text_en,unofficial_text_fr,content='document',content_rowid='id'
            );
        """)
        print("Building the canonical external-content search index", flush=True)
        database.execute("INSERT INTO document_search(document_search) VALUES('rebuild')")
        print("Verifying the search index against every content row", flush=True)
        database.execute("INSERT INTO document_search(document_search,rank) VALUES('integrity-check',1)")
        report["primary_after"] = database.execute("SELECT COUNT(*) FROM document").fetchone()[0]
        database.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", (
            ("fts", "true"), ("document_count", str(report["primary_after"])),
            ("citation_count", str(database.execute("SELECT COUNT(*) FROM citation_lookup").fetchone()[0])),
            ("name_count", str(database.execute("SELECT COUNT(*) FROM name_lookup").fetchone()[0])),
            ("consolidated_snapshots", json.dumps(report["snapshots"], separators=(",", ":"))),
        ))
        database.commit()
        (directory / "consolidation-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), flush=True)
        return report
    finally:
        database.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    consolidate(args.directory.resolve())
