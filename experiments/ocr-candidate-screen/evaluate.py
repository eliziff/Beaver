"""Final held-out recognition and matched ONNX CPU timing; no page-speed claim."""

import argparse
import gc
import io
import json
import platform
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
import torch
from torch import nn

from screen import Adapter, batches, digest, distance, evaluate, read_rows, write_json


class Export(nn.Module):
    def __init__(self, adapter):
        super().__init__()
        self.model = adapter.model
        self.adapter = adapter

    def forward(self, image, widths):
        return self.adapter.raw(image, widths)


class Kraken(Adapter):
    def __init__(self, pack, runtime):
        sys.path.insert(0, str(runtime))
        from kraken_lite.recognition import prepare_line

        self.prepare_line = prepare_line
        self.manifest = json.loads((pack / 'manifest.json').read_text(encoding='utf-8'))
        mapping = json.loads((pack / self.manifest['codec']['file']).read_text(encoding='utf-8'))
        if any(len(labels) != 1 for labels in mapping.values()):
            raise ValueError('This benchmark expects the installed single-label Kraken codec')
        self.chars = [''] * (max(labels[0] for labels in mapping.values()) + 1)
        for text, labels in mapping.items():
            self.chars[labels[0]] = text
        self.path = pack / self.manifest['model']['file']
        self.name = 'kraken'

    def prepare(self, rows):
        return [(self.prepare_line(Image.open(io.BytesIO(row['im'])), self.manifest).tensor[0, 0], row['text']) for row in rows], 0

    def batch(self, prepared, indices, device):
        widths = [prepared[i][0].shape[1] for i in indices]
        tensor = np.zeros((len(indices), 1, prepared[0][0].shape[0], max(widths)), dtype=np.float32)
        for j, i in enumerate(indices):
            tensor[j, 0, :, :widths[j]] = prepared[i][0]
        return torch.from_numpy(tensor), torch.tensor(widths)


def session(path, threads):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])


def feed(adapter, runtime, prepared, indices):
    image, widths = adapter.batch(prepared, indices, 'cpu')
    names = {x.name for x in runtime.get_inputs()}
    return {name: (widths.numpy() if name in {'widths', 'sequence_lengths'} else image.numpy()) for name in names}


def score_onnx(adapter, runtime, prepared, size):
    chars = edits = exact = 0
    for indices in batches(prepared, size):
        logits, lengths = runtime.run(None, feed(adapter, runtime, prepared, indices))
        if adapter.name == 'kraken':
            logits = logits.squeeze(2).transpose(0, 2, 1)
        texts = adapter.decode(torch.from_numpy(logits), torch.from_numpy(lengths.astype(np.int64)))
        for i, text in zip(indices, texts):
            truth = prepared[i][1]
            edits += distance(truth, text)
            chars += len(truth)
            exact += truth == text
    return {'cer': edits / chars, 'edits': edits, 'characters': chars,
            'exact_line_rate': exact / len(prepared), 'lines': len(prepared)}


def timing(adapter, runtime, prepared, size):
    # Freeze a uniformly spaced sample by ordinal, before looking at predictions.
    count = min(512, len(prepared))
    subset = [prepared[i] for i in np.linspace(0, len(prepared) - 1, count, dtype=int)]
    inputs = [feed(adapter, runtime, subset, indices) for indices in batches(subset, size)]
    for batch in inputs[:3]:
        runtime.run(None, batch)
    trials = []
    for _ in range(3):
        started = time.perf_counter()
        for batch in inputs:
            runtime.run(None, batch)
        trials.append(time.perf_counter() - started)
    return {'lines': count, 'seconds': trials, 'median_lines_per_second': count / statistics.median(trials),
            'scope': 'warm ONNX inference only; prepared width-bucketed tensors; no decoding, crop preparation or page segmentation'}


def export(adapter, prepared, path, threads):
    adapter.model.cpu().eval()
    x, widths = adapter.batch(prepared, [0, 1], 'cpu')
    fused = False
    if adapter.name == 'repsvtr':
        # Follow OpenOCR tools/infer_det.py:119 and the encoder's own fuse methods.
        def fuse_encoder(parent):
            for name, child in list(parent.named_children()):
                if hasattr(child, 'fuse'):
                    child = child.fuse()
                    setattr(parent, name, child)
                    fuse_encoder(child)
                elif isinstance(child, nn.BatchNorm2d):
                    setattr(parent, name, nn.Identity())
                else:
                    fuse_encoder(child)

        with torch.inference_mode():
            before, _ = adapter.raw(x, widths)
            fuse_encoder(adapter.model.encoder)
            after, _ = adapter.raw(x, widths)
            torch.testing.assert_close(before, after, atol=3e-4, rtol=3e-3)
        fused = True
    wrapper = Export(adapter).eval()
    with torch.inference_mode():
        torch.onnx.export(wrapper, (x, widths), path, dynamo=False, opset_version=17,
                          input_names=['image', 'widths'], output_names=['logits', 'lengths'],
                          dynamic_axes={'image': {0: 'batch', 3: 'width'}, 'widths': {0: 'batch'},
                                        'logits': {0: 'batch', 1: 'time'}, 'lengths': {0: 'batch'}})
    runtime = session(path, threads)
    worst = 0.0
    with torch.inference_mode():
        for indices in [[0, 1], [10, 100, 250]]:
            x, widths = adapter.batch(prepared, indices, 'cpu')
            expected, lengths = adapter.raw(x, widths)
            actual, actual_lengths = runtime.run(None, feed(adapter, runtime, prepared, indices))
            np.testing.assert_allclose(actual, expected.numpy(), atol=3e-4, rtol=3e-3)
            np.testing.assert_array_equal(actual_lengths, lengths.numpy())
            worst = max(worst, float(np.max(np.abs(actual - expected.numpy()))))
    return runtime, {'cases': 2, 'max_logit_delta': worst, 'repvit_fused': fused,
                     'sha256': digest(path), 'bytes': path.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--openocr', type=Path, required=True)
    parser.add_argument('--rep-weights', type=Path, required=True)
    parser.add_argument('--crnn-weights', type=Path)
    parser.add_argument('--models', nargs='+', choices=['indra', 'ppocr', 'repsvtr', 'crnn'], default=['indra', 'ppocr', 'repsvtr'])
    parser.add_argument('--receipt', default='evaluation.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--kraken-pack', type=Path, required=True)
    parser.add_argument('--kraken-runtime', type=Path, required=True)
    parser.add_argument('--threads', type=int, default=2)
    parser.add_argument('--batch-size', type=int, default=16)
    parser.add_argument('--width-scale', type=float, default=1.0)
    parser.add_argument('--baseline-root', type=Path, help='Compare against an earlier selected checkpoint instead of stock weights')
    args = parser.parse_args()
    if not 0 < args.width_scale <= 1:
        parser.error('--width-scale must be in (0, 1]')
    if 'crnn' in args.models and args.crnn_weights is None:
        parser.error('--crnn-weights is required for the CRNN candidate')
    sys.stdout.reconfigure(encoding='utf-8')
    torch.set_num_threads(args.threads)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    rows = read_rows(args.data_root / 'test.arrow')
    result = {'hardware': {'platform': platform.platform(), 'cpu': platform.processor(), 'gpu': torch.cuda.get_device_name()},
              'test_arrow_sha256': digest(args.data_root / 'test.arrow'),
              'protocol': {'cpu_threads': args.threads, 'batch_size': args.batch_size, 'cpu_provider': ort.__version__,
                           'selection': 'development CER selects each checkpoint; final test after training and selection'},
              'models': {}}
    if args.width_scale != 1:
        result['protocol']['input_width_scale'] = args.width_scale
    for name in args.models:
        print('FINAL_EVALUATION ' + name, flush=True)
        adapter = Adapter(name, args)
        prepared, capped = adapter.prepare(rows, width_scale=args.width_scale)
        baseline_source = None
        if args.baseline_root:
            baseline_path = args.baseline_root / name / 'best.pt'
            baseline_checkpoint = adapter.load_checkpoint(baseline_path)
            baseline_source = {'checkpoint_sha256': digest(baseline_path), 'selected_epoch': baseline_checkpoint['epoch']}
        adapter.model.cuda()
        baseline = evaluate(adapter, prepared, 'cuda', args.batch_size)
        adapter.model.cpu()
        checkpoint = adapter.load_checkpoint(args.output / name / 'best.pt')
        adapter.model.cuda()
        trained = evaluate(adapter, prepared, 'cuda', args.batch_size)
        runtime, parity = export(adapter, prepared, args.output / name / 'recognizer.onnx', args.threads)
        cpu = score_onnx(adapter, runtime, prepared, args.batch_size)
        speed = timing(adapter, runtime, prepared, args.batch_size)
        result['models'][name] = {'baseline_test_gpu': baseline, 'trained_test_gpu': trained,
                                  'trained_test_cpu': cpu, 'onnx': parity, 'cpu_timing': speed, 'width_capped': capped,
                                  'selected_epoch': checkpoint['epoch'],
                                  'checkpoint_sha256': digest(args.output / name / 'best.pt')}
        if baseline_source:
            result['models'][name]['baseline_source'] = baseline_source
        write_json(args.output / args.receipt, result)
        print(json.dumps({'model': name, 'test_cer': trained['cer'], 'cpu_lines_per_second': speed['median_lines_per_second']}), flush=True)
        del adapter, prepared, runtime, checkpoint
        gc.collect()
        torch.cuda.empty_cache()
    print('FINAL_EVALUATION kraken', flush=True)
    adapter = Kraken(args.kraken_pack, args.kraken_runtime)
    prepared, _ = adapter.prepare(rows)
    runtime = session(adapter.path, args.threads)
    result['models']['kraken'] = {'test_cpu': score_onnx(adapter, runtime, prepared, args.batch_size),
                                 'cpu_timing': timing(adapter, runtime, prepared, args.batch_size),
                                 'model_sha256': digest(adapter.path), 'model_bytes': adapter.path.stat().st_size}
    write_json(args.output / args.receipt, result)
    print(json.dumps(result['models']['kraken']), flush=True)


if __name__ == '__main__':
    main()
