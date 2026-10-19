"""Independent native detector outputs for checking the JavaScript postprocessors."""
import argparse
import ast
import hashlib
import importlib.util
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-root", type=Path, required=True)
    parser.add_argument("--browser-root", type=Path, required=True)
    args = parser.parse_args()
    config = json.loads((args.assets_root / "detectors/config.json").read_text())
    manifest = json.loads((args.browser_root / "inputs/manifest.json").read_text())
    first = args.browser_root / "inputs" / manifest["pages"][0]["png"]
    assert hashlib.sha256(first.read_bytes()).hexdigest() == manifest["pages"][0]["png_sha256"]
    bgr = cv2.imread(str(first))
    spec = importlib.util.spec_from_file_location("reference_indra_post", args.browser_root / "sources/indra/indra_ocr/det_post.py")
    indra = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(indra)
    # DB's geometry methods do not use Paddle. Remove that unused top-level
    # import instead of installing a second inference engine for a type check.
    db_path = args.browser_root / "sources/paddle/db_postprocess.py"
    tree = ast.parse(db_path.read_text())
    tree.body = [node for node in tree.body if not (isinstance(node, ast.Import) and any(item.name == "paddle" for item in node.names))]
    scope = {"__name__": "reference_paddle_post"}
    exec(compile(tree, str(db_path), "exec"), scope)
    output = args.browser_root / "detector-parity"
    output.mkdir(parents=True, exist_ok=True)
    receipt = {}
    for name in ["indra", "paddle"]:
        if name == "indra":
            image, _ = indra.page_to_input(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), config[name]["longSide"])
            image = image[None, None]
        else:
            h, w = bgr.shape[:2]
            ratio = min(max(1, config[name]["limitSide"] / min(h, w)), config[name]["maxSide"] / max(h, w))
            rh, rw = max(32, round(h * ratio / 32) * 32), max(32, round(w * ratio / 32) * 32)
            image = cv2.resize(bgr, (rw, rh)).astype(np.float32) / 255
            image = ((image - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)).transpose(2, 0, 1)[None]
        image = np.ascontiguousarray(image, dtype=np.float32)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        session = ort.InferenceSession(str(args.assets_root / "detectors" / name / "model.onnx"), options, providers=["CPUExecutionProvider"])
        prediction = session.run(None, {session.get_inputs()[0].name: image})[0]
        height, width = prediction.shape[-2:]
        if name == "indra":
            boxes = indra.decode(prediction[0])[:, :4]
        else:
            post = scope["DBPostProcess"](thresh=config[name]["threshold"], box_thresh=config[name]["boxThreshold"], unclip_ratio=config[name]["unclipRatio"], max_candidates=config[name]["maxCandidates"])
            quads, _ = post.boxes_from_bitmap(prediction[0, 0], prediction[0, 0] > config[name]["threshold"], width, height)
            boxes = np.array([[q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max()] for q in quads])
        image.tofile(output / (name + "-input.f32"))
        prediction.astype(np.float32).tofile(output / (name + "-output.f32"))
        receipt[name] = {"input_shape": list(image.shape), "output_shape": list(prediction.shape), "config": config[name], "boxes": boxes.tolist()}
        print(f"{name}: native output {prediction.shape}, {len(boxes)} line boxes")
    (output / "reference.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
