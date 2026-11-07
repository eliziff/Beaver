"""One pass over CourtListener's opinions dump that keeps the first substantial opinions of every cell.

    python -I cell_stream.py BULK_DIR OUT_DIR [PER_CELL] [MIN_CHARS] [THREADS]

A cell is court x year x cluster source x which renditions the opinion has. The cluster -> (court,
year, source) map is built from the clusters and dockets dumps themselves (BULK_DIR/*-2026-09-30.csv.bz2,
cached in OUT_DIR/map.npz), so no database is needed. The opinions dump is then decoded once (parallel
bzip2) and parsed with the dump's own CSV conventions. An opinion whose longest rendition has fewer than
MIN_CHARS characters is a stub: counted, never kept. Otherwise it is kept while its cell holds fewer than
PER_CELL, written as sample_head.py writes opinions (OUT_DIR/kept/<id>/<rendition>.<ext> and fields.json,
with the cell in "_cell"). OUT_DIR/cells.json (opinions, stubs, kept per cell) is checkpointed every minute;
a rerun decodes from the start again but keeps no opinion twice.
"""
import csv
import io
import json
import os
import sys
import time
import indexed_bzip2
import numpy as np

DATE = "2026-09-30"
RENDS = {"plain_text": "txt", "html": "html", "html_lawbox": "html", "html_columbia": "html",
         "html_anon_2020": "html", "xml_harvard": "xml", "xml_scan": "xml", "html_with_citations": "html"}
csv.field_size_limit(2**31 - 1)


def rows(path, threads):
    f = indexed_bzip2.open(path, parallelization=threads)
    r = csv.reader(io.TextIOWrapper(f, encoding="utf-8", newline="", errors="replace"), escapechar="\\", doublequote=False)
    head = next(r)
    return {h: i for i, h in enumerate(head)}, len(head), r


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def build_map(bulk, out, threads):
    path = os.path.join(out, "map.npz")
    if os.path.exists(path):
        z = np.load(path, allow_pickle=True)
        return list(z["courts"]), list(z["sources"]), z["court"], z["year"], z["src"]
    col, width, r = rows(os.path.join(bulk, f"opinion-clusters-{DATE}.csv.bz2"), threads)
    ids, dockets, years, srcs, sources = [], [], [], [], {}
    for n, rec in enumerate(r, 1):
        if len(rec) != width:
            continue
        ids.append(int(rec[col["id"]])); dockets.append(int(rec[col["docket_id"]] or 0))
        years.append(int((rec[col["date_filed"]] or "0")[:4] or 0)); srcs.append(sources.setdefault(rec[col["source"]], len(sources) + 1))
        if n % 2_000_000 == 0:
            log(f"clusters {n}")
    ids, dockets = np.array(ids, np.int64), np.array(dockets, np.int64)
    log(f"clusters {len(ids)}")
    need = np.zeros(int(dockets.max()) + 1, bool); need[dockets] = True
    docket_court = np.zeros(len(need), np.uint16); courts = {}
    col, width, r = rows(os.path.join(bulk, f"dockets-{DATE}.csv.bz2"), threads)
    for n, rec in enumerate(r, 1):
        if len(rec) != width:
            continue
        d = int(rec[col["id"]])
        if d < len(need) and need[d]:
            docket_court[d] = courts.setdefault(rec[col["court_id"]], len(courts) + 1)
        if n % 10_000_000 == 0:
            log(f"dockets {n}")
    size = int(ids.max()) + 1
    court = np.zeros(size, np.uint16); year = np.zeros(size, np.uint16); src = np.zeros(size, np.uint8)
    court[ids] = docket_court[dockets]; year[ids] = np.array(years, np.uint16); src[ids] = np.array(srcs, np.uint8)
    court_names = ["?"] + sorted(courts, key=courts.get); source_names = ["?"] + sorted(sources, key=sources.get)
    np.savez(path, courts=np.array(court_names, object), sources=np.array(source_names, object), court=court, year=year, src=src)
    log(f"map: {len(court_names) - 1} courts, {len(source_names) - 1} sources")
    return court_names, source_names, court, year, src


def main():
    bulk, out = sys.argv[1], sys.argv[2]
    per_cell = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    min_chars = int(sys.argv[4]) if len(sys.argv) > 4 else 2000
    threads = int(sys.argv[5]) if len(sys.argv) > 5 else 4
    kept_dir = os.path.join(out, "kept")
    os.makedirs(kept_dir, exist_ok=True)
    courts, sources, court, year, src = build_map(bulk, out, threads)
    state_path = os.path.join(out, "cells.json")
    already = set(os.listdir(kept_dir))
    cells = {}
    # The opinions dump through PyArrow's C++ CSV reader (the dump's conventions: backslash escapes, no doubled
    # quotes, newlines inside values; every column read as text, an unquoted empty field as null). Per batch the
    # cell, rendition presence and longest rendition are column operations; only kept opinions become Python rows.
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.csv as pcsv
    path = os.path.join(bulk, f"opinions-{DATE}.csv.bz2")
    head = next(csv.reader(io.TextIOWrapper(indexed_bzip2.open(path, parallelization=1), encoding="utf-8", newline=""), escapechar="\\", doublequote=False))
    reader = pcsv.open_csv(indexed_bzip2.open(path, parallelization=threads),
                           read_options=pcsv.ReadOptions(block_size=64 << 20, use_threads=True),
                           parse_options=pcsv.ParseOptions(escape_char="\\", double_quote=False, newlines_in_values=True,
                                                           invalid_row_handler=lambda row: "skip"),
                           convert_options=pcsv.ConvertOptions(column_types={h: pa.string() for h in head}, strings_can_be_null=True,
                                                               quoted_strings_can_be_null=False, check_utf8=False))
    rend_names = [x for x in RENDS if x in head]
    index = open(os.path.join(out, "kept.tsv"), "w", encoding="utf-8")  # id <tab> cell of every kept opinion, this pass
    t0 = last = time.time(); n = 0
    for batch in reader:
        size = batch.num_rows
        cid = pc.fill_null(pc.cast(batch.column("cluster_id"), pa.int64(), safe=False), 0).to_numpy(zero_copy_only=False)
        lens = np.stack([pc.fill_null(pc.utf8_length(batch.column(x)), 0).to_numpy(zero_copy_only=False) for x in rend_names], axis=1)
        inside = cid < len(court)
        safe = np.where(inside, cid, 0)
        crt, yr, sr = np.where(inside, court[safe], 0), np.where(inside, year[safe], 0), np.where(inside, src[safe], 0)
        longest = lens.max(axis=1)
        ids = batch.column("id")
        for i in range(size):
            have = [x for x, l in zip(rend_names, lens[i]) if l > 0]
            key = f"{courts[crt[i]]}|{int(yr[i])}|{sources[sr[i]]}|{'+'.join(have) or 'none'}"
            cell = cells.get(key)
            if cell is None:
                cell = cells[key] = {"opinions": 0, "stubs": 0, "kept": 0}
            cell["opinions"] += 1
            if longest[i] < min_chars:
                cell["stubs"] += 1
            elif cell["kept"] < per_cell:
                cell["kept"] += 1
                oid = ids[i].as_py()
                index.write(f"{oid}\t{key}\n")
                if oid not in already:
                    row = batch.slice(i, 1).to_pylist()[0]
                    d = os.path.join(kept_dir, oid)
                    os.makedirs(d, exist_ok=True)
                    for x in have:
                        with open(os.path.join(d, f"{x}.{RENDS[x]}"), "w", encoding="utf-8", newline="") as w:
                            w.write(row[x])
                    fields = {h: v for h, v in row.items() if h not in RENDS} | {"_cell": key}
                    with open(os.path.join(d, "fields.json"), "w", encoding="utf-8") as w:
                        json.dump(fields, w, indent=1)
        n += size
        if time.time() - last > 60:
            index.flush()
            json.dump({"rows": n, "done": False, "cells": cells}, open(state_path + ".tmp", "w", encoding="utf-8")); os.replace(state_path + ".tmp", state_path)
            log(f"rows {n} cells {len(cells)} kept {sum(v['kept'] for v in cells.values())} ({n / (time.time() - t0):.0f} rows/s)")
            last = time.time()
    index.close()
    json.dump({"rows": n, "done": True, "cells": cells}, open(state_path + ".tmp", "w", encoding="utf-8")); os.replace(state_path + ".tmp", state_path)
    log(f"done: rows {n} cells {len(cells)} kept {sum(v['kept'] for v in cells.values())}")


main()
