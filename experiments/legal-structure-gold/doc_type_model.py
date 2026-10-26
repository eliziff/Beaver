"""Document type: each document of a gold (a file, or each part of a packet at the gold's own document
starts) classified from its whole text (hashed word 1-2 grams and character 3-5 grams, a linear
model). Trained on train documents (5-fold out-of-fold predictions kept for them), scored on
development; test is never read. Writes OUT_DIR/doc-types.json: per source, its documents' first
line ids and type probabilities, for the heading editor (`train_heading_edits.py --doc-types`).

  python doc_type_model.py --gold B5 B6 B7 --out OUT_DIR
"""
import argparse
import gzip
import json
import time
from collections import Counter
from pathlib import Path

import numpy as np
from scipy.sparse import hstack
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix


def documents(gold):
    """The gold's documents: (type, first line id, whole text), at its document starts."""
    typed, units = gold["typed"], gold["units"]
    text_of = {l["id"]: l.get("corrected") if l.get("corrected") is not None else l["text"] for l in gold["lines"]}
    found = []
    for n, unit in enumerate(units):
        if n == 0 or unit.get("starts_document") or unit.get("document_type"):
            found.append({"type": unit.get("document_type") or (found[-1]["type"] if found else "other"), "first": None, "lines": []})
        for t in unit["lines"]:
            for span in typed[t]["spans"]:
                if found[-1]["first"] is None:
                    found[-1]["first"] = span["line_id"]
                if not found[-1]["lines"] or found[-1]["lines"][-1] != span["line_id"]:
                    found[-1]["lines"].append(span["line_id"])
    return [(d["type"], d["first"], "\n".join(text_of.get(i, "") for i in d["lines"])) for d in found if d["lines"]]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gold", type=Path, nargs="+", required=True, help="batch folders holding a/v4 and cohort-manifest.json")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    started = time.time()
    rows = []
    for batch in args.gold:
        split = {d["sha256"]: d.get("split", "unsplit") for d in json.load(open(batch / "cohort-manifest.json", encoding="utf-8"))["documents"]}
        for job in sorted((batch / "a" / "v4").iterdir()):
            path = job / "gold.json.gz"
            if not path.is_file():
                continue
            gold = json.loads(gzip.decompress(path.read_bytes()))
            sha = gold["source_sha256"]
            if split.get(sha) not in ("train", "development"):
                continue
            for kind, first, text in documents(gold):
                rows.append({"sha": sha, "split": split[sha], "type": kind, "first": first, "text": text})
    types = sorted({r["type"] for r in rows})
    print(f"{len(rows)} documents ({sum(r['split'] == 'train' for r in rows)} train), types: {dict(Counter(r['type'] for r in rows))}", flush=True)
    words = HashingVectorizer(n_features=2 ** 20, ngram_range=(1, 2), alternate_sign=False, norm="l2", lowercase=True)
    grams = HashingVectorizer(n_features=2 ** 20, analyzer="char_wb", ngram_range=(3, 5), alternate_sign=False, norm="l2", lowercase=True)
    X = hstack([words.transform([r["text"] for r in rows]), grams.transform([r["text"] for r in rows])]).tocsr()
    y = np.asarray([types.index(r["type"]) for r in rows])
    train = np.asarray([r["split"] == "train" for r in rows])
    model = lambda: LogisticRegression(C=10.0, max_iter=2000, class_weight="balanced")
    probabilities = np.zeros((len(rows), len(types)))
    # Out of fold over train, by source (a packet's documents stay in one fold).
    shas = sorted({r["sha"] for r, t in zip(rows, train) if t})
    fold = {sha: n % 5 for n, sha in enumerate(shas)}
    for f in range(5):
        held = np.asarray([t and fold[r["sha"]] == f for r, t in zip(rows, train)])
        fit = train & ~held
        m = model().fit(X[fit], y[fit])
        probabilities[np.ix_(held, m.classes_)] = m.predict_proba(X[held])
    m = model().fit(X[train], y[train])
    dev = ~train
    probabilities[np.ix_(dev, m.classes_)] = m.predict_proba(X[dev])
    predicted = probabilities.argmax(1)
    for name, mask in (("train out of fold", train), ("development", dev)):
        print(f"{name}: accuracy {np.mean(predicted[mask] == y[mask]):.3f} over {int(mask.sum())} documents", flush=True)
    labels = sorted(set(y[dev]) | set(predicted[dev]))
    print("development confusion (rows gold, columns predicted):", [types[i] for i in labels])
    for i, row in zip(labels, confusion_matrix(y[dev], predicted[dev], labels=labels)):
        print(f"  {types[i]:14} {row.tolist()}")
    out = {"types": types, "sources": {}}
    for r, p in zip(rows, probabilities):
        out["sources"].setdefault(r["sha"], []).append({"first": r["first"], "p": [round(float(v), 4) for v in p]})
    args.out.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(args.out / "doc-types.json", "w", encoding="utf-8"))
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
