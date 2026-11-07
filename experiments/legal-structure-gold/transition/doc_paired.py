"""Why a gold's paired reference marks are lost in DOC's reading: each line the gold pairs that the reading does not, by what
the line prints: figures run on from a word (a mark the parser reads), and whether a gold note of that number stands in
the document and is left over; or no such figures at all (recognition lost the mark).
python doc_paired.py GOLD_JSONL LABELS_DIR LINES_DIR"""
import collections, json, os, re, sys

gold_path, folder, dump = sys.argv[1:4]
tally, sample = collections.Counter(), {}
run_on = re.compile(r"[^\W\d_.,;:)\]”’»]?[\w.,;:)\]”’»](\d{1,3})(?:[\s.,;:)]|$)")
for raw in open(gold_path, encoding="utf-8"):
    doc = json.loads(raw)
    path = os.path.join(folder, f"{doc['sha256']}.labels.json")
    meta_path = os.path.join(dump, f"{doc['sha256']}.json")
    if not os.path.exists(path) or not os.path.exists(meta_path):
        continue
    read = json.load(open(path, encoding="utf-8"))
    gold = dict(zip(doc["ids"], doc["labels"]))
    lost = [k for k, (piece, label) in enumerate(zip(read["ids"], read["labels"])) if piece in gold and gold[piece][3] == 1 and label[3] == 0]
    if not lost:
        continue
    meta = json.load(open(meta_path, encoding="utf-8"))
    numbers = collections.Counter()
    for piece, text in zip(read["ids"], meta["texts"]):
        row = gold.get(piece)
        if row and row[0] in (5, 15) and row[1] == 1:
            numbers["".join(c for c in text.strip()[:6] if c.isdigit())] += 1
    for k in lost:
        text = meta["texts"][k]
        figures = [m.group(1) for m in run_on.finditer(text)]
        if not figures:
            kind = "no figures run on from a word: recognition lost the mark"
        elif any(f in numbers for f in figures):
            kind = "figures, a note of the number stands: more marks than notes or an order the search missed"
        else:
            kind = "figures, no gold note of that number: note unread or number misread"
        tally[kind] += 1
        sample.setdefault(kind, []).append((doc["sha256"][:12], read["ids"][k], text[-46:].encode("unicode_escape").decode()[:70], figures[:3]))
for kind, count in tally.most_common():
    print(count, kind)
    for item in sample[kind][:6]:
        print("   ", item)
