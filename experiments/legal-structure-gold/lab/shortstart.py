"""A candidate rule over the tagger's reading, measured in seconds: a text piece continuing a unit
(start 0) whose line and the line before are both short opens its own unit. Body and heading unit F1
per mode before and after, over thresholds.

  python shortstart.py ROWS_DIR PREDICTIONS.jsonl
"""
import collections
import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
R = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
     "marginal_note", "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
RI = {r: k for k, r in enumerate(R)}
BODY = {RI["text"], RI["provision"], RI["list_item"]}
CONTENTS, NOTE, TEXT = RI["contents"], RI["note"], RI["text"]
root, pred_path = sys.argv[1], sys.argv[2]
names = json.load(open(rf"{root}\features.json"))
LENGTH, RIGHT, PIECE_SHARE = names.index("length"), names.index("right_gap"), names.index("piece_share")
predicted = {}
for line in open(pred_path, encoding="utf-8"):
    d = json.loads(line)
    predicted[d["sha256"]] = dict(zip(d["ids"], d["labels"]))


def units(labels):
    out, open_ = [], None
    for k, lab in enumerate(labels):
        if lab is None or lab[0] == 0:
            continue
        r, s = lab[0], lab[1]
        if s != 0 or open_ is None or open_[0] != r:
            if open_:
                out.append(tuple(open_))
            open_ = [r, k, k]
        else:
            open_[2] = k
    if open_:
        out.append(tuple(open_))
    return out


docs = []
for line in open(rf"{root}\rows-development.jsonl", encoding="utf-8"):
    doc = json.loads(line)
    if doc["sha256"] not in predicted:
        continue
    own = predicted[doc["sha256"]]
    tagged = []
    for id_, lab0 in zip(doc["ids"], doc["tier0"]):
        lab = own.get(id_)
        tagged.append(list(lab0 if lab is None or lab0[0] in (CONTENTS, NOTE) or lab[0] == NOTE else lab))
    docs.append((doc.get("mode", "?"), doc["pages"], [t[0] for t in doc["text"]], doc["features"], doc["gold"], tagged))


def score(rule):
    tally = collections.defaultdict(lambda: [0, 0, 0])
    for mode, pages, texts, features, gold, tagged in docs:
        labels = [list(t) for t in tagged]
        if rule:
            for k in range(1, len(labels)):
                if labels[k][0] == TEXT and labels[k][1] == 0 and labels[k - 1][0] == TEXT and pages[k] == pages[k - 1] and rule(texts, features, k):
                    labels[k][1] = 1
        gu, pu = set(units(gold)), set(units(labels))
        for kind in ("body", "heading"):
            if kind == "body":
                g = {(-2, a, b) for r, a, b in gu if r in BODY}; p = {(-2, a, b) for r, a, b in pu if r in BODY}
            else:
                g = {u for u in gu if u[0] == RI["heading"]}; p = {u for u in pu if u[0] == RI["heading"]}
            for m in (mode, "all"):
                t = tally[(kind, m)]; t[0] += len(g); t[1] += len(p); t[2] += len(g & p)
    return tally


def show(name, tally):
    cells = []
    for kind in ("body", "heading"):
        for m in ("all", "digitalborn", "ocr"):
            e, p, c = tally[(kind, m)]
            cells.append(f"{2 * c / max(e + p, 1):.3f}")
    print(f"  {name:44} body all/dig/ocr {cells[0]} {cells[1]} {cells[2]}   heading {cells[3]} {cells[4]} {cells[5]}")


print("rule: a text piece inside a unit opens its own when its line and the line before are both short")
show("tagger as is", score(None))
for chars in (25, 32, 40, 50):
    show(f"both < {chars} chars", score(lambda texts, f, k, c=chars: len(texts[k].strip()) < c and len(texts[k - 1].strip()) < c))
for chars in (32, 40):
    show(f"both < {chars} chars, whole pieces", score(lambda texts, f, k, c=chars: len(texts[k].strip()) < c and len(texts[k - 1].strip()) < c and f[k][PIECE_SHARE] >= 0.99 and f[k - 1][PIECE_SHARE] >= 0.99))
for gap in (0.3, 0.4, 0.5):
    show(f"both right_gap > {gap}", score(lambda texts, f, k, g=gap: f[k][RIGHT] > g and f[k - 1][RIGHT] > g))
    show(f"right_gap > {gap} before, line ends short too", score(lambda texts, f, k, g=gap: f[k - 1][RIGHT] > g and f[k][RIGHT] > g and not texts[k - 1].rstrip().endswith((',', '-'))))
