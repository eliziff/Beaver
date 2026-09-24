"""Score predictions against gold records.

  python score.py exhibits <predictions.json>
      {"<record_id>": {"doc-xxxxxx.pdf": "B", ...}, ...}
      Task: given affidavit.pdf and the unlabeled files/, assign each file its
      exhibit label (the Court Records builder task). Score = files labelled
      correctly / files.

  python score.py chronology <predictions.json> [--with-affidavit]
      {"<record_id>": [{"date": "2023-03-14", "description": "...", "files": ["doc-xxxxxx.pdf"]}, ...]}
      Task: build a chronology from files/ alone (default: gold = events that
      cite an exhibit) or from files/ plus affidavit.pdf (--with-affidavit:
      gold = every event). A predicted row matches an unmatched gold event
      when its date agrees at the gold precision and it either cites one of
      the event's exhibit files or shares >= 30% of the event's content words.

Each record id resolves under the records root
(%LOCALAPPDATA%/OpenLegalData/benchmarks/court-record-exhibits/records).
"""
import json, os, re, sys

ROOT = os.path.join(os.environ.get("LOCALAPPDATA", ""), "OpenLegalData", "benchmarks", "court-record-exhibits", "records")
STOP = set("the a an of to and in on for by with at from as was were is be that this his her their its or which who had has have i my me we our".split())


def gold(record):
    return json.load(open(os.path.join(ROOT, record, "gold.json"), encoding="utf-8"))


def words(t):
    return {w for w in re.findall(r"[a-z0-9]+", t.lower()) if w not in STOP and len(w) > 2}


def date_ok(pred, event):
    d = (pred or "")[:10]
    if event["precision"] == "undated":
        return True
    lo, hi = event["date"], event.get("end_date") or event["date"]
    if event["precision"] in ("range", "approximate"):
        return bool(d) and lo[:len(d)] <= d[:len(lo)] <= hi + "~"
    return d[:len(lo)] == lo


def exhibits(preds):
    total = right = 0
    for rid, mapping in preds.items():
        g = {e["file"]: e["label"] for e in gold(rid)["exhibits"]}
        total += len(g)
        right += sum(mapping.get(f) == lab for f, lab in g.items())
        print(f"{rid}: {sum(mapping.get(f) == lab for f, lab in g.items())}/{len(g)}")
    print(f"exhibit assignment accuracy {right}/{total} = {right / max(total, 1):.3f}")


def chronology(preds, with_affidavit):
    tp = fp = fn = 0
    for rid, rows in preds.items():
        g = gold(rid)
        files = {e["label"]: e["file"] for e in g["exhibits"]}
        events = [e for e in g["events"] if with_affidavit or e["exhibits"]]
        # Files-only runs may also find events the affidavit never ties to a
        # file; those rows are neither credited nor penalized.
        unmatched, neutral = list(g["events"]), 0
        hit = 0
        for row in rows:
            match = None
            for ev in unmatched:
                if not date_ok(row.get("date"), ev):
                    continue
                cited = {files[l] for l in ev["exhibits"]} & set(row.get("files", []))
                gw = words(ev["description"])
                if cited or (gw and len(gw & words(row.get("description", ""))) / len(gw) >= 0.3):
                    match = ev
                    break
            if match:
                unmatched.remove(match)
                if match in events:
                    hit += 1
                else:
                    neutral += 1
        tp += hit; fp += len(rows) - hit - neutral; fn += sum(e in events for e in unmatched)
        print(f"{rid}: {hit}/{len(events)} events found, {len(rows) - hit - neutral} unmatched rows")
    p, r = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    print(f"chronology precision {p:.3f} recall {r:.3f} F1 {2 * p * r / max(p + r, 1e-9):.3f}")


def manifest(record):
    return json.load(open(os.path.join(os.path.dirname(ROOT), "haystack", record, "manifest.json"), encoding="utf-8"))["files"]


def haystack_exhibits(preds):
    """preds: {record: {label: haystack_file}}; the folder also holds distractors."""
    total = right = decoys = 0
    for rid, picks in preds.items():
        files = {e["file"]: e for e in manifest(rid)}
        labels = {e["label"] for e in files.values() if e["role"] == "exhibit"}
        total += len(labels)
        right += sum(files.get(picks.get(l), {}).get("label") == l for l in labels)
        decoys += sum(files.get(f, {}).get("role", "exhibit") != "exhibit" for f in picks.values())
    print(f"haystack exhibit identification {right}/{total} = {right / max(total, 1):.3f}; distractors picked {decoys}")


def haystack_chronology(preds, with_affidavit):
    """Rows cite haystack file names. Rows citing only other-matter, corpus or synthetic
    files are false positives; rows citing only same-matter or sibling documents
    (same proceeding, another application) are neutral."""
    mapped, distractor_rows, neutral_rows = {}, 0, 0
    for rid, rows in preds.items():
        files = {e["file"]: e for e in manifest(rid)}
        keep = []
        for row in rows:
            roles = {files.get(f, {}).get("role") for f in row.get("files", [])}
            if roles and roles <= {"other_matter", "corpus", "synthetic"}:
                distractor_rows += 1
                keep.append({**row, "files": [], "description": "\x00distractor"})  # cannot match gold
            elif roles and roles <= {"same_matter", "sibling"}:
                neutral_rows += 1
            else:
                keep.append({**row, "files": [files[f]["record_file"] for f in row.get("files", []) if files.get(f, {}).get("role") == "exhibit"]})
        mapped[rid] = keep
    print(f"rows citing only distractors: {distractor_rows}; same-matter rows (neutral): {neutral_rows}")
    chronology(mapped, with_affidavit)


if __name__ == "__main__":
    task, path = sys.argv[1], sys.argv[2]
    preds = json.load(open(path, encoding="utf-8"))
    {"exhibits": lambda: exhibits(preds), "chronology": lambda: chronology(preds, "--with-affidavit" in sys.argv),
     "haystack-exhibits": lambda: haystack_exhibits(preds),
     "haystack-chronology": lambda: haystack_chronology(preds, "--with-affidavit" in sys.argv)}[task]()
