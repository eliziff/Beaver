"""Train a small paragraph-boundary model on Rust-exported geometry and witnesses.

python train_paragraphs.py <paragraph-model/dataset.json> --out <paragraph-model>
Gold and model artifacts remain in ignored benchmark storage. Test is never loaded.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import time

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
import numpy as np
import torch
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.preprocessing import StandardScaler


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(path):
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest["schema_version"] != "legal-paragraph-boundaries.v1" or manifest["errors"]:
        raise ValueError("Expected a complete Rust paragraph dataset")
    parts = {split: {"x": [], "y": [], "baseline": [], "sources": []} for split in ("train", "development")}
    seen = set()
    for source in manifest["sources"]:
        if source["split"] not in parts or source["source_sha256"] in seen:
            raise ValueError("Unexpected split or duplicate source")
        seen.add(source["source_sha256"])
        file = path.parent / source["file"]
        if digest(file) != source["file_sha256"]:
            raise ValueError("Training data changed")
        data = json.loads(gzip.decompress(file.read_bytes()))
        if not data["starts"]:
            continue
        x = np.asarray(data["features"], dtype=np.float32)
        y = np.asarray(data["starts"], dtype=np.float32)
        baseline = np.asarray(data["baseline_starts"], dtype=bool)
        if x.shape != (len(y), len(manifest["feature_names"])) or not np.isfinite(x).all():
            raise ValueError("Invalid feature matrix")
        part = parts[source["split"]]
        part["sources"].append((source["source_sha256"], source["mode"], len(y)))
        part["x"].append(x)
        part["y"].append(y)
        part["baseline"].append(baseline)
    for part in parts.values():
        for field in ("x", "y", "baseline"):
            part[field] = np.concatenate(part[field])
    return manifest, parts


def metrics(y, prediction):
    p, r, f1, _ = precision_recall_fscore_support(y, prediction, average="binary", zero_division=0)
    return {"precision": float(p), "recall": float(r), "f1": float(f1),
            "errors": int(np.count_nonzero(y != prediction)),
            "confusion_matrix": confusion_matrix(y, prediction, labels=[0, 1]).tolist()}


def probabilities(model, x):
    with torch.inference_mode():
        return torch.cat([model(batch).flatten().sigmoid() for batch in x.split(32768)]).cpu().numpy()


def merge_policy(part, probability, threshold):
    merge = part["baseline"] & (probability < threshold)
    prediction = part["baseline"].copy()
    prediction[merge] = False
    correct = int(np.count_nonzero(merge & (part["y"] == 0)))
    return {"threshold": float(threshold), "merges": int(merge.sum()), "correct_merges": correct,
            "precision": correct / max(1, int(merge.sum())), "metrics": metrics(part["y"], prediction)}


def merge_threshold(part, probability):
    # Select only high-precision repairs; the Rust parser retains its strong boundaries.
    candidates = [merge_policy(part, probability, t) for t in np.linspace(0.05, 0.95, 19)]
    safe = [r for r in candidates if r["merges"] >= 20 and r["precision"] >= 0.95]
    return min(safe, key=lambda r: r["metrics"]["errors"])["threshold"] if safe else 0.0


def train(x, y, hidden, epochs, device):
    torch.manual_seed(7)
    model = torch.nn.Sequential(torch.nn.Linear(x.shape[1], hidden), torch.nn.ReLU(),
                                torch.nn.Linear(hidden, 1)) if hidden else torch.nn.Sequential(torch.nn.Linear(x.shape[1], 1))
    model = model.to(device)
    positives = y.sum()
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=(len(y) - positives) / positives)
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.001)
    began = time.perf_counter()
    for epoch in range(epochs):
        order = torch.randperm(len(y), device=device)
        total = 0.0
        for batch in order.split(8192):
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x[batch]).flatten(), y[batch])
            loss.backward()
            optimizer.step()
            total += float(loss.detach()) * len(batch)
        if epoch == 0 or (epoch + 1) % 5 == 0:
            print(f"hidden={hidden} epoch={epoch + 1} loss={total / len(y):.5f}", flush=True)
    if device.type == "cuda":
        torch.cuda.synchronize()
    return model.eval(), time.perf_counter() - began


def export(model, scaler, names, threshold):
    layers = []
    for layer in model:
        if isinstance(layer, torch.nn.Linear):
            layers.append({"weight": layer.weight.detach().cpu().tolist(), "bias": layer.bias.detach().cpu().tolist(),
                           "activation": "identity"})
        elif isinstance(layer, torch.nn.ReLU):
            layers[-1]["activation"] = "relu"
    return {"schema_version": "legal-paragraph-model.v1", "feature_names": names,
            "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(), "layers": layers, "threshold": threshold}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    parser.add_argument("--epochs", type=int, default=20)
    args = parser.parse_args()
    torch.set_num_threads(2)
    torch.use_deterministic_algorithms(True)
    device = torch.device(args.device)
    if device.type == "cuda":
        print("GPU:", torch.cuda.get_device_name(device), flush=True)
    manifest, parts = load(args.dataset)
    scaler = StandardScaler().fit(parts["train"]["x"])
    x = {split: torch.as_tensor(scaler.transform(part["x"]), dtype=torch.float32, device=device)
         for split, part in parts.items()}
    y = torch.as_tensor(parts["train"]["y"], dtype=torch.float32, device=device)
    report = {"schema_version": "legal-paragraph-training.v1", "submission_origin": "machine_test",
              "run_id": "paragraph-boundary-training", "dataset_sha256": digest(args.dataset),
              "device": str(device), "sources": {s: len(p["sources"]) for s, p in parts.items()},
              "pairs": {s: len(p["y"]) for s, p in parts.items()}, "candidates": []}
    report["baseline"] = {s: metrics(p["y"], p["baseline"]) for s, p in parts.items()}
    print("Rust baseline:", json.dumps(report["baseline"]), flush=True)
    best = None
    for hidden in (0, 32):
        model, seconds = train(x["train"], y, hidden, args.epochs, device)
        probability = {s: probabilities(model, value) for s, value in x.items()}
        thresholds = [(metrics(parts["development"]["y"], probability["development"] >= t)["f1"], t)
                      for t in np.linspace(0.1, 0.9, 17)]
        _, threshold = max(thresholds)
        result = {"hidden": hidden, "training_seconds": seconds, "threshold": float(threshold),
                  "metrics": {s: metrics(parts[s]["y"], value >= threshold) for s, value in probability.items()}}
        repair_threshold = merge_threshold(parts["development"], probability["development"])
        result["merge_policy"] = {s: merge_policy(parts[s], value, repair_threshold) for s, value in probability.items()}
        report["candidates"].append(result)
        print("Candidate:", json.dumps(result), flush=True)
        errors = result["merge_policy"]["development"]["metrics"]["errors"]
        if best is None or errors < best[0]:
            best = (errors, model, probability, threshold, hidden, repair_threshold)
    _, model, probability, threshold, hidden, repair_threshold = best
    args.out.mkdir(parents=True, exist_ok=True)
    artifact = export(model, scaler, manifest["feature_names"], float(threshold))
    artifact["merge_threshold"] = repair_threshold
    artifact["dataset_sha256"] = report["dataset_sha256"]
    model_file = args.out / "model.json"
    model_file.write_text(json.dumps(artifact, separators=(",", ":")), encoding="utf-8")
    report["selected_hidden"] = hidden
    report["model_sha256"] = digest(model_file)
    predictions = []
    for split, part in parts.items():
        at = 0
        for source, mode, count in part["sources"]:
            predictions.append({"source_sha256": source, "split": split, "mode": mode,
                                "probabilities": probability[split][at:at + count].tolist()})
            at += count
    (args.out / "predictions.json.gz").write_bytes(gzip.compress(json.dumps({
        "model_sha256": report["model_sha256"], "sources": predictions}, separators=(",", ":")).encode(), mtime=0))
    (args.out / "evaluation.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("Model:", model_file, flush=True)


if __name__ == "__main__":
    main()
