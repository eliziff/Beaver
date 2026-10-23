"""Train the tier-1 structure tagger on `structure-gold rows` output and report it against tier 0.

  python train_tagger.py ROWS_DIR --out OUT_DIR [--model gru|transformer] [--epochs N]

Each row is one piece of the parser's lines (a line cut at the parser's block boundaries) in its
reading order, with its evidence, the parser's labels (tier 0) and the gold's. The tagger reads a
whole document and predicts, per piece, its region, what starts there (inside, a unit, a resumed
unit), a document start, a note reference and, on a heading's first piece, the heading's level
(1 the outermost in its document). Parents are not predicted: the decoder derives them from
regions and levels by the hierarchy rule (CONVENTIONS section 2). A resumed piece resumes the
latest earlier unit of its region. Development selects the epoch; test is never read. Predictions
for development go to OUT_DIR/predictions-development-<model>.jsonl as {sha256, ids, labels} for
`grade --labels`.
"""
import argparse
import json
import math
import random
import re
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label"]
STARTS = ["inside", "unit", "resume"]
# Label columns: region, start, document, reference, heading level, marker, resumed row.
LABELS = 7
HEADS = [("region", 0, len(REGIONS)), ("start", 1, len(STARTS)), ("document", 2, 2), ("reference", 3, 2), ("level", 4, 10), ("marker", 5, 2)]
UNRANKED = {0, 5, 7, 10, 11, 12}
TEXT_CHARS = 32


def load(path):
    with open(path, encoding="utf-8") as stream:
        return [d for d in map(json.loads, stream) if d["ids"]]


class Vocab:
    def __init__(self, values):
        counts = {}
        for value in values:
            counts[value] = counts.get(value, 0) + 1
        self.index = {value: n + 1 for n, value in enumerate(sorted(v for v, c in counts.items() if c >= 5))}

    def __call__(self, value):
        return self.index.get(value, 0)

    def __len__(self):
        return len(self.index) + 1


def chars(text):
    codes = [min(ord(c), 0x2FFF) % 2048 + 1 for c in text[:TEXT_CHARS]]
    return codes + [0] * (TEXT_CHARS - len(codes))


FRENCH = re.compile(r"\b(le|la|les|des|du|une|est|sont|aux|dans|pour|qui|sur|par|au|ou|et|de)\b|[éèêàçùâîô]", re.I)
ENGLISH = re.compile(r"\b(the|of|and|to|in|is|for|that|by|with|or|any|shall|under|be|on|a)\b", re.I)
# Evidence beside the exported features: the piece's language.
EXTRA_FEATURES = 1


def language(text):
    """From -1 (English function words) to 1 (French), 0 where neither shows."""
    french, english = len(FRENCH.findall(text)), len(ENGLISH.findall(text))
    return (french - english) / max(french + english, 1)


class Document:
    """One document's tensors: normalized evidence, tier 0, text, reader codes, gold."""

    def __init__(self, raw, names, vocabs, mean, std):
        values = np.asarray(raw["features"], dtype=np.float32)
        self.language = np.asarray([language(t[0]) for t in raw["text"]], dtype=np.float32)
        self.features = np.concatenate([(values - mean) / std, self.language[:, None]], axis=1).astype(np.float32)
        self.tier0 = np.asarray(raw["tier0"], dtype=np.int64)
        self.text = np.asarray([chars(t[0]) for t in raw["text"]], dtype=np.int64)
        region_types, note_modes, families = vocabs
        self.reader = np.asarray([[region_types(t[1]), note_modes(t[2]), families(t[3])] for t in raw["text"]], dtype=np.int64)
        self.gold = np.asarray([g if g is not None else [-100] * LABELS for g in raw["gold"]], dtype=np.int64)
        # The level is learned on heading starts; elsewhere the column is no target.
        heading = REGIONS.index("heading")
        self.gold[(self.gold[:, 0] != heading) | (self.gold[:, 1] != 1), 4] = -100
        self.length = len(values)


class Tagger(nn.Module):
    def __init__(self, features, vocabs, kind="gru", hidden=128, layers=2, dropout=0.1, text_dropout=0.0):
        super().__init__()
        region_types, note_modes, families = vocabs
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv = nn.Conv1d(24, 64, 3, padding=1)
        self.tier0 = nn.ModuleList([nn.Embedding(n, 8) for _, _, n in HEADS])
        self.region_type = nn.Embedding(len(region_types), 8)
        self.note_mode = nn.Embedding(len(note_modes), 4)
        self.family = nn.Embedding(len(families), 8)
        width = features + 64 + 8 * len(HEADS) + 8 + 4 + 8
        self.project = nn.Sequential(nn.Linear(width, 2 * hidden), nn.GELU(), nn.Dropout(dropout))
        # Hiding a piece's text at times keeps the encoder from leaning on remembered wording.
        self.text_dropout = text_dropout
        self.kind = kind
        if kind == "gru":
            self.encoder = nn.GRU(2 * hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=dropout)
        else:
            layer = nn.TransformerEncoderLayer(2 * hidden, 4, 4 * hidden, dropout=0.1, batch_first=True, norm_first=True)
            self.encoder = nn.TransformerEncoder(layer, layers)
            self.position = nn.Embedding(1024, 2 * hidden)
        self.heads = nn.ModuleList([nn.Linear(2 * hidden, n) for _, _, n in HEADS])


    def encode(self, features, tier0, text, reader, lengths):
        """Each window's pieces' states: (windows, length, 2 * hidden)."""
        b, t, _ = features.shape
        c = self.char(text.view(b * t, TEXT_CHARS)).transpose(1, 2)
        c = F.relu(self.conv(c)).max(dim=2).values.view(b, t, -1)
        if self.training and self.text_dropout > 0:
            c = c * (torch.rand(b, t, 1, device=c.device) >= self.text_dropout)
        parts = [features, c, self.region_type(reader[..., 0]), self.note_mode(reader[..., 1]), self.family(reader[..., 2])]
        parts += [embed(tier0[..., column].clamp(min=0, max=embed.num_embeddings - 1)) for embed, (_, column, _) in zip(self.tier0, HEADS)]
        x = self.project(torch.cat(parts, dim=-1))
        if self.kind == "gru":
            # cuDNN's recurrence, in single precision.
            with torch.autocast(device_type=x.device.type, enabled=False):
                packed = nn.utils.rnn.pack_padded_sequence(x.float(), lengths.cpu(), batch_first=True, enforce_sorted=False)
                x, _ = self.encoder(packed)
                x, _ = nn.utils.rnn.pad_packed_sequence(x, batch_first=True, total_length=t)
            return x
        mask = torch.arange(t, device=x.device)[None] < lengths[:, None]
        x = x + self.position(torch.arange(t, device=x.device))[None]
        return self.encoder(x, src_key_padding_mask=~mask)

    def tag(self, states):
        return [head(states) for head in self.heads]


WINDOW, CONTEXT = 768, 128


class Windows:
    """Documents cut into windows of WINDOW pieces with CONTEXT more on each side, stacked for the
    encoder; each piece's state is read from the window that holds it in its core."""

    def __init__(self, docs, device):
        spans = [(k, max(0, core - CONTEXT), min(d.length, core + WINDOW + CONTEXT), core, min(d.length, core + WINDOW))
                 for k, d in enumerate(docs) for core in range(0, d.length, WINDOW)]
        length = max(hi - lo for _, lo, hi, _, _ in spans)
        f = torch.zeros(len(spans), length, docs[0].features.shape[1])
        t0 = torch.zeros(len(spans), length, LABELS, dtype=torch.long)
        tx = torch.zeros(len(spans), length, TEXT_CHARS, dtype=torch.long)
        rd = torch.zeros(len(spans), length, 3, dtype=torch.long)
        index = [np.zeros(d.length, dtype=np.int64) for d in docs]
        for w, (k, lo, hi, a, b) in enumerate(spans):
            d = docs[k]
            f[w, :hi - lo] = torch.from_numpy(d.features[lo:hi])
            t0[w, :hi - lo] = torch.from_numpy(d.tier0[lo:hi])
            tx[w, :hi - lo] = torch.from_numpy(d.text[lo:hi])
            rd[w, :hi - lo] = torch.from_numpy(d.reader[lo:hi])
            index[k][a:b] = w * length + np.arange(a - lo, b - lo)
        lengths = torch.as_tensor([hi - lo for _, lo, hi, _, _ in spans])
        self.inputs = [x.to(device) for x in (f, t0, tx, rd)] + [lengths.to(device)]
        self.index = [torch.as_tensor(i, device=device) for i in index]

    def states(self, model):
        """Each document's pieces' states, (pieces, 2 * hidden), in one tensor document after document."""
        x = model.encode(*self.inputs)
        flat = x.reshape(-1, x.shape[-1])
        return flat[torch.cat(self.index)]


def batches(docs, windows, rng):
    """Documents of like length together, at most `windows` encoder windows a batch."""
    order = sorted(range(len(docs)), key=lambda n: docs[n].length + rng.random() * 50)
    groups, current, used = [], [], 0
    for n in order:
        need = -(-docs[n].length // WINDOW)
        if current and used + need > windows:
            groups.append(current)
            current, used = [], 0
        current.append(n)
        used += need
    if current:
        groups.append(current)
    rng.shuffle(groups)
    return groups


def tag_loss(outputs, gold, weights):
    total = 0.0
    for output, (name, column, n) in zip(outputs, HEADS):
        total = total + F.cross_entropy(output.float(), gold[:, column], weight=weights.get(name), ignore_index=-100)
    return total


@torch.no_grad()
def predict(model, docs, device):
    """Per document: each head's prediction; the level stays on heading starts, and a resumed piece
    resumes the latest earlier unit of its region. Parents are not predicted: the decoder derives
    them from regions and levels by the hierarchy rule."""
    model.eval()
    results = []
    heading = REGIONS.index("heading")
    for doc in docs:
        states = Windows([doc], device).states(model).float()
        labels = np.zeros((doc.length, LABELS), dtype=np.int64)
        for output, (_, column, _) in zip(model.tag(states), HEADS):
            labels[:, column] = output.float().argmax(dim=-1).cpu().numpy()
        labels[:, 6] = -1
        labels[labels[:, 0] == 0, 1] = 0
        labels[(labels[:, 0] != heading) | (labels[:, 1] != 1), 4] = 0
        labels[labels[:, 1] != 1, 5] = 0
        latest = {}
        for n in range(doc.length):
            if labels[n, 1] == 2:
                labels[n, 6] = latest.get(int(labels[n, 0]), -1)
                if labels[n, 6] < 0:
                    labels[n, 1] = 1
            if labels[n, 1] == 1:
                latest[int(labels[n, 0])] = n
        results.append(labels)
    return results


def report(docs, predictions, label):
    """Per head accuracy against gold, beside tier 0."""
    lines = []
    for name, column, _ in HEADS:
        gold = np.concatenate([d.gold[:, column] for d in docs])
        mine = np.concatenate([p[:, column] for p in predictions])
        tier0 = np.concatenate([d.tier0[:, column] for d in docs])
        keep = gold != -100
        lines.append(f"{label} {name:9} n={int(keep.sum()):7} accuracy tier0 {np.mean(tier0[keep] == gold[keep]):.4f}"
                     f" model {np.mean(mine[keep] == gold[keep]):.4f}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=("gru", "transformer"), default="gru")
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--text-dropout", type=float, default=0.0)
    parser.add_argument("--train-share", type=float, default=1.0, help="train on this share of the train documents")
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--windows", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    names = json.loads((args.rows / "features.json").read_text())
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    if args.train_share < 1.0:
        train_raw = random.Random(args.seed).sample(train_raw, max(1, round(len(train_raw) * args.train_share)))
    vocabs = (Vocab(t[1] for d in train_raw for t in d["text"]), Vocab(t[2] for d in train_raw for t in d["text"]),
              Vocab(t[3] for d in train_raw for t in d["text"]))
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    train = [Document(d, names, vocabs, mean, std) for d in train_raw]
    dev = [Document(d, names, vocabs, mean, std) for d in dev_raw]
    print(f"loaded {len(train)} train / {len(dev)} development documents, {sum(d.length for d in train)} / "
          f"{sum(d.length for d in dev)} pieces in {time.time() - started:.1f}s", flush=True)
    # Starts weigh each class by the inverse square root of its frequency, at most 8:1.
    g = np.concatenate([d.gold[:, 1] for d in train])
    counts = np.bincount(g[g >= 0], minlength=len(STARTS)).astype(np.float64) + 1.0
    w = (counts.sum() / counts) ** 0.5
    w = np.minimum(w, 8 * w.min())
    weights = {"start": torch.tensor(w / w.mean(), dtype=torch.float32, device=device)}
    model = Tagger(train[0].features.shape[1], vocabs, kind=args.model, dropout=args.dropout,
                   text_dropout=args.text_dropout).to(device)
    print(f"{args.model}: {sum(p.numel() for p in model.parameters()):,} parameters", flush=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * len(batches(train, args.windows, random.Random(0)))
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    rng = random.Random(args.seed)
    best, best_state = -1.0, None
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        model.train()
        began, total, count = time.time(), 0.0, 0
        for group in batches(train, args.windows, rng):
            docs = [train[n] for n in group]
            gold = torch.as_tensor(np.concatenate([d.gold for d in docs]), device=device)
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                states = Windows(docs, device).states(model)
                outputs = model.tag(states)
            tagged = tag_loss(outputs, gold, weights)
            tagged.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step(); schedule.step()
            total += float(tagged.detach()); count += 1
        predictions = predict(model, dev, device)
        lines = report(dev, predictions, f"epoch {epoch + 1:2}")
        # Selection: region, start and level accuracy on development, alike.
        selected = float(np.mean([float(l.split("model ")[1].split()[0]) for l in (lines[0], lines[1], lines[-1])]))
        print(f"epoch {epoch + 1:2} loss {total / max(count, 1):.4f} in {time.time() - began:.1f}s; selection {selected:.4f}", flush=True)
        for l in lines:
            print("  " + l, flush=True)
        if selected > best:
            best, best_state = selected, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    torch.save({"state": best_state, "model": args.model, "vocabs": [v.index for v in vocabs],
                "mean": mean.tolist(), "std": std.tolist()}, args.out / f"tagger-{args.model}.pt")
    predictions = predict(model, dev, device)
    note = REGIONS.index("note")
    with open(args.out / f"predictions-development-{args.model}.jsonl", "w", encoding="utf-8") as pure, \
            open(args.out / f"predictions-development-{args.model}-hybrid.jsonl", "w", encoding="utf-8") as hybrid:
        for raw, labels in zip(dev_raw, predictions):
            pure.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")
            # Tier 0 keeps its notes (their pairs are its own) and its document starts.
            tier0 = np.asarray(raw["tier0"], dtype=np.int64)
            mixed = labels.copy()
            notes = (tier0[:, 0] == note) | (labels[:, 0] == note)
            mixed[notes, :2] = tier0[notes, :2]
            mixed[notes, 4:] = tier0[notes, 4:]
            # Note references are tier 0's as well: their pairs belong to its notes.
            mixed[:, 3] = tier0[:, 3]
            mixed[:, 2] = tier0[:, 2]
            hybrid.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": mixed.tolist()}) + "\n")
    for l in report(dev, predictions, "best"):
        print(l)
    print(f"done in {time.time() - started:.0f}s; best selection {best:.4f}")


if __name__ == "__main__":
    main()
