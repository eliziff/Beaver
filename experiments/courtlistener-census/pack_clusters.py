"""The clusters of packed opinions, one JSON line each, for courtlistener-structure's --clusters.

    python -I pack_clusters.py CL_DB IDS OUT.jsonl

CL_DB is the loaded CourtListener DuckDB (opinion_clusters, load_duckdb.py); IDS has one cluster id a line. Writes
{"id": cluster id, "fields": {field: text}} with cluster_round.py's text fields that are not empty.
"""
import json
import sys
import duckdb

TEXT = ["headmatter", "syllabus", "headnotes", "summary", "arguments", "judges", "attorneys", "disposition", "history",
        "posture", "procedural_history", "cross_reference", "correction", "other_dates", "nature_of_suit",
        "case_name", "case_name_full", "case_name_short", "date_filed", "precedential_status", "scdb_votes_majority",
        "scdb_votes_minority", "citation_count", "filepath_json_harvard"]
db, ids, out = sys.argv[1:4]
clusters = sorted({int(line) for line in open(ids, encoding="utf-8") if line.strip()})
print(len(clusters), "clusters", flush=True)
con = duckdb.connect(db, read_only=True)
con.execute("create temp table wanted(id bigint)")
con.execute("insert into wanted select unnest(?)", [clusters])
columns = ", ".join(f'c."{name}"' for name in TEXT)
cursor = con.execute(f"select c.id, {columns} from opinion_clusters c join wanted w on c.id = w.id")
n = 0
with open(out, "w", encoding="utf-8", newline="\n") as w:
    while True:
        rows = cursor.fetchmany(10000)
        if not rows:
            break
        for row in rows:
            fields = {name: str(value) for name, value in zip(TEXT, row[1:]) if value and str(value).strip()}
            w.write(json.dumps({"id": str(row[0]), "fields": fields}, ensure_ascii=False, default=str) + "\n")
            n += 1
        print(n, flush=True)
print("done", n, flush=True)
