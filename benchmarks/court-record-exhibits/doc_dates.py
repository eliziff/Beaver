"""Document-date framing: every date mention in an exhibit file is a candidate for the file's date.

Usage: python doc_dates.py candidates <out.jsonl>   one line per (file, candidate) with context and label
       python doc_dates.py oracle                   ceiling of one-entry-per-document chronologies

A candidate is positive when its date matches (score.date_ok) a dated gold
event that cites the file. The chronology built from one entry per document
can only score what these candidates allow, so the oracle bounds every
document-date model.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score
from audit import DATES, iso_dates
from baseline import ROOT

WINDOW = 160


def file_text(rid, name):
    t = open(os.path.join(ROOT, rid, "files", name.replace(".pdf", ".txt")), encoding="utf-8").read()
    return re.sub(r"\[page \d+\]", "", t)


def candidates(text):
    """(start, end, iso) for every date mention, in reading order; ambiguous numeric dates give both readings."""
    seen = set()
    for rx in DATES:
        for m in rx.finditer(text):
            for d in sorted(iso_dates(m.group(0))):
                if (m.start(), d) not in seen:
                    seen.add((m.start(), d))
                    yield m.start(), m.end(), d


def records():
    for rid in sorted(os.listdir(ROOT)):
        if os.path.exists(os.path.join(ROOT, rid, "gold.json")):
            yield rid, score.gold(rid)


def file_events(g):
    files = {e["label"]: e["file"] for e in g["exhibits"]}
    out = {f: [] for f in files.values()}
    for ev in g["events"]:
        if ev["precision"] != "undated":
            for l in ev["exhibits"]:
                if l in files:
                    out[files[l]].append(ev)
    return out


def dump(path):
    n = pos = 0
    with open(path, "w", encoding="utf-8") as f:
        for rid, g in records():
            evs = file_events(g)
            for name, events in evs.items():
                text = file_text(rid, name)
                for i, (a, b, d) in enumerate(candidates(text)):
                    label = any(score.date_ok(d, ev) for ev in events)
                    f.write(json.dumps({"record": rid, "file": name, "i": i, "start": a, "chars": len(text), "date": d,
                                        "mention": text[a:b], "left": text[max(0, a - WINDOW):a], "right": text[b:b + WINDOW],
                                        "head": text[:600], "label": label, "file_has_event": bool(events)}, ensure_ascii=False) + "\n")
                    n += 1; pos += label
    print(f"{n} candidates, {pos} positive")


def oracle():
    """Ceiling: each file gets a matching candidate date when it has one; undated files are left out."""
    stats = {"files": 0, "cited": 0, "reachable": 0, "reachable_head": 0, "no_dates": 0}
    preds = {}
    for rid, g in records():
        rows = []
        for name, events in file_events(g).items():
            text = file_text(rid, name)
            cands = list(candidates(text))
            stats["files"] += 1; stats["cited"] += bool(events); stats["no_dates"] += not cands
            hit = next((d for _, _, d in cands if any(score.date_ok(d, ev) for ev in events)), None)
            stats["reachable"] += hit is not None
            stats["reachable_head"] += any(a < 1500 and any(score.date_ok(d, ev) for ev in events) for a, _, d in cands)
            if hit:
                rows.append({"date": hit, "description": "", "files": [name]})
        preds[rid] = rows
    print(stats)
    score.chronology(preds, False)
    # Selection ceiling: every candidate that matches an event citing its file, one row per (file, date).
    preds = {}
    for rid, g in records():
        rows = []
        for name, events in file_events(g).items():
            dates = {d for _, _, d in candidates(file_text(rid, name))}
            rows += [{"date": d, "description": "", "files": [name]} for d in sorted(dates) if any(score.date_ok(d, ev) for ev in events)]
        preds[rid] = rows
    score.chronology(preds, False)


if __name__ == "__main__":
    {"candidates": lambda: dump(sys.argv[2]), "oracle": oracle}[sys.argv[1]]()
