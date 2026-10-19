"""Prepare bounded Indra quantization/output trials or export selected students."""

import argparse
import json
from pathlib import Path
import shutil

import numpy as np
import onnx
from onnx import helper, TensorProto
from onnx import numpy_helper
import torch
import onnxruntime as ort
from onnxruntime.quantization import QuantFormat, QuantType, quantize_static
from onnxruntime.quantization.shape_inference import quant_pre_process

from evaluate import export, feed, score_onnx, session, timing
from optimize_repsvtr import Calibration, sample
from screen import Adapter, batches, digest, read_rows, write_json


def stage(path, codec, assets, name, metadata):
    target = assets / 'indra-followup' / name
    target.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target / 'model.onnx')
    shutil.copyfile(codec, target / 'codec.json')
    write_json(target / 'source.json', {**metadata, 'model_sha256': digest(path),
                                       'codec_sha256': digest(codec)})


def student_name(adapter):
    name = 'student' + str(len(adapter.model.blocks))
    if adapter.model.stem.out_channels != 128:
        name += 'c' + str(adapter.model.stem.out_channels)
    return name


def with_ids(source, target):
    model = onnx.load(source)
    model.graph.node.append(helper.make_node('ArgMax', ['logits'], ['class_ids'], axis=2, keepdims=0))
    # Retain optional logits for the existing confidence/retry consumer.
    model.graph.output.append(helper.make_tensor_value_info('class_ids', TensorProto.INT64, ['batch', 'time']))
    onnx.checker.check_model(model)
    onnx.save(model, target)


def linear_head(source, target):
    """Move the small feature tensor, rather than transposing all class scores."""
    model = onnx.load(source)
    producers = {output: node for node in model.graph.node for output in node.output}
    transpose = producers['logits']
    assert transpose.op_type == 'Transpose'
    assert next(helper.get_attribute_value(a) for a in transpose.attribute if a.name == 'perm') == [0, 2, 1]
    head = producers[transpose.input[0]]
    assert head.op_type == 'Conv'
    values = {value.name: numpy_helper.to_array(value) for value in model.graph.initializer}
    weight = values[head.input[1]]
    assert weight.ndim == 3 and weight.shape[-1] == 1
    model.graph.initializer.append(numpy_helper.from_array(np.ascontiguousarray(weight[:, :, 0].T), 'linear_head_weight'))
    kept = [node for node in model.graph.node if node.name not in {head.name, transpose.name}]
    del model.graph.node[:]
    model.graph.node.extend(kept + [
        helper.make_node('Transpose', [head.input[0]], ['linear_head_features'], perm=[0, 2, 1]),
        helper.make_node('MatMul', ['linear_head_features', 'linear_head_weight'], ['linear_head_scores']),
        helper.make_node('Add', ['linear_head_scores', head.input[2]], ['logits']),
    ])
    used = {value for node in model.graph.node for value in node.input}
    kept = [value for value in model.graph.initializer if value.name in used]
    del model.graph.initializer[:]
    model.graph.initializer.extend(kept)
    onnx.checker.check_model(model)
    onnx.save(model, target)


def quantize(args):
    folder = args.output
    folder.mkdir(parents=True, exist_ok=True)
    source = args.source_root / 'indra' / 'recognizer.onnx'
    expected = json.loads((args.source_root / 'evaluation.json').read_text())['models']['indra']
    assert digest(source) == expected['onnx']['sha256']
    adapter = Adapter('indra', args)
    adapter.load_checkpoint(args.source_root / 'indra' / 'best.pt')
    dev, _ = adapter.prepare(read_rows(args.data_root / 'eval.arrow'), width_scale=.76)
    calibration, _ = adapter.prepare(sample(read_rows(args.data_root / 'train.arrow'), 128), width_scale=.76)
    runtime = session(source, 1)
    result = {'source_sha256': digest(source), 'environment': {'onnxruntime': ort.__version__, 'onnx': onnx.__version__, 'torch': torch.__version__, 'numpy': np.__version__},
              'data_sha256': {s: digest(args.data_root / (s + '.arrow')) for s in ['train', 'eval']},
              'protocol': {'width_scale': .76, 'calibration_train_lines': 128, 'dev_lines': len(dev),
                           'accuracy_gate_absolute_cer': .0005, 'selection': 'development only; browser latency decides'}, 'variants': {}}
    metadata = json.loads((args.source_root / 'indra' / 'model-source.json').read_text())
    codec = args.source_root / 'indra' / 'codec.json'
    score = score_onnx(adapter, runtime, dev, 16)
    result['variants']['fp32'] = {'dev': score, 'timing': timing(adapter, runtime, dev, 16), 'sha256': digest(source), 'bytes': source.stat().st_size}
    stage(source, codec, args.assets_root, 'fp32', {'source': metadata, 'input_width_scale': .76})
    quality = args.assets_root / 'indra'
    stage(quality / 'model.onnx', quality / 'codec.json', args.assets_root, 'quality',
          json.loads((quality / 'source.json').read_text(encoding='utf-8')))
    ids_path = folder / 'ids.onnx'
    with_ids(source, ids_path)
    ids_runtime = session(ids_path, 1)
    schedules = list(batches(dev, 16))
    for position in np.linspace(0, len(schedules) - 1, 4, dtype=int):
        indices = schedules[position]
        inputs = feed(adapter, runtime, dev, indices)
        logits, lengths = runtime.run(None, inputs)
        ids, actual_lengths = ids_runtime.run(['class_ids', 'lengths'], inputs)
        np.testing.assert_array_equal(ids, logits.argmax(-1))
        np.testing.assert_array_equal(lengths, actual_lengths)
    result['variants']['ids'] = {'dev': score, 'parity_batches': 4, 'sha256': digest(ids_path), 'bytes': ids_path.stat().st_size}
    stage(ids_path, codec, args.assets_root, 'ids', {'source': metadata, 'input_width_scale': .76, 'greedy_output': 'class_ids; optional logits retained'})
    matmul_path = folder / 'matmul.onnx'
    linear_head(source, matmul_path)
    matmul_runtime = session(matmul_path, 1)
    for position in np.linspace(0, len(schedules) - 1, 4, dtype=int):
        inputs = feed(adapter, runtime, dev, schedules[position])
        expected_logits, expected_lengths = runtime.run(None, inputs)
        actual_logits, actual_lengths = matmul_runtime.run(None, inputs)
        np.testing.assert_allclose(actual_logits, expected_logits, atol=3e-4, rtol=3e-3)
        np.testing.assert_array_equal(actual_lengths, expected_lengths)
    result['variants']['matmul'] = {'dev': score_onnx(adapter, matmul_runtime, dev, 16), 'parity_batches': 4,
                                    'sha256': digest(matmul_path), 'bytes': matmul_path.stat().st_size}
    stage(matmul_path, codec, args.assets_root, 'matmul', {'source': metadata, 'input_width_scale': .76, 'classifier': 'MatMul with NTC features'})
    matmul_ids = folder / 'matmulids.onnx'
    with_ids(matmul_path, matmul_ids)
    stage(matmul_ids, codec, args.assets_root, 'matmulids', {'source': metadata, 'input_width_scale': .76, 'classifier': 'MatMul with NTC features', 'greedy_output': 'class_ids; optional logits retained'})
    result['variants']['matmulids'] = {'sha256': digest(matmul_ids), 'bytes': matmul_ids.stat().st_size}
    # Fold the normalization across Squeeze explicitly; the exporter leaves it separate.
    adapter.model.eval()
    inputs = adapter.batch(dev, [0, 1], 'cpu')
    with torch.inference_mode():
        before, lengths = adapter.raw(*inputs)
        adapter.model.stem = torch.nn.utils.fusion.fuse_conv_bn_eval(adapter.model.stem, adapter.model.stem_bn)
        adapter.model.stem_bn = torch.nn.Identity()
        after, actual_lengths = adapter.raw(*inputs)
        torch.testing.assert_close(before, after, atol=3e-4, rtol=3e-3)
        torch.testing.assert_close(lengths, actual_lengths)
    fused = folder / 'fused.onnx'
    fused_runtime, parity = export(adapter, dev, fused, 1)
    result['variants']['fused'] = {'dev': score_onnx(adapter, fused_runtime, dev, 16), 'onnx': parity,
                                  'normalization_fusion_max_logit_delta': float((before-after).abs().max())}
    stage(fused, codec, args.assets_root, 'fused', {'source': metadata, 'input_width_scale': .76, 'normalization_fused': True})
    fused_ids = folder / 'fusedids.onnx'
    with_ids(fused, fused_ids)
    stage(fused_ids, codec, args.assets_root, 'fusedids', {'source': metadata, 'input_width_scale': .76, 'normalization_fused': True, 'greedy_output': 'class_ids; optional logits retained'})
    result['variants']['fusedids'] = {'sha256': digest(fused_ids), 'bytes': fused_ids.stat().st_size}
    preprocessed = folder / 'quantization-input.onnx'
    try:
        quant_pre_process(fused, preprocessed, skip_optimization=True, skip_symbolic_shape=True)
        result['quantization_input_sha256'] = digest(preprocessed)
        graph = onnx.load(preprocessed).graph
        weights = {value.name: onnx.numpy_helper.to_array(value) for value in graph.initializer}
        for name, activation, weight in [('int8', QuantType.QInt8, QuantType.QInt8),
                                         ('uint8', QuantType.QUInt8, QuantType.QUInt8),
                                         ('mixed8', QuantType.QUInt8, QuantType.QInt8),
                                         ('mixed7', QuantType.QUInt8, QuantType.QInt8),
                                         ('pointwise8', QuantType.QInt8, QuantType.QInt8),
                                         ('body8', QuantType.QInt8, QuantType.QInt8)]:
            print('QUANTIZE ' + name, flush=True)
            path = folder / (name + '.onnx')
            nodes = [node.name for node in graph.node if node.op_type == 'Conv'
                     and (name != 'pointwise8' or all(n == 1 for n in weights[node.input[1]].shape[2:]))
                     and (name != 'body8' or not any('/' + part + '/' in node.name for part in ['stem', 'head']))]
            quantize_static(preprocessed, path, Calibration(adapter, runtime, calibration), quant_format=QuantFormat.QDQ,
                            op_types_to_quantize=['Conv'], per_channel=True, activation_type=activation, weight_type=weight,
                            nodes_to_quantize=nodes, reduce_range=name == 'mixed7',
                            extra_options={'ActivationSymmetric': activation == QuantType.QInt8, 'WeightSymmetric': weight == QuantType.QInt8})
            candidate = session(path, 1)
            entry = {'dev': score_onnx(adapter, candidate, dev, 16), 'timing': timing(adapter, candidate, dev, 16), 'quantized_convolutions': len(nodes),
                     'sha256': digest(path), 'bytes': path.stat().st_size}
            entry['passes_dev_gate'] = entry['dev']['cer'] <= score['cer'] + .0005
            result['variants'][name] = entry
            stage(path, codec, args.assets_root, name, {'source': metadata, 'input_width_scale': .76,
                                                       'quantization': {'format': 'QDQ', 'activation': activation.name, 'weight': weight.name,
                                                                        'per_channel': True, 'reduce_range': name == 'mixed7', 'calibration_train_lines': 128, 'normalization_fused': True}})
            write_json(folder / 'results.json', result)
            print(json.dumps({name: entry}), flush=True)
        result['complete'] = True
        write_json(folder / 'results.json', result)
    finally:
        preprocessed.unlink(missing_ok=True)


def student(args):
    folder = args.source_root / 'indra'
    training = json.loads((folder / 'result.json').read_text())
    assert training['completed']
    adapter = Adapter('indra', args)
    checkpoint = adapter.load_checkpoint(folder / 'best.pt')
    assert 'student' in adapter.meta
    dev, _ = adapter.prepare(read_rows(args.data_root / 'eval.arrow'))
    runtime, parity = export(adapter, dev, folder / 'recognizer.onnx', 1)
    result = {'model': 'indra', 'selected_epoch': checkpoint['epoch'], 'checkpoint_sha256': digest(folder / 'best.pt'),
              'parameters': sum(p.numel() for p in adapter.model.parameters()), 'onnx': parity,
              'dev_cpu': score_onnx(adapter, runtime, dev, 16), 'dev_timing': timing(adapter, runtime, dev, 16),
              'data_sha256': {'eval': digest(args.data_root / 'eval.arrow'), 'test': digest(args.data_root / 'test.arrow')}}
    # The architecture/checkpoint is selected before this previously examined test set.
    test, _ = adapter.prepare(read_rows(args.data_root / 'test.arrow'))
    result['test_cpu'] = score_onnx(adapter, runtime, test, 16)
    write_json(args.source_root / 'evaluation.json', result)
    codec = folder / 'codec.json'
    write_json(codec, {c: [i] for i, c in enumerate(adapter.chars) if i})
    name = student_name(adapter)
    stage(folder / 'recognizer.onnx', codec, args.assets_root, name,
          {'source': adapter.meta, 'checkpoint_sha256': result['checkpoint_sha256'], 'selected_epoch': checkpoint['epoch'], 'input_width_scale': 1})
    print(json.dumps(result), flush=True)


def compact(args):
    folder = args.source_root / 'indra'
    evaluation = json.loads((args.source_root / 'evaluation.json').read_text())
    source = folder / 'recognizer.onnx'
    assert digest(source) == evaluation['onnx']['sha256']
    adapter = Adapter('indra', args)
    adapter.load_checkpoint(folder / 'best.pt')
    assert 'student' in adapter.meta
    dev, _ = adapter.prepare(read_rows(args.data_root / 'eval.arrow'))
    original = session(source, 1)
    target = folder / 'greedy.onnx'
    with_ids(source, target)
    runtime = session(target, 1)
    schedules = list(batches(dev, 16))
    for position in np.linspace(0, len(schedules) - 1, 4, dtype=int):
        inputs = feed(adapter, original, dev, schedules[position])
        logits, lengths = original.run(None, inputs)
        ids, actual_lengths = runtime.run(['class_ids', 'lengths'], inputs)
        np.testing.assert_array_equal(ids, logits.argmax(-1))
        np.testing.assert_array_equal(actual_lengths, lengths)
    result = {'source_sha256': digest(source), 'sha256': digest(target),
              'bytes': target.stat().st_size, 'parity_batches': 4,
              'dev_arrow_sha256': digest(args.data_root / 'eval.arrow'),
              'evaluation_sha256': digest(args.source_root / 'evaluation.json')}
    name = student_name(adapter) + 'ids'
    stage(target, folder / 'codec.json', args.assets_root, name,
          {'source': adapter.meta, **result, 'input_width_scale': 1,
           'greedy_output': 'class_ids; optional logits retained'})
    write_json(args.source_root / 'compact-evaluation.json', result)
    print(json.dumps(result), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['quantize', 'student', 'compact'])
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--assets-root', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.action == 'quantize' and not args.output:
        parser.error('quantize requires --output')
    torch.set_num_threads(2)
    torch.manual_seed(714)
    {'quantize': quantize, 'student': student, 'compact': compact}[args.action](args)


if __name__ == '__main__':
    main()
