"""A learned row scorer for the chronology: which rule-proposed rows are real events.

Usage: python row_model.py <potion_dir> [--affidavit]

Candidates come from chrono_fast.py --sentences (files only) or, with
--affidavit, from affidavit_events.py rules. A row is labelled positive when it
matches a gold event under score.py's rule (same date at the gold precision and
a cited exhibit file or 30% of the event's content words). Features: Model2Vec
embedding of the row text and of its document title, plus structural signals.
A logistic model is trained leave-one-record-out (never on the record it
scores); the sweep reports what keeping rows above each threshold scores.
"""
import io, json, os, re, sys, contextlib
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score, chrono_fast, affidavit_events
from fastmatch import Potion, fit, predict
from baseline import ROOT

potion = Potion(sys.argv[1])
AFF = "--affidavit" in sys.argv
ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
tmp = os.path.join(os.environ["TEMP"], "rowmodel-cands.json")
with contextlib.redirect_stdout(io.StringIO()):
    if AFF:
        sys.argv = ["x", "rules", tmp] + ids; affidavit_events.main()
    else:
        sys.argv = ["x", tmp, "--sentences"] + ids; chrono_fast.main()
cands = json.load(open(tmp, encoding="utf-8"))
MONEY = re.compile(r"\$\s?\d")


def label(rid, rows):
    g = score.gold(rid)
    files = {e["label"]: e["file"] for e in g["exhibits"]}
    events = [e for e in g["events"] if AFF or e["exhibits"]]
    y = []
    for r in rows:
        hit = 0
        for ev in events:
            if not score.date_ok(r.get("date"), ev):
                continue
            gw = score.words(ev["description"])
            if ({files[l] for l in ev["exhibits"]} & set(r.get("files", []))) or (gw and len(gw & score.words(r["description"])) / len(gw) >= .3):
                hit = 1; break
        y.append(hit)
    return np.array(y, float)


def feats(rows):
    X = []
    per_file = {}
    for r in rows:
        for f in r.get("files", []) or ["_"]:
            per_file[f] = per_file.get(f, 0) + 1
    for i, r in enumerate(rows):
        d, t = r["description"], r.get("title", "")
        is_doc = float(d == t)
        struct = [is_doc, len(r.get("date", "")) / 10, float(len(r.get("date", "")) == 10),
                  np.log1p(per_file.get((r.get("files") or ["_"])[0], 1)), min(len(d), 400) / 400,
                  float(bool(chrono_fast.ACTION.search(d))), float(bool(MONEY.search(d))),
                  float(bool(re.search(r"\b(order|endorsement|judgment|affidavit|motion|application|notice|agreement|letter|email)\b", d, re.I))),
                  float(bool(re.search(r"\b(I|we|our|my)\b", d)))]
        X.append(np.concatenate([potion.embed(d), potion.embed(t) if t else np.zeros(potion.D), struct]))
    return np.array(X)


data = {rid: (cands[rid], feats(cands[rid]), label(rid, cands[rid])) for rid in ids if cands.get(rid)}
scored = {}
for rid in data:
    X = np.concatenate([data[k][1] for k in data if k != rid])
    y = np.concatenate([data[k][2] for k in data if k != rid])
    m = fit(X, y, l2=0.3, iters=800, lr=0.3)
    p = 1 / (1 + np.exp(-predict(m, data[rid][1])))
    scored[rid] = [{**r, "p": float(pi)} for r, pi in zip(data[rid][0], p)]


def run(rows_by):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        score.chronology(rows_by, AFF)
    return [float(x) for x in re.search(r"precision ([\d.]+) recall ([\d.]+) F1 ([\d.]+)", buf.getvalue()).groups()]


print(f"{len(data)} records, {sum(len(v[0]) for v in data.values())} candidate rows, {int(sum(v[2].sum() for v in data.values()))} match gold")
for t in [0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
    kept = {k: [r for r in v if r["p"] >= t] for k, v in scored.items()}
    p, r, f = run(kept)
    print(f"  keep p>={t:<4} rows {sum(len(v) for v in kept.values()):5}  precision {p:.3f} recall {r:.3f} F1 {f:.3f}")
json.dump(scored, open(os.path.join(os.environ["TEMP"], f"rowmodel-{'aff' if AFF else 'files'}.json"), "w", encoding="utf-8"))
