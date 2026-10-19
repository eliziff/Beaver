"""Prepare equivalent convolution graphs and private inputs for WASM kernel trials."""

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from evaluate import export, score_onnx
from optimize_indra import stage, with_ids
from screen import Adapter, batches, digest, read_rows, write_json


def head_inputs(adapter, rows, args, source):
    class Head(torch.nn.Module):
        def __init__(self, head):
            super().__init__()
            self.head = head

        def forward(self, image, widths):
            return self.head(image.squeeze(2)).transpose(1, 2), widths

    sample = [rows[int(i)] for i in np.linspace(0, len(rows) - 1, 128, dtype=int)]
    prepared, _ = adapter.prepare(sample)
    head = adapter.model.head
    entries, captured = [], []
    adapter.model.eval()
    hook = head.register_forward_pre_hook(lambda _, inputs: captured.append(inputs[0]))
    try:
        for number, indices in enumerate(batches(prepared, 4)):
            with torch.inference_mode():
                logits, lengths = adapter.raw(*adapter.batch(prepared, indices, 'cpu'))
            features = captured.pop().unsqueeze(2)
            name = f'features-{number}.f32'
            path = args.output / name
            features.numpy().astype('<f4').tofile(path)
            ids_path = args.output / f'ids-{number}.i32'
            logits.argmax(-1).numpy().astype('<i4').tofile(ids_path)
            entries.append({'file': name, 'sha256': digest(path), 'dims': list(features.shape),
                            'widths': lengths.tolist(), 'indices': indices,
                            'ids_file': ids_path.name, 'ids_sha256': digest(ids_path)})
    finally:
        hook.remove()
    for name, tensor in [('weight', head.weight[:, :, 0]), ('bias', head.bias)]:
        tensor.detach().numpy().astype('<f4').tofile(args.output / (name + '.f32'))
    folder = args.assets_root / 'indra-kernels' / args.name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / 'model.onnx'
    wrapper = Head(head).eval()
    with torch.inference_mode():
        torch.onnx.export(wrapper, (features, lengths), path, dynamo=False, opset_version=17,
                          input_names=['image', 'widths'], output_names=['logits', 'lengths'],
                          dynamic_axes={'image': {0: 'batch', 3: 'time'}, 'widths': {0: 'batch'},
                                        'logits': {0: 'batch', 1: 'time'}, 'lengths': {0: 'batch'}})
    from evaluate import session

    runtime = session(path, 1)
    actual, actual_lengths = runtime.run(None, {'image': features.numpy(), 'widths': lengths.numpy()})
    np.testing.assert_allclose(actual, logits.numpy(), atol=3e-4, rtol=3e-3)
    np.testing.assert_array_equal(actual_lengths, lengths.numpy())
    result = {**source, 'lines': len(sample), 'scales': {'1': entries},
              'head': {'model': path.relative_to(args.assets_root.parent).as_posix(),
                       'model_sha256': digest(path), 'channels': head.in_channels,
                       'classes': head.out_channels,
                       'weight': {'file': 'weight.f32', 'sha256': digest(args.output / 'weight.f32')},
                       'bias': {'file': 'bias.f32', 'sha256': digest(args.output / 'bias.f32')}}}
    write_json(folder / 'source.json', {**source, 'scope': 'classifier component only; not a page recognizer'})
    write_json(args.output / 'manifest.json', result)
    print(json.dumps({'head_channels': head.in_channels, 'classes': head.out_channels,
                      'manifest_sha256': digest(args.output / 'manifest.json')}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['spatial', 'inputs', 'head'])
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--assets-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--name', help='Separate package name for a spatial graph')
    parser.add_argument('--width-scale', type=float, choices=[1, .76], default=1)
    args = parser.parse_args()
    if args.action in {'spatial', 'head'} and (not args.name or not args.name.isascii() or not args.name.isalnum() or args.name.lower() != args.name):
        parser.error('spatial/head requires a lowercase alphanumeric --name')
    torch.set_num_threads(2)
    args.output.mkdir(parents=True, exist_ok=True)
    adapter = Adapter('indra', args)
    checkpoint = args.source_root / 'indra' / 'best.pt'
    adapter.load_checkpoint(checkpoint)
    rows = read_rows(args.data_root / 'eval.arrow')
    source = {'checkpoint_sha256': digest(checkpoint), 'dev_arrow_sha256': digest(args.data_root / 'eval.arrow')}
    if args.action == 'head':
        head_inputs(adapter, rows, args, source)
        return
    if args.action == 'inputs':
        # Ordinal sampling is fixed before measuring any candidate.
        sample = [rows[int(i)] for i in np.linspace(0, len(rows) - 1, 128, dtype=int)]
        result = {**source, 'lines': len(sample), 'batch_size': 4, 'scales': {}}
        for scale in [1, .76]:
            prepared, _ = adapter.prepare(sample, width_scale=scale)
            entries = []
            for number, indices in enumerate(batches(prepared, 4)):
                image, widths = adapter.batch(prepared, indices, 'cpu')
                name = f'input-{scale}-{number}.f32'
                path = args.output / name
                image.numpy().astype('<f4').tofile(path)
                entries.append({'file': name, 'sha256': digest(path), 'dims': list(image.shape),
                                'widths': widths.tolist(), 'indices': indices})
            result['scales'][str(scale)] = entries
        write_json(args.output / 'manifest.json', result)
        print(json.dumps({'input_lines': len(sample), 'manifest_sha256': digest(args.output / 'manifest.json')}), flush=True)
        return
    dev, _ = adapter.prepare(rows, width_scale=args.width_scale)
    from indra import IndraSpatial

    adapter.model.eval()
    inputs = adapter.batch(dev, [0, 1], 'cpu')
    with torch.inference_mode():
        before, lengths = adapter.raw(*inputs)
        adapter.model = IndraSpatial(adapter.model).eval()
        after, actual_lengths = adapter.raw(*inputs)
        torch.testing.assert_close(after, before, atol=3e-4, rtol=3e-3)
        torch.testing.assert_close(actual_lengths, lengths)
    path = args.output / (args.name + '.onnx')
    runtime, parity = export(adapter, dev, path, 1)
    result = {**source, 'width_scale': args.width_scale, 'onnx': parity,
              'dev_cpu': score_onnx(adapter, runtime, dev, 16),
              'spatial_max_logit_delta': float((after - before).abs().max())}
    codec = args.source_root / 'indra' / 'codec.json'
    metadata = {'source': adapter.meta, 'layout': 'NCHW with spatial height one',
                'input_width_scale': args.width_scale, **source}
    stage(path, codec, args.assets_root, args.name, metadata)
    compact = args.output / (args.name + 'ids.onnx')
    with_ids(path, compact)
    stage(compact, codec, args.assets_root, args.name + 'ids',
          {**metadata, 'greedy_output': 'class_ids; optional logits retained'})
    result['compact_sha256'] = digest(compact)
    write_json(args.output / (args.name + '-evaluation.json'), result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
