"""Zero-shot multiple choice with a small instruct LLM: letter log-probs, no generation.

Usage: python llm_mc.py <hf model> <tag> [--k 5] [--dir l2f|f2l|both] [--head 900] [--limit N]

Shortlists come from out-of-fold feature-model scores (--shortlist, default oof_v3.npz), so no gold
leaks in. Two directions:
  l2f  "Here is what the affidavit says about Exhibit X; which of these K file openings is it?"
  f2l  "Here is one file's opening; which of these K affidavit passages describes it?"
Candidates are shown in file / label order (not score order), letters A.. Output
llm_<tag>.npz: record -> labels x files x 2 (l2f, f2l) log-softmax over the shortlist,
-12 outside it.
"""
import json, os, re, sys, time
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
MODEL, TAG = args[0], args[1]
K, HEAD, DIRS, LIMIT = int(opt("--k", 5)), int(opt("--head", 900)), opt("--dir", "both"), int(opt("--limit", 0))
BS = int(opt("--bs", 8))
DEV = opt("--device", "cuda")
SHORT = opt("--shortlist", "oof_v3.npz")
ROT = int(opt("--rot", 1))  # cyclic rotations of the options, averaged (cancels letter-position bias)
HEAD_L2F = int(opt("--head-l2f", 450))
LET = "ABCDEFGHIJ"[:K]
FLOOR = -12.0

clip = lambda t, n: re.sub(r"\s+", " ", t).strip()[:n]


def passage(c, label):
    prev = clip(c["prev"], 2000)[-350:]
    main = clip(c["main"] or c["sentence"], 700)
    item = clip(c["item"], 250)
    s = (f"...{prev} " if prev else "") + main
    if item:
        s += f" [Exhibit {label} is: {item}]"
    return s


def filehead(t, n=None):
    t = clip(re.sub(r"\[page \d+\]", " ", t), n or HEAD)
    return t if len(t) > 30 else "(no readable text: image or scan)"


def prompt_l2f(label, psg, heads):
    opts = "\n\n".join(f"{LET[i]}. {h}" for i, h in enumerate(heads))
    return (f"An affidavit says this about Exhibit \"{label}\":\n\"{psg}\"\n\n"
            f"Below are the openings of {len(heads)} unlabelled files. Which file is Exhibit \"{label}\"?\n\n{opts}\n\n"
            f"Answer with one letter.")


def prompt_f2l(head, psgs):
    opts = "\n\n".join(f"{LET[i]}. {p}" for i, p in enumerate(psgs))
    return (f"Here is the opening of an unlabelled exhibit file:\n\"{head}\"\n\n"
            f"Below are {len(psgs)} passages from the affidavit, each about one exhibit. Which passage describes this file?\n\n{opts}\n\n"
            f"Answer with one letter.")


def main():
    tok = AutoTokenizer.from_pretrained(MODEL)
    tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16 if DEV == "cuda" else torch.float32).to(DEV).eval()
    letter_ids = []
    for ch in LET:
        ids = tok.encode(" " + ch, add_special_tokens=False)
        letter_ids.append(ids[0])
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    oof = np.load(os.path.join(HERE, SHORT))
    if LIMIT:
        recs = recs[:LIMIT]
    jobs = []  # (record, direction, row/col index, candidate indices, prompt)
    for r in recs:
        s = oof[r["record"]]
        L, N = s.shape
        k = min(K, L, N)
        C = r["ctx"]
        heads = [filehead(t) for t in r["texts"]]
        short = [filehead(t, HEAD_L2F) for t in r["texts"]]
        psgs = [passage(C[l], l) for l in r["labels"]]
        rots = lambda c: [c[q:] + c[:q] for q in range(min(ROT, len(c)))]
        if DIRS in ("l2f", "both"):
            for i, l in enumerate(r["labels"]):
                for cand in rots(sorted(np.argsort(-s[i])[:k])):
                    jobs.append((r["record"], 0, i, cand, prompt_l2f(l, psgs[i], [short[j] for j in cand])))
        if DIRS in ("f2l", "both"):
            for j in range(N):
                for cand in rots(sorted(np.argsort(-s[:, j])[:k])):
                    jobs.append((r["record"], 1, j, cand, prompt_f2l(heads[j], [psgs[i] for i in cand])))

    def chat(p):
        msgs = [{"role": "user", "content": p}]
        kw = {"enable_thinking": False} if "Qwen3" in MODEL else {}
        return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True, **kw) + "The answer is"

    texts = [chat(j[4]) for j in jobs]
    order = sorted(range(len(jobs)), key=lambda i: len(texts[i]))
    acc = {r["record"]: np.zeros((len(r["labels"]), len(r["files"]), 2), np.float32) for r in recs}
    cnt = {r["record"]: np.zeros((len(r["labels"]), len(r["files"]), 2), np.float32) for r in recs}
    t0 = time.time(); ntok = 0
    with torch.no_grad():
        for b in range(0, len(order), BS):
            idx = order[b:b + BS]
            enc = tok([texts[i] for i in idx], return_tensors="pt", padding=True, truncation=True, max_length=4096).to(DEV)
            ntok += int(enc["attention_mask"].sum())
            logits = model(**enc, logits_to_keep=1).logits[:, -1, :].float()
            raw = logits[:, letter_ids].cpu().numpy()
            for row, i in enumerate(idx):
                rid, d, a, cand, _ = jobs[i]
                x = raw[row, :len(cand)]
                lp = x - np.logaddexp.reduce(x)
                for c, j in enumerate(cand):
                    ij = (a, j) if d == 0 else (j, a)
                    acc[rid][ij + (d,)] += lp[c]; cnt[rid][ij + (d,)] += 1
    dt = time.time() - t0
    out = {k: np.where(cnt[k] > 0, acc[k] / np.maximum(cnt[k], 1), FLOOR).astype(np.float32) for k in acc}
    np.savez_compressed(os.path.join(HERE, f"llm_{TAG}.npz"), **out)
    print(f"{MODEL}: {len(jobs)} prompts, {ntok} tokens, {dt:.0f}s ({ntok / dt:.0f} tok/s)")
    # quick zero-shot accuracy: argmax over shortlist for each direction
    for d, name in ((0, "l2f"), (1, "f2l")):
        ok = n = 0
        for r in recs:
            m = out[r["record"]][:, :, d]
            if (m > FLOOR).sum() == 0:
                continue
            truth = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
            if d == 0:
                ok += int(truth[np.arange(len(m)), m.argmax(1)].sum()); n += len(m)
            else:
                ok += int(truth[m.argmax(0), np.arange(m.shape[1])].sum()); n += m.shape[1]
        if n:
            print(f"  {name} top-1 {ok / n:.3f} over {n}")


if __name__ == "__main__":
    main()
