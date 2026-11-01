"""The A2AJ alignment's readings of its PDFs (run.py read: the product's reading, extraction and recognition,
WORK/read/<sha>.json) as the structure gold's inputs (gold_structure_inputs' ExtractedPdf, <sha>.json.gz):
the same pages the A2AJ gold was aligned to, so nothing is extracted twice. For every source of label source
a2aj-align in the store with a reading and no input yet (SKIP lists those the inputs folder already holds),
gzips the reading into OUT_DIR; at most LIMIT of them.
python readings_to_inputs.py STORE READ_DIR OUT_DIR SKIP_LIST [LIMIT]"""
import gzip, json, os, shutil, sys
store, read_dir, out, skip_path = sys.argv[1:5]
limit = int(sys.argv[5]) if len(sys.argv) > 5 else None
skip = set(open(skip_path, encoding="utf-8").read().split())
os.makedirs(out, exist_ok=True)
done = missing = 0
for sha in sorted(os.listdir(store)):
    try:
        source = json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))
    except (OSError, ValueError):
        continue
    if source.get("label_source") != "a2aj-align" or f"{sha}.json.gz" in skip:
        continue
    reading = os.path.join(read_dir, f"{sha}.json")
    if not os.path.exists(reading):
        missing += 1
        continue
    with open(reading, "rb") as src, gzip.open(os.path.join(out, f"{sha}.json.gz"), "wb", compresslevel=6) as dst:
        shutil.copyfileobj(src, dst)
    done += 1
    if limit and done >= limit:
        break
print(f"{done} readings staged as inputs, {missing} a2aj-align sources without a reading")
