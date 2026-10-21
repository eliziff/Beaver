"""Fit line-feature heading baselines, independently of the parser's tree.

Use the existing `structure-gold rows` export. Train only on train; development chooses
thresholds and stopping. Level, parent and unit-stack features are excluded. Unknown
alignments are counted and omitted from supervised metrics. This is a detector probe,
not a full heading-span or PDF extraction score; test is never loaded.

  python heading_detection.py ROWS_DIR --out PRIVATE_OUTPUT_DIR
"""
import argparse
import hashlib
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path

import joblib
import lightgbm as lgb
import numpy as np
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_recall_curve
from sklearn.preprocessing import StandardScaler


@dataclass
class Rows:
    values: np.ndarray
    target: np.ndarray
    baseline: np.ndarray
    text: list
    documents: list
    weights: np.ndarray


def read_rows(path, names):
    columns = [i for i, name in enumerate(names)
               if not name.startswith("o_") and not re.match(r"u\d+_", name)]
    values, target, baseline, text, documents, weights = [], [], [], [], [], []
    offset = 0
    split = "train" if path.name == "rows-train.jsonl" else "development"
    with path.open(encoding="utf-8") as stream:
        for raw in map(json.loads, stream):
            if raw["split"] != split:
                raise ValueError(f"Unexpected split {raw['split']} in {path}")
            n = len(raw["ids"])
            if not n:
                continue
            own = np.asarray(raw["features"], dtype=np.float32)
            if own.shape != (n, len(names)) or len(raw["gold"]) != n:
                raise ValueError(f"Row dimensions disagree for {raw['sha256']}")
            values.append(own[:, columns])
            target.extend(-1 if gold is None else int(gold[0] == 3) for gold in raw["gold"])
            baseline.extend(int(label[0] == 3) for label in raw["tier0"])
            text.extend(row[0] for row in raw["text"])
            weights.extend([n ** -0.5] * n)
            documents.append({"sha256": raw["sha256"], "mode": raw["mode"],
                              "start": offset, "end": offset + n, "ids": raw["ids"]})
            offset += n
    weights = np.asarray(weights, dtype=np.float32)
    return Rows(np.concatenate(values), np.asarray(target, dtype=np.int8),
                np.asarray(baseline, dtype=np.int8), text, documents,
                weights / weights.mean()), [names[i] for i in columns]


def context(rows):
    """Neighbours are within the same document, including its page continuations."""
    parts = [rows.values]
    for lag in (-2, -1, 1, 2):
        shifted = np.full_like(rows.values, np.nan)
        for doc in rows.documents:
            start, end = doc["start"], doc["end"]
            left, right = max(start, start - lag), min(end, end - lag)
            if left < right:
                shifted[left:right] = rows.values[left + lag:right + lag]
        parts.append(shifted)
    return np.concatenate(parts, axis=1)


def counts(target, predicted):
    known = target >= 0
    target, predicted = target[known] == 1, predicted[known]
    expected, actual, correct = int(target.sum()), int(predicted.sum()), int((target & predicted).sum())
    return {"expected": expected, "predicted": actual, "correct": correct,
            "precision": correct / actual if actual else 1.0,
            "recall": correct / expected if expected else 1.0,
            "f1": 2 * correct / (expected + actual) if expected + actual else 1.0}


def report(rows, predicted):
    modes = {}
    for mode in ("all", "digitalborn", "ocr"):
        docs = [d for d in rows.documents if mode == "all" or d["mode"] == mode]
        indices = np.concatenate([np.arange(d["start"], d["end"]) for d in docs]) if docs else np.array([], dtype=int)
        per_document = [counts(rows.target[d["start"]:d["end"]], predicted[d["start"]:d["end"]])
                        for d in docs]
        with_headings = [m for m in per_document if m["expected"]]
        empty = [m for m in per_document if not m["expected"]]
        modes[mode] = {"documents": len(docs), "pieces": len(indices),
                       "unknown_alignment": int((rows.target[indices] < 0).sum()),
                       "pooled": counts(rows.target[indices], predicted[indices]),
                       "heading_documents": len(with_headings),
                       "document_f1_quartiles": np.quantile([m["f1"] for m in with_headings],
                                                          [0.25, 0.5, 0.75]).tolist() if with_headings else None,
                       "heading_documents_recall_below_half": sum(m["recall"] < 0.5 for m in with_headings),
                       "empty_documents": len(empty),
                       "empty_documents_with_false_headings": sum(m["predicted"] > 0 for m in empty)}
    return modes


def operating_point(target, probability, minimum_precision=None):
    known = target >= 0
    p, r, thresholds = precision_recall_curve(target[known], probability[known])
    f1 = 2 * p[:-1] * r[:-1] / np.maximum(p[:-1] + r[:-1], 1e-12)
    eligible = np.ones(len(thresholds), dtype=bool) if minimum_precision is None else p[:-1] >= minimum_precision
    if not eligible.any():
        return None
    best = np.argmax(np.where(eligible, f1, -1.0))
    return float(thresholds[best])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--jobs", type=int, default=2)
    args = parser.parse_args()
    began = time.time()
    args.out.mkdir(parents=True, exist_ok=True)
    input_hashes = {name: hashlib.sha256((args.rows / name).read_bytes()).hexdigest()
                    for name in ("features.json", "rows-train.jsonl", "rows-development.jsonl")}
    names = json.loads((args.rows / "features.json").read_text())
    train, names_used = read_rows(args.rows / "rows-train.jsonl", names)
    dev, _ = read_rows(args.rows / "rows-development.jsonl", names)
    known_train, known_dev = train.target >= 0, dev.target >= 0
    result = {"scope": "heading region on aligned parser pieces, independently of levels and parents",
              "test_evaluated": False, "features": names_used,
              "inputs": input_hashes,
              "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "training": {"documents": len(train.documents), "pieces": len(train.target),
                           "unknown_alignment": int((~known_train).sum()),
                           "heading_pieces": int((train.target == 1).sum())},
              "baseline": report(dev, dev.baseline.astype(bool)), "models": {}}
    print(f"{len(train.target)} train / {len(dev.target)} development pieces; "
          f"{len(names_used)} source features; loaded in {time.time() - began:.1f}s", flush=True)
    x_train, x_dev = context(train), context(dev)
    model = lgb.LGBMClassifier(objective="binary", n_estimators=1200, learning_rate=0.04,
                               num_leaves=31, min_child_samples=40, reg_lambda=1.0,
                               colsample_bytree=0.85, subsample=0.8, subsample_freq=1,
                               n_jobs=args.jobs, random_state=7, verbosity=-1)
    model.fit(x_train[known_train], train.target[known_train], sample_weight=train.weights[known_train],
              eval_set=[(x_dev[known_dev], dev.target[known_dev])],
              callbacks=[lgb.early_stopping(75, verbose=False)])
    probabilities = {"line_features": model.predict_proba(x_dev)[:, 1]}
    joblib.dump({"names": names_used, "classifier": model}, args.out / "line_features.joblib")
    del x_train, x_dev
    print(f"Line-feature classifier: {model.best_iteration_} trees, {time.time() - began:.1f}s", flush=True)

    # Fit vocabulary, inverse document frequencies and feature scaling on train only.
    words = TfidfVectorizer(ngram_range=(1, 2), min_df=3, max_features=30000,
                           sublinear_tf=True, dtype=np.float32)
    characters = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=3,
                                max_features=50000, sublinear_tf=True, dtype=np.float32)
    scaler = StandardScaler(with_mean=False)
    train_text = [text for text, keep in zip(train.text, known_train) if keep]
    x_train = sparse.hstack([words.fit_transform(train_text), characters.fit_transform(train_text),
                             sparse.csr_matrix(scaler.fit_transform(train.values[known_train]))], format="csr")
    x_dev = sparse.hstack([words.transform(dev.text), characters.transform(dev.text),
                           sparse.csr_matrix(scaler.transform(dev.values))], format="csr")
    linear = LogisticRegression(solver="liblinear", class_weight="balanced", C=1.0,
                                 max_iter=200, random_state=7)
    linear.fit(x_train, train.target[known_train], sample_weight=train.weights[known_train])
    probabilities["words_and_type"] = linear.predict_proba(x_dev)[:, 1]
    probabilities["combined"] = (probabilities["line_features"] + probabilities["words_and_type"]) / 2
    joblib.dump({"words": words, "characters": characters, "scaler": scaler, "classifier": linear},
                args.out / "words_and_type.joblib")
    print(f"Word/character classifier fitted, {time.time() - began:.1f}s", flush=True)
    for name, scores in probabilities.items():
        result["models"][name] = {}
        for point, precision in (("best_f1", None), ("pooled_precision_95", 0.95)):
            threshold = operating_point(dev.target, scores, precision)
            if threshold is None:
                result["models"][name][point] = None
                continue
            metrics = report(dev, scores >= threshold)
            result["models"][name][point] = {"threshold": threshold, "metrics": metrics}
            print(name, point, json.dumps({mode: m["pooled"] for mode, m in metrics.items()}), flush=True)
    for name, expected in input_hashes.items():
        if hashlib.sha256((args.rows / name).read_bytes()).hexdigest() != expected:
            raise ValueError(f"Training input changed during fitting: {name}")
    result["elapsed_seconds"] = time.time() - began
    (args.out / "evaluation.json").write_text(json.dumps(result, indent=2) + "\n")
    np.savez_compressed(args.out / "development-probabilities.npz", **probabilities)
    with (args.out / "development-index.jsonl").open("w", encoding="utf-8") as out:
        for doc in dev.documents:
            out.write(json.dumps(doc) + "\n")
    print(f"Done in {result['elapsed_seconds']:.1f}s", flush=True)


if __name__ == "__main__":
    main()
