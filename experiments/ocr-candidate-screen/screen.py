"""GPU fine-tuning using the existing Kraken line corpus and development CER."""

import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess
import sys
import time
import unicodedata

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')

import cv2
import numpy as np
import pyarrow.ipc as ipc
import torch
from huggingface_hub import hf_hub_download
from rapidfuzz.distance.Levenshtein import distance
from torch import nn
from torch.nn import functional as F

from indra import Indra, check_parity, select_blocks, select_channels, distillation_loss
from margin_jitter import jitter_margins


def normalized(text):
    text = re.sub(r'[\u00ad\u00ac]\r?\n', '', text)
    text = unicodedata.normalize('NFKC', text).replace('\u00ad', '').replace('\u00ac', '')
    return re.sub(r'\s+', ' ', text).strip()


def digest(path):
    with open(path, 'rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def write_json(path, value):
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    pending.replace(path)


def save_checkpoint(path, value):
    pending = path.with_suffix('.pending')
    try:
        torch.save(value, pending)
        pending.replace(path)
    finally:
        pending.unlink(missing_ok=True)


def audit_sources(bundle, data_root):
    pages, articles, result = {}, {}, {}
    for split in ['train', 'eval', 'test']:
        listing = bundle / f'{split}.lst'
        names = [Path(x.replace('\\', '/')).name for x in listing.read_text(encoding='utf-8-sig').splitlines() if x]
        if len(names) != len(set(names)):
            raise ValueError(f'Duplicate source pages in {split}')
        pages[split] = set(names)
        articles[split] = {re.search(r'article-(\d+)_', x).group(1) for x in names}
        if any(not (bundle / 'data' / x).is_file() or not (bundle / 'data' / x).with_suffix('.png').is_file() for x in names):
            raise ValueError(f'Missing source pages in {split}')
        path = data_root / f'{split}.arrow'
        with path.open('rb') as source:
            reader = ipc.open_file(source)
            count = sum(reader.get_batch(i).num_rows for i in range(reader.num_record_batches))
        result[split] = {'pages': len(names), 'articles': len(articles[split]), 'lines': count,
                         'manifest_sha256': digest(listing), 'arrow_sha256': digest(path)}
    for first, second in [('train', 'eval'), ('train', 'test'), ('eval', 'test')]:
        if pages[first] & pages[second] or articles[first] & articles[second]:
            raise ValueError(f'Source split overlap: {first}/{second}')
    result['page_overlap'] = result['article_overlap'] = 0
    result['source'] = 'existing CATMuS transfer remote_bundle and compiled Kraken recognition Arrow files'
    return result


def read_rows(path):
    rows = []
    with path.open('rb') as source:
        reader = ipc.open_file(source)
        for i in range(reader.num_record_batches):
            rows.extend(reader.get_batch(i).column('lines').to_pylist())
    for row in rows:
        row['text'] = normalized(row['text'])
    return rows


class Adapter:
    def __init__(self, name, args):
        self.name = name
        self.meta = {}
        if name == 'indra':
            path = Path(hf_hub_download('datalab-to/indra-ocr', 'rec.onnx'))
            meta_path = Path(hf_hub_download('datalab-to/indra-ocr', 'meta.json'))
            meta = json.loads(meta_path.read_text(encoding='utf-8'))
            vocab = json.loads(meta['vocab']) if isinstance(meta['vocab'], str) else meta['vocab']
            self.chars = [''] + vocab['chars']
            self.model = Indra(path)
            self.meta['parity'] = check_parity(self.model, path)
            self.height, self.maximum, self.minimum = 32, 4096, 8
            self.meta['source'] = {'repo': 'datalab-to/indra-ocr', 'revision': path.parent.name, 'sha256': digest(path)}
        elif name == 'ppocr':
            from transformers import AutoModelForTextRecognition

            repo = 'PaddlePaddle/PP-OCRv6_tiny_rec_safetensors'
            path = Path(hf_hub_download(repo, 'model.safetensors'))
            processor = json.loads(Path(hf_hub_download(repo, 'preprocessor_config.json')).read_text(encoding='utf-8'))
            self.chars = processor['character_list']
            self.chars[0] = ''
            self.model = AutoModelForTextRecognition.from_pretrained(path.parent)
            self.height, self.maximum, self.minimum = 48, 3200, 320
            self.meta['source'] = {'repo': repo, 'revision': path.parent.name, 'sha256': digest(path)}
        elif name == 'crnn':
            from importlib.metadata import version
            from doctr.models import crnn_mobilenet_v3_small

            self.model = crnn_mobilenet_v3_small(pretrained=False, pretrained_backbone=False, exportable=True)
            self.model.load_state_dict(torch.load(args.crnn_weights, map_location='cpu', weights_only=True), strict=True)
            self.chars = [''] + list(self.model.cfg['vocab'])
            # docTR puts CTC blank last; retain its weights while making blank zero.
            order = [len(self.chars) - 1] + list(range(len(self.chars) - 1))
            with torch.no_grad():
                self.model.linear.weight.copy_(self.model.linear.weight[order].clone())
                self.model.linear.bias.copy_(self.model.linear.bias[order].clone())
            self.height, self.maximum, self.minimum = 32, 4096, 128
            self.meta['source'] = {'repo': 'https://github.com/mindee/doctr', 'package_version': version('python-doctr'),
                                   'weights_url': self.model.cfg['url'], 'sha256': digest(args.crnn_weights)}
        else:
            import yaml

            sys.path.insert(0, str(args.openocr))
            from openrec.modeling import build_model

            config = yaml.safe_load((args.openocr / 'configs/rec/svtrv2/repsvtr_ch.yml').read_text(encoding='utf-8'))
            self.chars = [''] + (args.openocr / 'tools/utils/ppocr_keys_v1.txt').read_text(encoding='utf-8').splitlines() + [' ']
            config['Architecture']['Decoder']['out_channels'] = len(self.chars)
            self.model = build_model(config['Architecture'])
            checkpoint = torch.load(args.rep_weights, map_location='cpu', weights_only=True)
            state = checkpoint.get('state_dict', checkpoint)
            # The release includes auxiliary GTC training heads, absent at CTC inference.
            auxiliary = ('decoder.before_gtc.', 'decoder.gtc_head.')
            self.meta['omitted_auxiliary_tensors'] = sum(k.startswith(auxiliary) for k in state)
            state = {k: v for k, v in state.items() if not k.startswith(auxiliary)}
            self.model.load_state_dict(state, strict=True)
            self.height, self.maximum, self.minimum = 48, 4096, 32
            self.meta['source'] = {'repo': 'https://github.com/Topdu/OpenOCR',
                                   'revision': subprocess.check_output(['git', '-C', str(args.openocr), 'rev-parse', 'HEAD'], text=True).strip(),
                                   'sha256': digest(args.rep_weights)}
        self.mapping = {c: i for i, c in enumerate(self.chars) if i}
        self.meta['stock_parameters'] = sum(p.numel() for p in self.model.parameters())
        self.meta['stock_classes'] = len(self.chars)

    def raw(self, x, widths):
        if self.name == 'indra':
            return self.model(x, widths)
        if self.name == 'ppocr':
            h = self.model.head
            z = self.model.model(x).last_hidden_state.squeeze(2)
            z = h.act_fn(h.norm1(h.conv1(z)))
            z = h.act_fn(h.norm2(h.conv2(z))).transpose(1, 2)
            logits = h.fc2(h.fc1(z))
        elif self.name == 'crnn':
            z = self.model.feat_extractor(x).flatten(1, 2).transpose(1, 2)
            z, _ = self.model.decoder(z)
            logits = self.model.linear(z)
            return logits, torch.div(widths + 3, 4, rounding_mode='floor').clamp(max=logits.shape[1])
        else:
            z = self.model.encoder(x)
            decoder = self.model.decoder
            z = decoder.svtr_encoder(z).flatten(2).transpose(1, 2)
            logits = decoder.fc(z)
        return logits, torch.full((x.shape[0],), logits.shape[1], dtype=torch.long, device=x.device)

    def extend(self, rows):
        extra = sorted({c for row in rows for c in row['text']} - set(self.mapping))
        self.extend_vocab(extra)

    def extend_vocab(self, extra):
        if extra:
            if self.name == 'indra':
                old = self.model.head
                new = nn.Conv1d(old.in_channels, len(self.chars) + len(extra), 1)
                self.model.head = new
            elif self.name == 'ppocr':
                old = self.model.head.fc2
                new = nn.Linear(old.in_features, len(self.chars) + len(extra))
                self.model.head.fc2 = new
            elif self.name == 'crnn':
                old = self.model.linear
                new = nn.Linear(old.in_features, len(self.chars) + len(extra))
                self.model.linear = new
            else:
                old = self.model.decoder.fc
                new = nn.Linear(old.in_features, len(self.chars) + len(extra))
                self.model.decoder.fc = new
            with torch.no_grad():
                new.weight.zero_()
                new.bias.fill_(-12)
                new.weight[:len(self.chars)].copy_(old.weight)
                new.bias[:len(self.chars)].copy_(old.bias)
            self.chars.extend(extra)
            self.mapping = {c: i for i, c in enumerate(self.chars) if i}
            self.meta['added_train_characters'] = extra
        self.meta.setdefault('added_train_characters', [])

    def load_checkpoint(self, path):
        checkpoint = torch.load(path, map_location='cpu', weights_only=True)
        if checkpoint['chars'][:len(self.chars)] != self.chars:
            raise ValueError('Checkpoint character indices do not match the stock recognizer')
        self.model.cpu()
        self.extend_vocab(checkpoint['chars'][len(self.chars):])
        if self.name == 'indra' and 'student' in checkpoint.get('metadata', {}):
            student = checkpoint['metadata']['student']
            indices = student['block_indices']
            self.model.blocks = nn.ModuleList([self.model.blocks[i] for i in indices])
            if 'channel_indices' in student:
                select_channels(self.model, student['channels'], student['channel_indices'])
        self.model.load_state_dict(checkpoint['state_dict'], strict=True)
        self.meta.update(checkpoint.get('metadata', {}))
        return checkpoint

    def prepare(self, rows, training=False, width_scale=1.0):
        prepared = []
        capped = 0
        expanded = 0
        for row in rows:
            gray = cv2.imdecode(np.frombuffer(row['im'], np.uint8), cv2.IMREAD_GRAYSCALE)
            if gray is None:
                raise ValueError('Unreadable compiled line image')
            if self.name == 'indra':
                # Apply Indra's ink-box margins to an already rectified Kraken line.
                yy, xx = np.where(gray < 220)
                if len(xx):
                    x0, x1, y0, y1 = int(xx.min()), int(xx.max()) + 1, int(yy.min()), int(yy.max()) + 1
                    height = y1 - y0
                    px, py = math.ceil(.3 * height), math.ceil(.2 * height)
                    gray = cv2.copyMakeBorder(gray[y0:y1, x0:x1], py, py, px, px, cv2.BORDER_CONSTANT, value=255)
            natural = max(8, round(gray.shape[1] * self.height / gray.shape[0] * width_scale))
            width = min(self.maximum, natural)
            capped += natural > self.maximum
            if training:
                text = row['text']
                timesteps = len(text) + sum(a == b for a, b in zip(text, text[1:])) + 1
                required = timesteps * (4 if self.name in {'indra', 'crnn'} else 8)
                expanded += required > width
                width = max(width, required)
            image = cv2.resize(gray, (width, self.height), interpolation=cv2.INTER_AREA if gray.shape[0] > self.height else cv2.INTER_LINEAR)
            prepared.append((image, row['text']))
        if training:
            self.meta['ctc_expanded_train_lines'] = expanded
        return prepared, capped

    def batch(self, prepared, indices, device, margin_jitter=0.0):
        images = [prepared[i][0] for i in indices]
        if margin_jitter:
            for j, i in enumerate(indices):
                if torch.rand(()).item() < .5:
                    continue
                image = jitter_margins(images[j], ((torch.rand(4) * 2 - 1) * margin_jitter).tolist())
                text = prepared[i][1]
                required = 4 * (len(text) + sum(a == b for a, b in zip(text, text[1:])) + 1)
                width = max(8, required, round(image.shape[1] * self.height / image.shape[0]))
                images[j] = cv2.resize(image, (width, self.height), interpolation=cv2.INTER_AREA if image.shape[0] > self.height else cv2.INTER_LINEAR)
        widths = [image.shape[1] for image in images]
        width = math.ceil(max(self.minimum, max(widths)) / 8) * 8
        channels = 1 if self.name == 'indra' else 3
        x = np.zeros((len(indices), channels, self.height, width), dtype=np.float32)
        if self.name == 'crnn':
            mean = np.asarray(self.model.cfg['mean'], dtype=np.float32)[:, None, None]
            std = np.asarray(self.model.cfg['std'], dtype=np.float32)[:, None, None]
            x[:] = -mean / std
        for j, i in enumerate(indices):
            image = images[j].astype(np.float32) / 255
            if self.name == 'crnn':
                image = (image[None] - mean) / std
            else:
                image = 1 - image if self.name == 'indra' else image * 2 - 1
            x[j, :, :, :widths[j]] = image
        return torch.from_numpy(x).to(device), torch.tensor(widths, device=device)

    def decode(self, logits, lengths):
        ids = logits.argmax(-1).cpu().tolist()
        texts = []
        for sequence, length in zip(ids, lengths.cpu().tolist()):
            last, text = -1, []
            for token in sequence[:length]:
                if token and token != last:
                    text.append(self.chars[token])
                last = token
            texts.append(normalized(''.join(text)))
        return texts


def batches(prepared, size, seed=None):
    indices = sorted(range(len(prepared)), key=lambda i: prepared[i][0].shape[1])
    result = [indices[i:i + size] for i in range(0, len(indices), size)]
    if seed is not None:
        random.Random(seed).shuffle(result)
    return result


def evaluate(adapter, prepared, device, size):
    adapter.model.eval()
    edits = chars = exact = 0
    started = time.perf_counter()
    with torch.inference_mode():
        for indices in batches(prepared, size):
            logits, lengths = adapter.raw(*adapter.batch(prepared, indices, device))
            predicted = adapter.decode(logits, lengths)
            for i, text in zip(indices, predicted):
                truth = prepared[i][1]
                edits += distance(truth, text)
                chars += len(truth)
                exact += truth == text
    if device == 'cuda':
        torch.cuda.synchronize()
    seconds = time.perf_counter() - started
    return {'cer': edits / chars, 'edits': edits, 'characters': chars, 'exact_line_rate': exact / len(prepared),
            'lines': len(prepared), 'seconds': seconds, 'lines_per_second': len(prepared) / seconds}


def freeze_batch_norm(model):
    for module in model.modules():
        if isinstance(module, nn.modules.batchnorm._BatchNorm):
            module.eval()


def train_one(adapter, train_rows, dev_rows, args, output):
    train, capped = adapter.prepare(train_rows, training=True, width_scale=args.width_scale)
    dev, dev_capped = adapter.prepare(dev_rows, width_scale=args.width_scale)
    adapter.model.to('cuda').eval()
    # Bypass inference-only softmax for CTC training, but prove the public forward agrees.
    if adapter.name != 'indra':
        x, widths = adapter.batch(dev, list(range(min(3, len(dev)))), 'cuda')
        with torch.inference_mode():
            expected = adapter.model(x)
            if adapter.name == 'ppocr':
                expected = expected.last_hidden_state
            logits, _ = adapter.raw(x, widths)
            if adapter.name == 'crnn':
                torch.testing.assert_close(logits, expected['logits'], atol=2e-5, rtol=2e-4)
                from doctr.models import crnn_mobilenet_v3_small

                native = crnn_mobilenet_v3_small(pretrained=False, pretrained_backbone=False, exportable=True)
                native.load_state_dict(torch.load(args.crnn_weights, map_location='cpu', weights_only=True), strict=True)
                native = native.cuda().eval()
                original = native(x)['logits']
                order = [len(adapter.chars) - 1] + list(range(len(adapter.chars) - 1))
                torch.testing.assert_close(logits, original[:, :, order], atol=2e-5, rtol=2e-4)
                native_texts = [normalized(native.postprocessor(original[j:j + 1, :int(length)])[0][0])
                                for j, length in enumerate(widths.add(3).div(4, rounding_mode='floor'))]
                assert adapter.decode(logits, adapter.raw(x, widths)[1]) == native_texts
                adapter.meta['native_stock_head_parity'] = True
                del native
            else:
                torch.testing.assert_close(logits.softmax(-1), expected, atol=2e-5, rtol=2e-4)
        adapter.meta['public_forward_parity'] = True
    adapter.model.cpu()
    initial = None
    start_epoch = 0
    if args.resume and (output / 'last.pt').is_file():
        initial = adapter.load_checkpoint(output / 'last.pt')
        start_epoch = initial['epoch']
    elif args.warm_start:
        path = args.warm_start / adapter.name / 'best.pt'
        initial = adapter.load_checkpoint(path)
        start_epoch = initial['epoch']
        adapter.meta['initialization'] = {'checkpoint_epoch': start_epoch, 'sha256': digest(path),
                                          'optimizer': 'fresh AdamW from selected weights'}
    teacher = None
    if args.student_blocks or args.student_channels:
        teacher = Adapter('indra', args)
        teacher.load_checkpoint(args.warm_start / 'indra' / 'best.pt')
        teacher.model.cuda().eval().requires_grad_(False)
        if not (args.resume and (output / 'last.pt').is_file()):
            indices = select_blocks(adapter.model, args.student_blocks or len(adapter.model.blocks))
            adapter.meta['student'] = {'block_indices': indices, 'teacher_sha256': digest(args.warm_start / 'indra' / 'best.pt')}
            if args.student_channels:
                adapter.meta['student'].update(channels=args.student_channels,
                    channel_indices=select_channels(adapter.model, args.student_channels))
            start_epoch = 0
        assert len(adapter.model.blocks) == (args.student_blocks or len(teacher.model.blocks))
        assert adapter.model.stem.out_channels == (args.student_channels or 128)
        assert adapter.chars == teacher.chars
    adapter.model.cuda()
    baseline = evaluate(adapter, dev, 'cuda', args.batch_size)
    print(json.dumps({'model': adapter.name, 'baseline_dev': baseline}), flush=True)
    adapter.model.cpu()
    adapter.extend(train_rows)
    if adapter.name == 'repsvtr':
        # This upstream switch only changes gradient flow, not forward values.
        adapter.model.decoder.svtr_encoder.use_guide = False
    adapter.model.cuda()
    result = {'model': adapter.name, 'metadata': adapter.meta, 'baseline_dev': baseline,
              'train_lines': len(train), 'train_width_capped': capped, 'dev_width_capped': dev_capped,
              'initial_checkpoint_epoch': start_epoch,
              'epochs': [], 'protocol': {'epochs': args.epochs, 'batch_size': args.batch_size, 'lr': args.lr,
                                        'seed': args.seed, 'normalization': 'nfkc-collapse-not-soft-hyphen-v1',
                                        'batch_norm': 'frozen running statistics; trainable affine parameters',
                                        'patience': args.patience, 'min_epochs': args.min_epochs,
                                        'min_delta': args.min_delta, 'lr_patience': args.lr_patience,
                                        'lr_factor': .5, 'min_lr': 1e-6, 'test_used_for_selection': False}}
    optimizer = torch.optim.AdamW(adapter.model.parameters(), lr=args.lr, weight_decay=1e-5)
    if args.width_scale != 1:
        result['protocol']['input_width_scale'] = args.width_scale
    if args.margin_jitter:
        adapter.meta['margin_jitter'] = {'strength': args.margin_jitter, 'probability': .5,
                                         'pixels': 'retain all nonwhite pixels; jitter existing blank margins after ink trimming',
                                         'labels': 'unchanged human transcripts; training-only CTC sizing'}
        result['protocol']['margin_jitter'] = adapter.meta['margin_jitter']
    if teacher:
        result['protocol'].update(student_blocks=args.student_blocks, distillation_weight=.25, distillation_temperature=2.0)
        if args.student_channels:
            result['protocol']['student_channels'] = args.student_channels
    write_json(output / 'model-source.json', adapter.meta)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode='min', factor=.5, patience=args.lr_patience,
        threshold=args.min_delta, threshold_mode='abs', min_lr=1e-6)
    best = baseline['cer']
    result.update(best_epoch=start_epoch, best_dev=baseline, meaningful_best_cer=best,
                  epochs_without_improvement=0, completed=False)
    steps = start_epoch * math.ceil(len(train) / args.batch_size)
    previous_seconds = 0.0
    if args.resume and initial and 'optimizer' in initial:
        previous = initial['result']
        for key, value in result['protocol'].items():
            if key != 'epochs' and previous['protocol'][key] != value:
                raise ValueError('Cannot change the training protocol while resuming: ' + key)
        result = previous
        result['protocol']['epochs'] = args.epochs
        optimizer.load_state_dict(initial['optimizer'])
        scheduler.load_state_dict(initial['scheduler'])
        torch.set_rng_state(initial['rng_torch'])
        torch.cuda.set_rng_state_all(initial['rng_cuda'])
        best = result['best_dev']['cer']
        steps = result['epochs'][-1]['steps']
        previous_seconds = result['training_seconds']
        if not (output / 'best.pt').is_file():
            raise FileNotFoundError('The selected best checkpoint is missing')
    else:
        scheduler.step(best)
        save_checkpoint(output / 'best.pt', {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                                             'chars': adapter.chars, 'epoch': start_epoch, 'metadata': adapter.meta})
    del initial
    started = time.perf_counter()
    for epoch in range(start_epoch, args.epochs):
        adapter.model.train()
        freeze_batch_norm(adapter.model)
        loss_total = 0.0
        schedule = batches(train, args.batch_size, args.seed + epoch)
        for batch_number, indices in enumerate(schedule, 1):
            optimizer.zero_grad(set_to_none=True)
            inputs = adapter.batch(train, indices, 'cuda', margin_jitter=args.margin_jitter)
            logits, lengths = adapter.raw(*inputs)
            texts = [train[i][1] for i in indices]
            labels = [[adapter.mapping[c] for c in text] for text in texts]
            minimums = [len(x) + sum(a == b for a, b in zip(x, x[1:])) for x in labels]
            if any(n > t for n, t in zip(minimums, lengths.tolist())):
                raise ValueError('CTC line cannot fit its input; do not silently drop it')
            target = torch.tensor([c for row in labels for c in row], dtype=torch.long, device='cuda')
            target_lengths = torch.tensor([len(x) for x in labels], dtype=torch.long)
            loss = F.ctc_loss(logits.float().log_softmax(-1).transpose(0, 1), target, lengths.cpu(), target_lengths, blank=0, zero_infinity=False)
            if teacher:
                with torch.no_grad():
                    teacher_logits, teacher_lengths = teacher.raw(*inputs)
                assert torch.equal(lengths, teacher_lengths)
                loss = loss + .25 * distillation_loss(logits.float(), teacher_logits.float(), lengths)
            if not torch.isfinite(loss):
                raise ValueError('Non-finite CTC loss')
            loss.backward()
            nn.utils.clip_grad_norm_(adapter.model.parameters(), 5)
            optimizer.step()
            loss_total += loss.item()
            steps += 1
            if batch_number % 500 == 0:
                print(json.dumps({'model': adapter.name, 'epoch': epoch + 1, 'batch': batch_number,
                                  'batches': len(schedule), 'loss': loss_total / batch_number,
                                  'seconds': round(time.perf_counter() - started, 1)}), flush=True)
        score = evaluate(adapter, dev, 'cuda', args.batch_size)
        lr = optimizer.param_groups[0]['lr']
        result['epochs'].append({'epoch': epoch + 1, 'steps': steps, 'loss': loss_total / len(schedule),
                                  'learning_rate': lr, 'dev': score})
        checkpoint = {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                      'chars': adapter.chars, 'epoch': epoch + 1, 'metadata': adapter.meta}
        if score['cer'] < best:
            best = score['cer']
            save_checkpoint(output / 'best.pt', checkpoint)
            result['best_epoch'] = epoch + 1
            result['best_dev'] = score
        if score['cer'] < result['meaningful_best_cer'] - args.min_delta:
            result['meaningful_best_cer'] = score['cer']
            result['epochs_without_improvement'] = 0
        else:
            result['epochs_without_improvement'] += 1
        scheduler.step(score['cer'])
        stopped = args.patience > 0 and epoch + 1 >= args.min_epochs and result['epochs_without_improvement'] >= args.patience
        result['last_epoch'] = epoch + 1
        result['completed'] = stopped or epoch + 1 == args.epochs
        result['stop_reason'] = 'development_plateau' if stopped else ('epoch_cap' if result['completed'] else 'running')
        result['training_seconds'] = previous_seconds + time.perf_counter() - started
        result['peak_gpu_mib'] = torch.cuda.max_memory_allocated() / 2 ** 20
        save_checkpoint(output / 'last.pt', {**checkpoint, 'optimizer': optimizer.state_dict(),
                                             'scheduler': scheduler.state_dict(), 'result': result,
                                             'rng_torch': torch.get_rng_state(), 'rng_cuda': torch.cuda.get_rng_state_all()})
        write_json(output / 'result.json', result)
        print(json.dumps({'model': adapter.name, 'epoch_complete': epoch + 1, 'dev': score,
                          'best_epoch': result['best_epoch'], 'learning_rate': lr,
                          'next_learning_rate': optimizer.param_groups[0]['lr'],
                          'epochs_without_improvement': result['epochs_without_improvement'],
                          'stop_reason': result['stop_reason']}), flush=True)
        if stopped:
            break
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--source-bundle', type=Path, required=True)
    parser.add_argument('--openocr', type=Path)
    parser.add_argument('--rep-weights', type=Path)
    parser.add_argument('--crnn-weights', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--models', nargs='+', choices=['indra', 'ppocr', 'repsvtr', 'crnn'], default=['indra', 'ppocr', 'repsvtr'])
    parser.add_argument('--epochs', type=int, default=30, help='Maximum total epochs, including warm-start epochs')
    parser.add_argument('--warm-start', type=Path, help='Existing model root whose selected weights initialize a separate run')
    parser.add_argument('--resume', action='store_true', help='Resume optimizer, scheduler and weights from this output root')
    parser.add_argument('--patience', type=int, default=8)
    parser.add_argument('--min-epochs', type=int, default=10)
    parser.add_argument('--min-delta', type=float, default=1e-5)
    parser.add_argument('--lr-patience', type=int, default=2)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--lr', type=float, default=1e-4)
    parser.add_argument('--width-scale', type=float, default=1.0, help='Recognition input width relative to Quality; evaluation never expands from labels')
    parser.add_argument('--margin-jitter', type=float, default=0.0, help='Training-only blank-margin variation in [0, 1]; all glyph pixels remain')
    parser.add_argument('--seed', type=int, default=714)
    parser.add_argument('--student-blocks', type=int, choices=[6, 8], help='Distill a smaller full-width Indra from the warm-start teacher')
    parser.add_argument('--student-channels', type=int, choices=[64, 96], help='Physically prune Indra channels and distill from the full warm-start teacher')
    args = parser.parse_args()
    if 'repsvtr' in args.models and (args.openocr is None or args.rep_weights is None):
        parser.error('--openocr and --rep-weights are required for the RepSVTR candidate')
    if 'crnn' in args.models and args.crnn_weights is None:
        parser.error('--crnn-weights is required for the CRNN candidate')
    if args.epochs < 1 or args.patience < 0 or args.min_epochs < 1 or args.lr_patience < 0 or args.min_delta < 0:
        parser.error('Invalid epoch, patience or development threshold')
    if not 0 < args.width_scale <= 1:
        parser.error('--width-scale must be in (0, 1]')
    if not 0 <= args.margin_jitter <= 1 or args.margin_jitter and args.models != ['indra']:
        parser.error('--margin-jitter must be in [0, 1] and is supported only for Indra')
    if args.warm_start and args.warm_start.resolve() == args.output.resolve():
        parser.error('A warm start must use a separate output root to preserve its checkpoints')
    if (args.student_blocks or args.student_channels) and (args.models != ['indra'] or not args.warm_start or args.width_scale != 1):
        parser.error('Student pruning requires --models indra, --warm-start, and full input width')
    sys.stdout.reconfigure(encoding='utf-8')
    args.output.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(2)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    if not torch.cuda.is_available():
        raise RuntimeError('The screen requires the desktop CUDA GPU')
    lock = args.output / 'running.pid'
    with lock.open('x') as stream:
        stream.write(str(os.getpid()))
    try:
        audit = audit_sources(args.source_bundle, args.data_root)
        reference = args.output / 'data-audit.json' if args.resume else (args.warm_start / 'data-audit.json' if args.warm_start else None)
        if reference and json.loads(reference.read_text(encoding='utf-8')) != audit:
            raise ValueError('Training corpus or partition changed since the source checkpoint')
        write_json(args.output / 'data-audit.json', audit)
        print(json.dumps({'data_audit': audit}), flush=True)
        train = read_rows(args.data_root / 'train.arrow')
        dev = read_rows(args.data_root / 'eval.arrow')
        for name in args.models:
            random.seed(args.seed)
            np.random.seed(args.seed)
            torch.manual_seed(args.seed)
            torch.cuda.reset_peak_memory_stats()
            folder = args.output / name
            folder.mkdir(exist_ok=True)
            if (folder / 'best.pt').is_file() and not args.resume:
                raise ValueError('An existing model output requires --resume: ' + name)
            if args.resume and (folder / 'result.json').is_file():
                previous = json.loads((folder / 'result.json').read_text(encoding='utf-8'))
                if previous.get('completed') and (previous['stop_reason'] == 'development_plateau' or previous['last_epoch'] >= args.epochs):
                    print(json.dumps({'model': name, 'already_complete': True, 'best_epoch': previous['best_epoch']}), flush=True)
                    continue
            adapter = Adapter(name, args)
            write_json(folder / 'model-source.json', adapter.meta)
            train_one(adapter, train, dev, args, folder)
            del adapter
            gc.collect()
            torch.cuda.empty_cache()
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
