"""The transition parser's labels (LEGALPDF_TRANSITION_LABELS, one file per document, each line's first
piece) as one predictions file over the rows' pieces: a line's later pieces go on with its unit, and a
resumption's pointer (to the first line of the unit it resumes) points at that line's first piece.
python assemble_labels.py LABELS_DIR ROWS_JSONL OUT.jsonl"""
import json, os, sys
folder, rows, out = sys.argv[1:4]
with open(out, "w", encoding="utf-8") as f:
    for raw in open(rows, encoding="utf-8"):
        doc = json.loads(raw)
        path = os.path.join(folder, f"{doc['sha256']}.labels.json")
        if not os.path.exists(path):
            continue
        parsed = json.load(open(path, encoding="utf-8"))
        lines = [piece.partition("@")[0] for piece in parsed["ids"]]
        by_line = dict(zip(lines, parsed["labels"]))
        first_piece = {}
        for row, piece in enumerate(doc["ids"]):
            first_piece.setdefault(piece.partition("@")[0], row)
        labels = []
        for piece in doc["ids"]:
            line, _, offset = piece.partition("@")
            label = list(by_line.get(line, [0, 0, 0, 0, 0, 0, -1, 0]))
            if offset != "0":
                # A later piece goes on with its line's unit, and holds the line's paired marks that fall in it.
                label = [label[0], 0, 0, label[3], 0, 0, -1, 0]
            elif label[6] >= 0:
                label[6] = first_piece.get(lines[label[6]], -1)
                if label[6] < 0:
                    label[1] = 0
            labels.append(label)
        f.write(json.dumps({"sha256": doc["sha256"], "ids": doc["ids"], "labels": labels}) + "\n")
