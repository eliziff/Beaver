"""Two fresh stratified samples of substantial opinions, by one pass over the opinions dump.

    python -I sample_stream.py OPINIONS.csv.bz2 RUN_DIR PACK_IDS OUT_DIR [SIZE] [THREADS] [FIRST]

A stratum is a court and a year, its size the opinions in it of MIN_CHARS or more that the pack in PACK_IDS (kept.tsv) does
not hold, from RUN_DIR/cells.json. Each stratum draws in proportion to the root of its size, at least one, so a small
court's years stay in the sample and a large one still weighs more. An opinion falls in sample 1 or sample 2 by a fixed hash
of its id, so a rerun picks the same ones. Writes OUT_DIR/s1.jsonl and s2.jsonl in pack_kept.py's form, and strata.json with
each stratum's size and rate, whose inverse is an opinion's weight when a count is carried back to the whole table.
"""
import csv
import io
import json
import math
import os
import sys
import time
import indexed_bzip2
import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.csv as pcsv

MIN_CHARS = 2000
RENDS = {"plain_text": "txt", "html": "html", "html_lawbox": "html", "html_columbia": "html",
         "html_anon_2020": "html", "xml_harvard": "xml", "xml_scan": "xml", "html_with_citations": "html"}
csv.field_size_limit(2**31 - 1)
dump, run, pack_ids, out = sys.argv[1:5]
size = int(sys.argv[5]) if len(sys.argv) > 5 else 100_000
threads = int(sys.argv[6]) if len(sys.argv) > 6 else 8
first = int(sys.argv[7]) if len(sys.argv) > 7 else 0


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


z = np.load(os.path.join(run, "map.npz"), allow_pickle=True)
courts, court, year = list(z["courts"]), z["court"], z["year"]
index = {name: at for at, name in enumerate(courts)}
strata = {}
for key, cell in json.load(open(os.path.join(run, "cells.json"), encoding="utf-8"))["cells"].items():
    name, when = key.split("|")[:2]
    stratum = index.get(name, 0) * 10000 + int(when)
    strata[stratum] = strata.get(stratum, 0) + cell["opinions"] - cell["stubs"] - cell["kept"]
strata = {key: n for key, n in strata.items() if n > 0}
total_root = sum(math.sqrt(n) for n in strata.values())
scale = size / total_root
rates = {key: min(0.5, max(1, scale * math.sqrt(n)) / n) for key, n in strata.items()}
json.dump({"size": size, "strata": {f"{courts[key // 10000]}|{key % 10000}": [strata[key], rates[key]] for key in strata}},
          open(os.path.join(out, "strata.json"), "w", encoding="utf-8"))
log(f"strata {len(strata)} eligible {sum(strata.values())} expected {sum(strata[key] * rates[key] for key in strata):.0f}")
keys = np.array(sorted(rates), np.int64)
values = np.array([rates[key] for key in keys])
held = set()
with open(pack_ids, encoding="utf-8") as ids:
    for row in ids:
        held.add(row.split("\t", 1)[0])
head = next(csv.reader(io.TextIOWrapper(indexed_bzip2.open(dump, parallelization=1), encoding="utf-8", newline=""), escapechar="\\", doublequote=False))
reader = pcsv.open_csv(indexed_bzip2.open(dump, parallelization=threads),
                       read_options=pcsv.ReadOptions(block_size=64 << 20, use_threads=True),
                       parse_options=pcsv.ParseOptions(escape_char="\\", double_quote=False, newlines_in_values=True, invalid_row_handler=lambda row: "skip"),
                       convert_options=pcsv.ConvertOptions(column_types={h: pa.string() for h in head}, strings_can_be_null=True, quoted_strings_can_be_null=False, check_utf8=False))
rend_names = [x for x in RENDS if x in head]
files = [open(os.path.join(out, name), "w", encoding="utf-8", newline="\n") for name in (f"s{first + 1}.jsonl", f"s{first + 2}.jsonl")]
t0 = last = time.time()
seen = 0
written = [0, 0]
for batch in reader:
    cid = pc.fill_null(pc.cast(batch.column("cluster_id"), pa.int64(), safe=False), 0).to_numpy(zero_copy_only=False)
    oid = pc.fill_null(pc.cast(batch.column("id"), pa.int64(), safe=False), 0).to_numpy(zero_copy_only=False)
    longest = np.stack([pc.fill_null(pc.utf8_length(batch.column(x)), 0).to_numpy(zero_copy_only=False) for x in rend_names], axis=1).max(axis=1)
    inside = cid < len(court)
    safe = np.where(inside, cid, 0)
    stratum = np.where(inside, court[safe].astype(np.int64) * 10000 + year[safe].astype(np.int64), 0)
    at = np.minimum(np.searchsorted(keys, stratum), len(keys) - 1)
    rate = np.where(keys[at] == stratum, values[at], 0.0)
    draw = ((oid.astype(np.uint64) * np.uint64(2654435761)) % np.uint64(1 << 32)).astype(np.float64) / (1 << 32)
    picked = np.nonzero((longest >= MIN_CHARS) & (draw >= rate * first) & (draw < rate * (first + 2)))[0]
    for i in picked:
        row = batch.slice(int(i), 1).to_pylist()[0]
        if row["id"] in held:
            continue
        have = [x for x in rend_names if row.get(x)]
        record = {name: row[name] for name in have}
        named = {f"{x}.{RENDS[x]}": record[x] for x in have}
        named["fields.json"] = json.dumps({h: v for h, v in row.items() if h not in RENDS} | {"_stratum": f"{courts[int(stratum[i]) // 10000]}|{int(stratum[i]) % 10000}", "_rate": float(rate[i])})
        which = 0 if draw[i] < rate[i] * (first + 1) else 1
        files[which].write(json.dumps({"id": row["id"], "files": named}, ensure_ascii=False) + "\n")
        written[which] += 1
    seen += batch.num_rows
    if time.time() - last > 60:
        for f in files:
            f.flush()
        log(f"rows {seen} written {written} ({seen / (time.time() - t0):.0f} rows/s)")
        last = time.time()
for f in files:
    f.close()
log(f"done rows {seen} written {written}")
