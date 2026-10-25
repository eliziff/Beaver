"""A CPU tree baseline over existing `structure-gold rows` features, never gold features.

Python trains the experiment; it does not implement parser decisions. Only the
train/development row files are opened. Test data is not used to fit or tune.
"""
import argparse
import json
from pathlib import Path
import time

import numpy as np

from boundary_data import DEFAULT_OUT, atomic_json, check_partitions, digest, measure, read_json


def features(document, page_count, width):
    """Pool each page once, then compare four pages around every physical gap."""
    raw = np.asarray(document["features"], dtype=np.float32)
    pages = document["pages"]  # Rust rows use zero-based page indices.
    if raw.ndim != 2 or raw.shape != (len(pages), width) or any(type(p) is not int or not 0 <= p < page_count for p in pages):
        raise ValueError("Rust feature rows do not match the original page inventory")
    pooled = np.full((page_count + 4, width * 3 + 1), np.nan, dtype=np.float32)
    by_page = {}
    for i, page in enumerate(pages):
        by_page.setdefault(page, []).append(i)
    for p, indices in by_page.items():
        block = raw[indices]
        pooled[p + 2] = np.concatenate((block[0], block[-1], block.mean(axis=0), [len(indices)]))
    right = np.arange(1, page_count) + 2
    return np.concatenate([pooled[right + offset] for offset in (-2, -1, 0, 1)], axis=1)


def train(args):
    import lightgbm as lgb
    started = time.perf_counter()
    dataset = read_json(args.dataset)
    check_partitions(dataset["sources"])
    selected = {r["sha256"]: r for r in dataset["sources"] if r["split"] in {"train", "development"}}
    names = read_json(args.rows / "features.json")
    width = len(names)
    documents, input_hashes = {}, {}
    for split in ("train", "development"):
        path = args.rows / f"rows-{split}.jsonl"
        input_hashes[path.name] = digest(path)
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                sha = row["sha256"]
                if sha not in selected or selected[sha]["page_count"] < 2 or not row["features"]:
                    continue
                if sha in documents:
                    raise ValueError("Repeated Rust source feature rows")
                source = selected[sha]
                documents[sha] = (features(row, source["page_count"], width),
                                  np.array([source["labels"].get(str(p), -1) for p in range(2, source["page_count"] + 1)]))
    matrices = {}
    for split in ("train", "development"):
        items = [(x[y >= 0], y[y >= 0]) for sha, (x, y) in documents.items() if selected[sha]["split"] == split and np.any(y >= 0)]
        if not items:
            raise ValueError("No labeled feature rows for " + split)
        x, y = (np.concatenate(parts) for parts in zip(*items))
        if set(y) != {0, 1}:
            raise ValueError("Both split and continuation examples are required in " + split)
        matrices[split] = x, y
    prepared_seconds = time.perf_counter() - started
    x, y = matrices["train"]
    dev_x, dev_y = matrices["development"]
    model = lgb.train({"objective": "binary", "metric": "binary_logloss", "num_threads": 1,
                       "learning_rate": 0.05, "num_leaves": 15, "min_data_in_leaf": 20,
                       "verbosity": -1, "seed": 17, "deterministic": True, "force_col_wise": True},
                      lgb.Dataset(x, label=y), num_boost_round=args.rounds,
                      valid_sets=[lgb.Dataset(dev_x, label=dev_y)], callbacks=[lgb.early_stopping(30, verbose=False)])
    args.out.mkdir(parents=True, exist_ok=True)
    model.save_model(str(args.out / "model.txt"))
    prediction_start = time.perf_counter()
    predicted, binary = [], {}
    for sha, (values, _) in documents.items():
        if selected[sha]["split"] != "development":
            continue
        probabilities = model.predict(values, num_threads=1)
        predicted.append({"sha256": sha, "probabilities": {str(p): float(v) for p, v in enumerate(probabilities, 2)}})
        binary[sha] = {p: int(v >= 0.5) for p, v in enumerate(probabilities, 2)}
    prediction_seconds = time.perf_counter() - prediction_start
    report = {"partition_status": dataset["report"]["partition_status"], "dataset_sha256": digest(args.dataset),
              "rust_feature_inputs": input_hashes, "rust_features_sha256": digest(args.rows / "features.json"),
              "model_sha256": digest(args.out / "model.txt"), "feature_width": width, "threshold": 0.5,
              "trainer_sha256": digest(Path(__file__)), "lightgbm_version": lgb.__version__, "numpy_version": np.__version__,
              "train_gaps": len(y), "development_gaps": len(dev_y), "iterations": model.best_iteration,
              "feature_preparation_seconds": prepared_seconds, "prediction_seconds": prediction_seconds,
              "total_seconds": time.perf_counter() - started,
              "timing_scope": "cached Rust rows only; excludes PDF extraction/OCR/rendering; no end-to-end speed claim",
              "sources_without_features": sorted(selected.keys() - documents.keys()),
              **measure([r for r in selected.values() if r["split"] == "development"], binary)}
    atomic_json(args.out / "predictions-development.json", {"sources": predicted})
    atomic_json(args.out / "report.json", report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_OUT / "dataset.json")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT / "baseline")
    parser.add_argument("--rounds", type=int, default=500)
    args = parser.parse_args()
    if args.rounds < 1:
        parser.error("--rounds must be positive")
    print(json.dumps(train(args), indent=2))


if __name__ == "__main__":
    main()
