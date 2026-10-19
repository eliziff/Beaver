"""Stage official detector exports and record their immutable upstream sources."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

import onnx
import yaml
from huggingface_hub import HfApi, hf_hub_download


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    args = parser.parse_args()
    sources = {
        "indra": ("datalab-to/indra-ocr", "ed345c7f158eddbc7dee0c6a7269afb75a94f7e8", "det.onnx", "meta.json"),
        "paddle": ("PaddlePaddle/PP-OCRv6_tiny_det_onnx", "2ba1506c0380b8f0b03dd142459aac66d4421f6c", "inference.onnx", "inference.yml"),
    }
    configuration = {}
    for name, (repo, revision, model_name, metadata_name) in sources.items():
        revision = HfApi().model_info(repo, revision=revision).sha
        model = Path(hf_hub_download(repo, model_name, revision=revision))
        metadata = Path(hf_hub_download(repo, metadata_name, revision=revision))
        destination = args.assets_root / "detectors" / name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(model, destination / "model.onnx")
        shutil.copyfile(metadata, destination / metadata_name)
        graph = onnx.load(model)
        onnx.checker.check_model(graph)
        source = {
            "repo": repo, "revision": revision, "file": model_name,
            "sha256": hashlib.sha256(model.read_bytes()).hexdigest(),
            "bytes": model.stat().st_size,
            "inputs": [entry.name for entry in graph.graph.input],
            "outputs": [entry.name for entry in graph.graph.output],
        }
        (destination / "source.json").write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")
        if name == "indra":
            configuration[name] = {"longSide": json.loads(metadata.read_text())["det_long_side"]}
        else:
            metadata_config = yaml.safe_load(metadata.read_text())
            post = metadata_config["PostProcess"]
            configuration[name] = {
                "limitSide": 736, "limitType": "min", "maxSide": 4000,
                "threshold": post["thresh"], "boxThreshold": post["box_thresh"],
                "unclipRatio": post["unclip_ratio"], "maxCandidates": post["max_candidates"],
            }
        print(json.dumps(source))
        print(metadata.read_text(encoding="utf-8")[:450] if name == "paddle" else json.dumps(configuration[name]))
    (args.assets_root / "detectors/config.json").write_text(json.dumps(configuration, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
