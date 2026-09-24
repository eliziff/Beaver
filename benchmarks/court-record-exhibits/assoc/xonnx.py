"""Export a saved xenc.py cross-encoder to ONNX (fp32) and dynamic-int8, and check the logits.

Usage: python xonnx.py <model dir> <out prefix>
Writes <out prefix>.onnx and <out prefix>.int8.onnx (inputs input_ids, attention_mask,
token_type_ids: batch x seq int64; output logits: batch x 1).
"""
import os, sys
import numpy as np
import torch
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification

src, out = sys.argv[1], sys.argv[2]
model = AutoModelForSequenceClassification.from_pretrained(src, attn_implementation="eager").eval()  # sdpa mask logic traces to constants


class Wrap(torch.nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m

    def forward(self, input_ids, attention_mask, token_type_ids):
        return self.m(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).logits


rng = np.random.RandomState(0)
ids = torch.tensor(rng.randint(1000, 20000, (3, 97)), dtype=torch.long)  # int64 inputs, as a browser feed builds them
mask = torch.ones_like(ids); mask[1, 60:] = 0
tt = torch.zeros_like(ids); tt[:, 40:] = 1
with torch.no_grad():  # before the export: the exporter can leave the module in training mode (dropout)
    ref = Wrap(model)(ids, mask, tt).numpy()[:, 0]
fp32 = out + ".onnx"
torch.onnx.export(Wrap(model), (ids, mask, tt), fp32, input_names=["input_ids", "attention_mask", "token_type_ids"],
                  output_names=["logits"], dynamic_axes={n: {0: "batch", 1: "seq"} for n in ("input_ids", "attention_mask", "token_type_ids")} | {"logits": {0: "batch"}},
                  opset_version=17, dynamo=False)
int8 = out + ".int8.onnx"
quantize_dynamic(fp32, int8, weight_type=QuantType.QInt8)
feed = {"input_ids": ids.numpy(), "attention_mask": mask.numpy(), "token_type_ids": tt.numpy()}
for p in (fp32, int8):
    y = ort.InferenceSession(p, providers=["CPUExecutionProvider"]).run(None, feed)[0][:, 0]
    print(f"{os.path.basename(p)} {os.path.getsize(p) / 1e6:.1f} MB; |logit - torch| per row {np.round(np.abs(y - ref), 4)}")
