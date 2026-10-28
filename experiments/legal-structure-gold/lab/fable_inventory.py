"""The crop preparation's inventory rows from the gold audit's artifacts: each v4 gold file as a
line transcript with its partition from the cohort manifests and its path as the origin locator,
without packing any archive.

  python fable_inventory.py ARTIFACTS_JSONL_GZ CONFIG_JSON OUT_JSONL_GZ
"""
import gzip
import json
import sys

artifacts, config_path, out = sys.argv[1:4]
config = json.load(open(config_path, encoding="utf-8"))
partition = {}
for path in config["manifests"]:
    for row in json.load(open(path, encoding="utf-8"))["documents"]:
        if row.get("split"):
            partition[row["sha256"]] = row["split"]
written = skipped = 0
with gzip.open(out, "wt", encoding="utf-8") as sink:
    for line in gzip.open(artifacts, "rt", encoding="utf-8"):
        row = json.loads(line)
        split = partition.get(row["source_sha256"])
        if not split:
            skipped += 1
            continue
        sink.write(json.dumps({
            "artifact_sha256": row["sha256"], "source_sha256": row["source_sha256"], "collection": row["owner"],
            "kind": "line_transcript", "partition": split, "mode": row.get("mode"),
            "notes": {"origin_path": row["path"], "origin_owner": row["owner"]},
        }) + "\n")
        written += 1
print(f"{written} line transcripts written, {skipped} without a split -> {out}")
