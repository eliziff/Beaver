"""Heading edits: promote, demote, split and merge the parser's headings. A narrow model over one
document's heading candidates at once (its unit starts, every short line start inside a unit, and
every line of a heading), each read with its own evidence, the evidence of the pieces before and
after it, its whole text, the parser's own call, what the document's own outline says of it (its
bookmarks and its printed contents: whether they name it, at what level), and how its enumerator
stands in the run of headings before it. For each candidate it gives p(starts a heading) and p(goes
on the heading before it). The labels are then edited: a heading start below the demote threshold
becomes text, a non-heading above the promote threshold starts a heading (split out of its unit), a
line inside a heading below the split threshold opens a text unit, a unit after a heading above the
merge threshold joins it; every heading step is rebuilt from the levels that remain. Thresholds are
chosen on one half of development and scored on the other, both ways, by whole heading units (their
start and their extent); test is never read. Vision (`vision_features.py`) stays optional.

  python train_heading_edits.py ROWS_DIR --inputs DIR [DIR ...] --out OUT_DIR [--epochs N]

Writes OUT_DIR/edits-development.jsonl ({sha256, ids, labels}) for `grade --labels`, and
OUT_DIR/parser-development.jsonl, the labels edited, through the same decoder: the fair baseline.
"""
import argparse
import gzip
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

from train_tagger import REGIONS, chars, load, sight, words

HEADING, TEXT, CONTENTS = REGIONS.index("heading"), REGIONS.index("text"), REGIONS.index("contents")
DEEPEST = 9
# A line start inside a unit is a candidate where its piece holds at most this many characters.
SHORT = 120
# The parser's heading sources (the reader that made a line a heading), as the rows carry them.
SOURCES = ["", "layout", "native", "styled", "outline", "rules", "rules_promoted", "rules_lifted", "later"]


def source_of(raw, k):
    entry = raw["text"][k]
    return SOURCES.index(entry[4]) if len(entry) > 4 and entry[4] in SOURCES else 0
FAMILIES = [
    ("decimal", r"\d+(\.\d+)+\.?"), ("arabic", r"\d+[.)]"), ("(arabic)", r"\(\d+\)"),
    ("ROMAN", r"[IVXLC]+[.)]"), ("(roman)", r"\([ivxlc]+\)"), ("roman", r"[ivxlc]+[.)]"),
    ("LETTER", r"[A-Z][.)]"), ("(letter)", r"\([a-z]\)"), ("letter", r"[a-z][.)]"),
    ("word", r"(?i)(part|chapter|article|section|schedule|appendix|partie|chapitre|annexe)\s+\S+"),
]
ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}


def normal(text):
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def without_locator(text):
    return re.sub(r"[\s.·…_\-]*(\d+|[ivxlc]+)\s*$", "", text.strip(), flags=re.I)


def roman(token):
    total, last = 0, 0
    for c in reversed(token.lower()):
        v = ROMAN.get(c, 0)
        total, last = (total - v, last) if v < last else (total + v, v)
    return total


def enumerator(text):
    """(family index, value) of the enumerator a text opens with; (len(FAMILIES), 0) where none."""
    t = text.strip()
    for n, (name, pattern) in enumerate(FAMILIES):
        found = re.match(pattern + r"(\s|$)", t)
        if not found:
            continue
        token = found.group(0).strip().strip("().")
        if name == "decimal":
            return n, int(token.split(".")[-1] or 0)
        if name in ("arabic", "(arabic)"):
            return n, int(re.sub(r"\D", "", token) or 0)
        if name in ("ROMAN", "(roman)", "roman"):
            return n, roman(token)
        if name in ("LETTER", "(letter)", "letter"):
            return n, ord(token[:1].lower()) - 96
        return n, 0
    return len(FAMILIES), 0


def witnesses(raw, extraction, picked):
    """Per candidate: what the document's bookmarks and printed contents say of it, and how its
    enumerator stands in the run of the parser's headings before it."""
    texts = [t[0] for t in raw["text"]]
    tier0 = np.asarray(raw["tier0"], dtype=np.int64)
    pages = raw["pages"]
    entries = [(normal(e["title"]), e["level"], e["page_index"]) for e in (extraction or {}).get("outline", [])]
    entries = [e for e in entries if len(e[0]) >= 3]
    listed_x = [raw["features"][k][0] for k in range(len(texts)) if tier0[k, 0] == CONTENTS]
    tiers = sorted({round(x, 2) for x in listed_x})
    listed = [(normal(without_locator(texts[k])), tiers.index(round(raw["features"][k][0], 2)) if tiers else 0)
              for k in range(len(texts)) if tier0[k, 0] == CONTENTS]
    listed = [e for e in listed if len(e[0]) >= 3]

    def match(own, pool):
        for n, entry in enumerate(pool):
            if own == entry[0] or (len(own) >= 6 and len(entry[0]) >= 6 and (own in entry[0] or entry[0] in own)):
                return n
        return None

    rows = []
    last_value = {}
    count = {}
    for i, k in enumerate(picked):
        own = normal(texts[k])
        joined = normal(texts[k] + " " + texts[k + 1]) if k + 1 < len(texts) and len(texts[k + 1].strip()) <= SHORT else own
        b = match(own, entries) if len(own) >= 3 else None
        b = b if b is not None else (match(joined, entries) if len(joined) >= 3 else None)
        c = match(own, listed) if len(own) >= 3 else None
        c = c if c is not None else (match(joined, listed) if len(joined) >= 3 else None)
        family, value = enumerator(texts[k])
        onehot = [0.0] * (len(FAMILIES) + 1)
        onehot[family] = 1.0
        named = family < len(FAMILIES)
        continues = float(named and value > 0 and last_value.get(family) == value - 1)
        rows.append([
            float(b is not None), (entries[b][1] / DEEPEST) if b is not None else 0.0,
            min(abs(pages[k] - entries[b][2]), 5) / 5 if b is not None else 1.0,
            float(c is not None), (listed[c][1] / 6) if c is not None else 0.0,
            min(len(entries), 100) / 100, max([e[1] for e in entries], default=0) / DEEPEST, min(len(listed), 200) / 200,
            min(value, 50) / 50, continues, float(named and value == 1), min(count.get(family, 0), 20) / 20,
        ] + onehot)
        if tier0[k, 0] == HEADING and tier0[k, 1] == 1 and named:
            last_value[family] = value
            count[family] = count.get(family, 0) + 1
    return np.asarray(rows, dtype=np.float32).reshape(len(picked), 12 + len(FAMILIES) + 1)


def heading_units(labels, starts=None):
    """Each heading unit as (first piece, last piece): its start and the pieces that go on it."""
    units = []
    n = len(labels)
    for k in range(n):
        if labels[k][0] == HEADING and labels[k][1] == 1:
            end = k
            while end + 1 < n and labels[end + 1][1] == 0 and labels[end + 1][0] == HEADING:
                end += 1
            units.append((k, end))
    return units


class Candidates:
    """One document's heading candidates, in reading order, and everything the model reads of them."""

    def __init__(self, raw, names, mean, std, vision, extraction, base=None):
        tier0 = np.asarray(raw["tier0"], dtype=np.int64)
        # The labels the edits are made to: the parser's, or another model's (--base).
        self.base = np.asarray(base, dtype=np.int64) if base is not None else tier0
        gold = raw["gold"]
        self.raw, self.tier0 = raw, tier0
        raw_values = np.asarray(raw["features"], dtype=np.float32)
        # Unit starts, every short line start inside a unit (a heading glued to the unit before it),
        # and every line inside one of the labels' headings (where a heading may end early).
        line_start = raw_values[:, names.index("piece_start")] == 0
        short = np.asarray([len(t[0].strip()) <= SHORT for t in raw["text"]])
        inside_heading = (self.base[:, 0] == HEADING) & (self.base[:, 1] == 0)
        self.picked = np.flatnonzero((self.base[:, 1] == 1) | (tier0[:, 1] == 1) | (line_start & (short | inside_heading)))
        values = (raw_values - mean) / std
        before = np.concatenate([np.zeros((1, values.shape[1]), np.float32), values[:-1]])
        after = np.concatenate([values[1:], np.zeros((1, values.shape[1]), np.float32)])
        k = self.picked
        self.features = np.concatenate([values[k], before[k], after[k], witnesses(raw, extraction, k)], axis=1)
        texts = [raw["text"][i][0] for i in k]
        self.text, self.words = chars(texts), words(texts)
        self.sight = sight(raw, vision)[k]
        self.call = np.stack([np.minimum(tier0[k, 0], len(REGIONS) - 1), tier0[k, 1], np.minimum(tier0[k, 4], 18),
                              np.asarray([source_of(raw, i) for i in k], dtype=np.int64)], axis=1).reshape(len(k), 4)
        # Candidates the edits may not demote: parser headings from a source measured reliable.
        self.protected = np.zeros(len(k), dtype=bool)
        self.gold = np.asarray([[float(g is not None and g[0] == HEADING and g[1] == 1), float(g is not None and g[0] == HEADING and g[1] == 0)]
                                for g in (gold[i] for i in k)], dtype=np.float32).reshape(len(k), 2)
        self.gold_units = set(heading_units([g if g is not None else [0, 0] for g in gold]))


def sinusoid(n, width, device):
    position = torch.arange(n, device=device, dtype=torch.float32)[:, None]
    scale = torch.exp(torch.arange(0, width, 2, device=device, dtype=torch.float32) * (-math.log(10000.0) / width))
    table = torch.zeros(n, width, device=device)
    table[:, 0::2] = torch.sin(position * scale)
    table[:, 1::2] = torch.cos(position * scale)
    return table


class Editor(nn.Module):
    def __init__(self, features, vision, width=192, layers=3):
        super().__init__()
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv3 = nn.Conv1d(24, 64, 3, padding=1)
        self.conv5 = nn.Conv1d(24, 64, 5, padding=2)
        self.word = nn.Embedding(16384, 32, padding_idx=0)
        self.region = nn.Embedding(len(REGIONS), 8)
        self.start = nn.Embedding(3, 4)
        self.step = nn.Embedding(19, 8)
        self.source = nn.Embedding(len(SOURCES), 8)
        self.see = nn.Sequential(nn.LayerNorm(vision), nn.Linear(vision, 64), nn.GELU()) if vision else None
        inputs = features + 64 + 64 + 32 + 8 + 4 + 8 + 8 + (64 if vision else 0)
        self.project = nn.Sequential(nn.Linear(inputs, width), nn.GELU(), nn.Dropout(0.1))
        layer = nn.TransformerEncoderLayer(width, 4, 4 * width, dropout=0.1, batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, layers)
        # Two outputs a candidate: it starts a heading; it goes on the heading before it.
        self.out = nn.Linear(width, 2)

    def forward(self, features, text, word, sight_, call):
        n = features.shape[0]
        reads = []
        for lo in range(0, n, 2048):
            chunk = text[lo:lo + 2048]
            chunk = chunk[:, :max(1, int((chunk > 0).sum(dim=1).max()))]
            e = self.char(chunk).transpose(1, 2)
            reads.append(torch.cat([F.relu(self.conv3(e)).max(2).values, F.relu(self.conv5(e)).max(2).values], dim=1))
        c = torch.cat(reads)
        mask = (word > 0).unsqueeze(-1).float()
        w = (self.word(word) * mask).sum(1) / mask.sum(1).clamp(min=1)
        parts = [features, c, w, self.region(call[:, 0]), self.start(call[:, 1]), self.step(call[:, 2]), self.source(call[:, 3])]
        if self.see is not None:
            parts.append(self.see(sight_))
        x = self.project(torch.cat(parts, dim=1))
        x = x + sinusoid(n, x.shape[1], x.device)
        return self.out(self.encoder(x[None])[0])


def tensors(doc, device):
    return (torch.from_numpy(doc.features).to(device), torch.from_numpy(doc.text).to(device), torch.from_numpy(doc.words).to(device),
            torch.from_numpy(doc.sight).to(device), torch.from_numpy(doc.call).to(device))


@torch.no_grad()
def probabilities(model, docs, device):
    model.eval()
    return [torch.sigmoid(model(*tensors(d, device)).float()).cpu().numpy() if len(d.picked) else np.zeros((0, 2)) for d in docs]


def edited(doc, p, demote, promote, split=0.0, merge=1.01):
    """The labels with the edits made and every heading step rebuilt from the levels kept."""
    labels = doc.base.copy()
    n = len(labels)
    level, levels = None, {}
    for k in np.flatnonzero((labels[:, 0] == HEADING) & (labels[:, 1] == 1)):
        level = min(DEEPEST, max(1, (level or 1) + int(labels[k, 4]) - 10)) if labels[k, 4] else (level or 1)
        levels[int(k)] = level
    start = {int(k): p[i, 0] for i, k in enumerate(doc.picked)}
    protected = {int(k) for i, k in enumerate(doc.picked) if doc.protected[i]}
    goes_on = {int(k): p[i, 1] for i, k in enumerate(doc.picked)}
    # Starts: demote and promote.
    for k in map(int, doc.picked):
        heading = labels[k, 0] == HEADING and labels[k, 1] == 1
        if heading and start[k] < demote and k not in protected:
            labels[k, 0], labels[k, 4], labels[k, 7] = TEXT, 0, 10
            levels.pop(k, None)
            # The heading's own further lines go with it into the text unit.
            j = k + 1
            while j < n and labels[j, 1] == 0 and labels[j, 0] == HEADING:
                labels[j, 0] = TEXT
                j += 1
        elif not heading and (start[k] >= promote or k in protected):
            inside = labels[k, 1] != 1
            region = labels[k, 0]
            labels[k, 0], labels[k, 1], labels[k, 4], labels[k, 7] = HEADING, 1, 0, 0
            levels[k] = None
            # A heading split out of a unit: the unit's rest opens a unit of its own, of its region.
            if inside and k + 1 < n and labels[k + 1, 1] == 0 and region != HEADING:
                labels[k + 1, 1], labels[k + 1, 7] = 1, 10
                j = k + 1
                while j < n and (j == k + 1 or labels[j, 1] == 0):
                    labels[j, 0] = region
                    j += 1
    # Extents: a heading line that does not go on its heading opens text; a unit that does joins it.
    in_heading = False
    for k in range(n):
        if labels[k, 0] == HEADING and labels[k, 1] == 1:
            in_heading = True
            continue
        if not in_heading:
            continue
        if labels[k, 1] == 0 and labels[k, 0] == HEADING:
            if k in goes_on and goes_on[k] < split:
                labels[k, 0], labels[k, 1], labels[k, 7] = TEXT, 1, 10
                j = k + 1
                while j < n and labels[j, 1] == 0 and labels[j, 0] == HEADING:
                    labels[j, 0] = TEXT
                    j += 1
                in_heading = False
        elif labels[k, 1] == 1 and labels[k, 0] != HEADING and k in goes_on and goes_on[k] >= merge and start.get(k, 0.0) < promote:
            labels[k, 0], labels[k, 1], labels[k, 4], labels[k, 7] = HEADING, 0, 0, 0
            j = k + 1
            while j < n and labels[j, 1] == 0:
                labels[j, 0] = HEADING
                j += 1
        else:
            in_heading = False
    previous = None
    for k in sorted(levels):
        if not (labels[k, 0] == HEADING and labels[k, 1] == 1):
            continue
        level = levels[k] if levels[k] is not None else (previous or 1)
        labels[k, 4] = 10 + level - (previous or 1)
        previous = level
    return labels


def unit_f1(docs, ps, thresholds):
    """Whole heading units (start and extent) against the gold's."""
    correct = predicted = expected = 0
    for d, p in zip(docs, ps):
        mine = set(heading_units(edited(d, p, *thresholds)))
        correct += len(mine & d.gold_units)
        predicted += len(mine)
        expected += len(d.gold_units)
    return 2 * correct / max(predicted + expected, 1)


GRID = [round(x, 2) for x in np.arange(0.05, 0.96, 0.05)]
# Epoch selection reads a coarser grid; the final thresholds the full one.
COARSE = [0.1, 0.3, 0.5, 0.7, 0.9]


def choose(docs, ps, grid=GRID, extents=True):
    """Start thresholds first (extents untouched), then the extent thresholds given them."""
    best = (unit_f1(docs, ps, (0.0, 1.01)), 0.0, 1.01)
    for demote in grid + [0.0]:
        for promote in grid + [1.01]:
            if promote > demote:
                f = unit_f1(docs, ps, (demote, promote))
                if f > best[0]:
                    best = (f, demote, promote)
    f, demote, promote = best
    full = (f, demote, promote, 0.0, 1.01)
    for split in (grid + [0.0]) if extents else []:
        for merge in grid + [1.01]:
            f = unit_f1(docs, ps, (demote, promote, split, merge))
            if f > full[0]:
                full = (f, demote, promote, split, merge)
    return full


def extraction_of(sha, folders):
    for folder in folders:
        path = folder / f"{sha}.json.gz"
        if path.exists():
            return json.loads(gzip.decompress(path.read_bytes()))
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--inputs", type=Path, nargs="+", required=True, help="the grader's input folders (their extractions carry each document's bookmarks)")
    parser.add_argument("--vision", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--base", type=Path, help="labels ({sha256, ids, labels} rows) the development edits are made to, in place of the parser's")
    parser.add_argument("--load", type=Path, help="a trained heading-editor.pt: no training, only the edits")
    parser.add_argument("--folds", type=int, default=0, help="cross-fit: K models, each trained without one K-th of train; thresholds chosen on their out-of-fold predictions over all of train, development read by the K models' mean")
    parser.add_argument("--fold-epochs", type=int, default=10)
    args = parser.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    names = json.loads((args.rows / "features.json").read_text())
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    bases = {}
    if args.base:
        for line in open(args.base, encoding="utf-8"):
            row = json.loads(line)
            bases[row["sha256"]] = row["labels"]
    train = [Candidates(d, names, mean, std, args.vision, extraction_of(d["sha256"], args.inputs)) for d in train_raw]
    dev = [Candidates(d, names, mean, std, args.vision, extraction_of(d["sha256"], args.inputs), bases.get(d["sha256"])) for d in dev_raw]
    for name, docs in (("train", train), ("development", dev)):
        print(f"{name}: {len(docs)} documents, {sum(len(d.picked) for d in docs)} candidates, {sum(len(d.gold_units) for d in docs)} gold heading units, "
              f"{sum(int(d.gold[:, 0].sum()) for d in docs)} of their starts among the candidates", flush=True)
    positive = np.asarray([d.gold.sum(axis=0) for d in train]).sum(axis=0)
    total = sum(len(d.picked) for d in train)
    weight = torch.tensor((total - positive) / np.maximum(positive, 1.0), dtype=torch.float32, device=device).sqrt()
    model = Editor(train[0].features.shape[1], train[0].sight.shape[1]).to(device)
    print(f"{sum(p.numel() for p in model.parameters()):,} parameters; positive weights {weight.tolist()}", flush=True)
    if args.folds:
        crossfit(args, train, dev, weight, device, started)
        return
    best, best_state = -1.0, None
    if args.load:
        best_state = torch.load(args.load, map_location="cpu")["state"]
    else:
        optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
        schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=args.epochs * len(train), pct_start=0.1)
        order = list(range(len(train)))
        for epoch in range(args.epochs):
            model.train()
            random.shuffle(order)
            loss_sum, began = 0.0, time.time()
            for n in order:
                d = train[n]
                if not len(d.picked):
                    schedule.step()
                    continue
                optimizer.zero_grad(set_to_none=True)
                with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                    logits = model(*tensors(d, device))
                loss = F.binary_cross_entropy_with_logits(logits.float(), torch.from_numpy(d.gold).to(device), pos_weight=weight)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step(); schedule.step()
                loss_sum += float(loss.detach())
            ps = probabilities(model, dev, device)
            f, demote, promote, split, merge = choose(dev, ps, COARSE)
            print(f"epoch {epoch + 1:2} loss {loss_sum / len(train):.4f} in {time.time() - began:.0f}s; development heading units F1 {f:.4f} "
                  f"(demote {demote} promote {promote} split {split} merge {merge}; labels as given {unit_f1(dev, ps, (0.0, 1.01)):.4f})", flush=True)
            if f > best:
                best, best_state = f, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    args.out.mkdir(parents=True, exist_ok=True)
    torch.save({"state": best_state, "mean": mean.tolist(), "std": std.tolist()}, args.out / "heading-editor.pt")
    ps = probabilities(model, dev, device)
    halves = [list(range(0, len(dev), 2)), list(range(1, len(dev), 2))]
    rows = {}
    for chooser, applied in ((halves[0], halves[1]), (halves[1], halves[0])):
        f, *thresholds = choose([dev[i] for i in chooser], [ps[i] for i in chooser])
        held = unit_f1([dev[i] for i in applied], [ps[i] for i in applied], thresholds)
        given = unit_f1([dev[i] for i in applied], [ps[i] for i in applied], (0.0, 1.01))
        print(f"thresholds {thresholds} chosen on {len(chooser)} documents (F1 {f:.4f}); on the other {len(applied)}: {held:.4f} "
              f"against the labels as given {given:.4f}", flush=True)
        for i in applied:
            rows[i] = edited(dev[i], ps[i], *thresholds)
    with open(args.out / "edits-development.jsonl", "w", encoding="utf-8") as out, open(args.out / "parser-development.jsonl", "w", encoding="utf-8") as base:
        for i, d in enumerate(dev):
            out.write(json.dumps({"sha256": d.raw["sha256"], "ids": d.raw["ids"], "labels": rows[i].tolist()}) + "\n")
            base.write(json.dumps({"sha256": d.raw["sha256"], "ids": d.raw["ids"], "labels": d.base.tolist()}) + "\n")
    print(f"done in {time.time() - started:.0f}s; best development heading units F1 {best:.4f}")


def fit(docs, weight, device, epochs, lr, features, vision):
    """One editor trained on these documents for a fixed number of epochs."""
    model = Editor(features, vision).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=lr, total_steps=epochs * len(docs), pct_start=0.1)
    order = list(range(len(docs)))
    for _ in range(epochs):
        model.train()
        random.shuffle(order)
        for n in order:
            d = docs[n]
            if not len(d.picked):
                schedule.step()
                continue
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                logits = model(*tensors(d, device))
            loss = F.binary_cross_entropy_with_logits(logits.float(), torch.from_numpy(d.gold).to(device), pos_weight=weight)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step(); schedule.step()
    return model


def crossfit(args, train, dev, weight, device, started):
    """--folds: thresholds from out-of-fold predictions over all of train; development read by the
    fold models' mean, never used to choose anything."""
    k = args.folds
    oof = [None] * len(train)
    dev_sum = None
    args.out.mkdir(parents=True, exist_ok=True)
    for f in range(k):
        fold_docs = [d for i, d in enumerate(train) if i % k != f]
        held = [i for i in range(len(train)) if i % k == f]
        model = fit(fold_docs, weight, device, args.fold_epochs, args.lr, train[0].features.shape[1], train[0].sight.shape[1])
        for i, p in zip(held, probabilities(model, [train[i] for i in held], device)):
            oof[i] = p
        ps = probabilities(model, dev, device)
        dev_sum = ps if dev_sum is None else [a + b for a, b in zip(dev_sum, ps)]
        torch.save({"state": {n: v.detach().cpu() for n, v in model.state_dict().items()}}, args.out / f"heading-editor-fold{f}.pt")
        print(f"fold {f + 1}/{k} trained on {len(fold_docs)} documents in {time.time() - started:.0f}s", flush=True)
    dev_ps = [p / k for p in dev_sum]
    # The parser heading sources the edits may not demote, and restore where a base dropped them:
    # those whose headings are gold heading starts at least nine times in ten over train (at least 30).
    counts = {}
    for d in train:
        for i, piece in enumerate(d.picked):
            if d.tier0[piece, 0] == HEADING and d.tier0[piece, 1] == 1:
                tally = counts.setdefault(int(d.call[i, 3]), [0, 0])
                tally[0] += 1
                tally[1] += int(d.gold[i, 0] > 0)
    reliable = {s for s, (n, hit) in counts.items() if n >= 30 and hit / n >= 0.9}
    for s, (n, hit) in sorted(counts.items()):
        print(f"parser headings from {SOURCES[s] or '(none)'}: {n}, gold heading starts {hit} ({hit / n:.1%}){' (protected)' if s in reliable else ''}", flush=True)
    for d in train + dev:
        d.protected = np.asarray([int(d.call[i, 3]) in reliable and d.tier0[piece, 0] == HEADING and d.tier0[piece, 1] == 1
                                  for i, piece in enumerate(d.picked)], dtype=bool)
    # The out-of-fold and development probabilities, by document, for a second stage.
    with open(args.out / "probabilities.json", "w", encoding="utf-8") as kept:
        json.dump({"train": {d.raw["sha256"]: {"picked": d.picked.tolist(), "p": p.tolist()} for d, p in zip(train, oof)},
                   "development": {d.raw["sha256"]: {"picked": d.picked.tolist(), "p": p.tolist()} for d, p in zip(dev, dev_ps)}}, kept)
    coarse = [round(x, 2) for x in np.arange(0.1, 0.95, 0.1)]
    with open(args.out / "parser-development.jsonl", "w", encoding="utf-8") as base:
        for d in dev:
            base.write(json.dumps({"sha256": d.raw["sha256"], "ids": d.raw["ids"], "labels": d.base.tolist()}) + "\n")
    for name, extents in (("starts", False), ("extents", True)):
        f, *thresholds = choose(train, oof, coarse, extents)
        held = unit_f1(dev, dev_ps, thresholds)
        given = unit_f1(dev, dev_ps, (0.0, 1.01))
        print(f"{name}: thresholds {[float(x) for x in thresholds]} chosen out of fold on {len(train)} train documents (F1 {f:.4f}); "
              f"development {held:.4f} against the labels as given {given:.4f}", flush=True)
        with open(args.out / f"edits-{name}-development.jsonl", "w", encoding="utf-8") as out:
            for d, p in zip(dev, dev_ps):
                out.write(json.dumps({"sha256": d.raw["sha256"], "ids": d.raw["ids"], "labels": edited(d, p, *thresholds).tolist()}) + "\n")
    print(f"done in {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
