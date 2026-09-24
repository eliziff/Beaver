"""Train a matter-relevance cross-encoder on real documents only; test on the haystacks.

Usage: python train_relevance.py <out_dir> [--base cross-encoder/ms-marco-MiniLM-L-6-v2] [--epochs 2] [--export]

Query = the matter statement a user would type (gold proceeding + the
affidavit's stated purpose). Training uses only records that have no
haystack: positives are that record's exhibits; negatives are other records'
exhibits and unrelated corpus PDFs. No synthetic document is ever trained on,
so the haystack test (real exhibits vs same-cast synthetic, other-matter and
corpus distractors) cannot be passed by learning the synthetic renderer.
Writes <out_dir>/doc_scores.json {record: {file: score}} for the haystacks.
"""
import json, os, random, re, sys, time
import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score
from chrono_fast import file_text
from haystack import CORPUS

torch.set_num_threads(2)
args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
out = args[0]
BASE, EPOCHS = opt("--base", "cross-encoder/ms-marco-MiniLM-L-6-v2"), int(opt("--epochs", 2))
os.makedirs(out, exist_ok=True)
ROOT, HS = score.ROOT, os.path.join(os.path.dirname(score.ROOT), "haystack")
haystacks = set(os.listdir(HS))
train_ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")) and d not in haystacks)
rng = random.Random(0)
focus = lambda rid: (lambda g: f"{g['proceeding']}. {g['document']}")(score.gold(rid))[:500]
head = lambda path: re.sub(r"\s+", " ", file_text(path))[:1500] or "(no readable text)"
exhibit_heads = {rid: [head(os.path.join(ROOT, rid, "files", e["file"])) for e in score.gold(rid)["exhibits"][:30]] for rid in train_ids}
corpus = [os.path.join(dp, f) for dp, _, fs in os.walk(CORPUS) for f in fs if f.endswith(".pdf") and os.path.getsize(os.path.join(dp, f)) < 5_000_000]
corpus_heads = [head(p) for p in rng.sample(corpus, 120)]
pairs = []
for rid in train_ids:
    q = focus(rid)
    pairs += [(q, h, 1.0) for h in exhibit_heads[rid]]
    others = [h for o in train_ids if o != rid for h in exhibit_heads[o]]
    pairs += [(q, h, 0.0) for h in rng.sample(others, min(len(others), 2 * len(exhibit_heads[rid])))]
    pairs += [(q, h, 0.0) for h in rng.sample(corpus_heads, 4)]
print(f"training on {len(train_ids)} records, {len(pairs)} pairs ({sum(p[2] for p in pairs):.0f} positive)", flush=True)
tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForSequenceClassification.from_pretrained(BASE)
optim = torch.optim.AdamW(model.parameters(), lr=3e-5, weight_decay=0.01)
lossf = torch.nn.BCEWithLogitsLoss()
t0 = time.time()
model.train()
for epoch in range(EPOCHS):
    rng.shuffle(pairs)
    for i in range(0, len(pairs), 16):
        b = pairs[i:i + 16]
        enc = tok([p[0] for p in b], [p[1] for p in b], truncation="longest_first", max_length=256, padding=True, return_tensors="pt")
        loss = lossf(model(**enc).logits.view(-1), torch.tensor([p[2] for p in b]))
        loss.backward(); optim.step(); optim.zero_grad()
    print(f"epoch {epoch} done {time.time() - t0:.0f}s", flush=True)
model.eval()
scores = {}
with torch.no_grad():
    for rid in sorted(haystacks):
        man = json.load(open(os.path.join(HS, rid, "manifest.json"), encoding="utf-8"))["files"]
        q = focus(rid)
        hs = [head(os.path.join(HS, rid, "files", e["file"])) for e in man]
        s = []
        for i in range(0, len(hs), 16):
            enc = tok([q] * len(hs[i:i + 16]), hs[i:i + 16], truncation="longest_first", max_length=256, padding=True, return_tensors="pt")
            s += model(**enc).logits.view(-1).tolist()
        scores[rid] = {e["file"]: {"role": e["role"], "score": v} for e, v in zip(man, s)}
json.dump(scores, open(os.path.join(out, "doc_scores.json"), "w"), indent=0)
print("scored", len(scores), "haystacks", flush=True)
if "--export" in args:
    mdir = os.path.join(out, "model"); os.makedirs(mdir, exist_ok=True)
    enc = tok(["q"], ["d"], return_tensors="pt")
    names = [n for n in ("input_ids", "attention_mask", "token_type_ids") if n in enc]
    torch.onnx.export(model, tuple(enc[n] for n in names), os.path.join(mdir, "model_fp32.onnx"), input_names=names, output_names=["logits"],
                      dynamic_axes={n: {0: "b", 1: "s"} for n in names}, opset_version=17)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(os.path.join(mdir, "model_fp32.onnx"), os.path.join(mdir, "model.onnx"), weight_type=QuantType.QInt8)
    os.remove(os.path.join(mdir, "model_fp32.onnx")); tok.save_pretrained(mdir)
    print("exported", os.path.getsize(os.path.join(mdir, "model.onnx")) // 1_000_000, "MB", flush=True)
