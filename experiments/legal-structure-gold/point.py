"""Point each unit start of a labels file at its parent with a trained tagger's pointer head.

  python point.py ROWS_DIR TAGGER.pt LABELS.jsonl --out OUT.jsonl [--keep-parser-notes]
                  [--blend PROBABILITIES.npz --weight W]

LABELS.jsonl ({sha256, ids, labels} over development, as `train_trees.py` writes) supplies the
regions and unit starts; with --blend, regions and starts are instead the argmax of W times the
trees' probabilities (`train_trees.py`'s npz) plus 1 - W times the tagger's own. The tagger then
chooses each start's parent among the earlier starts in reach, and a resumed piece resumes the
latest earlier unit of its region. With --keep-parser-notes, the parser (tier 0) keeps its notes
and their pairs and its document starts.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from train_tagger import CHUNK, REACH, REGIONS, Document, Starts, Tagger, Vocab, Windows, load


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("tagger", type=Path)
    parser.add_argument("labels", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--keep-parser-notes", action="store_true")
    parser.add_argument("--blend", type=Path)
    parser.add_argument("--weight", type=float, default=0.5)
    args = parser.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    saved = torch.load(args.tagger, map_location="cpu")
    vocabs = []
    for index in saved["vocabs"]:
        vocab = Vocab([])
        vocab.index = index
        vocabs.append(vocab)
    names = json.loads((args.rows / "features.json").read_text())
    mean, std = np.asarray(saved["mean"], dtype=np.float32), np.asarray(saved["std"], dtype=np.float32)
    dev_raw = load(args.rows / "rows-development.jsonl")
    model = Tagger(len(names), vocabs, kind=saved["model"]).to(device)
    model.load_state_dict(saved["state"])
    model.eval()
    given = {}
    for line in open(args.labels, encoding="utf-8"):
        row = json.loads(line)
        given[row["sha256"]] = np.asarray(row["labels"], dtype=np.int64)
    trees = np.load(args.blend) if args.blend else None
    note = REGIONS.index("note")
    offset = 0
    with open(args.out, "w", encoding="utf-8") as stream, torch.no_grad():
        for raw in dev_raw:
            doc = Document(raw, names, vocabs, mean, std)
            labels = given[raw["sha256"]].copy()
            states = Windows([doc], device).states(model).float()
            if trees is not None:
                region, start = (torch.softmax(head(states), dim=-1).cpu().numpy() for head in model.heads[:2])
                span = slice(offset, offset + doc.length)
                labels[:, 0] = np.argmax(args.weight * trees["region"][span] + (1 - args.weight) * region, axis=1)
                labels[:, 1] = np.argmax(args.weight * trees["start"][span] + (1 - args.weight) * start, axis=1)
            offset += doc.length
            if args.keep_parser_notes:
                notes = (doc.tier0[:, 0] == note) | (labels[:, 0] == note)
                labels[notes, :2] = doc.tier0[notes, :2]
                labels[:, 3] = doc.tier0[:, 3]
            labels[labels[:, 0] == 0, 1] = 0
            labels[:, 5:] = -1
            rows = np.nonzero((labels[:, 1] == 1) & (labels[:, 0] > 0))[0]
            for k in range(0, len(rows), CHUNK):
                starts = Starts(doc, rows, rows[k:k + CHUNK], device)
                choice = model.parents(states, starts).argmax(dim=1).cpu().numpy()
                for i, (q, c) in enumerate(zip(starts.queries, choice)):
                    labels[q, 5] = -1 if c == REACH else int(starts.candidates[i, c])
            latest = {}
            for n in range(doc.length):
                if labels[n, 1] == 2:
                    labels[n, 6] = latest.get(int(labels[n, 0]), -1)
                    if labels[n, 6] < 0:
                        labels[n, 1] = 1
                if labels[n, 1] == 1:
                    latest[int(labels[n, 0])] = n
            stream.write(json.dumps({"sha256": raw["sha256"], "ids": raw["ids"], "labels": labels.tolist()}) + "\n")


if __name__ == "__main__":
    main()
