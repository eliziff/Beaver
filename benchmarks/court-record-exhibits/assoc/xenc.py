"""Pair-reading reranker: a cross-encoder reads (the affidavit's text around one exhibit mention,
one file's opening) together and is trained listwise over the feature model's shortlist.

Usage: python xenc.py <hf model or dir> <tag> [--folds 0,1,2,3,4] [--epochs 4] [--lr 3e-5] [--bs 4]
                     [--k 5] [--maxlen 512] [--qt 192] [--dirs row|both] [--shortlist oof_v4.npz]
                     [--overfit N --steps S] [--final DIR] [--savefold DIR]

Shortlists: top-K of the out-of-fold feature scores (row = a mention's top-K files, col = a
file's top-K mentions); the gold is forced in for training only. Loss: softmax cross-entropy
over each shortlist's pair logits (listwise), rows and, with --dirs both, columns. Each record is
scored by the model trained without its fold. Writes
  ce_<tag>.npz   record -> labels x files raw pair logits (NaN outside the scored pairs)
  llm_<tag>.npz  record -> labels x files x 2 shortlist log-softmax (row, col), -12 outside,
                 the format llmfeat.py / models.py already stack.
--overfit N trains on N row groups of the fold-0 training records for --steps steps and reports
loss and top-1 on those same groups (the gate before any held-out conclusion).
--final DIR trains on every record and saves the model to DIR (for ONNX export).
Reads inputs2.json, folds.json and the shortlist only (no gold files outside inputs2.json).
"""
import json, math, os, random, re, sys, time
import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
MODEL, TAG = args[0], args[1]
FOLDS = [int(x) for x in opt("--folds", "0,1,2,3,4").split(",")]
EPOCHS, LR, BS, K = float(opt("--epochs", 4)), float(opt("--lr", 3e-5)), int(opt("--bs", 4)), int(opt("--k", 5))
MAXLEN, QT, DIRS = int(opt("--maxlen", 512)), int(opt("--qt", 192)), opt("--dirs", "row")
OVERFIT, STEPS, FINAL = int(opt("--overfit", 0)), int(opt("--steps", 200)), opt("--final", "")
SHORT = opt("--shortlist", "oof_v4.npz")
SYNTH = "--synth" in args
RESID = "--resid" in args  # train on top of the feature score: pair logit = v4 score + CE output
OOF = {}
SRC = {}  # (record, synthetic file index) -> the gold file it copies
FLOOR = -12.0
DEV = "cuda" if torch.cuda.is_available() else "cpu"
ws = lambda t: re.sub(r"\s+", " ", t or "").strip()


def mention_text(c, label):
    """What the affidavit says about this exhibit: the listed item (if any), then the text the
    mention owns (from the previous other-exhibit mention up to it, and a little after)."""
    before, after = (ws(s) for s in (c.get("seg") or ["", ""]))
    if not (before or after):
        before, after = ws(c.get("prev"))[-300:] + " " + ws(c.get("main") or c.get("sentence")), ""
    item = ws(c.get("item"))
    return (f"[{item}] " if item else "") + before[-700:] + f' <Exhibit "{label}"> ' + after[:300]


def file_text(t):
    t = ws(re.sub(r"\[page \d+\]", " ", t or ""))[:2500]
    return t if len(t) > 30 else "(no readable text: image or scan)"


def encode(tok, recs):
    """record -> (query token ids per label, file token ids per file[, synthetic variants]).
    With --synth, each label also gets one variant of its gold file in which a single field the
    mention text shares with the file (a number, month, ordinal or capitalised name) is swapped
    for another of the same type: a one-field near-duplicate hard negative. Appended after the
    real files; SYN[(record, label index)] = its file index."""
    out = {}
    rng = random.Random(7)
    for r in recs:
        qt = [mention_text(r["ctx"][l], l) for l in r["labels"]]
        q = [tok(t, add_special_tokens=False)["input_ids"] for t in qt]
        q = [x[-QT:] if len(x) > QT else x for x in q]  # keep the end: the mention sits late in the text
        ft = [file_text(t) for t in r["texts"]]
        f = [tok(t, add_special_tokens=False)["input_ids"][:MAXLEN] for t in ft]
        if SYNTH:
            names = sorted({w for t in ft for w in CAPS.findall(t[:1500])})
            for i, l in enumerate(r["labels"]):
                g = [j for j, fn in enumerate(r["files"]) if r["truth"][fn] == l]
                v = perturb(qt[i], ft[g[0]], names, rng) if g else None
                if v:
                    SYN[(r["record"], i)] = len(f); SRC[(r["record"], len(f))] = g[0]
                    f.append(tok(v, add_special_tokens=False)["input_ids"][:MAXLEN])
        out[r["record"]] = (q, f)
    return out


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"]
CAPS = re.compile(r"\b[A-Z][a-z]{3,}\b")
STOP = set(MONTHS) | set(ORD) | {"This", "That", "With", "From", "Dear", "Page", "Exhibit", "Affidavit", "Court", "Canada", "Ontario",
                                "Alberta", "British", "Columbia", "Province", "Limited", "Corporation", "Company", "Agreement", "Street", "Justice",
                                "Honourable", "Order", "Letter", "Email", "Sent", "Subject", "Date", "Attached", "Sworn", "Before", "Commissioner"}
SYN = {}


def perturb(q, f, names, rng):
    """Swap one field shared by the mention text q and the visible file opening f[:1200]."""
    head = f[:1200]
    fields = []
    for m in sorted(set(re.findall(r"\b\d{1,6}\b", q)) & set(re.findall(r"\b\d{1,6}\b", head))):
        fields.append(("num", m))
    for m in MONTHS:
        if re.search(rf"\b{m}\b", q) and re.search(rf"\b{m}\b", head):
            fields.append(("month", m))
    for m in ORD:
        if re.search(rf"\b{m}\b", q, re.I) and re.search(rf"\b{m}\b", head, re.I):
            fields.append(("ord", m))
    for m in sorted(set(CAPS.findall(q)) & set(CAPS.findall(head)) - STOP):
        fields.append(("name", m))
    if not fields:
        return None
    kind, m = rng.choice(fields)
    if kind == "num":
        if len(m) == 4 and m[:2] in ("19", "20"):
            new = str(int(m) + rng.choice([-2, -1, 1, 2]))
        elif int(m) <= 31:
            new = str(rng.choice([d for d in range(1, 29) if d != int(m)]))
        else:
            new = str(int(m) + rng.choice([-3, -2, -1, 1, 2, 3])).zfill(len(m))
        return re.sub(rf"\b{m}\b", new, f)
    if kind == "month":
        return re.sub(rf"\b{m}\b", rng.choice([x for x in MONTHS if x != m]), f)
    if kind == "ord":
        new = rng.choice([x for x in ORD if x != m])
        return re.sub(rf"\b{m}\b", lambda mm: new.upper() if mm.group(0).isupper() else new if mm.group(0)[0].isupper() else new.lower(), f, flags=re.I)
    alt = [w for w in names if w != m and w not in q and w not in STOP]
    return re.sub(rf"\b{m}\b", rng.choice(alt), f) if alt else None


def groups(recs, oof, train, dirs):
    """Listwise groups: (record, [(i, j) pairs], gold position or -1)."""
    gs = []
    for r in recs:
        s = oof[r["record"]]
        L, N = s.shape
        k = min(K, L, N)
        T = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
        for i in range(L):
            cand = list(np.argsort(-s[i])[:k]); g = int(T[i].argmax()) if T[i].any() else -1
            if train and g >= 0 and g not in cand:
                cand[-1] = g
            if train and (r["record"], i) in SYN:
                cand = cand + [SYN[(r["record"], i)]]
            gs.append((r["record"], [(i, int(j)) for j in cand], cand.index(g) if g in cand else -1))
        if dirs == "both":
            for j in range(N):
                cand = list(np.argsort(-s[:, j])[:k]); g = int(T[:, j].argmax()) if T[:, j].any() else -1
                if train and g >= 0 and g not in cand:
                    cand[-1] = g
                gs.append((r["record"], [(int(i), j) for i in cand], cand.index(g) if g in cand else -1))
    return gs


def batch(enc, pairs, cls, sep):
    ids, tt = [], []
    for rid, i, j in pairs:
        q, f = enc[rid][0][i], enc[rid][1][j]
        f = f[:MAXLEN - 3 - len(q)]
        ids.append([cls] + q + [sep] + f + [sep]); tt.append([0] * (len(q) + 2) + [1] * (len(f) + 1))
    n = max(map(len, ids))
    I = torch.zeros(len(ids), n, dtype=torch.long); T = torch.zeros_like(I); M = torch.zeros_like(I)
    for b, (x, y) in enumerate(zip(ids, tt)):
        I[b, :len(x)] = torch.tensor(x); T[b, :len(y)] = torch.tensor(y); M[b, :len(x)] = 1
    return {"input_ids": I.to(DEV), "token_type_ids": T.to(DEV), "attention_mask": M.to(DEV)}


def logits_of(model, enc, pairs, cls, sep):
    with torch.autocast(DEV, dtype=torch.bfloat16, enabled=DEV == "cuda"):
        return model(**batch(enc, pairs, cls, sep)).logits[:, 0].float()


def group_loss(model, enc, gs, cls, sep):
    pairs = [(rid, i, j) for rid, pr, _ in gs for i, j in pr]
    z = logits_of(model, enc, pairs, cls, sep)
    loss, ok, o = 0.0, 0, 0
    for rid, pr, g in gs:
        s = z[o:o + len(pr)]; o += len(pr)
        if RESID:
            s = s + torch.tensor([float(OOF[rid][i, SRC.get((rid, j), j)]) for i, j in pr], device=DEV)
        loss = loss + torch.nn.functional.cross_entropy(s[None], torch.tensor([g], device=DEV))
        ok += int(int(s.argmax()) == g)
    return loss / len(gs), ok


def train(tok, enc, tr, steps_total=None, log_every=100, probe=None):
    model = AutoModelForSequenceClassification.from_pretrained(MODEL, num_labels=1).to(DEV)
    cls, sep = tok.cls_token_id, tok.sep_token_id
    tr = [g for g in tr if g[2] >= 0 and len(g[1]) > 1]
    steps = steps_total or int(math.ceil(len(tr) / BS) * EPOCHS)
    optim = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.01)
    warm = max(1, steps // 10)
    sched = torch.optim.lr_scheduler.LambdaLR(optim, lambda s: min(1.0, (s + 1) / warm) * max(0.0, (steps - s) / max(1, steps - warm)))
    rng = random.Random(0); order = []
    model.train(); t0 = time.time(); run = n = ok = 0
    for step in range(steps):
        if len(order) < BS:
            o = list(range(len(tr))); rng.shuffle(o); order += o
        gs = [tr[order.pop()] for _ in range(BS)]
        loss, k = group_loss(model, enc, gs, cls, sep)
        optim.zero_grad(); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optim.step(); sched.step()
        run += float(loss) * len(gs); ok += k; n += len(gs)
        if (step + 1) % log_every == 0 or step + 1 == steps:
            msg = f"  step {step + 1}/{steps} loss {run / n:.3f} train-batch top-1 {ok / n:.3f} {time.time() - t0:.0f}s"
            if DEV == "cuda":
                msg += f" maxmem {torch.cuda.max_memory_allocated() / 2**30:.2f}GB"
            if probe is not None:
                model.eval()
                with torch.no_grad():
                    pl = pok = 0
                    for b in range(0, len(probe), 8):
                        l_, k_ = group_loss(model, enc, probe[b:b + 8], cls, sep); pl += float(l_) * len(probe[b:b + 8]); pok += k_
                model.train()
                msg += f" | probe loss {pl / len(probe):.3f} top-1 {pok / len(probe):.3f}"
            print(msg, flush=True); run = n = ok = 0
    model.eval()
    return model


def score(model, tok, enc, recs, oof):
    """Raw logits for the union of row and column top-K pairs of each record."""
    cls, sep = tok.cls_token_id, tok.sep_token_id
    out = {}
    for r in recs:
        s = oof[r["record"]]; L, N = s.shape; k = min(K, L, N)
        m = np.zeros((L, N), bool)
        m[np.arange(L)[:, None], np.argsort(-s, 1)[:, :k]] = True
        m[np.argsort(-s, 0)[:k], np.arange(N)[None, :]] = True
        pairs = [(r["record"], int(i), int(j)) for i, j in zip(*np.nonzero(m))]
        z = np.full((L, N), np.nan, np.float32)
        with torch.no_grad():
            for b in range(0, len(pairs), 64):
                v = logits_of(model, enc, pairs[b:b + 64], cls, sep).cpu().numpy()
                for (_, i, j), x in zip(pairs[b:b + 64], v):
                    z[i, j] = x
        out[r["record"]] = z
    return out


def shortlist_lp(z, s):
    """Row and column log-softmax of the pair logits over each top-K shortlist (llm_mc format)."""
    L, N = s.shape; k = min(K, L, N)
    o = np.full((L, N, 2), FLOOR, np.float32)
    for i in range(L):
        c = np.argsort(-s[i])[:k]; x = z[i, c]; o[i, c, 0] = x - np.logaddexp.reduce(x)
    for j in range(N):
        c = np.argsort(-s[:, j])[:k]; x = z[c, j]; o[c, j, 1] = x - np.logaddexp.reduce(x)
    return o


def top1(gs, Z):
    ok = n = 0
    for rid, pr, g in gs:
        if g < 0:
            continue
        v = [Z[rid][i, j] for i, j in pr]
        ok += int(int(np.argmax(v)) == g); n += 1
    return ok / max(n, 1), n


def main():
    tok = AutoTokenizer.from_pretrained(MODEL)
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    oof = np.load(os.path.join(HERE, SHORT))
    OOF.update({k: oof[k] for k in oof.files})
    fo = json.load(open(os.path.join(HERE, "folds.json")))
    t0 = time.time(); enc = encode(tok, recs)
    print(f"encoded {len(recs)} records in {time.time() - t0:.0f}s; device {DEV}", flush=True)
    if OVERFIT:
        tr = groups([r for r in recs if fo[r["record"]] != 0], oof, True, "row")
        tr = [g for g in tr if g[2] >= 0 and len(g[1]) == K]
        tr = random.Random(1).sample(tr, OVERFIT)
        train(tok, enc, tr, steps_total=STEPS, log_every=25, probe=tr)
        return
    if FINAL:
        model = train(tok, enc, groups(recs, oof, True, DIRS))
        model.save_pretrained(FINAL); tok.save_pretrained(FINAL)
        print(f"saved {FINAL}")
        return
    pz, pl = os.path.join(HERE, f"ce_{TAG}.npz"), os.path.join(HERE, f"llm_{TAG}.npz")
    Z = dict(np.load(pz)) if os.path.exists(pz) else {}
    for k in FOLDS:
        t0 = time.time()
        trr = [r for r in recs if fo[r["record"]] != k]; ter = [r for r in recs if fo[r["record"]] == k]
        model = train(tok, enc, groups(trr, oof, True, DIRS), log_every=200)
        if opt("--savefold", "") and k == FOLDS[0]:  # held-out model for the ONNX/int8 accuracy and timing check
            model.save_pretrained(opt("--savefold", "")); tok.save_pretrained(opt("--savefold", ""))
        Z.update(score(model, tok, enc, ter, oof))
        np.savez_compressed(pz, **Z)
        np.savez_compressed(pl, **{rid: shortlist_lp(Z[rid], oof[rid]) for rid in Z})
        te_row = groups(ter, oof, False, "row")
        v4 = {r["record"]: oof[r["record"]] for r in ter}
        a, n = top1(te_row, Z); b, _ = top1(te_row, v4)
        print(f"fold {k}: {len(trr)} train records, {len(ter)} test; row shortlist top-1 CE {a:.3f} vs v4 {b:.3f} (n={n}); {time.time() - t0:.0f}s", flush=True)
        del model; torch.cuda.empty_cache() if DEV == "cuda" else None


if __name__ == "__main__":
    main()
