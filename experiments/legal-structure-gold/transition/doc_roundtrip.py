"""The gold's labels against what DOC's decoding made of them (LEGALPDF_TRANSITION_DOC_ORACLE with
LEGALPDF_TRANSITION_LABELS), line by line: each column's lines that differ, the commonest (gold, read) pairs of each,
documents wholly held, and a line of each pair to look at. A cell the gold leaves unknown (-1) is not compared; its
unmarked body (101) is text.
python doc_roundtrip.py GOLD_JSONL LABELS_DIR"""
import collections, json, os, sys

COLUMNS = ["region", "start", "document", "paired", "level_step", "marked", "pointer", "depth_step"]
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
gold_path, folder = sys.argv[1:3]
differ, pairs, sample = collections.Counter(), collections.Counter(), {}
lines = documents = held = missing = split_pieces = 0
for raw in open(gold_path, encoding="utf-8"):
    doc = json.loads(raw)
    path = os.path.join(folder, f"{doc['sha256']}.labels.json")
    if not os.path.exists(path):
        missing += 1
        continue
    read = json.load(open(path, encoding="utf-8"))
    gold = dict(zip(doc["ids"], doc["labels"]))
    place = {piece.split("@")[0]: k for k, piece in enumerate(read["ids"])}
    documents += 1
    clean = True
    split_pieces += sum(not piece.endswith("@0") for piece in doc["ids"])
    for piece, label in zip(read["ids"], read["labels"]):
        want = gold.get(piece)
        if want is None:
            continue
        lines += 1
        for at, name in enumerate(COLUMNS):
            expected = 1 if at == 0 and want[at] == 101 else want[at]
            if at == 6 and expected >= 0:
                # A row's pointer counts the gold's pieces; a reading's, its lines.
                expected = place.get(doc["ids"][expected].split("@")[0], -1)
            if expected < 0 and at != 6:
                continue
            if expected != label[at]:
                region = REGIONS[max(1 if want[0] == 101 else want[0], 0)]
                key = (name, region, expected if at != 6 else expected >= 0, label[at] if at != 6 else label[at] >= 0)
                differ[name] += 1
                pairs[key] += 1
                sample.setdefault(key, (doc["sha256"][:12], piece))
                clean = False
    held += clean
print(f"{documents} documents ({missing} without labels), {held} wholly held, {lines} lines compared, {split_pieces} pieces past a line's first")
for name in COLUMNS:
    print(f"{name:12} {differ[name]:8} differ ({differ[name] / max(lines, 1):.4%})")
for key, count in pairs.most_common(60):
    print(count, key, sample[key])
