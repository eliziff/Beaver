"""The exported encoder against the trained one on a document of another length and more looks:
python tier_onnx_check.py OUT_DIR"""
import json, os, sys
import numpy as np
import onnxruntime as ort
import torch
sys.path.insert(0, os.path.dirname(__file__))
import tier
out = sys.argv[1]
meta = json.load(open(os.path.join(out, "encoder.json")))
model = tier.Encoder(meta["width"], tier.SIZES[meta["size"]]["hidden"], tier.SIZES[meta["size"]]["layers"])
model.load_state_dict(torch.load(os.path.join(out, "encoder.pt"), map_location="cpu"))
model.eval()
rng = np.random.default_rng(3)
n = 413
features = rng.standard_normal((n, meta["width"])).astype(np.float32)
chars = rng.integers(0, 2049, (n, meta["chars"])).astype(np.int64)
words = rng.integers(0, 16384, (n, meta["words"])).astype(np.int64)
looks = rng.integers(0, 37, n).astype(np.int64)
with torch.no_grad():
    want = model(*(torch.as_tensor(a) for a in (features, chars, words, looks))).numpy()
session = ort.InferenceSession(os.path.join(out, "encoder.onnx"), providers=["CPUExecutionProvider"])
got = session.run(["logits"], {"features": features, "chars": chars, "words": words, "looks": looks})[0]
print("shape", got.shape, "max difference", float(np.abs(got - want).max()))
