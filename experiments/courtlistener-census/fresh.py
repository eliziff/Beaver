"""Hand a round's new vocabulary to readers, and take their labels back into the catalogue.

    python -I fresh.py export LEDGER_DB OUT_DIR [PER_BATCH]   writes OUT_DIR/batch-NNN.json, prints the batch paths
    python -I fresh.py ingest LEDGER_DB JOURNAL...            adds every reader's labels to `catalogue`

A batch holds PER_BATCH new keys (from the `fresh` view), each with its opinion count and up to
3 examples (id, cluster source, year, 400 characters of source around it).
"""
import json
import os
import sys
import duckdb


def export(db, out, per):
    con = duckdb.connect(db, read_only=True)
    rows = con.execute("SELECT f.key, f.opinions, f.round FROM fresh f ORDER BY split_part(f.key, '|', 1), f.opinions DESC, f.key").fetchall()
    ex = {}
    for key, oid, src, year, snip in con.execute("SELECT key, id, cluster_source, year, snippet FROM example WHERE round = (SELECT max(round) FROM vocab)").fetchall():
        ex.setdefault(key, []).append({"opinion": oid, "cluster_source": src, "year": year, "source": snip})
    os.makedirs(out, exist_ok=True)
    paths = []
    for n in range(0, len(rows), per):
        batch = [{"key": k, "opinions": o, "examples": ex.get(k, [])} for k, o, _ in rows[n:n + per]]
        p = os.path.join(out, f"batch-{n // per:03d}.json")
        json.dump(batch, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        paths.append(p)
    print(json.dumps(paths))


def ingest(db, journals):
    """Each reader's label is kept; `verdict` takes structure if any reader said structure."""
    con = duckdb.connect(db)
    rnd = con.execute("SELECT max(round) FROM vocab").fetchone()[0]
    rows = []
    for j in journals:
        labels = {}
        for line in open(j, encoding="utf-8"):
            e = json.loads(line)
            if e.get("type") == "started":
                labels[e["agentId"]] = e.get("label", "")
            r = e.get("result") if e.get("type") == "result" else None
            if isinstance(r, dict) and "labels" in r:
                model = labels.get(e["agentId"], "?").split(":")[0]
                for lab in r["labels"]:
                    rows.append((lab["key"], rnd, model, lab.get("meaning"), lab.get("verdict")))
    keys = sorted({r[0] for r in rows})
    con.execute("DELETE FROM catalogue WHERE key IN (SELECT unnest(?))", [keys])
    if rows:
        con.execute("CREATE TEMP TABLE t (key VARCHAR, round INTEGER, model VARCHAR, meaning VARCHAR, verdict VARCHAR)")
        con.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?)", rows)
        con.execute("INSERT INTO catalogue SELECT * FROM t")
    con.execute("""CREATE OR REPLACE VIEW verdict AS
        SELECT key, CASE WHEN bool_or(verdict = 'structure') THEN 'structure'
                         WHEN bool_or(verdict = 'unclear') THEN 'unclear'
                         WHEN bool_or(verdict = 'presentation') THEN 'presentation' ELSE 'none' END AS verdict,
               count(DISTINCT verdict) > 1 AS disputed, string_agg(model || ': ' || meaning, ' | ') AS meanings
        FROM catalogue GROUP BY key""")
    print(json.dumps({"labels": len(rows), "keys": len(keys), "fresh_left": con.execute("SELECT count(*) FROM fresh").fetchone()[0]}))


cmd = sys.argv[1]
if cmd == "export":
    export(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 40)
elif cmd == "ingest":
    ingest(sys.argv[2], sys.argv[3:])
