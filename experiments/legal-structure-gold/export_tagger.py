"""Export a trained tagger to ONNX for the engine, with its vocabularies and normalization beside it.
python export_tagger.py ROWS_DIR CHECKPOINT OUT_DIR
Writes OUT_DIR/tagger.onnx (inputs features[1,T,F] f32, tier0[1,T,7] i64, text[1,T,C] i64 (each piece's whole text, padded to the longest), reader[1,T,3] i64;
outputs one logits tensor per head) and OUT_DIR/tagger.json (feature names, vocabularies, mean, std, heads)."""
import json, sys, time
from pathlib import Path
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_tagger as tt

rows, ckpt, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
saved = torch.load(ckpt, map_location="cpu")
names = json.loads((rows / "features.json").read_text())


class Fixed(tt.Vocab):
    def __init__(self, index):
        self.index = index


vocabs = tuple(Fixed(v) for v in saved["vocabs"])
mean, std = np.asarray(saved["mean"], dtype=np.float32), np.asarray(saved["std"], dtype=np.float32)
dev = tt.load(rows / "rows-development.jsonl")[:4]
docs = [tt.Document(d, names, vocabs, mean, std) for d in dev]
model = tt.Tagger(docs[0].features.shape[1], vocabs, kind=saved["model"], hidden=saved.get("hidden", 128), layers=saved.get("layers", 2)).to("cpu")
model.load_state_dict(saved["state"])
model.eval()


class Exported(nn.Module):
    """The tagger over one unpadded sequence: the GRU runs without packing (one sequence, no padding)."""

    def __init__(self, tagger):
        super().__init__()
        self.t = tagger

    def forward(self, features, tier0, text, reader):
        t = self.t
        b, n, _ = features.shape
        c = t.char(text.view(b * n, text.shape[-1])).transpose(1, 2)
        c = F.relu(t.conv(c)).max(dim=2).values.view(b, n, -1)
        parts = [features, c, t.region_type(reader[..., 0]), t.note_mode(reader[..., 1]), t.family(reader[..., 2])]
        parts += [embed(tier0[..., column].clamp(min=0, max=embed.num_embeddings - 1)) for embed, (_, column, _) in zip(t.tier0, tt.HEADS)]
        x = t.project(torch.cat(parts, dim=-1))
        x, _ = t.encoder(x)
        return tuple(head(x) for head in t.heads)


exported = Exported(model).eval()
doc = docs[0]
n = min(doc.length, 300)
inputs = (torch.from_numpy(doc.features[:n])[None], torch.from_numpy(doc.tier0[:n])[None],
          torch.from_numpy(doc.text[:n])[None], torch.from_numpy(doc.reader[:n])[None])
with torch.no_grad():
    reference = exported(*inputs)
    # The training path, for a check that the unpacked GRU matches the packed one.
    states = tt.Windows([doc], torch.device("cpu")).states(model).float()[:n]
    check = model.tag(states)[0]
print("max |logit difference| region head, export vs training path:", float((reference[0][0] - check).abs().max()))
head_names = [name for name, _, _ in tt.HEADS]
torch.onnx.export(exported, inputs, str(out / "tagger.onnx"), opset_version=17, input_names=["features", "tier0", "text", "reader"],
                  output_names=head_names, dynamic_axes={**{k: {1: "pieces"} for k in ["features", "tier0", "reader"] + head_names}, "text": {1: "pieces", 2: "chars"}},
                  dynamo=False)
json.dump({"features": names, "heads": [[name, column, classes] for name, column, classes in tt.HEADS], "regions": tt.REGIONS,
           "starts": tt.STARTS, "labels": tt.LABELS, "window": tt.WINDOW, "context": tt.CONTEXT,
           "vocabs": saved["vocabs"], "mean": saved["mean"], "std": saved["std"], "model": saved["model"]},
          open(out / "tagger.json", "w", encoding="utf-8"))
print("wrote", out / "tagger.onnx", (out / "tagger.onnx").stat().st_size, "bytes")
try:
    import onnxruntime as ort
    for threads in (1, 4):
        opts = ort.SessionOptions(); opts.intra_op_num_threads = threads
        session = ort.InferenceSession(str(out / "tagger.onnx"), opts, providers=["CPUExecutionProvider"])
        feed = {k: v.numpy() for k, v in zip(["features", "tier0", "text", "reader"], inputs)}
        session.run(None, feed)
        started = time.time()
        for _ in range(5):
            outputs = session.run(None, feed)
        per = (time.time() - started) / 5
        print(f"onnxruntime CPU {threads} thread(s): {per * 1000:.1f} ms for {n} pieces = {per * 1000 / n:.3f} ms/piece; "
              f"max |diff| vs torch {float(np.abs(outputs[0] - reference[0].numpy()).max()):.5f}")
except ImportError:
    print("onnxruntime not installed here; latency measured in the engine")
