"""The transition parser's tier 1 and tier 2 local scores: a document encoder over each line's evidence (the
parser's own line features from its dump, LEGALPDF_TRANSITION_DUMP), its text (the tagger's character codes
and hashed words, so the engine reads them as the tagger's runner does) and the whole document around it:
each line beside its look's and its template's lines over the whole document (the stylesheet's templates,
`stylesheet::template_ids`) and the document's mean; the document's openers (lines opening on a marker, or
short: `stylesheet::opener`) attending to one another across the whole document, each line reading the last
opener at or before it; then a bidirectional GRU over every line in reading order. It gives each line each
region-and-opening class's probability and, were it a heading's opening, each heading level's (an absolute
level, not a step from the heading before). Tier 1 is the small encoder, tier 2 the large; the parser and its
ranker stay the same.

pretrain: the encoder's text and sequence read on the HTML pages' silver lines (kinds and unit starts, no
layout), its layout input zero.
fit: k encoders out of fold on train (fold i fitted on every train document but those of fold i, CRC-32 of the
sha256 mod k, as the forests' folds), each reading its fold's documents, and one on all of train, reading every
other document; each document's probabilities written to OUT/scores/<sha>.local.f32 (lines x 34) and
<sha>.levels.f32 (lines x 10), the parser's LEGALPDF_TRANSITION_LOCAL_SCORES; the full encoder exported to
OUT/encoder.onnx with OUT/encoder.json (LEGALPDF_TRANSITION_ENCODER).

python tier.py pretrain SILVER_LINES_JSONL DUMP_DIR OUT.pt [--size small|large]   (the dump for its line width)
python tier.py fit DUMP_DIR GOLD_STORE OUT_DIR [--init PRE.pt] [--size small|large]"""
import argparse, json, os, re, sys, zlib
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLASSES, LEVELS = 34, 10
SIZES = {"small": dict(hidden=96, layers=2, heads=4, attention=2, epochs=6), "large": dict(hidden=256, layers=3, heads=8, attention=3, epochs=8)}
CHARS, WORDS = 160, 32
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
WORD_SPLIT = re.compile(r"[^0-9A-Za-zÀ-ɏ]+")
HEADING = 3


def fnv1a(token):
    h = 0x811C9DC5
    for byte in token.encode("utf-8"):
        h = ((h ^ byte) * 0x01000193) & 0xFFFFFFFF
    return h


def char_codes(text):
    """The tagger's chars(): each character min(code point, 0x2FFF) % 2048 + 1, the first CHARS."""
    return [min(ord(c), 0x2FFF) % 2048 + 1 for c in text[:CHARS]]


def word_codes(text):
    """The tagger's words(): each lowercase word's FNV-1a % 16383 + 1, the first WORDS."""
    return [fnv1a(t) % 16383 + 1 for t in WORD_SPLIT.split(text.lower()) if t][:WORDS]


def padded(rows, width):
    out = np.zeros((len(rows), max(width, 1)), dtype=np.int16)
    for k, r in enumerate(rows):
        out[k, :len(r)] = r
    return out


def gold_levels(gold):
    """Each heading opening's absolute level, the gold's level steps (10 the same) replayed from one in each
    constituent document; -100 where the gold says no level or the line opens no heading."""
    levels = np.full(len(gold), -100, dtype=np.int64)
    current = 0
    for k, g in enumerate(gold):
        if g[2] == 1:
            current = 0
        if g[0] == HEADING and g[1] == 1:
            if g[4] < 0:
                current = 0
                continue
            current = int(np.clip(max(current, 1) + g[4] - 10, 1, LEVELS - 1))
            levels[k] = current
    return levels


class Doc:
    """One document's lines: features (lines x width), char and word codes, look and template indexes, the
    openers' places and each line's last opener (from 1, 0 for none), target class and level."""

    def __init__(self, sha, features, texts, looks, templates, openers, target, levels):
        self.sha = sha
        self.features = features
        self.chars = padded([char_codes(t) for t in texts], CHARS)
        self.words = padded([word_codes(t) for t in texts], WORDS)
        _, self.looks = np.unique(np.asarray(looks, dtype=np.int64), return_inverse=True)
        self.templates = np.asarray(templates, dtype=np.int64)
        places = np.flatnonzero(np.asarray(openers, dtype=bool))
        self.openers = places if len(places) else np.zeros(1, dtype=np.int64)
        self.last_opener = np.searchsorted(self.openers, np.arange(len(texts)), side="right")
        self.target = target
        self.levels = levels
        self.length = len(texts)


class Attention(nn.Module):
    """One pre-norm self-attention block over a set of states (m, d), its shapes read off the states so the
    exported graph takes any number of them (PyTorch's own block exports with the traced count fixed)."""

    def __init__(self, d, heads):
        super().__init__()
        self.heads, self.size = heads, d // heads
        self.norm1, self.norm2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.out = nn.Linear(d, d)
        self.feed = nn.Sequential(nn.Linear(d, 2 * d), nn.GELU(), nn.Dropout(0.1), nn.Linear(2 * d, d))
        self.drop = nn.Dropout(0.1)

    def forward(self, x):
        q, k, v = self.qkv(self.norm1(x)).chunk(3, dim=-1)
        split = lambda t: t.reshape(-1, self.heads, self.size).transpose(0, 1)
        q, k, v = split(q), split(k), split(v)
        weights = torch.softmax(q @ k.transpose(1, 2) / self.size ** 0.5, dim=-1)
        y = (weights @ v).transpose(0, 1).reshape(-1, self.heads * self.size)
        x = x + self.drop(self.out(y))
        return x + self.drop(self.feed(self.norm2(x)))


class Encoder(nn.Module):
    def __init__(self, width, hidden, layers, heads, attention):
        super().__init__()
        self.width = width
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv3 = nn.Conv1d(24, 64, 3, padding=1)
        self.conv5 = nn.Conv1d(24, 64, 5, padding=2)
        self.word = nn.Embedding(16384, 32, padding_idx=0)
        d = 2 * hidden
        self.project = nn.Sequential(nn.Linear(width + 160, d), nn.GELU(), nn.Dropout(0.1))
        # The openers across the whole document, attending to one another.
        self.attend = nn.ModuleList([Attention(d, heads) for _ in range(attention)])
        # The line beside its look's lines, its template's, the document's mean and its last opener's state.
        self.mix = nn.Sequential(nn.Linear(5 * d, d), nn.GELU())
        self.encoder = nn.GRU(d, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=0.1)
        self.head = nn.Linear(d, CLASSES)
        self.level = nn.Linear(d, LEVELS)

    @staticmethod
    def pooled(x, index):
        onehot = (index[:, None] == torch.arange(index.max() + 1, device=index.device)[None]).float()
        return onehot @ ((onehot.t() @ x) / onehot.sum(0).clamp(min=1)[:, None])

    def forward(self, features, chars, words, looks, templates, openers, last_opener):
        """One document: features (n, width), chars (n, CHARS), words (n, WORDS), looks and templates (n),
        openers (m), last_opener (n) -> class logits (n, 34), level logits (n, 10)."""
        e = self.char(chars).transpose(1, 2)
        c = torch.cat([F.relu(self.conv3(e)).max(dim=2).values, F.relu(self.conv5(e)).max(dim=2).values], dim=-1)
        mask = (words > 0).unsqueeze(-1).float()
        w = (self.word(words) * mask).sum(1) / mask.sum(1).clamp(min=1)
        x = self.project(torch.cat([features, c, w], dim=-1))
        attended = x[openers]
        for block in self.attend:
            attended = block(attended)
        states = torch.cat([torch.zeros_like(x[:1]), attended], dim=0)[last_opener]
        whole = x.mean(0, keepdim=True).expand_as(x)
        x = self.mix(torch.cat([x, self.pooled(x, looks), self.pooled(x, templates), whole, states], dim=-1))
        y, _ = self.encoder(x[None])
        return self.head(y[0]), self.level(y[0])


def tensors(doc, mean, std):
    f = torch.as_tensor(np.clip((doc.features - mean) / std, -8, 8), dtype=torch.float32, device=DEVICE)
    codes = lambda a: torch.as_tensor(np.asarray(a).astype(np.int64), device=DEVICE)
    return f, codes(doc.chars), codes(doc.words), codes(doc.looks), codes(doc.templates), codes(doc.openers), codes(doc.last_opener)


def fold_of(sha, folds):
    return zlib.crc32(sha.encode()) % folds


def partition(store, sha):
    try:
        return json.load(open(os.path.join(store, sha, "source.json"), encoding="utf-8"))["partition"]
    except (OSError, KeyError, ValueError):
        return None


def load_dump(folder, store):
    docs = []
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".json") or name.endswith(".labels.json"):
            continue
        meta = json.load(open(os.path.join(folder, name), encoding="utf-8"))
        x = np.fromfile(os.path.join(folder, f"{meta['sha256']}.lines.f32"), dtype="<f4").reshape(meta["lines"], meta["line_width"])
        gold = np.asarray(meta["gold"], dtype=np.int64).reshape(-1, 8)
        target = np.where(gold[:, 0] >= 0, gold[:, 0] * 2 + (gold[:, 1] == 1), -100)
        doc = Doc(meta["sha256"], x, meta["texts"], meta["looks"], meta["templates"], meta["openers"], target, gold_levels(gold))
        doc.split = partition(store, meta["sha256"])
        docs.append(doc)
    return docs


def train(model, docs, mean, std, epochs, label):
    """Every document whole, in a shuffled order, a step each; AdamW with a one-cycle rate. The loss is the
    classes' cross-entropy and, on heading openings with a known level, the levels'."""
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-4)
    steps = epochs * len(docs)
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=2e-3, total_steps=max(steps, 1), pct_start=0.1)
    rng = np.random.default_rng(0)
    model.train()
    for epoch in range(epochs):
        total, count = 0.0, 0
        for k in rng.permutation(len(docs)):
            doc = docs[k]
            target = torch.as_tensor(doc.target, device=DEVICE)
            levels = torch.as_tensor(doc.levels, device=DEVICE)
            if not (target >= 0).any():
                scheduler.step()
                continue
            logits, level_logits = model(*tensors(doc, mean, std))
            loss = F.cross_entropy(logits, target, ignore_index=-100)
            if (levels >= 0).any():
                loss = loss + 0.5 * F.cross_entropy(level_logits, levels, ignore_index=-100)
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            total += float(loss.detach()) * int((target >= 0).sum())
            count += int((target >= 0).sum())
        print(f"{label} epoch {epoch + 1}: loss {total / max(count, 1):.4f}", flush=True)


@torch.no_grad()
def probabilities(model, doc, mean, std):
    model.eval()
    logits, levels = model(*tensors(doc, mean, std))
    return (torch.softmax(logits.float(), dim=-1).cpu().numpy().astype("<f4"), torch.softmax(levels.float(), dim=-1).cpu().numpy().astype("<f4"))


def accuracy(model, docs, mean, std):
    right = total = level_right = level_total = 0
    for doc in docs:
        classes, levels = probabilities(model, doc, mean, std)
        keep = doc.target >= 0
        right += int((classes.argmax(1)[keep] == doc.target[keep]).sum())
        total += int(keep.sum())
        known = doc.levels >= 0
        level_right += int((levels.argmax(1)[known] == doc.levels[known]).sum())
        level_total += int(known.sum())
    return right / max(total, 1), total, level_right / max(level_total, 1), level_total


def silver_docs(path, width):
    """The silver lines as documents of text alone: each line's kind its region, opening its unit; one
    template; its short lines its openers; no levels."""
    kinds = {"paragraph": 1, "heading": 3, "quote": 4, "note": 5, "list_item": 2}
    by_doc = {}
    for raw in open(path, encoding="utf-8"):
        row = json.loads(raw)
        by_doc.setdefault(row["doc"], []).append(row)
    docs = []
    for name, rows in by_doc.items():
        rows.sort(key=lambda r: r["n"])
        target = np.asarray([kinds[r["kind"]] * 2 + 1 if r["kind"] in kinds else -100 for r in rows], dtype=np.int64)
        texts = [r["text"] for r in rows]
        docs.append(Doc(name, np.zeros((len(rows), width), dtype=np.float32), texts, [0] * len(rows), [0] * len(rows),
                        [len(t) <= 60 or bool(r.get("number")) for t, r in zip(texts, rows)], target, np.full(len(rows), -100, dtype=np.int64)))
    return docs


def export(model, mean, std, out, size):
    """The full encoder as ONNX (CPU, a whole document a run) and what the engine reads beside it."""
    model = model.cpu().eval()
    n, m = 7, 3
    inputs = (torch.zeros(n, model.width), torch.ones(n, CHARS, dtype=torch.int64), torch.ones(n, WORDS, dtype=torch.int64),
              torch.zeros(n, dtype=torch.int64), torch.zeros(n, dtype=torch.int64), torch.arange(m, dtype=torch.int64), torch.zeros(n, dtype=torch.int64))
    names = ["features", "chars", "words", "looks", "templates", "openers", "last_opener"]
    axes = {name: {0: "m" if name == "openers" else "n"} for name in names}
    axes.update({"logits": {0: "n"}, "levels": {0: "n"}})
    torch.onnx.export(model, inputs, os.path.join(out, "encoder.onnx"), input_names=names, output_names=["logits", "levels"],
                      dynamic_axes=axes, dynamo=False, opset_version=17)
    json.dump({"width": model.width, "chars": CHARS, "words": WORDS, "classes": CLASSES, "levels": LEVELS, "size": size,
               "mean": mean.tolist(), "std": std.tolist()}, open(os.path.join(out, "encoder.json"), "w"))


def build(width, size):
    return Encoder(width, size["hidden"], size["layers"], size["heads"], size["attention"]).to(DEVICE)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["pretrain", "fit"])
    parser.add_argument("paths", nargs="+")
    parser.add_argument("--size", default="small", choices=sorted(SIZES))
    parser.add_argument("--init")
    parser.add_argument("--folds", type=int, default=3)
    args = parser.parse_args()
    size = SIZES[args.size]
    if args.command == "pretrain":
        silver, folder, out = args.paths
        width = next(json.load(open(os.path.join(folder, n), encoding="utf-8"))["line_width"] for n in sorted(os.listdir(folder))
                     if n.endswith(".json") and not n.endswith(".labels.json"))
        docs = silver_docs(silver, width)
        print(f"silver: {len(docs)} documents, {sum(d.length for d in docs)} lines", flush=True)
        model = build(width, size)
        zero, one = np.zeros(width, np.float32), np.ones(width, np.float32)
        train(model, docs, zero, one, 2, "pretrain")
        torch.save(model.state_dict(), out)
        return
    folder, store, out = args.paths
    os.makedirs(os.path.join(out, "scores"), exist_ok=True)
    docs = load_dump(folder, store)
    train_docs = [d for d in docs if d.split == "train"]
    others = [d for d in docs if d.split != "train"]
    width = docs[0].features.shape[1]
    stacked = np.concatenate([d.features for d in train_docs])
    mean, std = stacked.mean(0).astype(np.float32), (stacked.std(0) + 1e-3).astype(np.float32)
    del stacked
    print(f"{len(train_docs)} train documents, {len(others)} others, line width {width}", flush=True)

    def fresh():
        model = build(width, size)
        if args.init:
            model.load_state_dict(torch.load(args.init, map_location=DEVICE))
        return model

    def write(model, chosen):
        for doc in chosen:
            classes, levels = probabilities(model, doc, mean, std)
            classes.tofile(os.path.join(out, "scores", f"{doc.sha}.local.f32"))
            levels.tofile(os.path.join(out, "scores", f"{doc.sha}.levels.f32"))

    for i in range(args.folds):
        model = fresh()
        train(model, [d for d in train_docs if fold_of(d.sha, args.folds) != i], mean, std, size["epochs"], f"fold{i}")
        write(model, [d for d in train_docs if fold_of(d.sha, args.folds) == i])
    model = fresh()
    train(model, train_docs, mean, std, size["epochs"], "full")
    write(model, others)
    dev = [d for d in others if d.split == "development"]
    print("development, the full encoder: move accuracy %.4f over %d lines, heading level accuracy %.4f over %d headings" % accuracy(model, dev, mean, std), flush=True)
    torch.save(model.state_dict(), os.path.join(out, "encoder.pt"))
    export(model, mean, std, out, args.size)


if __name__ == "__main__":
    main()
    # Its files written, the process ends without the interpreter's teardown, which CUDA and the ONNX exporter
    # crash on Windows (0xC0000409) after a run that did all its work.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
