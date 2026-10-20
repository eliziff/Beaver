"""Prepare GPU detector candidates; leave the released CPU detector untouched."""

import argparse
import hashlib
import json
import uuid
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.transformers.float16 import convert_float_to_float16
from onnxruntime.transformers.onnx_model import OnnxModel

from gpu_graphs import webgpu_activations, webgpu_softplus


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-root', type=Path, default=Path('legal-browser-ocr/assets'))
    parser.add_argument('--output', type=Path, default=Path('benchmarks/local-data/ocr-candidate-screen/gpu/detector-preparation.json'))
    args = parser.parse_args()
    source = args.assets_root / 'detectors/indra'
    metadata = json.loads((source / 'source.json').read_text(encoding='utf-8'))
    original = source / 'model.onnx'
    assert digest(original) == metadata['sha256']
    graph = onnx.load(original)
    changed = webgpu_activations(graph)
    softplus = webgpu_softplus(graph)
    assert changed == 31 and softplus == 1
    result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'source': metadata,
              'hardswish_lowered': changed, 'softplus_lowered': softplus, 'variants': {}}
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    baseline = ort.InferenceSession(str(original), options, providers=['CPUExecutionProvider'])
    # Independent generated strokes test numeric equivalence, not document accuracy.
    samples = []
    for height, width in [(96, 128), (192, 128)]:
        image = np.zeros((1, 1, height, width), np.float32)
        for y in range(12, height - 6, 17):
            image[:, :, y:y + 3, 9:width - 11:2] = 1
        samples.append({baseline.get_inputs()[0].name: image})
    expected = [baseline.run(None, sample)[0] for sample in samples]
    for name in ['gpu-fp32', 'gpu-fp16']:
        destination = args.assets_root / 'detectors' / name
        destination.mkdir(parents=True, exist_ok=True)
        model = graph if name == 'gpu-fp32' else convert_float_to_float16(graph, keep_io_types=True)
        OnnxModel(model).topological_sort()
        onnx.checker.check_model(model)
        path = destination / 'model.onnx'
        onnx.save(model, path)
        if name == 'gpu-fp32':
            candidate = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
            errors = []
            for sample, truth in zip(samples, expected):
                actual = candidate.run(None, sample)[0]
                np.testing.assert_allclose(actual, truth, rtol=2e-4, atol=2e-4)
                errors.append(float(np.max(np.abs(actual - truth))))
        else:
            errors = None  # FP16 quality is gated on actual browser document output.
        item = {'sha256': digest(path), 'bytes': path.stat().st_size,
                'operators': dict(Counter(node.op_type for node in model.graph.node)),
                'fp32_stroke_max_absolute_error': errors, 'document_accuracy_gate_passed': False}
        (destination / 'source.json').write_text(json.dumps({**result, **item}, indent=2) + '\n', encoding='utf-8')
        result['variants'][name] = item
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    main()
