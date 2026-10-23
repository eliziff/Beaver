"""Prepare isolated detector/head speed candidates from the existing model assets."""

import argparse
import difflib
import hashlib
import json
import os
import uuid
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
import onnxruntime as ort


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def options():
    value = ort.SessionOptions()
    value.intra_op_num_threads = value.inter_op_num_threads = 1
    return value


def inspect(root):
    for name, path in [
        ('detector', root / 'legal-browser-ocr/assets/detectors/indra/model.onnx'),
        ('standard', root / 'legal-browser-ocr/assets/indra-followup/gpu8croph-capture/model.onnx'),
        ('light', root / 'legal-browser-ocr/assets/indra-followup/gpu64croph-capture/model.onnx'),
    ]:
        graph = onnx.shape_inference.infer_shapes(onnx.load(path))
        types = {value.name: {'type': value.type.tensor_type.elem_type,
                 'shape': [dim.dim_param or dim.dim_value for dim in value.type.tensor_type.shape.dim]}
                 for value in [*graph.graph.input, *graph.graph.value_info, *graph.graph.output]}
        arrays = {value.name: list(value.dims) for value in graph.graph.initializer}
        print(json.dumps({'name': name, 'sha256': digest(path), 'ops': dict(Counter(node.op_type for node in graph.graph.node)),
                          'inputs': [types[value.name] for value in graph.graph.input],
                          'tail': [{'op': node.op_type, 'name': node.name, 'inputs': list(node.input), 'outputs': list(node.output),
                                    'shapes': {key: types.get(key, arrays.get(key)) for key in [*node.input, *node.output]}}
                                   for node in graph.graph.node[-8:]]}))


def quantize_detector(root):
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
    from onnxruntime.quantization.shape_inference import quant_pre_process

    source = root / 'legal-browser-ocr/assets/detectors/indra/model.onnx'
    cache = root / 'benchmarks/local-data/ocr-candidate-screen/detector-student/cache'
    cache_manifest = json.loads((cache / 'manifest.json').read_text())
    assert digest(source) == cache_manifest['teacher_sha256']
    assert cache_manifest['splits']['page_overlap'] == cache_manifest['splits']['article_overlap'] == 0
    selected = np.linspace(0, cache_manifest['splits']['train']['pages'] - 1, 24, dtype=int).tolist()
    input_name = onnx.load(source).graph.input[0].name

    class Reader(CalibrationDataReader):
        def __init__(self):
            self.rows = iter(selected)

        def get_next(self):
            index = next(self.rows, None)
            if index is None:
                return None
            with np.load(cache / f'train-{index:04}.npz') as row:
                return {input_name: row['image'][None].astype(np.float32)}

    output = root / 'legal-browser-ocr/assets/detectors/frontier-int8'
    output.mkdir(parents=True, exist_ok=True)
    optimized = output / 'preprocessed.onnx'
    try:
        quant_pre_process(str(source), str(optimized), skip_symbolic_shape=True)
        for name, activation, weight in [('s8', QuantType.QInt8, QuantType.QInt8), ('u8', QuantType.QUInt8, QuantType.QUInt8)]:
            folder = output / name
            folder.mkdir(exist_ok=True)
            model = folder / 'model.onnx'
            quantize_static(str(optimized), str(model), Reader(), quant_format=QuantFormat.QDQ,
                            per_channel=True, activation_type=activation, weight_type=weight,
                            op_types_to_quantize=['Conv'], extra_options={'ActivationSymmetric': False})
            graph = onnx.load(model)
            onnx.checker.check_model(graph)
            runtime = ort.InferenceSession(str(model), options(), providers=['CPUExecutionProvider'])
            original = ort.InferenceSession(str(source), options(), providers=['CPUExecutionProvider'])
            checks = []
            for index in [0, 23, 47, 67]:
                with np.load(cache / f'eval-{index:04}.npz') as row:
                    image = row['image'][None].astype(np.float32)
                before = original.run(None, {input_name: image})[0]
                after = runtime.run(None, {input_name: image})[0]
                assert before.shape == after.shape and np.isfinite(after).all()
                checks.append({'development_page_index': index, 'mean_absolute_tensor_delta': float(np.abs(before - after).mean()),
                               'maximum_absolute_tensor_delta': float(np.abs(before - after).max())})
            receipt = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'source_sha256': digest(source),
                       'model_sha256': digest(model), 'model_bytes': model.stat().st_size,
                       'format': name + ' QDQ per-channel Conv', 'calibration_split': 'train', 'calibration_indices': selected,
                       'cache_manifest_sha256': digest(cache / 'manifest.json'), 'checks': checks,
                       'document_cer_measured': False, 'operators': dict(Counter(node.op_type for node in graph.graph.node))}
            write_json(folder / 'source.json', receipt)
            print(json.dumps(receipt), flush=True)
    finally:
        optimized.unlink(missing_ok=True)


def prepare_heads(root):
    for name in ['gpu8croph', 'gpu64croph']:
        source = root / 'legal-browser-ocr/assets/indra-followup' / (name + '-capture/model.onnx')
        graph = onnx.shape_inference.infer_shapes(onnx.load(source))
        head = next(node for node in graph.graph.node if node.name == '/model/head/Conv')
        arrays = {value.name: numpy_helper.to_array(value) for value in graph.graph.initializer}
        weight, bias = arrays[head.input[1]], arrays[head.input[2]]
        classes, channels, height, width = weight.shape
        assert (height, width) == (1, 1) and weight.dtype == bias.dtype == np.float16
        feature = onnx.utils.Extractor(graph).extract_model(['image', 'mask'], [head.input[0]])
        feature.graph.node.append(helper.make_node('Cast', [head.input[0]], ['features'], to=TensorProto.FLOAT))
        del feature.graph.output[:]
        feature.graph.output.append(helper.make_tensor_value_info('features', TensorProto.FLOAT, ['batch', channels, 1, 'steps']))
        onnx.checker.check_model(feature)
        output = source.parent.with_name(name + '-features')
        output.mkdir(exist_ok=True)
        model = output / 'model.onnx'
        onnx.save(feature, model)
        # Column-major classes make adjacent GPU lanes read adjacent weights.
        header = np.array([channels, classes, 1, 0], np.uint32).tobytes()
        values = weight[:, :, 0, 0].T.astype(np.float32).copy().tobytes() + bias.astype(np.float32).tobytes()
        binary = output / 'head.bin'
        binary.write_bytes(header + values)
        classifier = helper.make_graph([
            helper.make_node('Cast', ['features'], ['half_features'], to=TensorProto.FLOAT16),
            helper.make_node('Conv', ['half_features', 'weight', 'bias'], ['scores'], kernel_shape=[1, 1], strides=[1, 1], dilations=[1, 1], pads=[0, 0, 0, 0]),
            helper.make_node('Squeeze', ['scores', 'axis'], ['squeezed']),
            helper.make_node('Transpose', ['squeezed'], ['half_logits'], perm=[0, 2, 1]),
            helper.make_node('Cast', ['half_logits'], ['logits'], to=TensorProto.FLOAT),
        ], 'existing-fp16-ctc-head', [helper.make_tensor_value_info('features', TensorProto.FLOAT, ['batch', channels, 1, 'steps'])],
            [helper.make_tensor_value_info('logits', TensorProto.FLOAT, ['batch', 'steps', classes])],
            [numpy_helper.from_array(weight, 'weight'), numpy_helper.from_array(bias, 'bias'), numpy_helper.from_array(np.array([2], np.int64), 'axis')])
        component = helper.make_model(classifier, opset_imports=[helper.make_opsetid('', 17)], ir_version=9)
        onnx.checker.check_model(component)
        onnx.save(component, output / 'classifier.onnx')
        receipt = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'source_sha256': digest(source),
                   'model_sha256': digest(model), 'head_sha256': digest(binary), 'classifier_sha256': digest(output / 'classifier.onnx'),
                   'classes': classes, 'channels': channels, 'output_rounding': 'float16 then float32, matching the original head',
                   'document_cer_measured': False}
        write_json(output / 'source.json', receipt)
        print(json.dumps(receipt), flush=True)


def prepare_conv_fusion(root):
    source = root / 'legal-browser-ocr/assets/detectors/indra/model.onnx'
    graph = onnx.load(source)
    consumers = {}
    for node in graph.graph.node:
        for value in node.input:
            consumers.setdefault(value, []).append(node)
    replacements, skipped = {}, set()
    for node in graph.graph.node:
        following = consumers.get(node.output[0], [])
        if node.op_type == 'Conv' and len(following) == 1 and following[0].op_type == 'HardSwish':
            activation = following[0]
            fused = onnx.NodeProto()
            fused.CopyFrom(node)
            fused.op_type, fused.domain = 'FusedConv', 'com.microsoft'
            fused.output[0] = activation.output[0]
            fused.attribute.append(helper.make_attribute('activation', 'HardSwish'))
            replacements[node.name] = fused
            skipped.add(activation.name)
    assert len(replacements) == 31, len(replacements)
    nodes = [replacements.get(node.name, node) for node in graph.graph.node if node.name not in skipped]
    del graph.graph.node[:]
    graph.graph.node.extend(nodes)
    graph.opset_import.append(helper.make_opsetid('com.microsoft', 1))
    onnx.checker.check_model(graph)
    output = root / 'legal-browser-ocr/assets/detectors/frontier-convhswish'
    output.mkdir(parents=True, exist_ok=True)
    onnx.save(graph, output / 'model.onnx')
    write_json(output / 'source.json', {'origin': 'machine_test', 'run_id': str(uuid.uuid4()),
               'source_sha256': digest(source), 'model_sha256': digest(output / 'model.onnx'), 'fused_nodes': len(replacements),
               'weights_unchanged': True, 'browser_tensor_parity_measured': False})
    cache = Path(os.environ.get('OCR_WASM_TOOLS', Path.home() / '.local/share/legal-browser-ocr')) / 'onnxruntime-1.22.0'
    changes = {}

    def replace(relative, before, after):
        original = (cache / relative).read_text()
        modified = changes.get(relative, original)
        assert modified.count(before) == 1, (relative, before)
        changes[relative] = modified.replace(before, after)

    replace('onnxruntime/core/mlas/inc/mlas.h', '    MlasActivationKindCount,', '    MlasHardSwishActivation,\n    MlasActivationKindCount,')
    activation = '''template<>
struct MLAS_ACTIVATION_FUNCTION<MlasHardSwishActivation>
{
    MLAS_ACTIVATION_FUNCTION(const MLAS_ACTIVATION*) {}
    MLAS_FLOAT32X4 Activate(MLAS_FLOAT32X4 Value) {
        auto gate = MlasAddFloat32x4(MlasMultiplyFloat32x4(Value, MlasBroadcastFloat32x4(1.0f / 6.0f)), MlasBroadcastFloat32x4(.5f));
        gate = MlasMaximumFloat32x4(MlasMinimumFloat32x4(gate, MlasBroadcastFloat32x4(1.0f)), MlasZeroFloat32x4());
        return MlasMultiplyFloat32x4(Value, gate);
    }
    float Activate(float Value) {
        const float gate = std::max(std::min((1.0f / 6.0f) * Value + .5f, 1.0f), 0.0f);
        return Value * gate;
    }
};

'''
    replace('onnxruntime/core/mlas/lib/activate.cpp', 'template<>\nstruct MLAS_ACTIVATION_FUNCTION<MlasHardSigmoidActivation>',
            activation + 'template<>\nstruct MLAS_ACTIVATION_FUNCTION<MlasHardSigmoidActivation>')
    replace('onnxruntime/core/mlas/lib/activate.cpp', '        case MlasActivationKindCount:',
            '''        case MlasHardSwishActivation:
        {
            MlasActivationKernel<MlasHardSwishActivation>(Activation, Buffer, Bias, M, N, ldc);
            break;
        }

        case MlasActivationKindCount:''')
    replace('onnxruntime/contrib_ops/cpu/fused_activation.cc', '    } else {\n      // The remaining activation types',
            '    } else if (activation_type == "HardSwish") {\n      activation.ActivationKind = MlasHardSwishActivation;\n    } else {\n      // The remaining activation types')
    patch = ''.join('diff --git a/' + relative + ' b/' + relative + '\n' + ''.join(difflib.unified_diff(
        (cache / relative).read_text().splitlines(keepends=True), modified.splitlines(keepends=True),
        fromfile='a/' + relative, tofile='b/' + relative)) for relative, modified in changes.items())
    (root / 'experiments/ocr-candidate-screen/conv-hardswish-wasm.patch').write_text(patch)
    operators = {}
    for line in (root / 'experiments/ocr-candidate-screen/hardswish-operators.config').read_text().splitlines():
        domain, version, names = line.split(';')
        operators[(domain, int(version))] = set(names.split(','))
    scratch = root / 'legal-browser-ocr/assets/indra-kernels/frontier2'
    scratch.mkdir(parents=True, exist_ok=True)
    for name in ['s8', 'u8']:
        path = root / 'legal-browser-ocr/assets/detectors/frontier-int8' / name / 'model.onnx'
        optimized = scratch / ('optimized-' + name + '.onnx')
        try:
            config = options()
            config.optimized_model_filepath = str(optimized)
            runtime = ort.InferenceSession(str(path), config, providers=['CPUExecutionProvider'], disabled_optimizers=['NchwcTransformer'])
            del runtime
            for model in [onnx.load(path), onnx.load(optimized)]:
                versions = {entry.domain: entry.version for entry in model.opset_import}
                for node in model.graph.node:
                    operators.setdefault((node.domain or 'ai.onnx', versions[node.domain]), set()).add(node.op_type)
        finally:
            optimized.unlink(missing_ok=True)
    operators[('com.microsoft', 1)].update({'NhwcConv', 'QLinearConv', 'QLinearAdd', 'QLinearConcat'})
    config_path = root / 'experiments/ocr-candidate-screen/frontier-operators.config'
    config_path.write_text(''.join(f'{domain};{version};{",".join(sorted(names))}\n' for (domain, version), names in sorted(operators.items())))
    print(json.dumps({'fused_convolutions': len(replacements), 'patch_sha256': digest(root / 'experiments/ocr-candidate-screen/conv-hardswish-wasm.patch'),
                      'config_sha256': digest(config_path)}), flush=True)


def inspect_kernel():
    source = Path(os.environ.get('OCR_WASM_TOOLS', Path.home() / '.local/share/legal-browser-ocr')) / 'onnxruntime-1.22.0/onnxruntime'
    for relative in ['core/mlas/lib/activate.cpp', 'core/providers/cpu/nn/conv.h',
                     'core/providers/cpu/nn/conv_attributes.h', 'core/util/math_cpuonly.h', 'contrib_ops/cpu/fused_conv.cc']:
        path = source / relative
        if not path.exists():
            continue
        lines = path.read_text().splitlines()
        selected = set()
        for index, line in enumerate(lines):
            if any(key in line for key in ['HardSigmoid', 'GetMlasActivation', 'MlasClipActivation', 'activation_', 'activation ==']):
                selected.update(range(max(0, index - 4), min(len(lines), index + 13)))
        print(json.dumps({'file': relative, 'lines': [f'{i+1}: {lines[i]}' for i in sorted(selected)]}))
    for path in (source / 'contrib_ops/cpu').rglob('*.h'):
        contents = path.read_text(errors='replace')
        if 'GetFusedActivationAttr' in contents:
            print(json.dumps({'file': str(path.relative_to(source)), 'contents': contents}))
    print(json.dumps({'home_directories': [str(path) for path in Path.home().iterdir() if path.is_dir() and not path.name.startswith('.')]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['inspect', 'quantize-detector', 'heads', 'conv-fusion', 'inspect-kernel'])
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    if args.mode == 'inspect':
        inspect(args.root)
    elif args.mode == 'quantize-detector':
        quantize_detector(args.root)
    elif args.mode == 'heads':
        prepare_heads(args.root)
    elif args.mode == 'conv-fusion':
        prepare_conv_fusion(args.root)
    else:
        inspect_kernel()


if __name__ == '__main__':
    main()
