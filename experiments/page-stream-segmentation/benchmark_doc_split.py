"""Measure the visual splitter on saved teacher pages: CPU and desktop CUDA.

Times preprocessed 512-pixel image inputs, image encoder and boundary head.
Excludes PDF decoding/rendering, OCR and the unused text encoder/stock CRF.
"""
import time
STARTED = time.perf_counter()
import argparse
import gc
import hashlib
import json
from pathlib import Path
import socket
import statistics

import numpy as np
from PIL import Image
import torch  # Preload CUDA/cuDNN before ONNX Runtime on Windows.
import onnxruntime as ort


def benchmark(args):
    dataset = json.loads(args.dataset.read_text(encoding='utf-8'))
    case = next(c for c in dataset['cases'] if c['split'] == 'train' and len(c['images']) >= 8)
    assets = case['images'][:8]
    pixels = []
    for asset in assets:
        path = args.dataset.parent / asset['path']
        with path.open('rb') as stream:
            if hashlib.file_digest(stream, 'sha256').hexdigest() != asset['sha256']:
                raise ValueError('Teacher image changed')
        with Image.open(path) as image:
            pixels.append((np.asarray(image.convert('RGB'), dtype=np.float32)/255 - .5)/.5)
    pixels = np.stack(pixels).transpose(0, 3, 1, 2).copy()
    count = len(pixels)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    results = []
    for name in ('CUDAExecutionProvider', 'CPUExecutionProvider'):
        provider = [(name, {'use_tf32': 0, 'gpu_mem_limit': 3 * 1024**3}), 'CPUExecutionProvider'] if name.startswith('CUDA') else [name]
        began = time.perf_counter()
        image = ort.InferenceSession(str(args.upstream / 'image_model.onnx'), options, providers=provider)
        head = ort.InferenceSession(str(args.upstream / 'head.onnx'), options, providers=provider)
        if name not in image.get_providers() or name not in head.get_providers():
            raise RuntimeError('Requested execution provider unavailable')
        initialization = time.perf_counter()-began
        trials = []
        for trial in range(4):
            began = time.perf_counter()
            embeddings = np.concatenate([image.run(['image_embed'], {'pixel_values': pixels[i:i+2]})[0]
                                         for i in range(0, count, 2)])
            image_seconds = time.perf_counter()-began
            began = time.perf_counter()
            output = head.run(['boundary_logit'], {'v_img': embeddings[None],
                'v_txt': np.zeros((1,count,384), dtype=np.float32), 'gate': np.zeros((1,count), dtype=np.float32),
                'mask': np.ones((1,count), dtype=np.float32)})[0]
            head_seconds = time.perf_counter()-began
            if not np.isfinite(output).all():
                raise ValueError('Invalid splitter output')
            trials.append({'image_seconds': image_seconds, 'head_seconds': head_seconds,
                           'total_seconds': image_seconds+head_seconds})
        median = statistics.median(t['total_seconds'] for t in trials[1:])
        results.append({'provider': name, 'pages': count, 'image_batch': 2, 'cpu_threads': 1,
            'session_initialization_seconds': initialization, 'first_packet_seconds': trials[0]['total_seconds'],
            'warm_pages_per_second': count/median, 'warm_ms_per_page': median/count*1000,
            'warm_image_seconds': statistics.median(t['image_seconds'] for t in trials[1:]),
            'warm_head_seconds': statistics.median(t['head_seconds'] for t in trials[1:]), 'trials': trials})
        print(json.dumps(results[-1]), flush=True)
        del image, head
        gc.collect()
    report = {'submission_origin': 'machine_test', 'run_id': 'doc-split-v1-desktop-inference',
        'host': socket.gethostname(), 'gpu': torch.cuda.get_device_name(), 'onnxruntime': ort.__version__,
        'image_encoder_bytes': (args.upstream/'image_model.onnx').stat().st_size,
        'head_bytes': (args.upstream/'head.onnx').stat().st_size, 'results': results,
        'process_seconds_including_imports_and_both_providers': time.perf_counter()-STARTED,
        'scope': 'Visual-only doc-split-v1; saved preprocessed pages, including runtime CPU/GPU transfers. '
                 'Excludes PDF extraction/rendering, image decoding, OCR, text encoder and stock CRF. '
                 'One warmup then three measured packets; CPU uses one thread. Not a laptop measurement.'}
    args.out.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--upstream', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    benchmark(parser.parse_args())
