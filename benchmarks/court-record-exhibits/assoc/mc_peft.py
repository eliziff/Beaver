"""peft-LoRA fine-tune of a small instruct LLM on listwise multiple choice over the feature model's
top-K shortlist, grouped 5-fold by record.

Usage: python mc_peft.py <hf model> <tag> [--shortlist oof_v6.npz] [--dir f2l|l2f|both] [--epochs 2]
                         [--lr 1e-4] [--rank 16] [--folds 0,1,2,3,4] [--overfit 50 --steps 300]

Prompts are llm_mc.py's. Training prompts come from the training folds' records: shortlist = top-K
of the out-of-fold feature scores with the true answer forced in, candidates shuffled; loss =
cross-entropy over the K letter logits (a softmax over the shortlist). Held-out prompts list the
candidates in file / label order. Adapters: peft LoraConfig on every attention and MLP projection
(fp32 adapter weights over a bf16 base), AdamW, 30 warm-up steps then linear decay, batch 4.

--overfit N --steps S: train S optimizer steps (batch 1) on N training prompts of fold 0 and report
loss and top-1 on those same N prompts; the setup is sound when the loss goes to ~0.
Writes llm_<tag>.npz (labels x files x 2 = l2f, f2l log-softmax over the shortlist, -12 outside).
"""
import json, os, random, sys, time
import numpy as np
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig, get_peft_model
import llm_mc as M

args = sys.argv[1:]
opt = lambda n, d: args[args.index(n) + 1] if n in args else d
MODEL, TAG = args[0], args[1]
EPOCHS, RANK, LR = float(opt("--epochs", 2)), int(opt("--rank", 16)), float(opt("--lr", 1e-4))
FOLDS = [int(x) for x in opt("--folds", "0,1,2,3,4").split(",")]
DIRS = opt("--dir", "f2l")
OVERFIT, STEPS = int(opt("--overfit", 0)), int(opt("--steps", 300))
ACC = 1 if OVERFIT else 4
HERE, K, LET = M.HERE, M.K, M.LET


def build(recs, oof, train, rng):
    """(record, direction, index, candidates, prompt, gold letter index or -1)."""
    jobs = []
    for r in recs:
        s = oof[r["record"]]
        L, N = s.shape
        k = min(K, L, N)
        truth = np.array([[r["truth"][f] == l for f in r["files"]] for l in r["labels"]])
        heads = [M.filehead(t) for t in r["texts"]]
        short = [M.filehead(t, M.HEAD_L2F) for t in r["texts"]]
        psgs = [M.passage(r["ctx"][l], l) for l in r["labels"]]

        def cands(scores, g):
            c = list(np.argsort(-scores)[:k])
            if train:
                if g not in c:
                    c[-1] = g
                rng.shuffle(c)
                return c
            return sorted(c)
        if DIRS in ("l2f", "both"):
            for i, l in enumerate(r["labels"]):
                g = int(truth[i].argmax()); c = cands(s[i], g)
                jobs.append((r["record"], 0, i, c, M.prompt_l2f(l, psgs[i], [short[j] for j in c]), c.index(g) if g in c else -1))
        if DIRS in ("f2l", "both"):
            for j in range(N):
                g = int(truth[:, j].argmax()); c = cands(s[:, j], g)
                jobs.append((r["record"], 1, j, c, M.prompt_f2l(heads[j], [psgs[i] for i in c]), c.index(g) if g in c else -1))
    return jobs


def new_model():
    base = AutoModelForCausalLM.from_pretrained(MODEL, dtype=torch.bfloat16).cuda()
    base.config.use_cache = False
    base.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    base.enable_input_require_grads()
    cfg = LoraConfig(r=RANK, lora_alpha=2 * RANK, lora_dropout=0.05, task_type="CAUSAL_LM",
                     target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    model = get_peft_model(base, cfg)
    for p in model.parameters():
        if p.requires_grad and p.dtype != torch.float32:
            p.data = p.data.float()
    return model


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
    out = dict(np.load(path)) if os.path.exists(path) and not OVERFIT else {}
    for r in recs:
        out.setdefault(r["record"], np.full((len(r["labels"]), len(r["files"]), 2), M.FLOOR, np.float32))

    def score(model, jobs):
        """Letter log-softmax over each job's candidates, batched by length."""
        model.eval()
        texts = [chat(j[4]) for j in jobs]
        res = [None] * len(jobs)
        idx_sorted = sorted(range(len(jobs)), key=lambda i: len(texts[i]))
        with torch.no_grad():
            for b in range(0, len(idx_sorted), 8):
                idx = idx_sorted[b:b + 8]
                enc = tok([texts[i] for i in idx], return_tensors="pt", padding=True, truncation=True, max_length=4096).to("cuda")
                lp = model(**enc, logits_to_keep=1).logits[:, -1, letter_ids].float().cpu().numpy()
                for row, i in enumerate(idx):
                    x = lp[row, :len(jobs[i][3])]
                    res[i] = x - np.logaddexp.reduce(x)
        model.train()
        return res

    def train(model, jobs, steps, rng, log_every, probe=None):
        params = [p for p in model.parameters() if p.requires_grad]
        optim = torch.optim.AdamW(params, lr=LR, weight_decay=0.0)
        sched = torch.optim.lr_scheduler.LambdaLR(optim, lambda s: min(1.0, (s + 1) / 30) * max(0.0, 1 - s / max(1, steps)))
        model.train()
        order = []
        while len(order) < steps * ACC:
            o = list(range(len(jobs))); rng.shuffle(o); order += o
        run, hit, t0 = 0.0, 0, time.time()
        for n, i in enumerate(order[:steps * ACC]):
            enc = tok(chat(jobs[i][4]), return_tensors="pt", truncation=True, max_length=2048).to("cuda")
            logits = model(**enc, logits_to_keep=1).logits[0, -1, letter_ids[:len(jobs[i][3])]].float()
            loss = torch.nn.functional.cross_entropy(logits[None], torch.tensor([jobs[i][5]], device="cuda"))
            (loss / ACC).backward()
            run += float(loss.detach()); hit += int(int(logits.argmax()) == jobs[i][5])
            if (n + 1) % ACC == 0:
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                optim.step(); sched.step(); optim.zero_grad()
                step = (n + 1) // ACC
                if step % log_every == 0:
                    msg = f"  step {step}/{steps} train loss {run / (log_every * ACC):.3f} top-1 {hit / (log_every * ACC):.3f} lr {sched.get_last_lr()[0]:.1e} {time.time() - t0:.0f}s maxmem {torch.cuda.max_memory_allocated() / 1e9:.2f}GB"
                    if probe:
                        lp = score(model, probe)
                        msg += f" | probe loss {-np.mean([l[j[5]] for l, j in zip(lp, probe)]):.3f} top-1 {np.mean([int(l.argmax()) == j[5] for l, j in zip(lp, probe)]):.3f}"
                    print(msg, flush=True)
                    run, hit = 0.0, 0

    if OVERFIT:
        rng = random.Random(0)
        tr = build([r for r in recs if fo[r["record"]] != 0], oof, True, rng)
        few = rng.sample(tr, OVERFIT)
        model = new_model()
        model.print_trainable_parameters()
        lp = score(model, few)
        print(f"overfit gate: {OVERFIT} prompts, start loss {-np.mean([l[j[5]] for l, j in zip(lp, few)]):.3f} top-1 {np.mean([int(l.argmax()) == j[5] for l, j in zip(lp, few)]):.3f} (chance 1/{K})", flush=True)
        train(model, few, STEPS, rng, 25, probe=few)
        return

    for k in FOLDS:
        t0 = time.time()
        rng = random.Random(k)
        tr = build([r for r in recs if fo[r["record"]] != k], oof, True, rng)
        te = build([r for r in recs if fo[r["record"]] == k], oof, False, rng)
        model = new_model()
        steps = int(len(tr) * EPOCHS / ACC)
        train(model, tr, steps, rng, 100)
        lp = score(model, te)
        ok, n = [0, 0], [0, 0]
        for l, (rid, d, a, cand, _, g) in zip(lp, te):
            for c, j in enumerate(cand):
                if d == 0:
                    out[rid][a, j, 0] = l[c]
                else:
                    out[rid][j, a, 1] = l[c]
            n[d] += 1; ok[d] += int(g >= 0 and int(l.argmax()) == g)
        np.savez_compressed(path, **out)
        print(f"fold {k}: {len(tr)} train prompts, {len(te)} test, {steps} steps; shortlist top-1 l2f {ok[0] / max(1, n[0]):.3f} f2l {ok[1] / max(1, n[1]):.3f}; {time.time() - t0:.0f}s", flush=True)
        del model; torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
