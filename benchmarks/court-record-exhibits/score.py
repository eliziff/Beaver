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

  python score.py events <predictions.json> [--embed BGE_DIR] [--threshold T]
      Chronology creation scored by meaning: rows citing an event's files are
      paired one-to-one with gold events by description similarity; dates do
      not gate a match and are reported separately.

Exhibits with "same_text_as" (identical files within a record) are interchangeable.

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


def twins(g):
    """label -> the labels whose files carry the same text (gold "same_text_as"): either assignment is right."""
    return {e["label"]: {e["label"], *e.get("same_text_as", [])} for e in g["exhibits"]}


def event_files(g, ev):
    """The files an event cites, with same-text twins."""
    files, tw = {e["label"]: e["file"] for e in g["exhibits"]}, twins(g)
    return {files[x] for l in ev["exhibits"] for x in tw.get(l, {l}) if x in files}


def exhibits(preds):
    total = right = 0
    for rid, mapping in preds.items():
        gd = gold(rid)
        g, tw = {e["file"]: e["label"] for e in gd["exhibits"]}, twins(gd)
        total += len(g)
        ok = sum(mapping.get(f) in tw[lab] for f, lab in g.items())
        right += ok
        print(f"{rid}: {ok}/{len(g)}")
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
                cited = event_files(g, ev) & set(row.get("files", []))
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


SUFFIX = re.compile(r"(?:ing|ed|es|s)$")


def lexical(a, b):
    """F1 of content-word stems: a model-free stand-in for meaning."""
    wa, wb = ({SUFFIX.sub("", w) for w in words(t)} for t in (a, b))
    both = len(wa & wb)
    return 2 * both / (len(wa) + len(wb)) if both else 0.0


def events(preds, embed_dir=None, threshold=None):
    """Chronology creation scored by meaning. A row may match a gold event only if it cites one of
    the event's exhibit files. Rows and events are then paired one-to-one by description similarity
    (bge-small cosine with --embed DIR, else content-word F1). A pair counts when the similarity
    clears the threshold. Dates never gate a match; date agreement is reported for the matched pairs."""
    from scipy.optimize import linear_sum_assignment
    import numpy as np
    sim = lexical
    if embed_dir:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        from fastmatch import Embedder
        emb, cache = Embedder(embed_dir, pooling="cls", max_len=96), {}
        vec = lambda t: cache[t] if t in cache else cache.setdefault(t, emb.embed(t))
        sim = lambda a, b: float(vec(a) @ vec(b))
    # Calibrated on an independent reviewer's descriptions of the same events (2026-09-24): at 0.70 every
    # same-event pair passes and 8% of different-event pairs from the same record do; lexical 0.25 keeps all and passes 6%.
    threshold = threshold if threshold is not None else (0.70 if embed_dir else 0.25)
    tp = rows_n = gold_n = dated = covered = 0
    sims = []
    for rid, rows in preds.items():
        g = gold(rid)
        evs = [e for e in g["events"] if e["exhibits"]]
        gold_n += len(evs); rows_n += len(rows)
        covered += sum(any(event_files(g, e) & set(r.get("files", [])) for r in rows) for e in evs)
        if not rows or not evs:
            continue
        m = np.zeros((len(rows), len(evs)))
        for i, r in enumerate(rows):
            for j, e in enumerate(evs):
                if event_files(g, e) & set(r.get("files", [])):
                    m[i, j] = sim(r.get("description", ""), e["description"])
        for i, j in zip(*linear_sum_assignment(-m)):
            if m[i, j] >= threshold:
                tp += 1; sims.append(m[i, j]); dated += date_ok(rows[i].get("date"), evs[j])
    p, r = tp / max(rows_n, 1), tp / max(gold_n, 1)
    print(f"events matched by meaning {tp} of {gold_n} gold, {rows_n} rows ({'bge-small' if embed_dir else 'lexical'} >= {threshold})")
    print(f"evidence coverage (a row cites the event's file) {covered / max(gold_n, 1):.3f}; matched pairs: date agrees {dated / max(tp, 1):.3f}, "
          f"mean similarity {sum(sims) / max(len(sims), 1):.3f}")
    print(f"events precision {p:.3f} recall {r:.3f} F1 {2 * p * r / max(p + r, 1e-9):.3f}")


def manifest(record):
    return json.load(open(os.path.join(os.path.dirname(ROOT), "haystack", record, "manifest.json"), encoding="utf-8"))["files"]


def haystack_exhibits(preds):
    """preds: {record: {label: haystack_file}}; the folder also holds distractors."""
    total = right = decoys = 0
    for rid, picks in preds.items():
        files = {e["file"]: e for e in manifest(rid)}
        labels, tw = {e["label"] for e in files.values() if e["role"] == "exhibit"}, twins(gold(rid))
        total += len(labels)
        right += sum(files.get(picks.get(l), {}).get("label") in tw.get(l, {l}) for l in labels)
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
    arg = lambda n: sys.argv[sys.argv.index(n) + 1] if n in sys.argv else None
    {"exhibits": lambda: exhibits(preds), "chronology": lambda: chronology(preds, "--with-affidavit" in sys.argv),
     "events": lambda: events(preds, arg("--embed"), float(arg("--threshold")) if arg("--threshold") else None),
     "haystack-exhibits": lambda: haystack_exhibits(preds),
     "haystack-chronology": lambda: haystack_chronology(preds, "--with-affidavit" in sys.argv)}[task]()
