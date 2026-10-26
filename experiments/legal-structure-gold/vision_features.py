"""Visual evidence for the tier-1 tagger: every page of every document in a rows directory read by
an ImageNet ResNet-18 (frozen, to its third stage), and each piece's box pooled from its page's
feature map, beside the page's own pooled map. The pages are the renders the gold was authored from
(each job's images/page-NNNNNN-*.png), so the tagger sees what the gold's reader saw.

  python vision_features.py ROWS_DIR --gold B5_DIR B6_DIR ... --out VISION_DIR [--side 1024]

Writes VISION_DIR/<sha256>.npz per document: piece (pieces x 256) and page (pages x 256), float16,
pages in the rows' page slots. A page the gold has no render of reads as zeros, and is counted.
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
import torchvision
from PIL import Image

MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
# Each piece's box read as a grid of this many rows and columns of the feature map, averaged.
GRID = (4, 16)


def renders(gold_dirs):
    """Each source's page renders by 1-based page number, from its job's receipt and images."""
    found = {}
    for gold in gold_dirs:
        for job in (gold / "v4").iterdir():
            receipt = job / "receipt.json"
            if not receipt.is_file():
                continue
            sha = json.loads(receipt.read_text(encoding="utf-8")).get("source_sha256")
            pages = {}
            for image in (job / "images").glob("page-*.png"):
                pages[int(image.name.split("-")[1])] = image
            if sha and pages:
                found[sha] = pages
    return found


def backbone(device):
    model = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1)
    stages = torch.nn.Sequential(model.conv1, model.bn1, model.relu, model.maxpool, model.layer1, model.layer2, model.layer3)
    return stages.eval().to(device)


def page_tensor(path, side):
    image = Image.open(path).convert("RGB")
    scale = side / max(image.size)
    image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.BILINEAR)
    array = torch.from_numpy(np.asarray(image, dtype=np.uint8).copy()).permute(2, 0, 1).float().div(255).unsqueeze(0)
    return (array - MEAN) / STD


def pool_boxes(fmap, boxes):
    """Each box ([x0, y0, x1, y1] as fractions of the page) averaged over a GRID of the map: (boxes, channels)."""
    if len(boxes) == 0:
        return torch.zeros(0, fmap.shape[1], device=fmap.device)
    b = torch.as_tensor(np.asarray(boxes, dtype=np.float32), device=fmap.device).clamp(0, 1)
    rows, cols = GRID
    ty = (torch.arange(rows, device=fmap.device).float() + 0.5) / rows
    tx = (torch.arange(cols, device=fmap.device).float() + 0.5) / cols
    y = b[:, 1:2] + (b[:, 3:4] - b[:, 1:2]) * ty[None]
    x = b[:, 0:1] + (b[:, 2:3] - b[:, 0:1]) * tx[None]
    grid = torch.stack([x[:, None, :].expand(-1, rows, -1), y[:, :, None].expand(-1, -1, cols)], dim=-1) * 2 - 1
    sampled = F.grid_sample(fmap.expand(len(b), -1, -1, -1), grid, align_corners=False)
    return sampled.mean(dim=(2, 3))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("rows", type=Path)
    parser.add_argument("--gold", type=Path, nargs="+", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--side", type=int, default=1024)
    args = parser.parse_args()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    started = time.time()
    pages_of = renders(args.gold)
    model = backbone(device)
    args.out.mkdir(parents=True, exist_ok=True)
    documents = pages_read = pages_missing = 0
    for split in ("train", "development"):
        for line in open(args.rows / f"rows-{split}.jsonl", encoding="utf-8"):
            doc = json.loads(line)
            if not doc["ids"]:
                continue
            target = args.out / f"{doc['sha256']}.npz"
            if target.exists():
                continue
            slots = np.asarray(doc["pages"], dtype=np.int64)
            boxes = np.asarray([f[:4] for f in doc["features"]], dtype=np.float32)
            count = int(slots.max()) + 1
            piece = torch.zeros(len(slots), 256)
            page = torch.zeros(count, 256)
            images = pages_of.get(doc["sha256"], {})
            with torch.no_grad():
                for slot in range(count):
                    path = images.get(slot + 1)
                    if path is None:
                        pages_missing += 1
                        continue
                    try:
                        image = page_tensor(path, args.side)
                    except OSError as error:
                        # A render that does not read (truncated on disk) counts as no render.
                        print(f"unreadable render {path}: {error}", flush=True)
                        pages_missing += 1
                        continue
                    fmap = model(image.to(device))
                    page[slot] = fmap.mean(dim=(2, 3))[0].cpu()
                    here = np.flatnonzero(slots == slot)
                    piece[here] = pool_boxes(fmap, boxes[here]).cpu()
                    pages_read += 1
            np.savez(target, piece=piece.numpy().astype(np.float16), page=page.numpy().astype(np.float16))
            documents += 1
            if documents % 25 == 0:
                print(f"{documents} documents, {pages_read} pages read, {pages_missing} missing, {time.time() - started:.0f}s", flush=True)
    print(f"done: {documents} documents, {pages_read} pages read, {pages_missing} pages without a render, {time.time() - started:.0f}s")


if __name__ == "__main__":
    main()
