"""One file of the kept records, for passes over them: the folders sit on a hard disk, a seek apiece.

    python -I pack_kept.py KEPT_DIR OUT.jsonl [--workers 32] ID_FILE...

Packs the ids of each ID_FILE in turn (one id per line, or a tab after it, as kept.tsv), one JSON line per record:
{"id", "files": {name: text}}, fields.json among them as text. Many readers at once let the disk's queue order the
seeks: 11 records/s with 12 against 1.5/s with one. A rerun appends after the ids already in OUT.
"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor

p = argparse.ArgumentParser()
p.add_argument("kept")
p.add_argument("out")
p.add_argument("ids", nargs="+")
p.add_argument("--workers", type=int, default=32)
a = p.parse_args()
done = set()
if os.path.exists(a.out):
    with open(a.out, encoding="utf-8") as lines:
        for line in lines:
            if line.endswith("\n"):  # a line cut short by a stop is packed again
                done.add(line[8:line.index('"', 8)])  # {"id": "NNN", ...


def wanted():
    for name in a.ids:
        with open(name, encoding="utf-8") as ids:
            for row in ids:
                folder = row.split("\t", 1)[0].strip()
                if folder and folder not in done:
                    done.add(folder)
                    yield folder


def read(folder):
    try:
        files = {}
        for entry in os.scandir(os.path.join(a.kept, folder)):
            with open(entry.path, "rb") as f:
                files[entry.name] = f.read().decode("utf-8", "replace")
        return json.dumps({"id": folder, "files": files}, ensure_ascii=False)
    except OSError as error:
        print(json.dumps({"skip": folder, "error": str(error)}), flush=True)
        return None


t0 = time.time()
n = 0
with open(a.out, "a", encoding="utf-8", newline="\n") as w, ThreadPoolExecutor(a.workers) as pool:
    pending = []
    for folder in wanted():
        pending.append(folder)
        if len(pending) == a.workers * 8:
            for line in pool.map(read, pending):
                if line:
                    w.write(line + "\n")
                    n += 1
            pending = []
            w.flush()
            print(json.dumps({"packed": n, "seconds": round(time.time() - t0)}), flush=True)
    for line in pool.map(read, pending):
        if line:
            w.write(line + "\n")
            n += 1
print(json.dumps({"packed": n, "seconds": round(time.time() - t0), "done": True}), flush=True)
