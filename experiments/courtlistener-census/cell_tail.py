"""Keep the first few substantial opinions of every court x year x source x renditions cell, from the
opinions CSV while load_duckdb.py is still writing it.

    python -I cell_tail.py CL_DB OPINIONS_CSV OUT_DIR [PER_CELL] [MIN_CHARS]

The cluster -> (court, year, cluster source) map comes from CL_DB's opinion_clusters and dockets
(read-only; the loader holds no connection while it decompresses). The CSV is followed as it grows
(OPINIONS_CSV, or OPINIONS_CSV.part while it is still being written) and parsed with the dump's own
conventions. An opinion is kept when its longest rendition has at least MIN_CHARS characters (stubs are
skipped) and its cell holds fewer than PER_CELL; its renditions and fields go to
OUT_DIR/<id>/ as sample_head.py writes them, plus the cell in fields.json. OUT_DIR/cells.json counts every
cell seen (opinions, stubs, kept) and is rewritten as the run goes, so a rerun resumes from it.
"""
import csv
import json
import os
import sys
import time
import duckdb
import numpy as np

RENDS = {"plain_text": "txt", "html": "html", "html_lawbox": "html", "html_columbia": "html",
         "html_anon_2020": "html", "xml_harvard": "xml", "xml_scan": "xml", "html_with_citations": "html"}
csv.field_size_limit(2**31 - 1)


def cluster_map(db):
    con = duckdb.connect(db, read_only=True)
    courts = [r[0] for r in con.execute("SELECT DISTINCT court_id FROM dockets WHERE court_id IS NOT NULL ORDER BY 1").fetchall()]
    sources = [r[0] for r in con.execute("SELECT DISTINCT source FROM opinion_clusters ORDER BY 1").fetchall()]
    cidx, sidx = {c: i + 1 for i, c in enumerate(courts)}, {s: i + 1 for i, s in enumerate(sources)}
    n = con.execute("SELECT max(id) FROM opinion_clusters").fetchone()[0] + 1
    court = np.zeros(n, np.uint16); year = np.zeros(n, np.uint16); src = np.zeros(n, np.uint8)
    rows = con.execute("""SELECT c.id, d.court_id, TRY_CAST(substr(c.date_filed, 1, 4) AS INTEGER), c.source
                          FROM opinion_clusters c LEFT JOIN dockets d ON d.id = c.docket_id""")
    while True:
        batch = rows.fetchmany(500_000)
        if not batch:
            break
        for cid, ct, yr, s in batch:
            court[cid] = cidx.get(ct, 0); year[cid] = yr or 0; src[cid] = sidx.get(s, 0)
    con.close()
    return ["?"] + courts, ["?"] + sources, court, year, src


def follow(path):
    """Lines of a file that is still being written (path.part until it is renamed to path)."""
    part = path + ".part"
    while not os.path.exists(path) and not os.path.exists(part):
        time.sleep(5)
    f = open(part if os.path.exists(part) else path, "r", encoding="utf-8", newline="")
    buf = ""
    while True:
        chunk = f.readline()
        if chunk:
            buf += chunk
            if buf.endswith("\n"):
                yield buf
                buf = ""
            continue
        if os.path.exists(path) and not os.path.exists(part):  # renamed: the file is complete
            rest = f.read()
            if not rest:
                if buf:
                    yield buf
                return
            buf += rest
            continue
        time.sleep(2)


def main():
    db, csv_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    per_cell = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    min_chars = int(sys.argv[5]) if len(sys.argv) > 5 else 2000
    os.makedirs(out, exist_ok=True)
    state_path = os.path.join(out, "cells.json")
    state = json.load(open(state_path, encoding="utf-8")) if os.path.exists(state_path) else {"rows": 0, "cells": {}}
    skip = state["rows"]
    courts, sources, court, year, src = cluster_map(db)
    print(json.dumps({"clusters": int(len(court)), "courts": len(courts), "sources": len(sources), "resume_after_rows": skip}), flush=True)
    reader = csv.reader(follow(csv_path), escapechar="\\", doublequote=False)
    head = next(reader)
    col = {h: i for i, h in enumerate(head)}
    t0, last = time.time(), time.time()
    for n, rec in enumerate(reader, 1):
        if n <= skip or len(rec) != len(head):
            continue
        cid = int(rec[col["cluster_id"]] or 0)
        c = (courts[court[cid]], int(year[cid]), sources[src[cid]]) if cid < len(court) else ("?", 0, "?")
        have = [r for r in RENDS if rec[col[r]]]
        key = f"{c[0]}|{c[1]}|{c[2]}|{'+'.join(have) or 'none'}"
        cell = state["cells"].setdefault(key, {"opinions": 0, "stubs": 0, "kept": 0})
        cell["opinions"] += 1
        longest = max((len(rec[col[r]]) for r in have), default=0)
        if longest < min_chars:
            cell["stubs"] += 1
        elif cell["kept"] < per_cell:
            cell["kept"] += 1
            d = os.path.join(out, rec[col["id"]])
            os.makedirs(d, exist_ok=True)
            for r in have:
                with open(os.path.join(d, f"{r}.{RENDS[r]}"), "w", encoding="utf-8", newline="") as w:
                    w.write(rec[col[r]])
            fields = {h: rec[i] for h, i in col.items() if h not in RENDS}
            fields["_cell"] = key
            json.dump(fields, open(os.path.join(d, "fields.json"), "w", encoding="utf-8"), indent=1)
        state["rows"] = n
        if time.time() - last > 60:
            json.dump(state, open(state_path + ".tmp", "w", encoding="utf-8")); os.replace(state_path + ".tmp", state_path)
            kept = sum(v["kept"] for v in state["cells"].values())
            print(json.dumps({"rows": n, "cells": len(state["cells"]), "kept": kept, "rows_per_s": round((n - skip) / (time.time() - t0))}), flush=True)
            last = time.time()
    json.dump(state, open(state_path + ".tmp", "w", encoding="utf-8")); os.replace(state_path + ".tmp", state_path)
    print(json.dumps({"done": True, "rows": state["rows"], "cells": len(state["cells"])}), flush=True)


main()
