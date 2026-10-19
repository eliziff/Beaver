"""Verify the unpacked native package on the independently invented Lite OCR fixture."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import shutil
import tempfile
import unicodedata
import uuid


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).split())


def distance(left, right):
    row = list(range(len(right) + 1))
    for i, a in enumerate(left):
        previous, row[0] = row[0], i + 1
        for j, b in enumerate(right):
            old = row[j + 1]
            row[j + 1] = min(old + 1, row[j] + 1, previous + (a != b))
            previous = old
    return row[-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", type=Path)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    stage, fixture, output = (path.resolve() for path in (args.stage, args.fixture, args.output))
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((stage / "runtime-manifest.json").read_text(encoding="utf-8"))
    for name, spec in manifest["files"].items():
        path = (stage / name).resolve()
        assert path.is_relative_to(stage)
        data = path.read_bytes()
        assert len(data) == spec["bytes"] and hashlib.sha256(data).hexdigest() == spec["sha256"], name
    binary = stage / "legalocr.exe"
    assert subprocess.run([binary, "--help"], cwd=stage, capture_output=True).returncode == 0
    with tempfile.TemporaryDirectory(prefix="boundary-", dir=output) as directory:
        root = Path(directory)
        source = root / "invented.png"
        source.write_bytes((fixture / "synthetic-scan.png").read_bytes())
        listing = root / "images.json"
        listing.write_text('["invented.png"]', encoding="utf-8")
        before = source.read_bytes()
        rejected = subprocess.run([binary, listing, "--output", source], cwd=stage, capture_output=True)
        assert rejected.returncode != 0 and b"overwrite" in rejected.stderr
        assert source.read_bytes() == before
    gold = normalized((fixture / "synthetic-gold.txt").read_text(encoding="utf-8"))
    result = {"origin": "machine_test", "run_id": str(uuid.uuid4()), "input_origin": "independently_invented",
              "runtime_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "tiers": {}}
    cases = [(tier, "cpu") for tier in ("quality", "balanced", "fast", "turbo", "extreme")] + [("balanced", "auto")]
    for tier, backend in cases:
        destination = output / (tier + ("-auto" if backend == "auto" else "") + ".json")
        args = [binary, fixture / "synthetic-scan.png", "--tier", tier, "--backend", backend, "--output", destination]
        if backend == "cpu":
            args += ["--workers", "1", "--threads", "1", "--layout-workers", "1", "--batch-size", "16", "--width-bucket", "24"]
        child = subprocess.run(args, cwd=stage, capture_output=True, timeout=120)
        assert child.returncode == 0, child.stderr.decode("utf-8", errors="replace")
        value = json.loads(destination.read_text(encoding="utf-8"))
        pages = value["pages"]
        assert len(pages) == 1
        text = normalized("\n".join(line["text"] for line in pages[0]["lines"]))
        cer = distance(text, gold) / len(gold)
        assert cer < .12, f"{tier}: fixture CER {cer}"
        checked = {"cer": cer, "characters": len(text), "lines": len(pages[0]["lines"]),
                   "backend": value["runtime"]["backend"], "startup_seconds": value["startup_seconds"]}
        if backend == "auto":
            result["automatic"] = checked
        else:
            result["tiers"][tier] = checked
    if result["automatic"]["backend"] != "cpu":
        with tempfile.TemporaryDirectory(prefix="gpu-fallback-", dir=output) as directory:
            root = Path(directory)
            assert root.is_relative_to(output)
            models = root / "models"
            shutil.copytree(stage / "runtime/indra", models)
            manifest_path = models / "manifest.json"
            pack = json.loads(manifest_path.read_text(encoding="utf-8"))
            gpu = pack["models"][pack["tiers"]["balanced"]["model"]]["gpu"]
            invalid = b"machine_test: independently invented invalid ONNX graph"
            (models / gpu["path"]).write_bytes(invalid)
            gpu["sha256"] = hashlib.sha256(invalid).hexdigest()
            pack["assets"][gpu["path"]].update(bytes=len(invalid), sha256=gpu["sha256"])
            manifest_path.write_text(json.dumps(pack), encoding="utf-8")
            destination = root / "fallback.json"
            child = subprocess.run([binary, fixture / "synthetic-scan.png", "--model-pack", models,
                "--backend", "auto", "--workers", "1", "--threads", "1", "--layout-workers", "1",
                "--batch-size", "16", "--width-bucket", "24", "--output", destination],
                cwd=stage, capture_output=True, timeout=120)
            assert child.returncode == 0, child.stderr.decode("utf-8", errors="replace")
            fallback = json.loads(destination.read_text(encoding="utf-8"))
            assert fallback["runtime"]["backend"] == "cpu"
            reference = json.loads((output / "balanced.json").read_text(encoding="utf-8"))
            recognized = lambda value: [(page["lines"], page["layout_boxes"]) for page in value["pages"]]
            assert recognized(fallback) == recognized(reference)
            result["gpu_fallback"] = "passed: failed GPU initialization returns the exact CPU result"
    (output / "results.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
