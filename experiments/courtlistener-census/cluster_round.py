"""A reading round over the clusters' own text fields (headmatter, syllabus, headnotes, summary, arguments, ...).

    python -I cluster_round.py CL_DB MAP_NPZ OUT_DIR [PER_COURT]

CL_DB is the loaded CourtListener DuckDB (opinion_clusters); MAP_NPZ is cell_stream.py's cluster -> court map.
For each court, up to PER_COURT clusters that carry any text field are chosen: field combinations and decades
the court has not shown yet first, ties by a hash of the id. Each chosen cluster becomes OUT_DIR/c<id>/ with
fields.json (its scalar fields and "_cell": court|year|source|fields) and one file per non-empty text field,
cluster.<field>.html when it is markup and .txt otherwise, read the way codex_read.py reads opinions.
"""
import hashlib
import json
import os
import re
import sys
from collections import defaultdict
import duckdb
import numpy as np

TEXT = ["headmatter", "syllabus", "headnotes", "summary", "arguments", "judges", "attorneys", "disposition", "history",
        "posture", "procedural_history", "cross_reference", "correction", "other_dates", "nature_of_suit"]
SCALAR = ["id", "case_name", "case_name_full", "date_filed", "source", "precedential_status", "citation_count",
          "filepath_json_harvard", "filepath_pdf_harvard", "docket_id", "slug"]


def main():
    db, map_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    per = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    z = np.load(map_path, allow_pickle=True)
    courts, court = list(z["courts"]), z["court"]
    con = duckdb.connect(db, read_only=True)
    flags = ", ".join(f"coalesce(length({f}), 0) > 0 AS {f}" for f in TEXT)
    rows = con.execute(f"SELECT id, source, substr(date_filed, 1, 4) AS year, {flags} FROM opinion_clusters").fetchall()
    by_court = defaultdict(list)
    for r in rows:
        cid, source, year, has = r[0], r[1], r[2] or "?", r[3:]
        present = [f for f, h in zip(TEXT, has) if h]
        if not present:
            continue
        c = courts[court[cid]] if cid < len(court) else "?"
        by_court[c].append((cid, year, source, "+".join(present)))
    chosen = []
    for c, items in by_court.items():
        seen_f, seen_d, picks = set(), set(), []
        items.sort(key=lambda r: hashlib.sha1(str(r[0]).encode()).hexdigest())
        while items and len(picks) < per:
            items.sort(key=lambda r: ((r[3] in seen_f) + (r[1][:3] in seen_d), hashlib.sha1(str(r[0]).encode()).hexdigest()))
            r = items.pop(0); picks.append((c, *r)); seen_f.add(r[3]); seen_d.add(r[1][:3])
        chosen += picks
    os.makedirs(out, exist_ok=True)
    cols = ", ".join(SCALAR + TEXT)
    ids = [x[1] for x in chosen]
    meta = {x[1]: x for x in chosen}
    for k in range(0, len(ids), 2000):
        for row in con.execute(f"SELECT {cols} FROM opinion_clusters WHERE id IN (SELECT unnest(?))", [ids[k:k + 2000]]).fetchall():
            rec = dict(zip(SCALAR + TEXT, row))
            c, cid, year, source, present = meta[rec["id"]]
            d = os.path.join(out, f"c{cid}")
            os.makedirs(d, exist_ok=True)
            for f in TEXT:
                v = rec[f]
                if v:
                    ext = "html" if re.search(r"<[A-Za-z][^>]{0,200}>", v[:5000]) else "txt"
                    with open(os.path.join(d, f"cluster.{f}.{ext}"), "w", encoding="utf-8", newline="") as w:
                        w.write(v)
            fields = {k2: (str(v) if v is not None else None) for k2, v in rec.items() if k2 in SCALAR}
            fields["_cell"] = f"{c}|{year}|{source}|{present}"
            fields["cluster_id"] = str(cid)
            json.dump(fields, open(os.path.join(d, "fields.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps({"courts": len(by_court), "chosen": len(chosen)}))


main()
