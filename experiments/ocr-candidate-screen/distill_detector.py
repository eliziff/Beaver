"""Distill stock Indra line detection on existing train/dev pages, never test pages."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import time
import uuid

os.environ.setdefault('OMP_NUM_THREADS', '2')

import numpy as np
import onnxruntime as ort
from PIL import Image
import torch
from torch import nn
from torch.nn import functional as F


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(path, value):
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    pending.replace(path)


def block(before, after, stride=1, dilation=1):
    return nn.Sequential(nn.Conv2d(before, before, 3, stride, dilation, dilation=dilation, groups=before),
                         nn.Conv2d(before, after, 1), nn.ReLU())


class Student(nn.Module):
    def __init__(self, width_multiplier=1, stem_channels=None):
        super().__init__()
        self.channels = [round(value * width_multiplier) for value in [8, 16, 24, 32]]
        if stem_channels:
            self.channels[0] = stem_channels
        a, b, c, d = self.channels
        self.stem = nn.Sequential(nn.Conv2d(1, a, 3, 2, 1), nn.ReLU())
        self.down = nn.ModuleList([block(a, b, 2), block(b, c, 2), block(c, d, 2)])
        self.context = nn.Sequential(block(d, d, dilation=2), block(d, d, dilation=2))
        self.up = nn.ModuleList([block(d + c, c), block(c + b, b), block(b + a, a)])
        self.head = nn.Conv2d(a, 3, 1)
        nn.init.constant_(self.head.bias[1:], 8)

    def forward(self, image):
        features = [self.stem(image)]
        for layer in self.down:
            features.append(layer(features[-1]))
        value = self.context(features[-1])
        for layer, skip in zip(self.up, reversed(features[:-1])):
            value = layer(torch.cat([F.interpolate(value, size=skip.shape[-2:], mode='nearest'), skip], dim=1))
        value = self.head(value)
        return torch.cat([value[:, :1], F.relu(value[:, 1:]) + .001], dim=1)


def shrink_high_resolution(state, model):
    source, target = state['stem.0.bias'].numel(), model.channels[0]
    if source == target:
        return None
    assert target < source
    lower = model.channels[1]
    score = state['down.0.1.weight'].abs().sum((0, 2, 3))
    score += state['up.2.1.weight'][:, lower:].abs().sum((0, 2, 3))
    stem = score.topk(target).indices.sort().values
    head = state['head.weight'].abs().sum((0, 2, 3)).topk(target).indices.sort().values
    combined = torch.cat([torch.arange(lower), lower + stem])
    for prefix, indices in [('stem.0', stem), ('down.0.0', stem), ('up.2.0', combined)]:
        for suffix in ['weight', 'bias']:
            key = prefix + '.' + suffix
            state[key] = state[key][indices].clone()
    state['down.0.1.weight'] = state['down.0.1.weight'][:, stem].clone()
    state['up.2.1.weight'] = state['up.2.1.weight'][head][:, combined].clone()
    state['up.2.1.bias'] = state['up.2.1.bias'][head].clone()
    state['head.weight'] = state['head.weight'][:, head].clone()
    assert all(state[key].shape == value.shape for key, value in model.state_dict().items())
    return {'source_channels': source, 'target_channels': target, 'stem_indices': stem.tolist(), 'head_indices': head.tolist()}


def source_splits(bundle):
    splits, article_sets, audit = {}, {}, {}
    for name in ['train', 'eval', 'test']:
        listing = bundle / (name + '.lst')
        names = [Path(line.replace('\\', '/')).name for line in listing.read_text(encoding='utf-8-sig').splitlines() if line]
        assert len(names) == len(set(names))
        splits[name] = names
        article_sets[name] = {re.search(r'article-(\d+)_', item).group(1) for item in names}
        audit[name] = {'pages': len(names), 'articles': len(article_sets[name]), 'manifest_sha256': digest(listing)}
    for a, b in [('train', 'eval'), ('train', 'test'), ('eval', 'test')]:
        assert not set(splits[a]) & set(splits[b]) and not article_sets[a] & article_sets[b]
    audit.update(page_overlap=0, article_overlap=0, geometry_target='stock Indra predictions, not human box gold')
    return splits, audit


def prepare(args, splits, audit):
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    teacher = ort.InferenceSession(str(args.teacher), options, providers=['CPUExecutionProvider'])
    source_hashes = {split: [digest((args.source_bundle / 'data' / name).with_suffix('.png')) for name in splits[split]]
                     for split in ['train', 'eval']}
    identity = {'teacher_sha256': digest(args.teacher), 'side': args.side, 'splits': audit, 'page_sha256': source_hashes}
    cache = args.cache_root or args.output / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    receipt = cache / 'manifest.json'
    if receipt.is_file():
        assert json.loads(receipt.read_text()) == identity, 'Cache input changed; use a different owning output directory'
    datasets = {}
    for split in ['train', 'eval']:
        rows = []
        for index, name in enumerate(splits[split]):
            path = cache / f'{split}-{index:04}.npz'
            if not receipt.is_file() or not path.is_file():
                with Image.open((args.source_bundle / 'data' / name).with_suffix('.png')) as source:
                    scale = args.side / max(source.size)
                    width, height = [max(1, round(size * scale)) for size in source.size]
                    resized = np.array(source.convert('L').resize((width, height), Image.Resampling.LANCZOS), np.float32)
                image = np.zeros((1, 1, math.ceil(height / 32) * 32, math.ceil(width / 32) * 32), np.float32)
                image[0, 0, :height, :width] = 1 - resized / 255
                target = teacher.run(None, {teacher.get_inputs()[0].name: image})[0]
                assert target.shape == (1, 3, image.shape[2] // 2, image.shape[3] // 2) and np.isfinite(target).all()
                np.savez(path, image=image[0].astype(np.float16), target=target[0].astype(np.float16))
            with np.load(path) as row:
                rows.append((torch.from_numpy(row['image'].copy()), torch.from_numpy(row['target'].copy())))
            if (index + 1) % 100 == 0:
                print(json.dumps({'prepare': split, 'pages': index + 1}), flush=True)
        datasets[split] = rows
    write_json(receipt, identity)
    return datasets, identity


def collate(rows, device):
    height = max(row[0].shape[1] for row in rows)
    width = max(row[0].shape[2] for row in rows)
    image = torch.zeros((len(rows), 1, height, width), dtype=torch.float16)
    target = torch.zeros((len(rows), 3, height // 2, width // 2), dtype=torch.float16)
    valid = torch.zeros((len(rows), 1, height // 2, width // 2), dtype=torch.float32)
    for i, (x, y) in enumerate(rows):
        image[i, :, :x.shape[1], :x.shape[2]] = x
        target[i, :, :y.shape[1], :y.shape[2]] = y
        valid[i, :, :y.shape[1], :y.shape[2]] = 1
    return image.to(device), target.to(device), valid.to(device)


def loss(prediction, target, valid, refine=False):
    prediction, target = prediction.float(), target.float()
    probability = target[:, :1].sigmoid()
    core_target = (target[:, :1] > 0).float() if refine else probability
    weight = valid * (1 + 19 * core_target)
    core = F.binary_cross_entropy_with_logits(prediction[:, :1], core_target, reduction='none')
    core = (core * weight).sum() / weight.sum().clamp_min(1)
    if refine:
        predicted = prediction[:, :1].sigmoid() * valid
        actual = core_target * valid
        intersection = (predicted * actual).sum((1, 2, 3))
        core = core + (1 - (2 * intersection + 1) / (predicted.sum((1, 2, 3)) + actual.sum((1, 2, 3)) + 1)).mean()
    mask = valid * probability
    bounds = F.smooth_l1_loss(prediction[:, 1:] / 16, target[:, 1:] / 16, reduction='none')
    bounds = (bounds * mask).sum() / (2 * mask.sum()).clamp_min(1)
    return core + 4 * bounds


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-bundle', type=Path, required=True)
    parser.add_argument('--teacher', type=Path, default=Path('legal-browser-ocr/assets/detectors/indra/model.onnx'))
    parser.add_argument('--output', type=Path, default=Path('benchmarks/local-data/ocr-candidate-screen/detector-student'))
    parser.add_argument('--side', type=int, default=896)
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--width-multiplier', type=float, default=1)
    parser.add_argument('--stem-channels', type=int)
    parser.add_argument('--cache-root', type=Path)
    parser.add_argument('--refine', type=Path, help='Refine these same-size weights with binary core BCE plus Dice')
    args = parser.parse_args()
    torch.set_num_threads(2)
    torch.manual_seed(4817)
    random.seed(4817)
    assert torch.cuda.is_available(), 'Use the existing desktop CUDA environment'
    args.output.mkdir(parents=True, exist_ok=True)
    splits, audit = source_splits(args.source_bundle)
    datasets, identity = prepare(args, splits, audit)
    model = Student(args.width_multiplier, args.stem_channels).cuda()
    pruning = None
    if args.refine:
        state = torch.load(args.refine, map_location='cpu', weights_only=True)
        pruning = shrink_high_resolution(state, model)
        model.load_state_dict(state)
    optimizer = torch.optim.AdamW(model.parameters(), lr=.0003 if args.refine else .002, weight_decay=.0001)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, args.epochs, eta_min=.0001)
    scaler = torch.amp.GradScaler('cuda')
    best, stale, history, started = float('inf'), 0, [], time.monotonic()
    checkpoint = args.output / 'best.pt'
    receipt = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'inputs': identity,
               'architecture': {'channels': model.channels, 'width_multiplier': args.width_multiplier},
               'refinement': {'checkpoint_sha256': digest(args.refine), 'objective': 'binary core BCE plus Dice; unchanged distance targets', 'pruning': pruning} if args.refine else None,
               'parameters': sum(value.numel() for value in model.parameters()), 'history': history,
               'selection': 'minimum development distillation loss; minimum 10 epochs; patience 6',
               'document_accuracy_gate_passed': False}
    for epoch in range(args.epochs):
        model.train()
        order = list(range(len(datasets['train'])))
        random.shuffle(order)
        train_loss = 0
        for start in range(0, len(order), 4):
            rows = [datasets['train'][i] for i in order[start:start + 4]]
            x, target, valid = collate(rows, 'cuda')
            if random.random() < .5:
                x, target, valid = [value.flip(-1) for value in [x, target, valid]]
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast('cuda', dtype=torch.float16):
                value = loss(model(x), target, valid, bool(args.refine))
            assert torch.isfinite(value), 'Non-finite training loss'
            scaler.scale(value).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5)
            scaler.step(optimizer)
            scaler.update()
            train_loss += value.item() * len(rows)
        model.eval()
        development_loss = 0
        with torch.inference_mode(), torch.autocast('cuda', dtype=torch.float16):
            for start in range(0, len(datasets['eval']), 4):
                rows = datasets['eval'][start:start + 4]
                x, target, valid = collate(rows, 'cuda')
                development_loss += loss(model(x), target, valid, bool(args.refine)).item() * len(rows)
        development_loss /= len(datasets['eval'])
        assert math.isfinite(development_loss)
        if development_loss < best:
            best, stale = development_loss, 0
            torch.save(model.state_dict(), checkpoint)
            receipt['selected_epoch'] = epoch + 1
        else:
            stale += 1
        history.append({'epoch': epoch + 1, 'train_loss': train_loss / len(order), 'eval_loss': development_loss,
                        'elapsed_seconds': time.monotonic() - started})
        write_json(args.output / 'results.json', receipt)
        print(json.dumps(history[-1]), flush=True)
        scheduler.step()
        if epoch + 1 >= 10 and stale >= 6:
            break
    model.load_state_dict(torch.load(checkpoint, weights_only=True))
    model = model.cpu().eval()
    path = args.output / 'model.onnx'
    example = torch.rand(1, 1, 256, 320)
    torch.onnx.export(model, example, path, input_names=['image'], output_names=['prediction'], opset_version=17,
                      dynamic_axes={'image': {0: 'batch', 2: 'height', 3: 'width'},
                                    'prediction': {0: 'batch', 2: 'half_height', 3: 'half_width'}})
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    exported = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
    for height, width in [(256, 320), (384, 256)]:
        x = torch.rand(1, 1, height, width)
        with torch.inference_mode():
            expected = model(x).numpy()
        np.testing.assert_allclose(exported.run(None, {'image': x.numpy()})[0], expected, rtol=.0001, atol=.0001)
    receipt.update(model_sha256=digest(path), model_bytes=path.stat().st_size, export_parity_passed=True)
    write_json(args.output / 'results.json', receipt)
    print(json.dumps({key: receipt[key] for key in ['parameters', 'selected_epoch', 'model_bytes', 'model_sha256']}), flush=True)


if __name__ == '__main__':
    main()
