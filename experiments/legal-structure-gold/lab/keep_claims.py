"""The tagger's development predictions with tier 0's contents and table claims kept: a piece the
parser read as a contents line or a table cell keeps that region and start under the model, as the
hybrid keeps its notes. Writes predictions-development-gru-keep.jsonl beside the input.

  python keep_claims.py ROWS_DIR PREDICTIONS_JSONL
"""
import json
import sys

rows_dir, predictions = sys.argv[1], sys.argv[2]
tier0 = {}
for line in open(rf"{rows_dir}\rows-development.jsonl", encoding="utf-8"):
    doc = json.loads(line)
    tier0[doc["sha256"]] = dict(zip(doc["ids"], doc["tier0"]))
out = predictions.replace("gru.jsonl", "gru-keep.jsonl")
kept = changed = 0
with open(out, "w", encoding="utf-8") as sink:
    for line in open(predictions, encoding="utf-8"):
        row = json.loads(line)
        labels = row["labels"]
        t0 = tier0.get(row["sha256"], {})
        for k, piece_id in enumerate(row["ids"]):
            base = t0.get(piece_id)
            if base is None:
                continue
            if base[0] == 7:
                if labels[k][0] != base[0] or labels[k][1] != base[1]:
                    changed += 1
                labels[k][0], labels[k][1] = base[0], base[1]
                kept += 1
        sink.write(json.dumps(row) + "\n")
print(f"{kept} pieces kept as the parser's contents lines ({changed} changed) -> {out}")
