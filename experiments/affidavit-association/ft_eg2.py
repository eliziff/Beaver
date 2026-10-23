"""Recovered EmbeddingGemma association LoRA primitives, extended for distractors.

Original experiment: desktop beaver-train/neural/ft_eg2.py (2026-10-08).
The runner owns splits, immutable inputs, receipts and saving the adapter.
"""
import hashlib, random, time
import numpy as np
import torch
import torch.nn.functional as Fn
from feats_neural import views, rrank

R, EPOCHS, LR = 16, 2, 2e-4
MAXLEN, MAXFILES, TEMP = 512, 16, 0.05
ENCODE_BATCH = 8


def load_model():
    from sentence_transformers import SentenceTransformer
    from peft import LoraConfig, get_peft_model
    m = SentenceTransformer("google/embeddinggemma-2", device="cuda", model_kwargs={"torch_dtype": torch.bfloat16},
                           config_kwargs={"vision_config": None, "audio_config": None})
    m.max_seq_length = MAXLEN
    tr = m[0]
    base = tr.auto_model if hasattr(tr, "auto_model") else tr.model
    cfg = LoraConfig(r=R, lora_alpha=2 * R, lora_dropout=0.05,
                     target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
    # Only the text tower: restrict LoRA to modules whose path is not in a vision/audio encoder.
    names = [n for n, mod in base.named_modules() if n.split(".")[-1] in cfg.target_modules and not any(k in n for k in ("vision", "audio"))]
    cfg.target_modules = names
    peft = get_peft_model(base, cfg)
    if hasattr(tr, "auto_model"):
        tr.auto_model = peft
    else:
        tr.model = peft
    try:
        peft.gradient_checkpointing_enable()
        peft.enable_input_require_grads()
    except Exception as e:
        print("no grad checkpointing:", e)
    peft.print_trainable_parameters()
    return m, peft


def embed(m, texts, prompt):
    p = m.prompts[prompt]
    feats = m.tokenize([p + (t or " ") for t in texts])
    feats = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in feats.items()}
    out = m(feats)["sentence_embedding"]
    return Fn.normalize(out.float(), dim=-1)


def sample_record(r, rng, device='cuda'):
    refs, files = views(r)
    T = np.array([[float(l in r.get("acceptable", {}).get(f, [r["truth"].get(f)])) for f in r["files"]] for l in r["labels"]])
    positive = [j for j in range(len(r["files"])) if T[:, j].sum()]
    negative = [j for j in range(len(r["files"])) if not T[:, j].sum()]
    budget = min(4, len(negative), MAXFILES - 2)
    fi = sorted(rng.sample(positive, min(len(positive), MAXFILES - budget)) + rng.sample(negative, budget))
    li = [i for i in range(len(r["labels"])) if T[i, fi].sum() > 0]
    if not li or len(fi) < 2:
        return None
    v = rng.choice(["segb", "sega", "desc", "para", "para"])
    return [refs[v][i] for i in li], [files['full'][j] for j in fi], torch.tensor(T[np.ix_(li, fi)], device=device)


def train(m, peft, recs, plan, frozen_vectors, steps_log=50):
    rng = random.Random(0)
    params = [p for p in peft.parameters() if p.requires_grad]
    optim = torch.optim.AdamW(params, lr=LR, weight_decay=0.0)
    total = int(EPOCHS * len(recs))
    sched = torch.optim.lr_scheduler.LambdaLR(optim, lambda s: min(1.0, (s + 1) / 50) * max(0.0, 1 - s / total))
    m.train(); t0, run, acc, step = time.time(), [], [], 0
    order, trace = [], []
    while len(order) < total:
        o = list(range(len(recs))); rng.shuffle(o); order += o
    for idx in order[:total]:
        s = sample_record(recs[idx], rng)
        if s is None:
            continue
        q, d, T = s
        q_parts = [plan.parts(text, 'SearchQuery') for text in q]
        qi = [rng.randrange(len(parts)) for parts in q_parts]
        qv = np.stack([frozen_vectors['SearchQuery', text][i] for text, i in zip(q, qi)])
        truth = T.cpu().numpy()
        di = []
        for j, text in enumerate(d):
            positive = truth[:, j] > 0
            queries = qv[positive] if positive.any() else qv
            di.append(int((queries @ frozen_vectors['Document', text].T).max(0).argmax()))
        d_parts = [plan.parts(text, 'Document') for text in d]
        def chosen(texts, parts, indices):
            return [{'text_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                     'characters': windows[i]['characters'], 'tokens': windows[i]['tokens']}
                    for text, windows, i in zip(texts, parts, indices)]
        trace.append({'record': recs[idx]['record'], 'queries': chosen(q, q_parts, qi),
                      'documents': chosen(d, d_parts, di)})
        q = [parts[i]['text'] for parts, i in zip(q_parts, qi)]
        d = [parts[i]['text'] for parts, i in zip(d_parts, di)]
        try:
            S = embed(m, q, "SearchQuery") @ embed(m, d, "Document").T / TEMP
            row = T / T.sum(1, keepdim=True).clamp_min(1)
            col = T / T.sum(0, keepdim=True).clamp_min(1)
            loss = -(row * Fn.log_softmax(S, 1)).sum() / len(T)
            loss -= (col * Fn.log_softmax(S, 0)).sum() / (T.sum(0) > 0).sum()
            optim.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            optim.step(); sched.step()
        except torch.cuda.OutOfMemoryError:
            optim.zero_grad(); torch.cuda.empty_cache(); raise
        run.append(loss.item()); acc.append(float(T[torch.arange(len(T), device=T.device), S.argmax(1)].float().mean()))
        step += 1
        if step % steps_log == 0:
            print(f"  step {step}/{total} loss {np.mean(run[-steps_log:]):.3f} top-1 {np.mean(acc[-steps_log:]):.3f} {time.time() - t0:.0f}s maxmem {torch.cuda.max_memory_allocated() / 1e9:.2f}GB", flush=True)
    m.eval()
    return run, trace


@torch.no_grad()
def cache_vectors(m, records, label, plan):
    """Encode every chunk of every source view, preserving task-prompt identity."""
    texts = {'SearchQuery': {}, 'Document': {}}
    for record in records:
        refs, files = views(record)
        for prompt, groups in [('SearchQuery', refs), ('Document', files)]:
            for group in groups.values():
                texts[prompt].update(dict.fromkeys(group))
    cache = {}
    for prompt, unique in texts.items():
        chunks = dict.fromkeys(part['text'] for text in unique for part in plan.parts(text, prompt))
        chunks = list(chunks)
        vectors = {}
        for i in range(0, len(chunks), ENCODE_BATCH):
            batch = chunks[i:i + ENCODE_BATCH]
            for text, vector in zip(batch, embed(m, batch, prompt).cpu().numpy()):
                vectors[text] = vector
            if i % 800 == 0:
                print(label, prompt, i, '/', len(chunks), flush=True)
        for text in unique:
            cache[prompt, text] = np.stack([vectors[part['text']] for part in plan.parts(text, prompt)])
    return cache


def features(r, cache):
    refs, files = views(r)
    documents = [cache['Document', text] for text in files['full']]
    pooled = lambda chunks: chunks.mean(0) / max(float(np.linalg.norm(chunks.mean(0))), 1e-9)
    document_means = np.stack([pooled(chunks) for chunks in documents])
    blocks = []
    for rn, rt in refs.items():
        queries = [cache['SearchQuery', text] for text in rt]
        maximum = np.asarray([[float((q @ d.T).max(1).mean()) for d in documents] for q in queries])
        mean = np.stack([pooled(chunks) for chunks in queries]) @ document_means.T
        for s in (maximum, mean):
            blocks += [s, rrank(s, 1), rrank(s, 0)]
    return np.stack(blocks, axis=2).astype(np.float32)

