"""Screen CPU quantization on development data, then test the selected export."""

import argparse
import gc
import json
from pathlib import Path
import statistics
import sys
import time

import numpy as np
import onnxruntime as ort
from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_dynamic, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process
import torch

from evaluate import feed, score_onnx, session, timing
from screen import Adapter, batches, digest, read_rows, write_json


def sample(rows, count):
    return [rows[i] for i in np.linspace(0, len(rows) - 1, min(count, len(rows)), dtype=int)]


def quick_timing(adapter, runtime, prepared, size):
    subset = sample(prepared, 64)
    inputs = [feed(adapter, runtime, subset, ids) for ids in batches(subset, size)]
    for batch in inputs[:2]:
        runtime.run(None, batch)
    trials = []
    for _ in range(3):
        started = time.perf_counter()
        for batch in inputs:
            runtime.run(None, batch)
        trials.append(time.perf_counter() - started)
    return {'lines': len(subset), 'seconds': trials, 'lines_per_second': len(subset) / statistics.median(trials)}


class Calibration(CalibrationDataReader):
    def __init__(self, adapter, runtime, prepared):
        self.inputs = iter(feed(adapter, runtime, prepared, ids) for ids in batches(prepared, 4))

    def get_next(self):
        return next(self.inputs, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--openocr', type=Path, required=True)
    parser.add_argument('--rep-weights', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resume', action='store_true', help='Reuse completed development scores after checking model hashes')
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    torch.set_num_threads(2)
    folder = args.output / 'repsvtr'
    source = folder / 'recognizer.onnx'
    adapter = Adapter('repsvtr', args)
    checkpoint = torch.load(folder / 'best.pt', map_location='cpu', weights_only=True)
    adapter.chars = checkpoint['chars']
    del checkpoint
    dev, _ = adapter.prepare(sample(read_rows(args.data_root / 'eval.arrow'), 256))
    calibration, _ = adapter.prepare(sample(read_rows(args.data_root / 'train.arrow'), 64))
    result = {'source_sha256': digest(source), 'runtime': ort.__version__,
              'protocol': {'calibration': '64 uniformly spaced training lines; batch 4; no transcripts',
                           'selection': '256 uniformly spaced development lines; fastest variant within +0.05 percentage points CER of FP32',
                           'threads': 2, 'batch_size': 16, 'test_used_for_selection': False},
              'variants': {}}
    receipt = args.output / 'repsvtr-optimization.json'
    audit = json.loads((args.output / 'data-audit.json').read_text(encoding='utf-8'))
    result['data_sha256'] = {split: digest(args.data_root / (split + '.arrow')) for split in ['train', 'eval', 'test']}
    assert all(value == audit[split]['arrow_sha256'] for split, value in result['data_sha256'].items())
    previous = {}
    if args.resume:
        previous = json.loads(receipt.read_text(encoding='utf-8'))
        assert previous['source_sha256'] == result['source_sha256']
        assert previous['protocol'] == result['protocol']
        assert previous['runtime'] == result['runtime']
        assert previous.get('data_sha256', result['data_sha256']) == result['data_sha256']
        result['variants'] = previous['variants']
    runtime = session(source, 2)
    baseline_dev = result['variants'].get('fp32', {}).get('dev') or score_onnx(adapter, runtime, dev, 16)
    result['variants']['fp32'] = {'path': source.name, 'sha256': digest(source), 'bytes': source.stat().st_size,
                                  'dev': baseline_dev,
                                  'timing': quick_timing(adapter, runtime, dev, 16)}
    result['fp32_batch_screen'] = {str(size): quick_timing(adapter, runtime, dev, size) for size in [1, 4]}
    print(json.dumps({'fp32': result['variants']['fp32'], 'batch_screen': result['fp32_batch_screen']}), flush=True)
    write_json(receipt, result)
    preprocessed = folder / 'quantization-input.onnx'
    try:
        quant_pre_process(source, preprocessed, skip_symbolic_shape=True)
        for name, mode in [('dynamic-matmul', 'dynamic'), ('int8-qdq', 'static'),
                           ('uint8-qdq', 'unsigned'), ('int8-conv-qdq', 'conv')]:
            path = folder / (name + '.onnx')
            print('QUANTIZE ' + name, flush=True)
            cached = result['variants'].get(name)
            if cached:
                assert digest(path) == cached['sha256']
            elif mode == 'dynamic':
                quantize_dynamic(preprocessed, path, op_types_to_quantize=['MatMul'], per_channel=True,
                                 reduce_range=True, weight_type=QuantType.QInt8)
            else:
                quantize_static(preprocessed, path, Calibration(adapter, runtime, calibration),
                                quant_format=QuantFormat.QDQ,
                                op_types_to_quantize=['Conv'] if mode == 'conv' else ['Conv', 'MatMul'],
                                per_channel=True,
                                activation_type=QuantType.QUInt8 if mode == 'unsigned' else QuantType.QInt8,
                                weight_type=QuantType.QUInt8 if mode == 'unsigned' else QuantType.QInt8,
                                extra_options={'ActivationSymmetric': mode != 'unsigned',
                                               'WeightSymmetric': mode != 'unsigned'})
            candidate = session(path, 2)
            entry = {'path': path.name, 'sha256': digest(path), 'bytes': path.stat().st_size,
                     'dev': cached['dev'] if cached else score_onnx(adapter, candidate, dev, 16),
                     'timing': quick_timing(adapter, candidate, dev, 16)}
            result['variants'][name] = entry
            print(json.dumps({name: entry}), flush=True)
            write_json(receipt, result)
            del candidate
            gc.collect()
        baseline = result['variants']['fp32']['dev']['cer']
        eligible = {name: entry for name, entry in result['variants'].items() if entry['dev']['cer'] <= baseline + .0005}
        selected = max(eligible, key=lambda name: eligible[name]['timing']['lines_per_second'])
        result['selected'] = selected
        write_json(receipt, result)
        print('SELECTED ' + selected, flush=True)
        del runtime
        if previous.get('selected') == selected and 'selected_test_timing' in previous:
            for key in ['selected_test', 'selected_test_timing', 'test_width_capped']:
                result[key] = previous[key]
            result['test_receipt_reused'] = True
        elif selected == 'fp32' and (args.output / 'evaluation.json').is_file():
            original = json.loads((args.output / 'evaluation.json').read_text(encoding='utf-8'))
            assert original['test_arrow_sha256'] == result['data_sha256']['test']
            original = original['models']['repsvtr']
            assert original['onnx']['sha256'] == result['source_sha256']
            result['selected_test'] = original['trained_test_cpu']
            result['selected_test_timing'] = original['cpu_timing']
            result['test_width_capped'] = original['width_capped']
            result['test_receipt_reused'] = 'original FP32 evaluation; identical model and frozen test hashes'
        else:
            runtime = session(folder / eligible[selected]['path'], 2)
            test, capped = adapter.prepare(read_rows(args.data_root / 'test.arrow'))
            result['selected_test'] = score_onnx(adapter, runtime, test, 16)
            result['selected_test_timing'] = timing(adapter, runtime, test, 16)
            result['test_width_capped'] = capped
        write_json(receipt, result)
        print(json.dumps({'selected': selected, 'test': result['selected_test'], 'timing': result['selected_test_timing']}), flush=True)
    finally:
        preprocessed.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
