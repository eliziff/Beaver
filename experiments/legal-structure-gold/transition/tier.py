"""The transition parser's tier 1 and tier 2 local scores: a document encoder over each line's evidence (the
parser's own line features from its dump, LEGALPDF_TRANSITION_DUMP), its text (the tagger's character codes
and hashed words, so the engine reads them as the tagger's runner does) and the document around it (each
line's look summed over the whole document, the document's mean, then a bidirectional GRU over every line in
reading order), giving each region-and-opening class's probability. Tier 1 is the small encoder, tier 2 the
large; the parser and its ranker stay the same.

pretrain: the encoder's text and sequence read on the HTML pages' silver lines (kinds and unit starts, no
layout), its layout input zero.
fit: k encoders out of fold on train (fold i fitted on every train document but those of fold i, CRC-32 of the
sha256 mod k, as the forests' folds), each reading its fold's documents, and one on all of train, reading every
other document; each document's probabilities written to OUT/scores/<sha>.local.f32 (lines x 34, the parser's
LEGALPDF_TRANSITION_LOCAL_SCORES); the full encoder exported to OUT/encoder.onnx with OUT/encoder.json.

python tier.py pretrain SILVER_LINES_JSONL DUMP_DIR OUT.pt [--size small|large]   (the dump for its line width)
python tier.py fit DUMP_DIR GOLD_STORE OUT_DIR [--init PRE.pt] [--size small|large]"""
import argparse, json, os, re, sys, zlib
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

CLASSES = 34
REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote", "marginal_note",
           "furniture", "page_label", "line_label", "title", "note_quote", "provision"]
SIZES = {"small": dict(hidden=96, layers=2, epochs=6), "large": dict(hidden=256, layers=3, epochs=8)}
CHARS, WORDS = 160, 32
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
WORD_SPLIT = re.compile(r"[^0-9A-Za-zÀ-ɏ]+")


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


class Doc:
    """One document's lines: features (lines x width), char and word codes, look index, target class."""

    def __init__(self, sha, features, texts, looks, target):
        self.sha = sha
        self.features = features
        self.chars = padded([char_codes(t) for t in texts], CHARS)
        self.words = padded([word_codes(t) for t in texts], WORDS)
        _, self.looks = np.unique(np.asarray(looks, dtype=np.int64), return_inverse=True)
        self.target = target
        self.length = len(texts)


class Encoder(nn.Module):
    def __init__(self, width, hidden, layers):
        super().__init__()
        self.width = width
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv3 = nn.Conv1d(24, 64, 3, padding=1)
        self.conv5 = nn.Conv1d(24, 64, 5, padding=2)
        self.word = nn.Embedding(16384, 32, padding_idx=0)
        self.project = nn.Sequential(nn.Linear(width + 160, 2 * hidden), nn.GELU(), nn.Dropout(0.1))
        # The line beside how its document sets its look, and the document's mean.
        self.mix = nn.Sequential(nn.Linear(6 * hidden, 2 * hidden), nn.GELU())
        self.encoder = nn.GRU(2 * hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=0.1)
        self.head = nn.Linear(2 * hidden, CLASSES)

    def forward(self, features, chars, words, looks):
        """One document: features (n, width), chars (n, CHARS), words (n, WORDS), looks (n) -> logits (n, 34)."""
        e = self.char(chars).transpose(1, 2)
        c = torch.cat([F.relu(self.conv3(e)).max(dim=2).values, F.relu(self.conv5(e)).max(dim=2).values], dim=-1)
        mask = (words > 0).unsqueeze(-1).float()
        w = (self.word(words) * mask).sum(1) / mask.sum(1).clamp(min=1)
        x = self.project(torch.cat([features, c, w], dim=-1))
        onehot = (looks[:, None] == torch.arange(looks.max() + 1, device=looks.device)[None]).float()
        look = onehot @ ((onehot.t() @ x) / onehot.sum(0).clamp(min=1)[:, None])
        whole = x.mean(0, keepdim=True).expand_as(x)
        x = self.mix(torch.cat([x, look, whole], dim=-1))
        y, _ = self.encoder(x[None])
        return self.head(y[0])


def tensors(doc, mean, std):
    f = torch.as_tensor(np.clip((doc.features - mean) / std, -8, 8), dtype=torch.float32, device=DEVICE)
    codes = lambda a: torch.as_tensor(a.astype(np.int64), device=DEVICE)
    return f, codes(doc.chars), codes(doc.words), codes(doc.looks)


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
        doc = Doc(meta["sha256"], x, meta["texts"], meta["looks"], target)
        doc.split = partition(store, meta["sha256"])
        docs.append(doc)
    return docs


def train(model, docs, mean, std, epochs, label):
    """Every document whole, in a shuffled order, a step each; Adam with a falling rate."""
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
            if not (target >= 0).any():
                scheduler.step()
                continue
            logits = model(*tensors(doc, mean, std))
            loss = F.cross_entropy(logits, target, ignore_index=-100)
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
    return torch.softmax(model(*tensors(doc, mean, std)).float(), dim=-1).cpu().numpy().astype("<f4")


def accuracy(model, docs, mean, std):
    right = total = 0
    for doc in docs:
        p = probabilities(model, doc, mean, std).argmax(1)
        keep = doc.target >= 0
        right += int((p[keep] == doc.target[keep]).sum())
        total += int(keep.sum())
    return right / max(total, 1), total


def silver_docs(path, width):
    """The silver lines as documents of text alone: each line's kind its region, opening its unit."""
    kinds = {"paragraph": 1, "heading": 3, "quote": 4, "note": 5, "list_item": 2}
    by_doc = {}
    for raw in open(path, encoding="utf-8"):
        row = json.loads(raw)
        by_doc.setdefault(row["doc"], []).append(row)
    docs = []
    for name, rows in by_doc.items():
        rows.sort(key=lambda r: r["n"])
        target = np.asarray([kinds[r["kind"]] * 2 + 1 if r["kind"] in kinds else -100 for r in rows], dtype=np.int64)
        docs.append(Doc(name, np.zeros((len(rows), width), dtype=np.float32), [r["text"] for r in rows], [0] * len(rows), target))
    return docs


def export(model, mean, std, out, size):
    """The full encoder as ONNX (CPU, a whole document a run) and what the engine reads beside it."""
    model = model.cpu().eval()
    n = 7
    inputs = (torch.zeros(n, model.width), torch.ones(n, CHARS, dtype=torch.int64), torch.ones(n, WORDS, dtype=torch.int64), torch.zeros(n, dtype=torch.int64))
    torch.onnx.export(model, inputs, os.path.join(out, "encoder.onnx"), input_names=["features", "chars", "words", "looks"], output_names=["logits"],
                      dynamic_axes={"features": {0: "n"}, "chars": {0: "n"}, "words": {0: "n"}, "looks": {0: "n"}, "logits": {0: "n"}}, dynamo=False, opset_version=17)
    json.dump({"width": model.width, "chars": CHARS, "words": WORDS, "classes": CLASSES, "size": size, "mean": mean.tolist(), "std": std.tolist()},
              open(os.path.join(out, "encoder.json"), "w"))


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
        model = Encoder(width, size["hidden"], size["layers"]).to(DEVICE)
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
        model = Encoder(width, size["hidden"], size["layers"]).to(DEVICE)
        if args.init:
            model.load_state_dict(torch.load(args.init, map_location=DEVICE))
        return model

    def write(model, chosen):
        for doc in chosen:
            probabilities(model, doc, mean, std).tofile(os.path.join(out, "scores", f"{doc.sha}.local.f32"))

    for i in range(args.folds):
        model = fresh()
        train(model, [d for d in train_docs if fold_of(d.sha, args.folds) != i], mean, std, size["epochs"], f"fold{i}")
        write(model, [d for d in train_docs if fold_of(d.sha, args.folds) == i])
    model = fresh()
    train(model, train_docs, mean, std, size["epochs"], "full")
    write(model, others)
    dev = [d for d in others if d.split == "development"]
    print("development move accuracy, the full encoder: %.4f over %d lines" % accuracy(model, dev, mean, std), flush=True)
    torch.save(model.state_dict(), os.path.join(out, "encoder.pt"))
    export(model, mean, std, out, args.size)


if __name__ == "__main__":
    main()
