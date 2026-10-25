"""Each piece's words as a static embedding (Model2Vec, potion-multilingual-128M by default),
reduced by a PCA fit on training pieces, for the taggers' text input.

  python embed_rows.py ROWS_DIR OUT.npz [--model NAME] [--dims 32]
"""
import argparse
import json
from pathlib import Path

import numpy as np
from model2vec import StaticModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("rows", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--model", default="minishlab/potion-multilingual-128M")
    parser.add_argument("--dims", type=int, default=32)
    args = parser.parse_args()
    model = StaticModel.from_pretrained(args.model)
    embedded = {}
    for split in ("train", "development"):
        for line in open(args.rows / f"rows-{split}.jsonl", encoding="utf-8"):
            doc = json.loads(line)
            embedded[doc["sha256"]] = (split, model.encode([t[0] or " " for t in doc["text"]]).astype(np.float32))
    train = np.concatenate([e for split, e in embedded.values() if split == "train"])
    mean = train.mean(axis=0)
    _, _, vt = np.linalg.svd(train[np.random.default_rng(0).choice(len(train), min(len(train), 50000), replace=False)] - mean,
                             full_matrices=False)
    basis = vt[:args.dims].T
    np.savez_compressed(args.out, **{sha: ((e - mean) @ basis).astype(np.float16) for sha, (_, e) in embedded.items()})
    print(f"{len(embedded)} documents, {len(train)} training pieces, {args.dims} dimensions -> {args.out}")


if __name__ == "__main__":
    main()
