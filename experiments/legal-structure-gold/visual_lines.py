"""Each source line's look on the page: the vision encoder of NVIDIA Nemotron 3.5 Parse (C-RADIOv4,
27 blocks of width 1152) run over every gold page rendered as the model's processor prepares it,
its patch features mean-pooled inside each line's box. One npz per source: line ids and their
vectors (float16, 1152 wide).

  python visual_lines.py LINEBOXES_DIR CHECKPOINT OUT_DIR [--mode ocr] [--limit N] [--dtype bf16|fp32] [--device cuda|cpu]

The encoder and position code below are ported from nvidia/Nemotron-3.5-Parse
(hf_nemotron_parse_modeling.py, hf_prefix_geometry.py, hf_nemotron_parse_processor.py):
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: OpenMDW-1.1
"""
import argparse
import gzip
import json
import time
from functools import partial
from pathlib import Path

import fitz
import numpy as np
import torch
from safetensors import safe_open
from timm.models.vision_transformer import Block
from torch import nn
from torch.nn import functional as F

MEAN = (0.48145466, 0.4578275, 0.40821073)
STD = (0.26862954, 0.26130258, 0.27577711)
MAX_H, MAX_W, PATCH = 2048, 1664, 16
PREFIX = "encoder.model_encoder.radio_model.model."


class Encoder(nn.Module):
    """RADIO's ViT as Nemotron 3.5 Parse runs it: 10 register tokens, content-normalized positions."""

    def __init__(self):
        super().__init__()
        self.cls = nn.Parameter(torch.empty(10, 1152))
        self.embedder = nn.Linear(768, 1152, bias=False)
        self.pos_embed = nn.Parameter(torch.empty(1, 16384, 1152))
        self.blocks = nn.ModuleList([Block(1152, 16, mlp_ratio=4304 / 1152, qkv_bias=True,
                                           norm_layer=partial(nn.LayerNorm, eps=1e-6)) for _ in range(27)])

    def load(self, checkpoint):
        state = {}
        with safe_open(checkpoint, "pt") as f:
            for key in f.keys():
                if key.startswith(PREFIX):
                    name = key[len(PREFIX):].replace("patch_generator.cls_token.token", "cls") \
                        .replace("patch_generator.embedder", "embedder").replace("patch_generator.pos_embed", "pos_embed")
                    state[name] = f.get_tensor(key)
        self.load_state_dict(state, strict=True)

    def positions(self, rows, cols, content_h, content_w):
        grid = self.pos_embed.reshape(1, 128, 128, -1).permute(0, 3, 1, 2).float()
        content_rows, content_cols = -(-content_h // PATCH), -(-content_w // PATCH)
        if min(content_rows, content_cols) == 1:
            grid = F.adaptive_avg_pool2d(grid, (content_rows, content_cols))
        else:
            grid = F.interpolate(grid, size=(content_rows, content_cols), mode="bilinear", align_corners=False, antialias=True)
        row_starts = torch.arange(rows, device=grid.device, dtype=torch.float32) * PATCH
        col_starts = torch.arange(cols, device=grid.device, dtype=torch.float32) * PATCH
        y = (row_starts + 0.5 * (content_h - row_starts).clamp(0, PATCH)).clamp(max=content_h) / content_h
        x = (col_starts + 0.5 * (content_w - col_starts).clamp(0, PATCH)).clamp(max=content_w) / content_w
        gy, gx = torch.meshgrid(y, x, indexing="ij")
        sample = torch.stack((2 * gx - 1, 2 * gy - 1), dim=-1).unsqueeze(0)
        out = F.grid_sample(grid, sample, mode="bilinear", padding_mode="border", align_corners=False)
        return out.flatten(2).permute(0, 2, 1)

    def forward(self, patches, rows, cols, content_h, content_w):
        x = self.embedder(patches).unsqueeze(0)
        x = x + self.positions(rows, cols, content_h, content_w).to(x.dtype)
        x = torch.cat((self.cls.unsqueeze(0).to(x.dtype), x), dim=1)
        for block in self.blocks:
            x = block(x)
        return x[0, 10:].reshape(rows, cols, -1)


def page_image(document, index, width_pt, height_pt, shrink=1.0):
    """The page rendered to fit the model's canvas (never upscaled past it), padded white at the
    bottom and right to the encoder's grid; returns patches, the grid, content size and scale."""
    scale = min(MAX_H / height_pt, MAX_W / width_pt) * shrink
    pix = document[index].get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
    image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)[:int(MAX_H * shrink), :int(MAX_W * shrink)]
    h, w = image.shape[:2]
    H, W = -(-h // 16) * 16, -(-w // 64) * 64
    canvas = np.full((H, W, 3), 255, dtype=np.uint8)
    canvas[:h, :w] = image
    t = torch.from_numpy(canvas).permute(2, 0, 1).float().div_(255)
    t = (t - torch.tensor(MEAN).view(3, 1, 1)) / torch.tensor(STD).view(3, 1, 1)
    patches = t.unfold(1, 16, 16).unfold(2, 16, 16).permute(1, 2, 0, 3, 4).reshape(-1, 768)
    return patches, H // 16, W // 16, h, w, scale


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("boxes", type=Path)
    parser.add_argument("checkpoint")
    parser.add_argument("out", type=Path)
    parser.add_argument("--mode")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dtype", default="bf16")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--shrink", type=float, default=1.0, help="render below the model canvas (0.5: half the side)")
    parser.add_argument("--threads", type=int, default=0)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.threads:
        torch.set_num_threads(args.threads)
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}[args.dtype]
    encoder = Encoder()
    encoder.load(args.checkpoint)
    encoder = encoder.to(args.device, dtype).eval()
    files = sorted(args.boxes.glob("*.json.gz"))
    done = pages = 0
    seconds = 0.0
    for path in files:
        source = json.load(gzip.open(path))
        if (args.mode and source["mode"] != args.mode) or (args.out / f"{source['sha256']}.npz").exists():
            continue
        try:
            document = fitz.open(source["path"])
        except Exception as exc:
            print("SKIP", source["sha256"][:12], exc, flush=True)
            continue
        ids, vectors = [], []
        for page in source["pages"]:
            if not page["lines"] or page["index"] is None or page["index"] >= len(document):
                continue
            patches, rows, cols, h, w, scale = page_image(document, page["index"], page["width"], page["height"], args.shrink)
            started = time.perf_counter()
            with torch.no_grad():
                features = encoder(patches.to(args.device, dtype), rows, cols, h, w).float()
            if args.device == "cuda":
                torch.cuda.synchronize()
            seconds += time.perf_counter() - started
            pages += 1
            for line_id, (x0, y0, x1, y1) in page["lines"]:
                r0, r1 = int(max(0, y0 * scale) // 16), int(min(h - 1, y1 * scale) // 16)
                c0, c1 = int(max(0, x0 * scale) // 16), int(min(w - 1, x1 * scale) // 16)
                if r1 < r0 or c1 < c0:
                    continue
                ids.append(line_id)
                vectors.append(features[r0:r1 + 1, c0:c1 + 1].mean(dim=(0, 1)).cpu().numpy())
        np.savez_compressed(args.out / f"{source['sha256']}.npz", ids=np.asarray(ids),
                            vectors=np.asarray(vectors, dtype=np.float16).reshape(-1, 1152))
        done += 1
        if done % 10 == 0:
            print(f"{done} documents, {pages} pages, encoder {seconds / max(pages, 1):.3f} s/page", flush=True)
        if args.limit and done >= args.limit:
            break
    print(f"done: {done} documents, {pages} pages, encoder {seconds / max(pages, 1):.3f} s/page on {args.device} {args.dtype}")


if __name__ == "__main__":
    main()
