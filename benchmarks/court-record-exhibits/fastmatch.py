"""Fast, browser-sized exhibit identification: cheap pair signals + a tiny learned scorer.

Usage: python fastmatch.py <inputs.json> [--minilm MODEL_DIR] [--potion POTION_DIR] [--out weights.json]

inputs.json comes from exhibit_inputs.py. Every (label, file) pair gets signals
that cost microseconds in JavaScript: TF-IDF cosine, Model2Vec cosine, shared
dates, document-kind agreement, shared names, image-only x picture-like
reference. A logistic scorer over those signals is evaluated by
leave-one-record-out (it never sees the record it is scored on), then a
one-to-one assignment picks the files. With --minilm, a MiniLM cross-encoder
re-scores only each label's top 3 files on the first 128 tokens of the file,
as an extra signal. Prints accuracy per method and the per-record time budget.
"""
import json, math, os, re, sys, time
from collections import Counter
import numpy as np
from scipy.optimize import linear_sum_assignment
from baseline import tfidf
from audit import iso_dates

KINDS = {
    "email": (r"\be-?mails?\b|\bcorrespondence\b", r"^\s*(?:from|sent|to|subject|date)\s*:|\boutlook\b|@\w+\.\w+"),
    "letter": (r"\bletters?\b", r"\bdear\b|\byours (?:truly|very truly)\b|\bsincerely\b"),
    "text": (r"\btext messages?\b|\bsms\b|\bwhatsapp\b|\bmessages?\b", r"\bimessage\b|\bdelivered\b"),
    "picture": (r"\bphoto(?:graph)?s?\b|\bpictures?\b|\bimages?\b|\bscreenshots?\b", r"$^"),
    "order": (r"\border\b|\bendorsement\b|\bjudgment\b|\breasons\b", r"\bthis court orders\b|\bit is ordered\b|\bthe court orders\b|\bendorsement\b|\bjustice\b"),
    "agreement": (r"\bagreement\b|\bcontract\b|\bterm sheet\b|\blease\b|\bindenture\b", r"\bagreement\b|\bwhereas\b|\bin witness whereof\b|\bparties\b"),
    "invoice": (r"\binvoices?\b|\bstatements? of account\b|\bbills?\b", r"\binvoice\b|\bamount due\b|\bsubtotal\b|\bhst\b|\bgst\b"),
    "affidavit": (r"\baffidavit\b|\bdeclaration\b", r"\baffidavit\b|\bmake oath\b|\bsworn\b|\baffirmed\b"),
    "report": (r"\breport\b|\bmemorand", r"\breport\b|\bexecutive summary\b"),
    "search": (r"\bsearch(?:es)?\b|\bregistry\b|\bcorporate profile\b|\bppsa\b|\bppr\b", r"\bsearch\b|\bregistry\b|\bregistration\b"),
    "filing": (r"\bnotice of\b|\bstatement of claim\b|\bpleading\b|\bapplication\b|\bmotion\b", r"\bnotice of\b|\bstatement of claim\b|\bcourt file no\b|\bapplicant\b|\bplaintiff\b"),
    "financial": (r"\bfinancial statements?\b|\bcash flow\b|\bbudget\b|\bspreadsheet\b|\bledger\b", r"\bbalance sheet\b|\bcash flow\b|\btotal\b.*\d"),
    "news": (r"\barticle\b|\bnews\b|\bpress release\b|\bnews release\b|\bpublication\b", r"\bpress release\b|\bnews release\b|\breporter\b"),
}
NAME = re.compile(r"\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*\b")
STOPNAMES = set("The This That These Those Exhibit Attached Affidavit Court Ontario Canada Inc Ltd Limited Corporation Company January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday Page Dear Regards".split())
FEATURES = ["tfidf", "m2v", "date_head", "date_any", "kind", "kind_miss", "names", "picture_textless", "textless", "tfidf_rank", "m2v_rank",
            "title_sim", "title_rank", "desc_sim", "desc_rank", "md_head", "names_ci", "emb_sim", "emb_rank"]
from audit import NAMES as MONTH_NAMES, MN
MONTH_DAY = [re.compile(rf"\b({MN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b", re.I), re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?({MN})\b", re.I)]


def month_days(text):
    """(month, day) pairs stated with or without a year: "the October 14 Endorsement"."""
    out = set()
    for m in MONTH_DAY[0].finditer(text):
        out.add((MONTH_NAMES[m[1].lower()], int(m[2])))
    for m in MONTH_DAY[1].finditer(text):
        out.add((MONTH_NAMES[m[2].lower()], int(m[1])))
    return out


def kinds_of(text, which):
    t = text.lower()
    return {k for k, pats in KINDS.items() if re.search(pats[which], t, re.M)}


def names(text):
    return {n for n in NAME.findall(text) if n not in STOPNAMES}


class Potion:
    def __init__(self, base):
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(base, "tokenizer.json"))
        if os.path.exists(os.path.join(base, "potion.json")):  # Lens int8 packing
            self.D = json.load(open(os.path.join(base, "potion.json")))["dimensions"]
            self.table = np.fromfile(os.path.join(base, "potion.i8"), dtype=np.int8).reshape(-1, self.D)
            self.scale = np.fromfile(os.path.join(base, "potion.scales"), dtype=np.float32)
        else:  # stock Model2Vec safetensors
            from safetensors.numpy import load_file
            emb = next(iter(load_file(os.path.join(base, "model.safetensors")).values())).astype(np.float32)
            self.table, self.D, self.scale = emb, emb.shape[1], np.ones(len(emb), np.float32)

    def embed(self, text):
        ids = [i for i in self.tok.encode(text, add_special_tokens=False).ids if i < len(self.scale)]
        if not ids:
            return np.zeros(self.D, np.float32)
        v = (self.table[ids].astype(np.float32) * self.scale[ids, None]).sum(0)
        n = np.linalg.norm(v)
        return v / n if n else v


class MiniLM:
    def __init__(self, base, max_len=160):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(base, "tokenizer.json"))
        self.tok.enable_truncation(max_len, strategy="longest_first")
        opts = ort.SessionOptions(); opts.intra_op_num_threads = 1
        self.s = ort.InferenceSession(os.path.join(base, "model.onnx"), opts, providers=["CPUExecutionProvider"])
        self.names = [i.name for i in self.s.get_inputs()]

    def score(self, query, passage):
        e = self.tok.encode(query, passage)
        feeds = {"input_ids": np.array([e.ids], np.int64), "attention_mask": np.array([e.attention_mask], np.int64)}
        if "token_type_ids" in self.names:
            feeds["token_type_ids"] = np.array([e.type_ids], np.int64)
        return float(self.s.run(None, feeds)[0].ravel()[0])


class Embedder:
    """Small retrieval embedder (ONNX int8), query-prefixed descriptions vs file openings."""
    PREFIX = "Represent this sentence for searching relevant passages: "

    def __init__(self, base, pooling="cls", max_len=256):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.tok = Tokenizer.from_file(os.path.join(base, "tokenizer.json"))
        self.tok.enable_truncation(max_len)
        opts = ort.SessionOptions(); opts.intra_op_num_threads = 1
        self.s = ort.InferenceSession(os.path.join(base, "model_quantized.onnx"), opts, providers=["CPUExecutionProvider"])
        self.names = [i.name for i in self.s.get_inputs()]
        self.pooling, self.calls, self.seconds = pooling, 0, 0.0

    def embed(self, text, query=False):
        t0 = time.time()
        e = self.tok.encode((self.PREFIX if query else "") + (text or " "))
        feeds = {"input_ids": np.array([e.ids], np.int64), "attention_mask": np.array([e.attention_mask], np.int64)}
        if "token_type_ids" in self.names:
            feeds["token_type_ids"] = np.zeros((1, len(e.ids)), np.int64)
        h = self.s.run(None, feeds)[0][0]
        v = h[0] if self.pooling == "cls" else h.mean(0)
        self.calls += 1; self.seconds += time.time() - t0
        return v / (np.linalg.norm(v) or 1)


EMBEDDER = None


def ranks(row):
    order = np.argsort(-row)
    r = np.empty(len(row)); r[order] = np.arange(len(row))
    return r


def pair_features(rec, potion):
    labels, files, texts = rec["labels"], rec["files"], rec["texts"]
    para = [rec["paragraph"][l] for l in labels]
    m = tfidf(para + texts)
    tf = m[:len(labels)] @ m[len(labels):].T
    if potion:
        lv = np.stack([potion.embed(p) for p in para])
        fv = [np.stack([potion.embed(t[i:i + 900]) for i in range(0, max(1, len(t)), 800)][:8]) for t in texts]
        m2v = np.array([[float((f @ lv[i]).max()) if texts[j].strip() else 0.0 for j, f in enumerate(fv)] for i in range(len(labels))])
    else:
        m2v = np.zeros_like(tf)
    desc = [rec["description"][l] + " " + rec["defined"][l] for l in labels]
    mt = tfidf(desc + [t[:400] for t in texts])
    title = mt[:len(labels)] @ mt[len(labels):].T
    md_ = tfidf(desc + texts)
    dsim = md_[:len(labels)] @ md_[len(labels):].T
    if EMBEDDER:
        qv = np.stack([EMBEDDER.embed(d, query=True) for d in desc])
        dv = np.stack([EMBEDDER.embed(t[:1500]) if t.strip() else np.zeros(qv.shape[1]) for t in texts])
        esim = qv @ dv.T
    else:
        esim = np.zeros((len(labels), len(files)))
    heads = [t[:2500] for t in texts]
    fmd = [month_days(h) for h in heads]
    lheads = [h.lower() for h in heads]
    fdates_head = [iso_dates(h) for h in heads]
    fdates_any = [iso_dates(t) for t in texts]
    fkinds = [kinds_of(h, 1) for h in heads]
    fnames = [names(h) for h in heads]
    textless = [len(re.sub(r"\s", "", t)) < 50 for t in texts]
    X = np.zeros((len(labels), len(files), len(FEATURES)))
    for i, l in enumerate(labels):
        ref = rec["reference"][l] + " " + para[i][:600]
        rdates, rkinds, rnames = iso_dates(ref), kinds_of(rec["reference"][l], 0), names(ref)
        tr, mr, ttr, dr = ranks(tf[i]), ranks(m2v[i]), ranks(title[i]), ranks(dsim[i])
        rmd = month_days(desc[i] + " " + rec["reference"][l])
        dnames = {n.lower() for n in names(desc[i] + " " + rec["reference"][l])}
        for j in range(len(files)):
            X[i, j] = [tf[i, j], m2v[i, j],
                       float(bool(rdates & fdates_head[j])), float(bool(rdates & fdates_any[j])),
                       float(bool(rkinds & fkinds[j])), float(bool(rkinds) and bool(fkinds[j]) and not rkinds & fkinds[j]),
                       len(rnames & fnames[j]) / (1 + len(rnames)),
                       float(textless[j] and bool(rkinds & {"picture", "text"})), float(textless[j]),
                       1 / (1 + tr[j]), 1 / (1 + mr[j]),
                       title[i, j], 1 / (1 + ttr[j]), dsim[i, j], 1 / (1 + dr[j]),
                       float(bool(rmd & fmd[j])),
                       sum(n in lheads[j] for n in dnames) / (1 + len(dnames)),
                       esim[i, j], 1 / (1 + ranks(esim[i])[j])]
    return X


def fit(X, y, l2=0.1, iters=3000, lr=0.5):
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Z = (X - mu) / sd
    w, b = np.zeros(X.shape[1]), 0.0
    pos = y.mean()
    sw = np.where(y == 1, 0.5 / pos, 0.5 / (1 - pos))
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = (p - y) * sw
        w -= lr * (Z.T @ g / len(y) + l2 * w)
        b -= lr * g.mean()
    return {"mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist(), "b": b}


def predict(model, X):
    Z = (X - np.array(model["mu"])) / np.array(model["sd"])
    return Z @ np.array(model["w"]) + model["b"]


def assign(scores):
    rows, cols = linear_sum_assignment(-scores)
    return dict(zip(rows, cols))


def main():
    args = sys.argv[1:]
    opt = lambda n: args[args.index(n) + 1] if n in args else None
    recs = json.load(open(args[0], encoding="utf-8"))
    potion = Potion(opt("--potion")) if opt("--potion") else None
    minilm = MiniLM(opt("--minilm")) if opt("--minilm") else None
    global EMBEDDER
    if opt("--embed"):
        EMBEDDER = Embedder(opt("--embed"), opt("--pooling") or "cls")
    t0 = time.time()
    feats = {r["record"]: pair_features(r, potion) for r in recs}
    feat_s = time.time() - t0
    truth = {r["record"]: np.array([[1.0 if r["truth"][f] == l else 0.0 for f in r["files"]] for l in r["labels"]]) for r in recs}
    if minilm:
        t1, calls = time.time(), 0
        for r in recs:
            X = feats[r["record"]]
            base = X[:, :, FEATURES.index("tfidf")] + X[:, :, FEATURES.index("m2v")]
            extra = np.full(base.shape, -12.0)
            for i, l in enumerate(r["labels"]):
                q = r["reference"][l][:350]
                for j in np.argsort(-base[i])[:3]:
                    if r["texts"][j].strip():
                        extra[i, j] = minilm.score(q, r["texts"][j][:900]); calls += 1
            feats[r["record"]] = np.concatenate([X, extra[:, :, None]], axis=2)
        mini_s, mini_calls = time.time() - t1, calls
        FEATURES.append("minilm_top3")
    n_files = sum(len(r["files"]) for r in recs)

    def score_method(scorer):
        ok = 0
        for r in recs:
            s = scorer(r)
            a = assign(s)
            ok += sum(truth[r["record"]][i, j] for i, j in a.items())
        return ok / n_files

    print(f"{len(recs)} records, {n_files} files; signal time {feat_s:.1f}s total ({1000 * feat_s / len(recs):.0f} ms/record, Python)")
    if EMBEDDER:
        print(f"embedder: {EMBEDDER.calls} passes, {1000 * EMBEDDER.seconds / EMBEDDER.calls:.0f} ms/pass, {EMBEDDER.seconds / len(recs):.1f} s/record (native CPU, 1 thread)")
    if minilm:
        print(f"MiniLM top-3 re-score: {mini_calls} calls, {1000 * mini_s / max(mini_calls, 1):.0f} ms/call, {mini_s / len(recs):.1f} s/record")
    for k, name in enumerate(FEATURES):
        print(f"  single signal {name:18} assigned acc {score_method(lambda r: feats[r['record']][:, :, k]):.3f}")
    ok = 0
    for r in recs:  # leave-one-record-out
        tr = [x for x in recs if x["record"] != r["record"]]
        X = np.concatenate([feats[x["record"]].reshape(-1, len(FEATURES)) for x in tr])
        y = np.concatenate([truth[x["record"]].ravel() for x in tr])
        model = fit(X, y)
        s = predict(model, feats[r["record"]].reshape(-1, len(FEATURES))).reshape(len(r["labels"]), len(r["files"]))
        a = assign(s)
        ok += sum(truth[r["record"]][i, j] for i, j in a.items())
    print(f"LEARNED (leave-one-record-out) assigned acc {ok / n_files:.3f}")
    X = np.concatenate([feats[x["record"]].reshape(-1, len(FEATURES)) for x in recs])
    y = np.concatenate([truth[x["record"]].ravel() for x in recs])
    model = fit(X, y)
    print("weights:", {n: round(w, 2) for n, w in zip(FEATURES, model["w"])})
    if opt("--out"):
        json.dump({"features": FEATURES, **model}, open(opt("--out"), "w"), indent=1)


if __name__ == "__main__":
    main()
