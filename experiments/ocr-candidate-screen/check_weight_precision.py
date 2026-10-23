"""Score stored-weight precision on human development transcripts, using FP32 CPU math."""

import argparse
import json
from pathlib import Path
import uuid

import onnxruntime as ort
import torch

from gpu_indra import ids_score
from screen import Adapter, digest, read_rows, write_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--output', type=Path,
                        default=Path('benchmarks/local-data/ocr-candidate-screen/browser/packaging/precision-development.json'))
    parser.add_argument('--candidate-root', type=Path, help='Score a separately staged FP16/BF16 model group against its FP32 source')
    parser.add_argument('--only', nargs='+', choices=['standard', 'light'], default=['standard', 'light'])
    args = parser.parse_args()
    torch.set_num_threads(1)
    adapter = Adapter('indra', args)
    dev, _ = adapter.prepare(read_rows(args.data_root / 'eval.arrow'))
    assets = Path('legal-browser-ocr/assets')
    candidate = json.loads((args.candidate_root / 'source.json').read_text()) if args.candidate_root else None
    if candidate:
        assert candidate['weight_precision'] in ['fp16', 'bf16']
    result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()),
              'scope': 'All development lines, full width, human transcripts; no test-set selection',
              'development_sha256': digest(args.data_root / 'eval.arrow'), 'models': {}}
    for name, original_pack in [('standard', 'student8ids'), ('light', 'student10c64ids')]:
        if name not in args.only:
            continue
        pack = candidate['source_packs'][name] if candidate else original_pack
        codec = json.loads((assets / 'indra-followup' / pack / 'codec.json').read_text())
        adapter.chars = [''] * (max(max(ids) for ids in codec.values()) + 1)
        for character, ids in codec.items():
            for index in ids:
                adapter.chars[index] = character
        scores = result['models'][name] = {}
        for precision in ['fp32', candidate['weight_precision']] if candidate else ['fp32', 'fp16', 'bf16']:
            folder = assets / 'indra-compact' / (precision if precision != 'fp32' else '')
            path = folder / name / 'model.ort'
            if candidate:
                path = assets / 'indra-followup' / pack / 'model.onnx' if precision == 'fp32' else args.candidate_root / name / 'model.ort'
            options = ort.SessionOptions()
            options.intra_op_num_threads = options.inter_op_num_threads = 1
            options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED if path.suffix == '.onnx' else ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            runtime = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
            scores[precision] = {'sha256': digest(path), **ids_score(adapter, runtime, dev, 16)}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            write_json(args.output, result)
            print(json.dumps({'model': name, 'precision': precision, **scores[precision]}), flush=True)
        if candidate:
            assert scores[candidate['weight_precision']]['cer'] <= scores['fp32']['cer'] + .0005, 'Stored precision failed the development accuracy gate'


if __name__ == '__main__':
    main()
