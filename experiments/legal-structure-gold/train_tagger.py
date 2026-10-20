"""Train the tier-1 line tagger on `structure-gold rows` output and report it against tier 0.

  python train_tagger.py ROWS_DIR --out OUT_DIR [--model gru|transformer|lightgbm] [--epochs N]

Each row is one source line in the parser's reading order: its evidence (geometry, typography,
text shape, reader flags), the parser's labels (tier 0) and the gold's. The tagger reads a
document's lines in order and predicts, per line, the region, what starts there (inside, a unit,
a continued fragment), the unit's relation to the unit before, a document start and a note
reference. Train fits the model; development reports it beside tier 0 and selects the epoch.
Test is never read. Predictions for development go to OUT_DIR/predictions-development.jsonl.
"""
import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label"]
STARTS = ["inside", "unit", "continuation"]
RELATIONS = ["none", "first", "child", "sibling", "up 1", "up 2", "up 3", "up 4", "up 5", "other"]
HEADS = [("region", len(REGIONS)), ("start", len(STARTS)), ("relation", len(RELATIONS)), ("document", 2), ("reference", 2)]
TEXT_CHARS = 32


def load(path):
    docs = []
    with open(path, encoding="utf-8") as stream:
        for line in stream:
            d = json.loads(line)
            if not d["ids"]:
                continue
            docs.append(d)
    return docs


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


def tensors(doc, region_types, note_modes, mean, std):
    features = (np.asarray(doc["features"], dtype=np.float32) - mean) / std
    tier0 = np.asarray(doc["tier0"], dtype=np.int64)
    text = np.asarray([chars(t[0]) for t in doc["text"]], dtype=np.int64)
    reader = np.asarray([[region_types(t[1]), note_modes(t[2])] for t in doc["text"]], dtype=np.int64)
    gold = np.asarray([g if g is not None else [-100] * 5 for g in doc["gold"]], dtype=np.int64)
    return features, tier0, text, reader, gold


class Tagger(nn.Module):
    def __init__(self, features, region_types, note_modes, kind="gru", hidden=128, layers=2):
        super().__init__()
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv = nn.Conv1d(24, 64, 3, padding=1)
        self.tier0 = nn.ModuleList([nn.Embedding(n, 8) for _, n in HEADS])
        self.region_type = nn.Embedding(len(region_types), 8)
        self.note_mode = nn.Embedding(len(note_modes), 4)
        width = features + 64 + 8 * len(HEADS) + 8 + 4
        self.project = nn.Sequential(nn.Linear(width, 2 * hidden), nn.GELU(), nn.Dropout(0.1))
        self.kind = kind
        if kind == "gru":
            self.encoder = nn.GRU(2 * hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=0.1)
        else:
            layer = nn.TransformerEncoderLayer(2 * hidden, 4, 4 * hidden, dropout=0.1, batch_first=True, norm_first=True)
            self.encoder = nn.TransformerEncoder(layer, layers)
            self.position = nn.Embedding(1024, 2 * hidden)
        self.heads = nn.ModuleList([nn.Linear(2 * hidden, n) for _, n in HEADS])

    def forward(self, features, tier0, text, reader, mask):
        b, t, _ = features.shape
        c = self.char(text.view(b * t, TEXT_CHARS)).transpose(1, 2)
        c = F.relu(self.conv(c)).max(dim=2).values.view(b, t, -1)
        parts = [features, c, self.region_type(reader[..., 0]), self.note_mode(reader[..., 1])]
        parts += [embed(tier0[..., k].clamp(min=0)) for k, embed in enumerate(self.tier0)]
        x = self.project(torch.cat(parts, dim=-1))
        if self.kind == "gru":
            x, _ = self.encoder(x)
        else:
            x = x + self.position(torch.arange(t, device=x.device).clamp(max=1023))[None]
            x = self.encoder(x, src_key_padding_mask=~mask)
        return [head(x) for head in self.heads]


def batches(docs, window, batch_size, rng):
    """Random windows of each training document, every line covered about once per epoch."""
    pieces = []
    for n, doc in enumerate(docs):
        length = len(doc[0])
        for start in range(0, length, window):
            offset = rng.randint(0, max(0, min(window // 2, length - window))) if length > window else 0
            pieces.append((n, max(0, min(start + offset, length - window)) if length > window else 0))
    rng.shuffle(pieces)
    for k in range(0, len(pieces), batch_size):
        yield pieces[k:k + batch_size]


def collate(docs, pieces, window, device):
    length = max(min(window, len(docs[n][0]) - start) for n, start in pieces)
    b = len(pieces)
    f = torch.zeros(b, length, docs[0][0].shape[1])
    t0 = torch.zeros(b, length, 5, dtype=torch.long)
    tx = torch.zeros(b, length, TEXT_CHARS, dtype=torch.long)
    rd = torch.zeros(b, length, 2, dtype=torch.long)
    gd = torch.full((b, length, 5), -100, dtype=torch.long)
    mask = torch.zeros(b, length, dtype=torch.bool)
    for k, (n, start) in enumerate(pieces):
        features, tier0, text, reader, gold = docs[n]
        end = min(start + length, len(features))
        m = end - start
        f[k, :m] = torch.from_numpy(features[start:end])
        t0[k, :m] = torch.from_numpy(tier0[start:end])
        tx[k, :m] = torch.from_numpy(text[start:end])
        rd[k, :m] = torch.from_numpy(reader[start:end])
        gd[k, :m] = torch.from_numpy(gold[start:end])
        mask[k, :m] = True
    return [x.to(device) for x in (f, t0, tx, rd, gd, mask)]


def losses(outputs, gold, weights):
    total = 0.0
    for k, (output, (name, n)) in enumerate(zip(outputs, HEADS)):
        target = gold[..., k].clone()
        if name == "relation":
            # A relation belongs to a ranked unit's first line only.
            target[(gold[..., 1] != 1) | (target == 0)] = -100
        total = total + F.cross_entropy(output.reshape(-1, n), target.reshape(-1), weight=weights.get(name), ignore_index=-100)
    return total


@torch.no_grad()
def predict(model, docs, device, window=2048):
    model.eval()
    results = []
    for doc in docs:
        length = len(doc[0])
        outputs = [np.zeros((length, n), dtype=np.float32) for _, n in HEADS]
        for start in range(0, length, window // 2):
            end = min(start + window, length)
            f, t0, tx, rd, _, mask = collate([doc], [(0, start)], end - start, device)
            for k, out in enumerate(model(f, t0, tx, rd, mask)):
                keep = slice(0 if start == 0 else window // 4, end - start)
                outputs[k][start + keep.start:end] = out[0, keep].float().cpu().numpy()
            if end == length:
                break
        results.append([o.argmax(axis=1) for o in outputs])
    return results


def report(docs, predictions, label):
    """Per head: accuracy and macro F1 over the gold's lines, the model beside tier 0."""
    lines = []
    for name_index, (name, n) in enumerate(HEADS):
        gold, model, tier0 = [], [], []
        for doc, predicted in zip(docs, predictions):
            g = doc[4][:, name_index]
            keep = g != -100
            if name == "relation":
                keep &= (doc[4][:, 1] == 1) & (g > 0)
            gold.append(g[keep]); model.append(predicted[name_index][keep]); tier0.append(doc[1][:, name_index][keep])
        gold, model, tier0 = map(np.concatenate, (gold, model, tier0))
        def macro(p):
            scores = []
            for c in np.unique(gold):
                tp = np.sum((p == c) & (gold == c)); fp = np.sum((p == c) & (gold != c)); fn = np.sum((p != c) & (gold == c))
                scores.append(2 * tp / (2 * tp + fp + fn) if tp + fp + fn else 1.0)
            return float(np.mean(scores))
        lines.append(f"{label} {name:9} n={len(gold):7} accuracy tier0 {np.mean(tier0 == gold):.4f} model {np.mean(model == gold):.4f}"
                     f" | macro-F1 tier0 {macro(tier0):.4f} model {macro(model):.4f}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=("gru", "transformer"), default="gru")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--window", type=int, default=512)
    parser.add_argument("--batch", type=int, default=24)
    parser.add_argument("--lr", type=float, default=2e-3)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    region_types = Vocab(t[1] for d in train_raw for t in d["text"])
    note_modes = Vocab(t[2] for d in train_raw for t in d["text"])
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    train = [tensors(d, region_types, note_modes, mean, std) for d in train_raw]
    dev = [tensors(d, region_types, note_modes, mean, std) for d in dev_raw]
    print(f"loaded {len(train)} train / {len(dev)} development documents, {sum(len(d[0]) for d in train)} / "
          f"{sum(len(d[0]) for d in dev)} lines in {time.time() - started:.1f}s", flush=True)
    # Class weights from train for the starts and relations: the inverse square root of each
    # class's frequency. Regions, documents and references keep their own priors: the scorer
    # counts every line alike, and a false document start reassigns all that follows it.
    weights = {}
    for k, (name, n) in enumerate(HEADS):
        if name not in ("start", "relation"):
            continue
        g = np.concatenate([d[4][:, k] for d in train])
        if name == "relation":
            g = np.concatenate([d[4][(d[4][:, 1] == 1) & (d[4][:, k] > 0), k] for d in train])
        counts = np.bincount(g[g >= 0], minlength=n).astype(np.float64) + 1.0
        w = (counts.sum() / counts) ** 0.5
        weights[name] = torch.tensor(w / w.mean(), dtype=torch.float32, device=device)
    model = Tagger(train[0][0].shape[1], region_types, note_modes, kind=args.model).to(device)
    print(f"{args.model}: {sum(p.numel() for p in model.parameters()):,} parameters", flush=True)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    steps = args.epochs * sum(1 for _ in batches(train, args.window, args.batch, random.Random(0)))
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    rng = random.Random(args.seed)
    best, best_state = -1.0, None
    args.out.mkdir(parents=True, exist_ok=True)
    for epoch in range(args.epochs):
        model.train()
        began, total, count = time.time(), 0.0, 0
        for pieces in batches(train, args.window, args.batch, rng):
            f, t0, tx, rd, gd, mask = collate(train, pieces, args.window, device)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                outputs = model(f, t0, tx, rd, mask)
            loss = losses([o.float() for o in outputs], gd, weights)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step(); schedule.step()
            total += float(loss); count += 1
        predictions = predict(model, dev, device, 2048 if args.model == "gru" else args.window)
        lines = report(dev, predictions, f"epoch {epoch + 1:2}")
        # Selection: mean of the region, start and relation accuracy on development, as the
        # scorer counts lines alike.
        selected = np.mean([float(l.split("model ")[1].split()[0]) for l in lines[:3]])
        print(f"epoch {epoch + 1:2} loss {total / max(count, 1):.4f} in {time.time() - began:.1f}s; selection {selected:.4f}", flush=True)
        for l in lines: print("  " + l, flush=True)
        if selected > best:
            best, best_state = selected, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    torch.save({"state": best_state, "model": args.model, "region_types": region_types.index, "note_modes": note_modes.index,
                "mean": mean.tolist(), "std": std.tolist()}, args.out / f"tagger-{args.model}.pt")
    predictions = predict(model, dev, device, 2048 if args.model == "gru" else args.window)
    note = REGIONS.index("note")
    with open(args.out / f"predictions-development-{args.model}.jsonl", "w", encoding="utf-8") as pure, \
            open(args.out / f"predictions-development-{args.model}-hybrid.jsonl", "w", encoding="utf-8") as hybrid:
        for raw, predicted in zip(dev_raw, predictions):
            labels = np.stack(predicted, axis=1)
            pure.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")
            # Tier 0 keeps its notes (their pairs are its own) and its document starts; the model
            # decides the other regions, what starts where, and each unit's relation.
            tier0 = np.asarray(raw["tier0"], dtype=np.int64)
            mixed = labels.copy()
            notes = (tier0[:, 0] == note) | (labels[:, 0] == note)
            mixed[notes, 0] = tier0[notes, 0]
            mixed[notes, 1] = tier0[notes, 1]
            mixed[:, 3] = tier0[:, 3]
            hybrid.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": mixed.tolist()}) + "\n")
    for l in report(dev, predictions, "best"): print(l)
    print(f"done in {time.time() - started:.0f}s; best selection {best:.4f}")


if __name__ == "__main__":
    main()
