"""Fine-tune a small cross-encoder for exhibit identification, cross-validated by record.

Usage: python train_xenc.py <inputs.json> <out_dir> [--folds 4] [--epochs 2] [--base cross-encoder/ms-marco-MiniLM-L-6-v2]

Pairs are (affidavit description of an exhibit + its defined-term context,
the opening of a file). Positives are the true file; negatives are the other
files of the same record (hard negatives). Records are split into folds; each
record is scored only by the model trained without it, and the scores are
written to <out_dir>/xenc_sims.json for fastmatch.py (--extra). A final model
trained on every record is exported to <out_dir>/model (ONNX, int8) for the
browser.
"""
import json, os, random, sys, time
import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

torch.set_num_threads(2)
args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
recs = json.load(open(args[0], encoding="utf-8"))
out = args[1]
FOLDS, EPOCHS, BASE = int(opt("--folds", 4)), int(opt("--epochs", 2)), opt("--base", "cross-encoder/ms-marco-MiniLM-L-6-v2")
MAXLEN, NEG = 256, 7
os.makedirs(out, exist_ok=True)
tok = AutoTokenizer.from_pretrained(BASE)


def query(r, l):
    return (r["description"][l] + " || " + r["defined"][l])[:500]


def doc(t):
    return t[:1500] if t.strip() else "(image only, no text)"


def pairs(records, rng):
    data = []
    for r in records:
        for l in r["labels"]:
            q = query(r, l)
            neg = [j for j, f in enumerate(r["files"]) if r["truth"][f] != l]
            rng.shuffle(neg)
            for j, f in enumerate(r["files"]):
                if r["truth"][f] == l:
                    data.append((q, doc(r["texts"][j]), 1.0))
            data += [(q, doc(r["texts"][j]), 0.0) for j in neg[:NEG]]
    rng.shuffle(data)
    return data


def train(records, seed=0):
    rng = random.Random(seed)
    torch.manual_seed(seed)
    model = AutoModelForSequenceClassification.from_pretrained(BASE)
    optim = torch.optim.AdamW(model.parameters(), lr=3e-5, weight_decay=0.01)
    data = pairs(records, rng)
    pos_w = torch.tensor(sum(1 for d in data if not d[2]) / max(1, sum(1 for d in data if d[2])))
    loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pos_w)
    model.train()
    for epoch in range(EPOCHS):
        rng.shuffle(data)
        for i in range(0, len(data), 16):
            batch = data[i:i + 16]
            enc = tok([b[0] for b in batch], [b[1] for b in batch], truncation="longest_first", max_length=MAXLEN, padding=True, return_tensors="pt")
            logits = model(**enc).logits.view(-1)
            loss = loss_fn(logits, torch.tensor([b[2] for b in batch]))
            loss.backward(); optim.step(); optim.zero_grad()
    model.eval()
    return model, len(data)


@torch.no_grad()
def score(model, r):
    m = np.zeros((len(r["labels"]), len(r["files"])))
    for i, l in enumerate(r["labels"]):
        q = query(r, l)
        enc = tok([q] * len(r["files"]), [doc(t) for t in r["texts"]], truncation="longest_first", max_length=MAXLEN, padding=True, return_tensors="pt")
        m[i] = model(**enc).logits.view(-1).numpy()
    return m.tolist()


ids = sorted(r["record"] for r in recs)
fold_of = {rid: k % FOLDS for k, rid in enumerate(ids)}
sims, t0 = {}, time.time()
for k in range(FOLDS):
    tr = [r for r in recs if fold_of[r["record"]] != k]
    te = [r for r in recs if fold_of[r["record"]] == k]
    model, n = train(tr, seed=k)
    for r in te:
        sims[r["record"]] = {"xenc": score(model, r)}
    print(f"fold {k}: trained on {len(tr)} records ({n} pairs), scored {len(te)}; {time.time() - t0:.0f}s", flush=True)
    json.dump(sims, open(os.path.join(out, "xenc_sims.json"), "w"))
ok = total = 0
from scipy.optimize import linear_sum_assignment
for r in recs:
    s = np.array(sims[r["record"]]["xenc"])
    rows, cols = linear_sum_assignment(-s)
    ok += sum(r["truth"][r["files"][c]] == r["labels"][i] for i, c in zip(rows, cols))
    total += len(r["files"])
print(f"cross-validated xenc alone, one-to-one: {ok}/{total} = {ok / total:.3f}")
if "--export" in args:
    model, n = train(recs, seed=99)
    mdir = os.path.join(out, "model")
    os.makedirs(mdir, exist_ok=True)
    enc = tok(["q"], ["d"], return_tensors="pt")
    torch.onnx.export(model, (enc["input_ids"], enc["attention_mask"], enc["token_type_ids"]), os.path.join(mdir, "model_fp32.onnx"),
                      input_names=["input_ids", "attention_mask", "token_type_ids"], output_names=["logits"],
                      dynamic_axes={k: {0: "b", 1: "s"} for k in ["input_ids", "attention_mask", "token_type_ids"]}, opset_version=17)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(os.path.join(mdir, "model_fp32.onnx"), os.path.join(mdir, "model.onnx"), weight_type=QuantType.QInt8)
    os.remove(os.path.join(mdir, "model_fp32.onnx"))
    tok.save_pretrained(mdir)
    print("exported int8 ONNX:", os.path.getsize(os.path.join(mdir, "model.onnx")) // 1_000_000, "MB")
