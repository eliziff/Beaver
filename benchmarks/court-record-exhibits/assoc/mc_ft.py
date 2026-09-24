"""LoRA fine-tune a small instruct LLM on the multiple-choice framing, grouped 5-fold by record.

Usage: python mc_ft.py <hf model> <tag> [--k 5] [--head 900] [--epochs 2] [--rank 16] [--lr 2e-4] [--folds 0,1,2,3,4]

Same prompts as llm_mc.py (both directions). Training examples come from the training
folds' records: shortlist = top-K of the out-of-fold feature scores with the true answer
forced in, candidates shuffled; loss = cross-entropy over the K letter logits. Each held-out
record is scored by the model trained without its fold (candidates in file/label order).
Writes llm_<tag>.npz in llm_mc.py's format (labels x files x 2, -12 outside the shortlist).
"""
import json, math, os, random, sys, time
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
import llm_mc as M

args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
MODEL, TAG = args[0], args[1]
EPOCHS, RANK, LR = float(opt("--epochs", 2)), int(opt("--rank", 16)), float(opt("--lr", 5e-4))
FOLDS = [int(x) for x in opt("--folds", "0,1,2,3,4").split(",")]
ACC = 4
HERE = M.HERE
K, LET = M.K, M.LET


class LoRA(torch.nn.Module):
    def __init__(self, base, r):
        super().__init__()
        self.base = base
        self.A = torch.nn.Parameter(torch.randn(r, base.in_features, device=base.weight.device) / math.sqrt(base.in_features))
        self.B = torch.nn.Parameter(torch.zeros(base.out_features, r, device=base.weight.device))
        self.scale = 2.0

    def forward(self, x):
        return self.base(x) + ((x.float() @ self.A.T) @ self.B.T * self.scale).to(x.dtype)


def add_lora(model, r):
    targets = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")
    for name, mod in list(model.named_modules()):
        for t in targets:
            if hasattr(mod, t) and isinstance(getattr(mod, t), torch.nn.Linear):
                setattr(mod, t, LoRA(getattr(mod, t), r))
    for n, p in model.named_parameters():
        p.requires_grad = n.endswith(".A") or n.endswith(".B")
    return [p for p in model.parameters() if p.requires_grad]


def build(recs, oof, train, rng):
    """(record, direction, index, candidates, prompt, gold letter index or -1)."""
    jobs = []
    for r in recs:
        s = oof[r["record"]]
        L, N = s.shape
        k = min(K, L, N)
        truth = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
        heads = [M.filehead(t) for t in r["texts"]]
        psgs = [M.passage(r["ctx"][l], l) for l in r["labels"]]
        for i, l in enumerate(r["labels"]):
            cand = list(np.argsort(-s[i])[:k]); g = int(truth[i].argmax())
            if train:
                if g not in cand:
                    cand[-1] = g
                rng.shuffle(cand)
            else:
                cand = sorted(cand)
            jobs.append((r["record"], 0, i, cand, M.prompt_l2f(l, psgs[i], [heads[j] for j in cand]), cand.index(g) if g in cand else -1))
        for j in range(N):
            cand = list(np.argsort(-s[:, j])[:k]); g = int(truth[:, j].argmax())
            if train:
                if g not in cand:
                    cand[-1] = g
                rng.shuffle(cand)
            else:
                cand = sorted(cand)
            jobs.append((r["record"], 1, j, cand, M.prompt_f2l(heads[j], [psgs[i] for i in cand]), cand.index(g) if g in cand else -1))
    return jobs


def main():
    tok = AutoTokenizer.from_pretrained(MODEL)
    tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    letter_ids = [tok.encode(" " + ch, add_special_tokens=False)[0] for ch in LET]
    chat = lambda p: tok.apply_chat_template([{"role": "user", "content": p}], tokenize=False, add_generation_prompt=True,
                                            **({"enable_thinking": False} if "Qwen3" in MODEL else {})) + "The answer is"
    recs = json.load(open(os.path.join(HERE, "inputs2.json"), encoding="utf-8"))
    oof = np.load(os.path.join(HERE, M.SHORT))
    fo = json.load(open(os.path.join(HERE, "folds.json")))
    path = os.path.join(HERE, f"llm_{TAG}.npz")
    out = dict(np.load(path)) if os.path.exists(path) else {}
    for r in recs:
        out.setdefault(r["record"], np.full((len(r["labels"]), len(r["files"]), 2), M.FLOOR, np.float32))
    for k in FOLDS:
        t0 = time.time()
        rng = random.Random(k)
        tr = build([r for r in recs if fo[r["record"]] != k], oof, True, rng)
        te = build([r for r in recs if fo[r["record"]] == k], oof, False, rng)
        model = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16).cuda()
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
        model.config.use_cache = False
        params = add_lora(model, RANK)
        optim = torch.optim.AdamW(params, lr=LR, weight_decay=0.0)
        steps = int(len(tr) * EPOCHS)
        sched = torch.optim.lr_scheduler.LambdaLR(optim, lambda s: min(1.0, s / 30) * max(0.0, 1 - s / max(1, steps // ACC)))
        model.train()
        order = []
        while len(order) < steps:
            o = list(range(len(tr))); rng.shuffle(o); order += o
        run = 0.0
        for step, i in enumerate(order[:steps]):
            enc = tok(chat(tr[i][4]), return_tensors="pt", truncation=True, max_length=2048).to("cuda")
            logits = model(**enc, logits_to_keep=1).logits[0, -1, letter_ids[:len(tr[i][3])]].float()
            loss = torch.nn.functional.cross_entropy(logits[None], torch.tensor([tr[i][5]], device="cuda")) / ACC
            loss.backward(); run += float(loss.detach()) * ACC
            if (step + 1) % ACC == 0:
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                optim.step(); sched.step(); optim.zero_grad()
            if (step + 1) % 500 == 0:
                print(f"  fold {k} step {step + 1}/{steps} loss {run / 500:.3f} {time.time() - t0:.0f}s", flush=True); run = 0.0
        model.eval()
        texts = [chat(j[4]) for j in te]
        idx_sorted = sorted(range(len(te)), key=lambda i: len(texts[i]))
        ok = [0, 0]; n = [0, 0]
        with torch.no_grad():
            for b in range(0, len(idx_sorted), 8):
                idx = idx_sorted[b:b + 8]
                enc = tok([texts[i] for i in idx], return_tensors="pt", padding=True, truncation=True, max_length=4096).to("cuda")
                lp = torch.log_softmax(model(**enc, logits_to_keep=1).logits[:, -1, letter_ids].float(), -1).cpu().numpy()
                for row, i in enumerate(idx):
                    rid, d, a, cand, _, g = te[i]
                    kk = len(cand)
                    l = lp[row, :kk] - np.logaddexp.reduce(lp[row, :kk])
                    for c, j in enumerate(cand):
                        if d == 0:
                            out[rid][a, j, 0] = l[c]
                        else:
                            out[rid][j, a, 1] = l[c]
                    n[d] += 1; ok[d] += int(g >= 0 and int(l.argmax()) == g)
        np.savez_compressed(path, **out)
        print(f"fold {k}: {len(tr)} train prompts, {len(te)} test; shortlist top-1 l2f {ok[0] / max(1, n[0]):.3f} f2l {ok[1] / max(1, n[1]):.3f}; {time.time() - t0:.0f}s", flush=True)
        del model, optim; torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
