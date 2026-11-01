"""The gold authoring's own extractions (the parser export's cache, WORK/parsed/<sha>/.../parse-v1/extractions/
*.json.gz: {schema_version, source_sha256, cache_key, extraction}) as the structure gold's inputs
(<sha>.json.gz, the extraction alone): the pages each gold was authored on, so nothing is extracted twice. For
every source in the store with a gold, an extraction of its own PDF and no input yet.
python parsed_to_inputs.py STORE PARSED_DIR INPUTS_DIR"""
import glob, gzip, json, os, sys
store, parsed, inputs = sys.argv[1:4]
have = set(os.listdir(inputs))
done = skipped = 0
for sha in sorted(os.listdir(parsed)):
    if f"{sha}.json.gz" in have or not glob.glob(os.path.join(store, sha, "structure", "*", "gold.json.gz")):
        skipped += 1
        continue
    found = sorted(glob.glob(os.path.join(parsed, sha, "**", "parse-v1", "extractions", "*.json.gz"), recursive=True), key=os.path.getmtime)
    for path in reversed(found):
        cached = json.load(gzip.open(path, "rt", encoding="utf-8"))
        if cached.get("source_sha256") == sha and "pages" in cached.get("extraction", {}):
            with gzip.open(os.path.join(inputs, f"{sha}.json.gz"), "wt", encoding="utf-8") as out:
                json.dump(cached["extraction"], out)
            done += 1
            break
print(f"{done} extractions written as inputs, {skipped} skipped (an input already, or no gold)")
