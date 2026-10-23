"""Cut integer width bookkeeping out of a copied GPU recognizer; preserve its mask."""

import argparse
import hashlib
import json
from pathlib import Path
import uuid

import numpy as np
import onnx
from onnx import helper, TensorProto
import onnxruntime as ort


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets-root', type=Path, default=Path('legal-browser-ocr/assets'))
    parser.add_argument('--only', nargs='+', default=['gpu8h', 'gpu64h'])
    args = parser.parse_args()
    for name in args.only:
        assert name.isalnum(), 'Use a pack name, not a path'
        source = args.assets_root / 'indra-followup' / name
        original = source / 'model.onnx'
        metadata = json.loads((source / 'source.json').read_text(encoding='utf-8'))
        assert digest(original) == metadata['model_sha256']
        model = onnx.shape_inference.infer_shapes(onnx.load(original))
        width_values, convolution_values, candidates = {'widths'}, set(), set()
        for node in model.graph.node:
            if node.op_type == 'Mul':
                candidates.update(value for value in node.input if value in width_values and value not in convolution_values)
            if any(value in width_values for value in node.input):
                width_values.update(node.output)
            if node.op_type not in ['Shape', 'Size'] and (node.op_type in ['Conv', 'Gemm', 'MatMul'] or any(value in convolution_values for value in node.input)):
                convolution_values.update(node.output)
        assert len(candidates) == 1, sorted(candidates)
        mask = candidates.pop()
        extracted = onnx.utils.Extractor(model).extract_model(['image', mask], ['logits'])
        mask_input = next(value for value in extracted.graph.input if value.name == mask)
        mask_type = mask_input.type.tensor_type.elem_type
        assert mask_type in [TensorProto.FLOAT16, TensorProto.FLOAT]
        mask_input.CopyFrom(helper.make_tensor_value_info('mask', TensorProto.FLOAT, ['batch', 1, 1, 'steps']))
        extracted.graph.node.insert(0, helper.make_node('Cast', ['mask'], [mask], to=mask_type))
        onnx.checker.check_model(extracted)
        destination = source.with_name(name + '-capture')
        destination.mkdir(parents=True, exist_ok=True)
        path = destination / 'model.onnx'
        onnx.save(extracted, path)
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        before = ort.InferenceSession(str(original), options, providers=['CPUExecutionProvider'])
        after = ort.InferenceSession(str(path), options, providers=['CPUExecutionProvider'])
        checks = []
        for width in [128, 320, 768]:
            image = np.random.default_rng(width).uniform(0, 1, (2, 1, 32, width)).astype(np.float32)
            widths = np.array([width, width // 2 + 3], np.int64)
            lengths = (widths + 3) // 4
            mask_data = (np.arange((width + 3) // 4)[None, :] < lengths[:, None]).astype(np.float32)[:, None, None, :]
            expected = before.run(['logits'], {'image': image, 'widths': widths})[0]
            actual = after.run(['logits'], {'image': image, 'mask': mask_data})[0]
            np.testing.assert_array_equal(expected, actual)
            checks.append({'width': width, 'logits_exact': True})
        result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'original_model_sha256': digest(original),
                  'model_sha256': digest(path), 'mask_value': mask, 'mask_type': mask_type,
                  'image_dimensions': [dim.dim_param or dim.dim_value for dim in extracted.graph.input[0].type.tensor_type.shape.dim],
                  'checks': checks, 'document_accuracy_gate_passed': False,
                  'modification': 'External float mask replaces integer width bookkeeping; logits and weights unchanged'}
        (destination / 'source.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(json.dumps(result))


if __name__ == '__main__':
    main()
