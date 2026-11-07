"""Families of structure: the unit the discovery curve counts.

    python -I families.py export LEDGER_DB OUT_JSON      every key with no family yet, with its meaning, plus the family list
    python -I families.py ingest LEDGER_DB JOURNAL...    stores the reader's families and key assignments

A key (one element, class, value shape or repeated line) is too fine to count: each case has its own
running head. A family is one kind of structure the data supplies ("running head carrying the docket
number", "CAP page-number element"); a round's new families are what it discovered.
"""
import json
import sys
import duckdb


def export(db, out):
    con = duckdb.connect(db)
    con.execute("CREATE TABLE IF NOT EXISTS family (id VARCHAR, name VARCHAR, description VARCHAR, round INTEGER)")
    con.execute("CREATE TABLE IF NOT EXISTS key_family (key VARCHAR, family VARCHAR, round INTEGER)")
    keys = con.execute("""SELECT v.key, any_value(c.meaning), (SELECT min(round) FROM vocab x WHERE x.key = v.key) FROM verdict v JOIN catalogue c USING (key)
        WHERE v.key NOT IN (SELECT key FROM key_family) GROUP BY v.key ORDER BY v.key""").fetchall()
    fams = con.execute("SELECT id, name, description FROM family ORDER BY id").fetchall()
    json.dump({"families": [{"id": i, "name": n, "description": d} for i, n, d in fams],
               "keys": [{"key": k, "meaning": m} for k, m, _ in keys]}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(json.dumps({"unassigned_keys": len(keys), "families": len(fams), "out": out}))


def ingest(db, journals, rnd=None):
    con = duckdb.connect(db)
    if rnd is None:
        rnd = con.execute("SELECT max(round) FROM vocab").fetchone()[0]
    known = {r[0] for r in con.execute("SELECT id FROM family").fetchall()}
    new_f, assigned = [], []
    for j in journals:
        for line in open(j, encoding="utf-8"):
            e = json.loads(line)
            r = e.get("result") if e.get("type") == "result" else None
            if isinstance(r, dict) and "assignments" in r:
                for f in r.get("new_families", []):
                    if f["id"] not in known:
                        new_f.append((f["id"], f["name"], f["description"], rnd)); known.add(f["id"])
                for a in r["assignments"]:
                    assigned.append((a["key"], a["family"], rnd))
    if new_f:
        con.executemany("INSERT INTO family VALUES (?, ?, ?, ?)", new_f)
    if assigned:
        con.execute("DELETE FROM key_family WHERE key IN (SELECT unnest(?))", [[a[0] for a in assigned]])
        con.execute("CREATE TEMP TABLE t (key VARCHAR, family VARCHAR, round INTEGER)")
        con.executemany("INSERT INTO t VALUES (?, ?, ?)", assigned)
        con.execute("INSERT INTO key_family SELECT * FROM t")
    unknown = [a for a in assigned if a[1] not in known]
    print(json.dumps({"new_families": len(new_f), "assigned": len(assigned), "unknown_family_refs": len(unknown)}))


if sys.argv[1] == "export":
    export(sys.argv[2], sys.argv[3])
else:  # ingest LEDGER_DB [--round N] JOURNAL...: N is the round whose sort this was (default the latest)
    rest = sys.argv[3:]
    rnd = None
    if rest[:1] == ["--round"]:
        rnd, rest = int(rest[1]), rest[2:]
    ingest(sys.argv[2], rest, rnd)
