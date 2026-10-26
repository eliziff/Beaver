"""Heading steps: each heading's step from the heading before it in its document (10 the same, 10
plus the change), predicted over the document's whole run of headings at once. Each heading is read
with its own evidence, the pieces before and after it, its whole text, the step the labels gave it,
and how its evidence differs from the heading before it. Trained on the gold's headings; applied to
another model's headings (`train_heading_edits.py` output), whose steps it replaces. Test is never read.

  python train_heading_steps.py ROWS_DIR --out OUT_DIR --apply LABELS.jsonl [--epochs N]

Writes OUT_DIR/steps-development.jsonl ({sha256, ids, labels}): the applied labels with every heading
step the model's.
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

from train_heading_edits import HEADING, sinusoid
from train_tagger import REGIONS, chars, load, words

STEPS = 19


class Run:
    """One document's run of headings (the gold's, or the labels'), read for the step model."""

    def __init__(self, raw, mean, std, labels, gold_steps):
        labels = np.asarray(labels, dtype=np.int64)
        self.raw, self.labels = raw, labels
        self.picked = np.flatnonzero((labels[:, 0] == HEADING) & (labels[:, 1] == 1))
        values = (np.asarray(raw["features"], dtype=np.float32) - mean) / std
        before = np.concatenate([np.zeros((1, values.shape[1]), np.float32), values[:-1]])
        after = np.concatenate([values[1:], np.zeros((1, values.shape[1]), np.float32)])
        k = self.picked
        own = values[k]
        previous = np.concatenate([np.zeros((1, own.shape[1]), np.float32), own[:-1]]) if len(k) else own
        self.features = np.concatenate([own, before[k], after[k], own - previous], axis=1)
        texts = [raw["text"][i][0] for i in k]
        self.text, self.words = chars(texts), words(texts)
        tier0 = np.asarray(raw["tier0"], dtype=np.int64)
        self.call = np.stack([np.minimum(tier0[k, 4], STEPS - 1), np.minimum(labels[k, 4], STEPS - 1)], axis=1) if len(k) else np.zeros((0, 2), np.int64)
        gold = raw["gold"]
        self.target = np.asarray([gold[i][4] if gold_steps and gold[i] is not None and gold[i][0] == HEADING and gold[i][1] == 1 else -100
                                  for i in k], dtype=np.int64)


class Stepper(nn.Module):
    def __init__(self, features, width=192, layers=3):
        super().__init__()
        self.char = nn.Embedding(2049, 24, padding_idx=0)
        self.conv3 = nn.Conv1d(24, 64, 3, padding=1)
        self.conv5 = nn.Conv1d(24, 64, 5, padding=2)
        self.word = nn.Embedding(16384, 32, padding_idx=0)
        self.parser_step = nn.Embedding(STEPS, 8)
        self.given_step = nn.Embedding(STEPS, 8)
        self.project = nn.Sequential(nn.Linear(features + 64 + 64 + 32 + 16, width), nn.GELU(), nn.Dropout(0.1))
        layer = nn.TransformerEncoderLayer(width, 4, 4 * width, dropout=0.1, batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, layers)
        self.out = nn.Linear(width, STEPS)

    def forward(self, features, text, word, call):
        n = features.shape[0]
        text = text[:, :max(1, int((text > 0).sum(dim=1).max()))]
        e = self.char(text).transpose(1, 2)
        c = torch.cat([F.relu(self.conv3(e)).max(2).values, F.relu(self.conv5(e)).max(2).values], dim=1)
        mask = (word > 0).unsqueeze(-1).float()
        w = (self.word(word) * mask).sum(1) / mask.sum(1).clamp(min=1)
        x = self.project(torch.cat([features, c, w, self.parser_step(call[:, 0]), self.given_step(call[:, 1])], dim=1))
        x = x + sinusoid(n, x.shape[1], x.device)
        return self.out(self.encoder(x[None])[0])


def tensors(run, device):
    return tuple(torch.from_numpy(a).to(device) for a in (run.features, run.text, run.words, run.call))


@torch.no_grad()
def steps(model, runs, device):
    model.eval()
    return [model(*tensors(r, device)).float().argmax(-1).cpu().numpy() if len(r.picked) else np.zeros(0, np.int64) for r in runs]


def accuracy(runs, predicted):
    hits = total = given = 0
    for r, p in zip(runs, predicted):
        keep = r.target >= 0
        hits += int((p[keep] == r.target[keep]).sum())
        given += int((r.call[keep, 1] == r.target[keep]).sum())
        total += int(keep.sum())
    return hits / max(total, 1), given / max(total, 1), total


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--apply", type=Path, required=True, help="development labels whose heading steps are replaced")
    parser.add_argument("--epochs", type=int, default=30)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    train_raw, dev_raw = load(args.rows / "rows-train.jsonl"), load(args.rows / "rows-development.jsonl")
    stacked = np.concatenate([np.asarray(d["features"], dtype=np.float32) for d in train_raw])
    mean, std = stacked.mean(axis=0), stacked.std(axis=0) + 1e-6
    # Training runs are the gold's own headings, with the parser's steps beside them.
    def gold_labels(d):
        labels = np.asarray(d["tier0"], dtype=np.int64).copy()
        for i, g in enumerate(d["gold"]):
            heading = g is not None and g[0] == HEADING and g[1] == 1
            labels[i, 0] = HEADING if heading else (TEXT_FALLBACK if labels[i, 0] == HEADING else labels[i, 0])
            labels[i, 1] = 1 if heading else labels[i, 1]
        return labels
    train = [Run(d, mean, std, gold_labels(d), True) for d in train_raw]
    applied = {}
    for line in open(args.apply, encoding="utf-8"):
        row = json.loads(line)
        applied[row["sha256"]] = row["labels"]
    dev = [Run(d, mean, std, applied[d["sha256"]], True) for d in dev_raw]
    print(f"train: {sum(len(r.picked) for r in train)} gold headings; development: {sum(len(r.picked) for r in dev)} applied headings, "
          f"{sum(int((r.target >= 0).sum()) for r in dev)} of them gold headings", flush=True)
    model = Stepper(train[0].features.shape[1]).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=args.epochs * len(train), pct_start=0.1)
    best, best_state = -1.0, None
    order = list(range(len(train)))
    for epoch in range(args.epochs):
        model.train()
        random.shuffle(order)
        total = 0.0
        for n in order:
            r = train[n]
            if not len(r.picked) or not (r.target >= 0).any():
                schedule.step()
                continue
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
                logits = model(*tensors(r, device))
            loss = F.cross_entropy(logits.float(), torch.from_numpy(r.target).to(device), ignore_index=-100)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step(); schedule.step()
            total += float(loss.detach())
        mine, given, n = accuracy(dev, steps(model, dev, device))
        print(f"epoch {epoch + 1:2} loss {total / len(train):.4f}; development step accuracy {mine:.4f} against the labels' {given:.4f} over {n} headings", flush=True)
        if mine > best:
            best, best_state = mine, {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    model.load_state_dict(best_state)
    args.out.mkdir(parents=True, exist_ok=True)
    torch.save({"state": best_state, "mean": mean.tolist(), "std": std.tolist()}, args.out / "heading-steps.pt")
    with open(args.out / "steps-development.jsonl", "w", encoding="utf-8") as out:
        for r, p in zip(dev, steps(model, dev, device)):
            labels = r.labels.copy()
            labels[r.picked, 4] = p
            out.write(json.dumps({"sha256": r.raw["sha256"], "ids": r.raw["ids"], "labels": labels.tolist()}) + "\n")
    print(f"done in {time.time() - started:.0f}s; best development step accuracy {best:.4f}")


TEXT_FALLBACK = REGIONS.index("text")

if __name__ == "__main__":
    main()
