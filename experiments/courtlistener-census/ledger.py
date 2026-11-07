"""The reading ledger: every opinion sampled, who read it, and every structure each reading found.

    python -I ledger.py LEDGER_DB SAMPLE_DIR [WORKFLOW_JOURNAL ...] [--bulk CL_DB]

sample   one row per opinion written out by sample_head.py (its fields.json): id, cluster, file
         offset, which renditions it has and their sizes, opinion type, OCR flag, source host.
reading  one row per reading (workflow agent result): opinion id, model, run, item count.
item     one row per thing a reading found: what, snippet, shown_in, missing_from, encoding.
place    with --bulk (the loaded CourtListener DuckDB): each sampled opinion's court, year and
         cluster source, joined through opinion_clusters and dockets as far as they are loaded.
Rebuilt from its inputs on every run, so it never drifts from what was sampled and read.
"""
import json
import os
import sys
import duckdb

argv = sys.argv[1:]
bulk = None
if "--bulk" in argv:
    i = argv.index("--bulk"); bulk = argv[i + 1]; del argv[i:i + 2]
db_path, sample_dir, journals = argv[0], argv[1], argv[2:]
con = duckdb.connect(db_path)

samples = []
for i in sorted(os.listdir(sample_dir)):
    f = os.path.join(sample_dir, i, "fields.json")
    if not os.path.isfile(f):
        continue
    fields = json.load(open(f, encoding="utf-8"))
    rends = {os.path.splitext(n)[0]: os.path.getsize(os.path.join(sample_dir, i, n))
             for n in os.listdir(os.path.join(sample_dir, i)) if n != "fields.json"}
    host = (fields.get("download_url") or "").split("/")[2] if "://" in (fields.get("download_url") or "") else None
    samples.append((int(fields["id"]), int(fields["cluster_id"]), int(fields.get("_file_offset", -1)), os.path.basename(sample_dir),
                    sorted(rends), json.dumps(rends), fields.get("type"), fields.get("extracted_by_ocr"), host))
con.execute("CREATE OR REPLACE TABLE sample (id BIGINT, cluster_id BIGINT, file_offset BIGINT, sample_set VARCHAR, renditions VARCHAR[], rendition_bytes JSON, type VARCHAR, ocr VARCHAR, download_host VARCHAR)")
con.executemany("INSERT INTO sample VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", samples)

readings, items = [], []
for jpath in journals:
    run = os.path.basename(os.path.dirname(jpath))
    labels = {}
    for line in open(jpath, encoding="utf-8"):
        e = json.loads(line)
        if e.get("type") == "started":
            labels[e["agentId"]] = e.get("label", "")
        elif e.get("type") == "result" and isinstance(e.get("result"), dict) and "items" in e["result"]:
            r = e["result"]
            oid = int(labels.get(e["agentId"], "read:" + str(r.get("id"))).split(":")[1])
            model = e.get("model") or "haiku"
            readings.append((oid, model, run, e["agentId"], len(r["items"]), json.dumps(r.get("differences", []))))
            for k, it in enumerate(r["items"]):
                items.append((oid, model, run, k, it.get("what"), it.get("snippet"), it.get("shown_in", []), it.get("missing_from", []), it.get("encoding")))
con.execute("CREATE OR REPLACE TABLE reading (id BIGINT, model VARCHAR, run VARCHAR, agent VARCHAR, items INTEGER, differences JSON)")
con.execute("CREATE OR REPLACE TABLE item (id BIGINT, model VARCHAR, run VARCHAR, n INTEGER, what VARCHAR, snippet VARCHAR, shown_in VARCHAR[], missing_from VARCHAR[], encoding VARCHAR)")
if readings:
    con.executemany("INSERT INTO reading VALUES (?, ?, ?, ?, ?, ?)", readings)
if items:
    con.executemany("INSERT INTO item VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", items)

if bulk:
    con.execute(f"ATTACH '{bulk}' AS cl (READ_ONLY)")
    have = {r[0] for r in con.execute("SELECT table_name FROM duckdb_tables() WHERE database_name = 'cl'").fetchall()}
    year = "TRY_CAST(substr(c.date_filed, 1, 4) AS INTEGER)" if "opinion_clusters" in have else "NULL"
    court = "d.court_id" if "dockets" in have else "NULL"
    joins = ("LEFT JOIN cl.opinion_clusters c ON c.id = s.cluster_id " if "opinion_clusters" in have else "") + \
            ("LEFT JOIN cl.dockets d ON d.id = c.docket_id " if "dockets" in have and "opinion_clusters" in have else "")
    src = "c.source" if "opinion_clusters" in have else "NULL"
    con.execute(f"CREATE OR REPLACE TABLE place AS SELECT s.id, {court} AS court, {year} AS year, {src} AS cluster_source FROM sample s {joins}")

print(json.dumps({"samples": len(samples), "readings": len(readings), "items": len(items)}))
