"""CPU cost and int8 fidelity of the cross-encoder reranker (onnxruntime, laptop).

Usage: python xtime.py <model.onnx> <tokenizer dir> <ce tag> [--threads 2,4] [--fold 0] [--thr 0.5]

Per record, the pairs the "low" composition needs (a low-confidence label's top-5 files plus a
low-confidence file's top-5 labels, union) and the "all" composition's (every row and column
top-5) are tokenized as xenc.py does and scored in length-sorted batches of 16; reports
median / p90 / max seconds per record and total pairs. Fidelity: on the --fold records (the
held-out fold of the exported model) the ONNX logits are compared with ce_<tag>.npz (fp32 torch)
by row shortlist top-1 and max abs difference.
"""
import json, os, sys, time
import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

sys.argv, argv = sys.argv[:3], sys.argv  # xenc parses its own argv at import
import xenc
from common import HERE, load, folds, truth, assign

args = argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
onnx_path, tokdir, TAG = args[0], args[1], args[2]
THREADS = [int(x) for x in opt("--threads", "2,4").split(",")]
FOLD, THR = int(opt("--fold", 0)), float(opt("--thr", 0.5))
tok = AutoTokenizer.from_pretrained(tokdir)
recs2 = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
fo = json.load(open(os.path.join(HERE, "folds.json")))
B = np.load(os.path.join(HERE, "oof_v4.npz"))
CE = np.load(os.path.join(HERE, f"ce_{TAG}.npz"))
cls, sep = tok.cls_token_id, tok.sep_token_id


def pair_sets(s):
    L, N = s.shape; k = min(5, L, N)
    a = assign(s)
    e = np.exp(s - s.max(1, keepdims=True)); r = e / e.sum(1, keepdims=True)
    e = np.exp(s - s.max(0, keepdims=True)); c = e / e.sum(0, keepdims=True)
    lowl, lowf = np.zeros(L, bool), np.zeros(N, bool)
    for i, j in a.items():
        if min(r[i, j], c[i, j]) < THR:
            lowl[i] = lowf[j] = True
    rowk, colk = np.argsort(-s, 1)[:, :k], np.argsort(-s, 0)[:k]
    allp = {(i, int(j)) for i in range(L) for j in rowk[i]} | {(int(i), j) for j in range(N) for i in colk[:, j]}
    low = {(i, int(j)) for i in np.nonzero(lowl)[0] for j in rowk[i]} | {(int(i), j) for j in np.nonzero(lowf)[0] for i in colk[:, j]}
    return sorted(allp), sorted(low)


def run(sess, enc, pairs):
    feats = []
    for i, j in pairs:
        q, f = enc[0][i], enc[1][j]
        f = f[:xenc.MAXLEN - 3 - len(q)]
        feats.append(([cls] + q + [sep] + f + [sep], len(q) + 2))
    order = sorted(range(len(feats)), key=lambda t: len(feats[t][0]))
    out = np.zeros(len(feats), np.float32)
    for b in range(0, len(order), 16):
        idx = order[b:b + 16]; n = max(len(feats[t][0]) for t in idx)
        I = np.zeros((len(idx), n), np.int64); M = np.zeros_like(I); T = np.zeros_like(I)
        for row, t in enumerate(idx):
            x, qn = feats[t]; I[row, :len(x)] = x; M[row, :len(x)] = 1; T[row, qn:len(x)] = 1
        dt = np.int32 if "int32" in sess.get_inputs()[0].type else np.int64
        out[idx] = sess.run(None, {"input_ids": I.astype(dt), "attention_mask": M.astype(dt), "token_type_ids": T.astype(dt)})[0][:, 0]
    return out


print(f"{onnx_path}: {os.path.getsize(onnx_path) / 1e6:.1f} MB")
sets = {r["record"]: pair_sets(B[r["record"]]) for r in recs2}
print(f"pairs: all {sum(len(a) for a, _ in sets.values())}, low {sum(len(b) for _, b in sets.values())} over {len(recs2)} records")
for th in THREADS:
    so = ort.SessionOptions(); so.intra_op_num_threads = th; so.inter_op_num_threads = 1
    sess = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
    for which in (1, 0):
        secs = []
        for r in recs2:
            pairs = sets[r["record"]][which]
            t0 = time.time()
            enc = xenc.encode(tok, [r])[r["record"]]
            if pairs:
                run(sess, enc, pairs)
            secs.append(time.time() - t0)
        s = np.array(secs)
        print(f"  threads {th} [{'low' if which else 'all'}]: per record median {np.median(s):.2f}s p90 {np.percentile(s, 90):.2f}s max {s.max():.1f}s total {s.sum():.0f}s", flush=True)
# fidelity on the exported model's held-out fold
sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
ok_o = ok_t = n = 0; dmax = 0.0
for r in recs2:
    if fo[r["record"]] != FOLD:
        continue
    s = B[r["record"]]; z = CE[r["record"]]; enc = xenc.encode(tok, [r])[r["record"]]
    L, N = s.shape; k = min(5, L, N)
    pairs = [(i, int(j)) for i in range(L) for j in np.argsort(-s[i])[:k]]
    y = run(sess, enc, pairs); Y = np.full((L, N), np.nan, np.float32)
    for (i, j), v in zip(pairs, y):
        Y[i, j] = v
    dmax = max(dmax, float(np.nanmax(np.abs(Y - z))))
    T = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
    for i in range(L):
        c = np.argsort(-s[i])[:k]
        if T[i, c].any():
            n += 1; ok_o += int(T[i, c[np.argmax(Y[i, c])]]); ok_t += int(T[i, c[np.argmax(z[i, c])]])
print(f"fold {FOLD} row shortlist top-1: onnx {ok_o / n:.3f} vs torch {ok_t / n:.3f} (n={n} rows with gold in top-5); max |diff| {dmax:.3f}")
