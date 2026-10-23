"""Export existing Indra weights for GPU execution and measure matched CUDA inputs."""

import argparse
import json
import statistics
import time
import uuid
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.transformers.float16 import DEFAULT_OP_BLOCK_LIST, convert_float_to_float16
from onnxruntime.transformers.onnx_model import OnnxModel
import torch

from evaluate import Export, feed
from indra import IndraSpatial
from optimize_indra import stage, with_ids
from screen import Adapter, batches, digest, distance, read_rows, write_json
from gpu_graphs import webgpu_activations


def cuda_session(path, profile=None):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if profile:
        options.enable_profiling = True
        options.profile_file_prefix = str(profile)
    runtime = ort.InferenceSession(str(path), sess_options=options, providers=[
        # ORT 1.22's TF32 switch also excludes FP16 tensor-core plans when false.
        ('CUDAExecutionProvider', {'cudnn_conv_algo_search': 'HEURISTIC', 'use_tf32': '1'}),
        'CPUExecutionProvider',
    ])
    assert runtime.get_providers()[0] == 'CUDAExecutionProvider', runtime.get_providers()
    runtime.disable_fallback()
    return runtime


def ids_score(adapter, runtime, prepared, size):
    edits = characters = 0
    for indices in batches(prepared, size):
        ids, lengths = runtime.run(['class_ids', 'lengths'], feed(adapter, runtime, prepared, indices))
        for i, sequence, length in zip(indices, ids, lengths):
            previous, text = 0, []
            for token in sequence[:int(length)]:
                token = int(token)
                if token and token != previous:
                    text.append(adapter.chars[token])
                previous = token
            from screen import normalized
            prediction = normalized(''.join(text))
            truth = prepared[i][1]
            edits += distance(truth, prediction)
            characters += len(truth)
    return {'cer': edits / characters, 'edits': edits, 'characters': characters, 'lines': len(prepared)}


def prepare(args):
    roots = {
        'gpustock': None,
        'gpuquality': args.root / 'convergence',
        'gpu8': args.root / 'speed-followup/student8',
        'gpu6': args.root / 'speed-followup/student6',
        'gpu64': args.root / 'speed-frontier/channel64',
        'gpu96': args.root / 'speed-frontier/channel96',
        'gpu64crop': args.root / 'speed-frontier/crop-robust64',
        'gpu64control': args.root / 'speed-frontier/crop-control64',
        'gpu8crop': args.root / 'speed-frontier/crop-robust128',
        'gpu8control': args.root / 'speed-frontier/crop-control128',
    }
    result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'models': {},
              'protocol': 'Existing weights only; full width; FP16 selected on development human transcripts.'}
    for name, source in roots.items():
        if args.only and name not in args.only:
            continue
        adapter = Adapter('indra', args)
        if source:
            adapter.load_checkpoint(source / 'indra/best.pt')
        adapter.model.eval()
        dev, _ = adapter.prepare(read_rows(args.data_root / 'eval.arrow'))
        original = adapter.model
        sample = adapter.batch(dev, [0, 1], 'cpu')
        with torch.inference_mode():
            expected, expected_lengths = original(*sample)
            adapter.model = IndraSpatial(original).eval()
            actual, actual_lengths = adapter.model(*sample)
            torch.testing.assert_close(expected, actual, atol=3e-4, rtol=3e-3)
            torch.testing.assert_close(expected_lengths, actual_lengths)
        folder = args.output / name
        folder.mkdir(parents=True, exist_ok=True)
        codec = folder / 'codec.json'
        write_json(codec, {character: [i] for i, character in enumerate(adapter.chars) if i})
        raw = folder / 'fp32.onnx'
        with torch.inference_mode():
            torch.onnx.export(Export(adapter).eval(), sample, raw, dynamo=False, opset_version=17,
                              input_names=['image', 'widths'], output_names=['logits', 'lengths'],
                              dynamic_axes={'image': {0: 'batch', 3: 'width'}, 'widths': {0: 'batch'},
                                            'logits': {0: 'batch', 1: 'time'}, 'lengths': {0: 'batch'}})
        graph = onnx.load(raw)
        changed = webgpu_activations(graph)
        assert changed > 0
        onnx.save(graph, raw)
        compact = folder / 'model.onnx'
        with_ids(raw, compact)
        cpu = ort.InferenceSession(str(compact), providers=['CPUExecutionProvider'])
        for indices in list(batches(dev, 16))[:3]:
            inputs = feed(adapter, cpu, dev, indices)
            with torch.inference_mode():
                logits, lengths = adapter.model(torch.from_numpy(inputs['image']), torch.from_numpy(inputs['widths']))
            found, counts = cpu.run(['class_ids', 'lengths'], inputs)
            np.testing.assert_array_equal(found, logits.numpy().argmax(-1))
            np.testing.assert_array_equal(counts, lengths.numpy())
        half = folder / 'half.onnx'
        converted = convert_float_to_float16(
            onnx.load(compact), keep_io_types=True, disable_shape_infer=False,
            op_block_list=[*DEFAULT_OP_BLOCK_LIST, 'ArgMax'])
        OnnxModel(converted).topological_sort()
        onnx.checker.check_model(converted)
        onnx.save(converted, half)
        native = cuda_session(compact)
        baseline = ids_score(adapter, native, dev, 32)
        del native
        native = cuda_session(half)
        half_score = ids_score(adapter, native, dev, 32)
        del native
        metadata = {'source': adapter.meta, 'full_width': True, 'spatial_convolutions': True,
                    'hardswish_lowered': changed, 'class_ids': True, 'fp32_dev': baseline,
                    'fp16_dev': half_score, 'fp16_gate_absolute_cer': .0005,
                    'fp16_gate_passed': half_score['cer'] <= baseline['cer'] + .0005}
        stage(compact, codec, args.assets_root, name, metadata)
        stage(half, codec, args.assets_root, name + 'h', {**metadata, 'precision': 'float16; float32 image IO'})
        result['models'][name] = {**metadata, 'fp32_sha256': digest(compact), 'fp16_sha256': digest(half)}
        write_json(args.output / 'preparation.json', result)
        print(json.dumps({'model': name, 'fp32_dev_cer': baseline['cer'], 'fp16_dev_cer': half_score['cer'],
                          'fp16_gate_passed': metadata['fp16_gate_passed']}), flush=True)


def benchmark(args):
    manifest_path = args.root / 'speed-frontier/inputs/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    lines = []
    for entry in manifest['scales']['1']:
        path = manifest_path.parent / entry['file']
        assert digest(path) == entry['sha256']
        pixels = np.fromfile(path, dtype='<f4').reshape(entry['dims'])
        lines.extend((pixels[n, :, :, :width].copy(), width) for n, width in enumerate(entry['widths']))
    assert len(lines) == manifest['lines']
    result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'models': {},
              'hardware': {'gpu': torch.cuda.get_device_name(0)}, 'providers': ort.get_available_providers(),
              'input_manifest_sha256': digest(manifest_path),
              'scope': 'Warm CUDA recognition, prepared 128 development lines; CPU input/output copies included; no page-speed claim.'}
    for name in args.only:
        model = args.assets_root / 'indra-followup' / name / 'model.onnx'
        runtime = cuda_session(model)
        values = {}
        for size in [4, 16, 32, 64]:
            inputs = []
            for offset in range(0, len(lines), size):
                selected = lines[offset:offset + size]
                width = (max(line[1] for line in selected) + 7) // 8 * 8
                pixels = np.zeros((len(selected), 1, 32, width), dtype=np.float32)
                for n, (line, length) in enumerate(selected):
                    pixels[n, :, :, :length] = line
                inputs.append({'image': pixels, 'widths': np.asarray([line[1] for line in selected], dtype=np.int64)})
            for entry in inputs:
                runtime.run(['class_ids', 'lengths'], entry)
            trials = []
            for _ in range(7):
                started = time.perf_counter()
                for entry in inputs:
                    runtime.run(['class_ids', 'lengths'], entry)
                trials.append(time.perf_counter() - started)
            values[str(size)] = {'seconds': trials, 'lines_per_second': len(lines) / statistics.median(trials)}
        result['models'][name] = {'model_sha256': digest(model), 'batches': values}
        write_json(args.output / 'cuda.json', result)
        print(json.dumps({'model': name, 'lines_per_second_by_batch': {k: v['lines_per_second'] for k, v in values.items()}}), flush=True)
        del runtime


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'benchmark'])
    parser.add_argument('--root', type=Path, default=Path('benchmarks/local-data/ocr-candidate-screen'))
    parser.add_argument('--output', type=Path, default=Path('benchmarks/local-data/ocr-candidate-screen/gpu'))
    parser.add_argument('--assets-root', type=Path, default=Path('legal-browser-ocr/assets'))
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--only', nargs='+')
    args = parser.parse_args()
    if args.action == 'prepare' and not args.data_root:
        parser.error('prepare requires --data-root')
    if args.action == 'benchmark' and not args.only:
        parser.error('benchmark requires --only GPU_PACK ...')
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    args.output.mkdir(parents=True, exist_ok=True)
    (prepare if args.action == 'prepare' else benchmark)(args)


if __name__ == '__main__':
    main()
