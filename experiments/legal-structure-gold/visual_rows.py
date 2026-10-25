"""The line vectors of visual_lines.py joined onto the rows' pieces (a piece takes its line's vector),
reduced by a PCA fit on training lines, with a column saying whether the line had one: an npz of
per-document arrays aligned with the rows, for train_headings.py --visual.

  python visual_rows.py ROWS_DIR VISUAL_DIR OUT.npz [--dims 32]
"""
import argparse
import json
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("rows", type=Path)
    parser.add_argument("visual", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--dims", type=int, default=32)
    args = parser.parse_args()
    lines, splits = {}, {}
    for path in args.visual.glob("*.npz"):
        data = np.load(path)
        lines[path.stem] = dict(zip(data["ids"].tolist(), data["vectors"].astype(np.float32)))
    sample = [v for sha, by_line in lines.items() for v in list(by_line.values())[:200]]
    sample = np.stack(sample)
    mean = sample.mean(axis=0)
    _, _, vt = np.linalg.svd(sample[np.random.default_rng(0).choice(len(sample), min(len(sample), 40000), replace=False)] - mean,
                             full_matrices=False)
    basis = vt[:args.dims].T
    out = {}
    covered = total = 0
    for split in ("train", "development"):
        for line in open(args.rows / f"rows-{split}.jsonl", encoding="utf-8"):
            doc = json.loads(line)
            by_line = lines.get(doc["sha256"], {})
            rows = np.zeros((len(doc["ids"]), args.dims + 1), dtype=np.float16)
            for k, piece in enumerate(doc["ids"]):
                vector = by_line.get(piece.split("@")[0])
                if vector is not None:
                    rows[k, :args.dims] = (vector - mean) @ basis
                    rows[k, args.dims] = 1
                    covered += 1
                total += 1
            out[doc["sha256"]] = rows
    np.savez_compressed(args.out, **out)
    print(f"{len(lines)} documents with line vectors; {covered} of {total} pieces covered -> {args.out}")


if __name__ == "__main__":
    main()
