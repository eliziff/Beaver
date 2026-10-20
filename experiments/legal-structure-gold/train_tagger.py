"""Train the tier-1 structure tagger on `structure-gold rows` output and report it against tier 0.

  python train_tagger.py ROWS_DIR --out OUT_DIR [--model gru|transformer] [--epochs N]

Each row is one piece of the parser's lines (a line cut at the parser's block boundaries) in its
reading order, with its evidence, the parser's labels (tier 0) and the gold's. The tagger reads a
whole document and predicts, per piece, its region, what starts there (inside, a unit, a resumed
unit), a document start and a note reference; and, for each piece that opens a unit, the earlier
unit it falls under, or none. Parents are pointed at, the way HRDoc and Detect-Order-Construct
build a document's tree: attention over the unit starts in reach, each scored with the pair's own
evidence (indentation, type, numbering, distance, the parser's own choice, and whether a unit of
the candidate's type has closed it since). A resumed piece resumes the latest earlier unit of its
region. Development selects the epoch; test is never read. Predictions for development go to
OUT_DIR/predictions-development-<model>.jsonl as {sha256, ids, labels} for `grade --labels`.
"""
import argparse
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

REGIONS = ["none", "text", "list_item", "heading", "quote", "note", "table", "contents", "caption", "headnote",
           "marginal_note", "furniture", "page_label"]
STARTS = ["inside", "unit", "resume"]
# Label columns: region, start, relation, document, reference, parent row, resumed row.
HEADS = [("region", 0, len(REGIONS)), ("start", 1, len(STARTS)), ("document", 3, 2), ("reference", 4, 2)]
UNRANKED = {0, 5, 7, 10, 11, 12}
TEXT_CHARS = 32
REACH = 384
PAIR_FEATURES = 32


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


class Document:
    """One document's tensors: normalized evidence, tier 0, text, reader codes, raw pair evidence, gold."""

    def __init__(self, raw, names, vocabs, mean, std):
        values = np.asarray(raw["features"], dtype=np.float32)
        self.features = (values - mean) / std
        self.tier0 = np.asarray(raw["tier0"], dtype=np.int64)
        self.text = np.asarray([chars(t[0]) for t in raw["text"]], dtype=np.int64)
        region_types, note_modes, families = vocabs
        self.reader = np.asarray([[region_types(t[1]), note_modes(t[2]), families(t[3])] for t in raw["text"]], dtype=np.int64)
        self.gold = np.asarray([g if g is not None else [-100] * 7 for g in raw["gold"]], dtype=np.int64)
        column = {name: values[:, names.index(name)] for name in
                  ("x0", "size", "bold", "italic", "upper", "centre", "ends_colon", "marker", "ordinal", "prefix_depth", "indent")}
        ordinal = np.where(column["marker"] > 0, np.round(np.exp(column["ordinal"] * 5.0) - 1.0), -1.0)
        self.family = self.reader[:, 2].astype(np.int64) * (column["marker"] > 0)
        self.pair = np.stack([column["x0"], np.log(np.maximum(column["size"], 1e-3)), column["bold"], column["italic"],
                              column["upper"], column["centre"], column["ends_colon"], column["marker"], ordinal,
                              column["prefix_depth"], np.asarray(raw["pages"], dtype=np.float32)], axis=1).astype(np.float32)
        # A unit's type, for closing: size, weight, slope, capitals, numbering family and depth, indentation.
        self.style = [(round(float(column["size"][n]) * 10), bool(column["bold"][n] > 0.5), bool(column["italic"][n] > 0.5),
                       bool(column["upper"][n] > 0.6), int(self.family[n]), round(float(column["prefix_depth"][n]) * 3),
                       round(float(column["indent"][n]) * 40)) for n in range(len(values))]
        ids = {}
        self.style_id = np.asarray([ids.setdefault(s, len(ids)) for s in self.style], dtype=np.int64)
        # The type alone, and its place among the document's types, most prominent first.
        loose = [s[:4] for s in self.style]
        ladder = sorted(set(loose), key=lambda s: (-s[0], not s[1], not s[3], not s[2]))
        place = {s: k for k, s in enumerate(ladder)}
        self.loose_id = np.asarray([place[s] for s in loose], dtype=np.int64)
        self.length = len(values)


class Starts:
    """Unit starts and their candidates: for each query start, the starts before it in reach."""

    def __init__(self, doc, rows, queries, device):
        rows = np.asarray(rows, dtype=np.int64)
        queries = np.asarray(queries, dtype=np.int64)
        rank = {int(r): k for k, r in enumerate(rows)}
        query_rank = np.asarray([rank[int(r)] for r in queries], dtype=np.int64)
        candidate_rank = query_rank[:, None] - np.arange(1, REACH + 1)[None, :]
        valid = candidate_rank >= 0
        safe = np.clip(candidate_rank, 0, None)
        candidates = np.where(valid, rows[safe], -1)
        # Whether a unit of the candidate's own type, or of its numbering, opens again before the query.
        never = 1 << 30
        next_style, next_family = np.full(len(rows), never), np.full(len(rows), never)
        seen_style, seen_family = {}, {}
        for k in range(len(rows) - 1, -1, -1):
            row = int(rows[k])
            style = doc.style[row]
            next_style[k] = seen_style.get(style, never)
            seen_style[style] = k
            if doc.family[row] > 0:
                family = (int(doc.family[row]), style[5])
                next_family[k] = seen_family.get(family, never)
                seen_family[family] = k
        closed_style = valid & (next_style[safe] < query_rank[:, None])
        closed_family = valid & (next_family[safe] < query_rank[:, None])
        heading = np.cumsum(np.concatenate([[0], (doc.tier0[rows, 0] == 3).astype(np.int64)]))
        between = np.where(valid, heading[query_rank][:, None] - heading[np.minimum(safe + 1, len(rows))], 0)
        held = np.clip(candidates, 0, None)
        p, c = doc.pair[queries][:, None, :], doc.pair[held]
        shape = c[..., 0].shape
        same_family = (p[..., 7] > 0) & (c[..., 7] > 0) & (doc.family[queries][:, None] == doc.family[held])
        own, theirs = doc.tier0[queries, 0][:, None], doc.tier0[held, 0]
        kinds = [np.broadcast_to(own == r, shape) for r in (1, 2, 3)] + [theirs == r for r in (1, 2, 3)]
        features = np.stack([
            p[..., 0] - c[..., 0], p[..., 1] - c[..., 1], np.broadcast_to(p[..., 2], shape), c[..., 2],
            np.broadcast_to(p[..., 3], shape), c[..., 3], np.broadcast_to(p[..., 4], shape), c[..., 4],
            c[..., 5], c[..., 6], same_family, same_family & (p[..., 8] == c[..., 8] + 1) & (p[..., 9] == c[..., 9]),
            p[..., 9] - c[..., 9], np.log1p(np.maximum(query_rank[:, None] - candidate_rank, 0)),
            np.log1p(np.maximum(queries[:, None] - candidates, 0)) / 2.0,
            np.clip(p[..., 10] - c[..., 10], 0, 8) / 4.0, doc.tier0[queries, 5][:, None] == candidates,
            closed_style, closed_family, np.log1p(np.maximum(between, 0)), (query_rank[:, None] - candidate_rank) == 1,
            p[..., 10] == c[..., 10],
            # A unit set like the candidate is its sibling; one set less prominently may be its child.
            doc.style_id[queries][:, None] == doc.style_id[held], doc.loose_id[queries][:, None] == doc.loose_id[held],
            np.abs(p[..., 0] - c[..., 0]) < 0.012, np.clip(doc.loose_id[queries][:, None] - doc.loose_id[held], -10, 10) / 5.0,
            *kinds,
        ], axis=-1).astype(np.float32)
        features[~valid] = 0.0
        self.queries = queries
        self.candidates = candidates
        self.query = torch.as_tensor(queries, device=device)
        self.candidate = torch.as_tensor(candidates, device=device)
        self.pair = torch.as_tensor(features, device=device)

    def target(self, parents):
        """Each query's gold parent as a column: its place among the candidates, or the last (none)."""
        target = []
        for k, parent in enumerate(parents):
            if parent < 0:
                target.append(REACH)
            else:
                hit = np.nonzero(self.candidates[k] == parent)[0]
                target.append(int(hit[0]) if len(hit) else -100)
        return torch.as_tensor(target, device=self.query.device)


class Tagger(nn.Module):
    def __init__(self, features, vocabs, kind="gru", hidden=128, layers=2, key=128):
        super().__init__()
        region_types, note_modes, families = vocabs
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv = nn.Conv1d(24, 64, 3, padding=1)
        self.tier0 = nn.ModuleList([nn.Embedding(n, 8) for _, _, n in HEADS])
        self.region_type = nn.Embedding(len(region_types), 8)
        self.note_mode = nn.Embedding(len(note_modes), 4)
        self.family = nn.Embedding(len(families), 8)
        width = features + 64 + 8 * len(HEADS) + 8 + 4 + 8
        self.project = nn.Sequential(nn.Linear(width, 2 * hidden), nn.GELU(), nn.Dropout(0.1))
        self.kind = kind
        if kind == "gru":
            self.encoder = nn.GRU(2 * hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True, dropout=0.1)
        else:
            layer = nn.TransformerEncoderLayer(2 * hidden, 4, 4 * hidden, dropout=0.1, batch_first=True, norm_first=True)
            self.encoder = nn.TransformerEncoder(layer, layers)
            self.position = nn.Embedding(1024, 2 * hidden)
        self.heads = nn.ModuleList([nn.Linear(2 * hidden, n) for _, _, n in HEADS])
        self.query = nn.Linear(2 * hidden, key)
        self.keys = nn.Linear(2 * hidden, key)
        self.root = nn.Parameter(torch.zeros(key))
        self.root_bias = nn.Parameter(torch.zeros(1))
        self.pair = nn.Sequential(nn.Linear(PAIR_FEATURES, 64), nn.GELU(), nn.Linear(64, 1))
        self.scale = 1.0 / math.sqrt(key)


    def encode(self, features, tier0, text, reader, lengths):
        """Each window's pieces' states: (windows, length, 2 * hidden)."""
        b, t, _ = features.shape
        c = self.char(text.view(b * t, TEXT_CHARS)).transpose(1, 2)
        c = F.relu(self.conv(c)).max(dim=2).values.view(b, t, -1)
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

    def parents(self, states, starts):
        """Scores of each query start's earlier units in reach; the last column is none."""
        q = self.query(states[starts.query])
        attention = (q @ self.keys(states).T) * self.scale
        scores = attention.gather(1, starts.candidate.clamp(min=0)) + self.pair(starts.pair).squeeze(-1)
        scores = scores.masked_fill(starts.candidate < 0, float("-inf"))
        root = (q @ self.root) * self.scale + self.root_bias
        return torch.cat([scores, root[:, None]], dim=1)


WINDOW, CONTEXT = 768, 128


class Windows:
    """Documents cut into windows of WINDOW pieces with CONTEXT more on each side, stacked for the
    encoder; each piece's state is read from the window that holds it in its core."""

    def __init__(self, docs, device):
        spans = [(k, max(0, core - CONTEXT), min(d.length, core + WINDOW + CONTEXT), core, min(d.length, core + WINDOW))
                 for k, d in enumerate(docs) for core in range(0, d.length, WINDOW)]
        length = max(hi - lo for _, lo, hi, _, _ in spans)
        f = torch.zeros(len(spans), length, docs[0].features.shape[1])
        t0 = torch.zeros(len(spans), length, 7, dtype=torch.long)
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


def gold_starts(doc):
    """The gold's unit starts (candidates) and its ranked unit starts with a parent to learn (queries)."""
    g = doc.gold
    rows = np.nonzero((g[:, 1] == 1) & (g[:, 0] > 0))[0]
    queries = [int(r) for r in rows if g[r, 0] not in UNRANKED and g[r, 5] != -100]
    return rows, queries


def tag_loss(outputs, gold, weights):
    total = 0.0
    for output, (name, column, n) in zip(outputs, HEADS):
        total = total + F.cross_entropy(output.float(), gold[:, column], weight=weights.get(name), ignore_index=-100)
    return total


CHUNK = 1024


def parent_chunks(doc, device):
    """The gold's parent queries in chunks, each with its candidates and target columns."""
    rows, queries = gold_starts(doc)
    for k in range(0, len(queries), CHUNK):
        starts = Starts(doc, rows, queries[k:k + CHUNK], device)
        target = starts.target(doc.gold[starts.queries, 5])
        if (target >= 0).any():
            yield starts, target


@torch.no_grad()
def predict(model, docs, device):
    """Per document: each head's prediction, parents chosen among the predicted unit starts, and
    how many of the gold's parents the model points at over the gold's own unit starts."""
    model.eval()
    results, correct = [], 0
    for doc in docs:
        states = Windows([doc], device).states(model).float()
        labels = np.zeros((doc.length, 7), dtype=np.int64)
        for output, (_, column, _) in zip(model.tag(states), HEADS):
            labels[:, column] = output.float().argmax(dim=-1).cpu().numpy()
        labels[:, 5:] = -1
        labels[labels[:, 0] == 0, 1] = 0
        rows = np.nonzero((labels[:, 1] == 1) & (labels[:, 0] > 0))[0]
        for k in range(0, len(rows), CHUNK):
            starts = Starts(doc, rows, rows[k:k + CHUNK], device)
            choice = model.parents(states, starts).argmax(dim=1).cpu().numpy()
            for i, (q, c) in enumerate(zip(starts.queries, choice)):
                labels[q, 5] = -1 if c == REACH else int(starts.candidates[i, c])
        # A resumed piece resumes the latest earlier unit of its region.
        latest = {}
        for n in range(doc.length):
            if labels[n, 1] == 2:
                labels[n, 6] = latest.get(int(labels[n, 0]), -1)
                if labels[n, 6] < 0:
                    labels[n, 1] = 1
            if labels[n, 1] == 1:
                latest[int(labels[n, 0])] = n
        results.append(labels)
        for starts, target in parent_chunks(doc, device):
            keep = target >= 0
            correct += int((model.parents(states, starts)[keep].argmax(dim=1) == target[keep]).sum())
    return results, correct


def report(docs, predictions, correct, label):
    """Per head accuracy against gold, beside tier 0; parents over the gold's own unit starts."""
    lines = []
    for name, column, _ in HEADS:
        gold = np.concatenate([d.gold[:, column] for d in docs])
        mine = np.concatenate([p[:, column] for p in predictions])
        tier0 = np.concatenate([d.tier0[:, column] for d in docs])
        keep = gold != -100
        lines.append(f"{label} {name:9} n={int(keep.sum()):7} accuracy tier0 {np.mean(tier0[keep] == gold[keep]):.4f}"
                     f" model {np.mean(mine[keep] == gold[keep]):.4f}")
    queries = parser = 0
    for doc in docs:
        _, asked = gold_starts(doc)
        queries += len(asked)
        parser += int(sum(doc.tier0[q, 5] == doc.gold[q, 5] for q in asked))
    lines.append(f"{label} parent    n={queries:7} accuracy tier0 {parser / max(queries, 1):.4f} model {correct / max(queries, 1):.4f}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--model", choices=("gru", "transformer"), default="gru")
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
    model = Tagger(train[0].features.shape[1], vocabs, kind=args.model).to(device)
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
            loss = tagged
            # Parents chunk by chunk over a detached copy of the states, each chunk's pairs freed by
            # its own backward pass; their gradient then reaches the encoder in one pass with the rest.
            offsets = np.cumsum([0] + [d.length for d in docs])
            chunks = [(k, starts, target) for k, doc in enumerate(docs) for starts, target in parent_chunks(doc, device)]
            pointed = sum(int((target >= 0).sum()) for _, _, target in chunks)
            pointer = 0.0
            if pointed:
                held = states.detach().float().requires_grad_()
                for k, starts, target in chunks:
                    keep = target >= 0
                    scores = model.parents(held[offsets[k]:offsets[k + 1]], starts)
                    part = F.cross_entropy(scores[keep], target[keep], reduction="sum") / pointed
                    part.backward()
                    pointer += float(part.detach())
                loss = loss + (states.float() * held.grad).sum()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step(); schedule.step()
            total += float(tagged.detach()) + pointer; count += 1
        predictions, correct = predict(model, dev, device)
        lines = report(dev, predictions, correct, f"epoch {epoch + 1:2}")
        # Selection: region, start and parent accuracy on development, alike.
        selected = float(np.mean([float(l.split("model ")[1].split()[0]) for l in (lines[0], lines[1], lines[-1])]))
        print(f"epoch {epoch + 1:2} loss {total / max(count, 1):.4f} in {time.time() - began:.1f}s; selection {selected:.4f}", flush=True)
        for l in lines:
            print("  " + l, flush=True)
        if selected > best:
            best, best_state = selected, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    torch.save({"state": best_state, "model": args.model, "vocabs": [v.index for v in vocabs],
                "mean": mean.tolist(), "std": std.tolist()}, args.out / f"tagger-{args.model}.pt")
    predictions, correct = predict(model, dev, device)
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
            mixed[notes, 5:] = tier0[notes, 5:]
            mixed[:, 3] = tier0[:, 3]
            hybrid.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": mixed.tolist()}) + "\n")
    for l in report(dev, predictions, correct, "best"):
        print(l)
    print(f"done in {time.time() - started:.0f}s; best selection {best:.4f}")


if __name__ == "__main__":
    main()
