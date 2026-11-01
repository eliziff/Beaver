"""The gold's per-piece labels from the rows export, in the grader's predictions format, for the transition
parser's oracle (LEGALPDF_TRANSITION_GOLD); a piece without gold is all -1. A gold that does not say a
heading's level or a body unit's depth (label source a2aj-align: A2AJ's tree is not the print's) has those
columns -1, unknown, not 0; and its body text, where it leaves a quotation or a list item set in it unmarked, region
101 (UNMARKED_BODY: text, a quotation or a list item, the oracle's to choose).
python gold_labels.py OUT.jsonl GOLD_STORE ROWS_JSONL [ROWS_JSONL...]"""
import json, os, sys
out, store, sources = sys.argv[1], sys.argv[2], sys.argv[3:]
LEVELLESS = {"a2aj-align"}
UNMARKED_BODY = 101


def label_source(sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8")).get("label_source")
    except (OSError, ValueError):
        return None


with open(out, "w", encoding="utf-8") as f:
    for src in sources:
        for raw in open(src, encoding="utf-8"):
            doc = json.loads(raw)
            levelless = label_source(doc["sha256"]) in LEVELLESS
            labels = []
            for g in doc["gold"]:
                label = list(g) if g is not None else [-1] * 8
                if levelless and g is not None:
                    label[4] = -1
                    label[7] = -1
                    if label[0] == 1:
                        label[0] = UNMARKED_BODY
                labels.append(label)
            f.write(json.dumps({"sha256": doc["sha256"], "ids": doc["ids"], "labels": labels}) + "\n")
