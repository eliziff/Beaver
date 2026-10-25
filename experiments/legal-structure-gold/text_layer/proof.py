"""Proof sheets: random anchored and filled lines, each cropped from its page image with its exact text beside.

  python proof.py OUT_DIR [--anchored 20] [--filled 10] [--seed N]
Lines are drawn round-robin over the documents (seeded), two words or more. For each sheet (six crops) it
writes OUT_DIR/sheet-N.png and OUT_DIR/lines.txt (the numbered exact text), to be read against the picture. OUT_DIR is
scratch: delete it afterwards.
"""
import argparse
import gzip
import json
import random
import sys
from pathlib import Path

import fitz
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402


def boxes(layer):
    folder = build.DATA / "extract" / layer["source_sha256"]
    path = sorted(folder.glob("*/*/ocr.json.gz"))[-1]
    pages = json.load(gzip.open(path))["extraction"]["pages"]
    return {ln["id"]: ln["bbox"] for p in pages for ln in p["lines"]}


def draw(count, status, layers, rng):
    pools = []
    for layer in layers:
        pool = [x for x in layer["lines"] if x["status"] == status and len(x["exact"].split()) >= 2]
        rng.shuffle(pool)
        pools.append((layer, pool))
    picks, at = [], 0
    while len(picks) < count and any(p for _, p in pools):
        layer, pool = pools[at % len(pools)]
        at += 1
        if pool:
            picks.append((layer, pool.pop()))
    return picks


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out")
    parser.add_argument("--anchored", type=int, default=20)
    parser.add_argument("--filled", type=int, default=10)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    layers = [json.loads(f.read_text(encoding="utf-8")) for f in sorted((build.DATA / "text-layers").glob("*.json"))]
    rng.shuffle(layers)
    picks = draw(args.anchored, "anchored", layers, rng) + draw(args.filled, "filled", layers, rng)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    crops, lines = [], []
    cache = {}
    for number, (layer, line) in enumerate(picks, 1):
        sha = layer["source_sha256"]
        cache.setdefault(sha, (fitz.open(layer["pdf_path"]), boxes(layer)))
        doc, bbox = cache[sha]
        x0, y0, x1, y1 = bbox[line["id"]]
        page = doc[line["page"] - 1]
        clip = fitz.Rect(x0 - 6, y0 - 4, x1 + 6, y1 + 4)
        pix = page.get_pixmap(dpi=220, clip=clip)
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        scale = min(1.0, 1000 / image.width)
        image = image.resize((int(image.width * scale), int(image.height * scale)))
        crops.append((number, image))
        lines.append(f"{number:2d} [{line['status']}/{line['lang']}] {layer['a2aj']['citation']} {line['id']}\n     ocr:   {line['ocr']}\n     exact: {line['exact']}")
    for sheet, start in enumerate(range(0, len(crops), 6), 1):
        group = crops[start:start + 6]
        canvas = Image.new("RGB", (1060, sum(c.height + 22 for _, c in group)), "white")
        y = 0
        for number, image in group:
            ImageDraw.Draw(canvas).text((4, y + 4), str(number), fill="red")
            canvas.paste(image, (40, y + 4))
            y += image.height + 22
        canvas.save(out / f"sheet-{sheet}.png")
    (out / "lines.txt").write_text("\n".join(lines), encoding="utf-8")
    print(f"{len(lines)} lines written to {out / 'lines.txt'}")


if __name__ == "__main__":
    main()
