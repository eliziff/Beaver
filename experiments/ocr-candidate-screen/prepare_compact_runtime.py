"""Save portable CPU ORT graphs and the exact operator/type build configuration."""

import argparse
import hashlib
import json
from pathlib import Path
import uuid

import numpy as np
import onnx
from onnx import numpy_helper
import onnxruntime as ort
from onnxruntime.tools.ort_format_model import create_config_from_models


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--precision', choices=['fp32', 'fp16', 'bf16'], default='fp32',
                        help='Round stored weights; computation remains FP32. Accuracy must be evaluated separately.')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--standard-pack', default='student8ids')
    parser.add_argument('--light-pack', default='student10c64ids')
    args = parser.parse_args()
    assert all(name.replace('-', '').isalnum() for name in [args.standard_pack, args.light_pack]), 'Use asset pack names, not paths'
    args.output = args.output or Path('legal-browser-ocr/assets/indra-compact') / (args.precision if args.precision != 'fp32' else '')
    assert ort.__version__ == '1.22.0', 'Match the browser engine version'
    assets = Path('legal-browser-ocr/assets')
    sources = {
        'standard': assets / 'indra-followup' / args.standard_pack / 'model.onnx',
        'light': assets / 'indra-followup' / args.light_pack / 'model.onnx',
        'detector': assets / 'detectors/indra/model.onnx',
    }
    receipt = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'ort_version': ort.__version__,
               'optimization': 'EXTENDED; excludes architecture-specific level-3 layout transforms',
               'weight_precision': args.precision, 'computation': 'FP32',
               'source_packs': {'standard': args.standard_pack, 'light': args.light_pack}, 'models': {}}
    rng = np.random.default_rng(6841)
    converted = []
    for name, source in sources.items():
        model = onnx.load(source)
        changed = elements = 0
        precision = args.precision if name != 'detector' else 'fp32'
        if precision != 'fp32':
            for tensor in model.graph.initializer:
                if tensor.data_type != onnx.TensorProto.FLOAT:
                    continue
                values = numpy_helper.to_array(tensor).copy()
                assert np.isfinite(values).all()
                if precision == 'fp16':
                    rounded = values.astype(np.float16).astype(np.float32)
                else:
                    bits = values.view(np.uint32)
                    rounded = ((bits + 0x7fff + ((bits >> 16) & 1)) & 0xffff0000).view(np.float32)
                assert np.isfinite(rounded).all()
                changed += int(np.count_nonzero(values != rounded))
                elements += values.size
                tensor.CopyFrom(numpy_helper.from_array(rounded, tensor.name))
            onnx.checker.check_model(model)
        graph_bytes = model.SerializeToString()
        target = args.output / name / 'model.ort'
        target.parent.mkdir(parents=True, exist_ok=True)
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        options.optimized_model_filepath = str(target)
        options.add_session_config_entry('session.save_model_format', 'ORT')
        baseline = ort.InferenceSession(graph_bytes, options, providers=['CPUExecutionProvider'])
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        compact = ort.InferenceSession(str(target), options, providers=['CPUExecutionProvider'])
        checks = []
        shapes = [(1, 1, 160, 128), (1, 1, 224, 192)] if name == 'detector' else [(1, 1, 32, 128), (3, 1, 32, 512)]
        for shape in shapes:
            data = rng.random(shape, dtype=np.float32)
            inputs = {baseline.get_inputs()[0].name: data}
            if name != 'detector':
                inputs['widths'] = np.array([shape[-1] - 13 * index for index in range(shape[0])], np.int64)
            expected, actual = baseline.run(None, inputs), compact.run(None, inputs)
            assert len(expected) == len(actual)
            for left, right in zip(expected, actual):
                np.testing.assert_array_equal(left, right)
            checks.append({'shape': shape, 'all_outputs_exact': True})
        receipt['models'][name] = {'source_sha256': digest(source), 'ort_sha256': digest(target),
                                    'bytes': target.stat().st_size, 'path': target.as_posix(), 'checks': checks,
                                    'weight_precision': precision, 'rounded_elements': changed, 'float_elements': elements,
                                    'conversion_reference_sha256': hashlib.sha256(graph_bytes).hexdigest()}
        converted.append(target)
    config = args.output / 'operators.config'
    create_config_from_models(converted, config, enable_type_reduction=True)
    assert 'com.microsoft.nchwc' not in config.read_text(), 'Do not bake x64 layout kernels into the browser model'
    receipt['operator_config_sha256'] = digest(config)
    (args.output / 'source.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'precision': args.precision, 'operator_config_sha256': receipt['operator_config_sha256'],
                      'models': {name: {'bytes': info['bytes'], 'rounded_elements': info['rounded_elements']}
                                 for name, info in receipt['models'].items()}}), flush=True)


if __name__ == '__main__':
    main()
