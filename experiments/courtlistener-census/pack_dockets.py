"""The docket facts of the clusters a pack holds, one JSON line each, in pack_clusters.py's form for --clusters.

    python -I pack_dockets.py CL_DB DOCKETS.csv.bz2 CLUSTER_IDS OUT.jsonl

Writes {"id": cluster id, "fields": {"court": full name, "docket_number": ..., ...}}.
"""
import bz2, csv, json, sys
import duckdb

db, source, ids, out = sys.argv[1:5]
FIELDS = ["docket_number", "appeal_from_str", "assigned_to_str", "referred_to_str", "panel_str", "cause", "date_argued",
          "date_reargued", "date_reargument_denied", "date_cert_granted", "date_cert_denied", "date_terminated"]
csv.field_size_limit(1 << 24)
wanted = sorted({int(line) for line in open(ids, encoding="utf-8") if line.strip()})
con = duckdb.connect(db, read_only=True)
con.execute("create temp table wanted(id bigint)")
con.execute("insert into wanted select unnest(?)", [wanted])
clusters = {}
for cluster, docket in con.execute("select c.id, c.docket_id from opinion_clusters c join wanted w on c.id = w.id").fetchall():
    clusters.setdefault(str(docket), []).append(str(cluster))
courts = {str(court): name for court, name in con.execute("select id, full_name from courts").fetchall()}
print(len(wanted), "clusters", len(clusters), "dockets", flush=True)
rows = 0
with bz2.open(source, "rt", encoding="utf-8", newline="") as f, open(out, "w", encoding="utf-8", newline="\n") as w:
    reader = csv.DictReader(f)
    print(reader.fieldnames, flush=True)
    for row in reader:
        rows += 1
        if rows % 5000000 == 0:
            print(rows, flush=True)
        owners = clusters.get(row["id"])
        if not owners:
            continue
        fields = {name: row[name] for name in FIELDS if row.get(name, "").strip()}
        court = courts.get(row.get("court_id", ""))
        if court:
            fields["court"] = court
        for cluster in owners:
            w.write(json.dumps({"id": cluster, "fields": fields}, ensure_ascii=False) + "\n")
print("done", rows, flush=True)
