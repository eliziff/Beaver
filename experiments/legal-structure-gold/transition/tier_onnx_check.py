"""The exported encoder against the trained one on a document of another length, more looks and templates and
another number of openers: python tier_onnx_check.py OUT_DIR"""
import json, os, sys
import numpy as np
import onnxruntime as ort
import torch
sys.path.insert(0, os.path.dirname(__file__))
import tier
out = sys.argv[1]
meta = json.load(open(os.path.join(out, "encoder.json")))
model = tier.build(meta["width"], tier.SIZES[meta["size"]]).cpu()
model.load_state_dict(torch.load(os.path.join(out, "encoder.pt"), map_location="cpu"))
model.eval()
rng = np.random.default_rng(3)
n = 413
openers = np.sort(rng.choice(n, 57, replace=False)).astype(np.int64)
inputs = {
    "features": rng.standard_normal((n, meta["width"])).astype(np.float32),
    "chars": rng.integers(0, 2049, (n, meta["chars"])).astype(np.int64),
    "words": rng.integers(0, 16384, (n, meta["words"])).astype(np.int64),
    "looks": rng.integers(0, 37, n).astype(np.int64),
    "templates": rng.integers(0, 61, n).astype(np.int64),
    "openers": openers,
    "last_opener": np.searchsorted(openers, np.arange(n), side="right").astype(np.int64),
}
with torch.no_grad():
    want = [t.numpy() for t in model(*(torch.as_tensor(inputs[k]) for k in ["features", "chars", "words", "looks", "templates", "openers", "last_opener"]))]
session = ort.InferenceSession(os.path.join(out, "encoder.onnx"), providers=["CPUExecutionProvider"])
got = session.run(["logits", "levels"], inputs)
for name, a, b in zip(["logits", "levels"], got, want):
    print(name, "shape", a.shape, "max difference", float(np.abs(a - b).max()))
