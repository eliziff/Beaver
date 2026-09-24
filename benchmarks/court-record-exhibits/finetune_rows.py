"""Fine-tune a small transformer to score chronology rows, cross-validated by record.

Usage: python finetune_rows.py <out_dir> [--base Snowflake/snowflake-arctic-embed-xs] [--folds 5] [--epochs 3]

Candidates and labels are those of row_model.py (files only): rule-proposed rows
from chrono_fast.py --sentences, positive when they match a gold event. Input
text is "<document title> | <date> | <row text>". Each record is scored by the
model trained on the other folds; the sweep reports keeping rows above each
threshold. With --export, a final model on every record is saved as int8 ONNX.
"""
import io, json, os, re, sys, contextlib, random, time
import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import score, chrono_fast
from baseline import ROOT

torch.set_num_threads(2)
args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
out = args[0]
BASE, FOLDS, EPOCHS = opt("--base", "Snowflake/snowflake-arctic-embed-xs"), int(opt("--folds", 5)), int(opt("--epochs", 3))
os.makedirs(out, exist_ok=True)
ids = sorted(d for d in os.listdir(ROOT) if os.path.exists(os.path.join(ROOT, d, "gold.json")))
tmp = os.path.join(out, "cands.json")
with contextlib.redirect_stdout(io.StringIO()):
    sys.argv = ["x", tmp, "--sentences"] + ids; chrono_fast.main()
cands = json.load(open(tmp, encoding="utf-8"))


def labels(rid, rows):
    g = score.gold(rid)
    files = {e["label"]: e["file"] for e in g["exhibits"]}
    events = [e for e in g["events"] if e["exhibits"]]
    y = []
    for r in rows:
        hit = 0
        for ev in events:
            gw = score.words(ev["description"])
            if score.date_ok(r.get("date"), ev) and (({files[l] for l in ev["exhibits"]} & set(r.get("files", []))) or (gw and len(gw & score.words(r["description"])) / len(gw) >= .3)):
                hit = 1; break
        y.append(hit)
    return y


text = lambda r: f"{r.get('title', '')[:160]} | {r.get('date') or 'undated'} | {r['description'][:400]}"
data = {rid: (cands[rid], [text(r) for r in cands[rid]], labels(rid, cands[rid])) for rid in ids if cands.get(rid)}
tok = AutoTokenizer.from_pretrained(BASE)


def train(rids, seed):
    random.seed(seed); torch.manual_seed(seed)
    model = AutoModelForSequenceClassification.from_pretrained(BASE, num_labels=1)
    opt_ = torch.optim.AdamW(model.parameters(), lr=5e-5, weight_decay=0.01)
    ex = [(t, y) for rid in rids for t, y in zip(data[rid][1], data[rid][2])]
    pos = sum(y for _, y in ex); lossf = torch.nn.BCEWithLogitsLoss(pos_weight=torch.tensor((len(ex) - pos) / max(pos, 1)))
    model.train()
    for _ in range(EPOCHS):
        random.shuffle(ex)
        for i in range(0, len(ex), 16):
            b = ex[i:i + 16]
            enc = tok([t for t, _ in b], truncation=True, max_length=128, padding=True, return_tensors="pt")
            loss = lossf(model(**enc).logits.view(-1), torch.tensor([float(y) for _, y in b]))
            loss.backward(); opt_.step(); opt_.zero_grad()
    model.eval()
    return model


@torch.no_grad()
def predict(model, texts):
    ps = []
    for i in range(0, len(texts), 32):
        enc = tok(texts[i:i + 32], truncation=True, max_length=128, padding=True, return_tensors="pt")
        ps += torch.sigmoid(model(**enc).logits.view(-1)).tolist()
    return ps


rids = sorted(data)
fold = {rid: k % FOLDS for k, rid in enumerate(rids)}
scored, t0 = {}, time.time()
for k in range(FOLDS):
    model = train([r for r in rids if fold[r] != k], seed=k)
    for rid in [r for r in rids if fold[r] == k]:
        scored[rid] = [{**r, "p": p} for r, p in zip(data[rid][0], predict(model, data[rid][1]))]
    print(f"fold {k} done {time.time() - t0:.0f}s", flush=True)
json.dump(scored, open(os.path.join(out, "scored.json"), "w", encoding="utf-8"))


def run(rows_by):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        score.chronology(rows_by, False)
    return [float(x) for x in re.search(r"precision ([\d.]+) recall ([\d.]+) F1 ([\d.]+)", buf.getvalue()).groups()]


print(f"{len(data)} records, {sum(len(v[0]) for v in data.values())} rows, {sum(sum(v[2]) for v in data.values())} match gold; base {BASE}")
for t in [0.0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
    kept = {k: [r for r in v if r["p"] >= t] for k, v in scored.items()}
    p, r, f = run(kept)
    print(f"  keep p>={t:<4} rows {sum(len(v) for v in kept.values()):5}  precision {p:.3f} recall {r:.3f} F1 {f:.3f}", flush=True)
if "--export" in args:
    model = train(rids, seed=99)
    mdir = os.path.join(out, "model")
    os.makedirs(mdir, exist_ok=True)
    enc = tok(["x"], return_tensors="pt")
    names = [n for n in ("input_ids", "attention_mask", "token_type_ids") if n in enc]
    torch.onnx.export(model, tuple(enc[n] for n in names), os.path.join(mdir, "model_fp32.onnx"), input_names=names, output_names=["logits"],
                      dynamic_axes={n: {0: "b", 1: "s"} for n in names}, opset_version=17)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    quantize_dynamic(os.path.join(mdir, "model_fp32.onnx"), os.path.join(mdir, "model.onnx"), weight_type=QuantType.QInt8)
    os.remove(os.path.join(mdir, "model_fp32.onnx"))
    tok.save_pretrained(mdir)
    json.dump({"base": BASE, "input": "title | date | text", "max_length": 128, "threshold": 0.5, "records": len(rids)}, open(os.path.join(mdir, "rowmodel.json"), "w"))
    print("exported int8 ONNX", os.path.getsize(os.path.join(mdir, "model.onnx")) // 1_000_000, "MB", flush=True)
