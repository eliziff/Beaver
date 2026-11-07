"""The gold's rows and DOC's reading of them around lines of a document, with each line's text.
python doc_roundtrip_at.py GOLD_JSONL LABELS_DIR LINES_DIR SHA-PREFIX PIECE [PIECE ...]"""
import glob, json, os, sys

gold_path, folder, dump, prefix = sys.argv[1:5]
path = glob.glob(os.path.join(folder, prefix + "*.labels.json"))[0]
read = json.load(open(path, encoding="utf-8"))
sha = read["sha256"]
gold = next(json.loads(raw) for raw in open(gold_path, encoding="utf-8") if raw.startswith('{"sha256": "' + sha))
texts = json.load(open(os.path.join(dump, sha + ".json"), encoding="utf-8"))["texts"]
wanted = dict(zip(gold["ids"], gold["labels"]))
for piece in sys.argv[5:]:
    at = read["ids"].index(piece)
    print("--", prefix, piece)
    for k in range(max(at - 4, 0), min(at + 5, len(read["ids"]))):
        id_ = read["ids"][k]
        print(k, id_, "G", wanted.get(id_), "R", read["labels"][k], texts[k][:44].encode("ascii", "replace").decode())
