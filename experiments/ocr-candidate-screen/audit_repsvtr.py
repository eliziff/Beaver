"""Compare the adapted line preprocessor with OpenOCR's actual evaluator."""

import argparse
import json
from pathlib import Path
import sys

import cv2
import numpy as np
import torch

from screen import Adapter, digest, evaluate, read_rows, write_json


class OfficialResize(Adapter):
    def prepare(self, rows):
        from openrec.preprocess.resize import RecDynamicResize

        operation = RecDynamicResize(image_shape=[48, 320], padding=False)
        return [(operation({'image': cv2.imdecode(np.frombuffer(row['im'], np.uint8), cv2.IMREAD_COLOR)})['image'], row['text'])
                for row in rows], 0

    def batch(self, prepared, indices, device):
        width = max(prepared[i][0].shape[2] for i in indices)
        images = np.zeros((len(indices), 3, 48, width), dtype=np.float32)
        for j, i in enumerate(indices):
            image = prepared[i][0]
            images[j, :, :, :image.shape[2]] = image
        return torch.from_numpy(images).to(device), torch.full((len(indices),), width, device=device)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--openocr', type=Path, required=True)
    parser.add_argument('--rep-weights', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    torch.set_num_threads(2)
    rows = read_rows(args.data_root / 'eval.arrow')
    rows = [rows[i] for i in np.linspace(0, len(rows) - 1, 256, dtype=int)]
    adapter = Adapter('repsvtr', args)
    official = object.__new__(OfficialResize)
    official.name, official.model, official.chars = adapter.name, adapter.model, adapter.chars
    adapted, _ = adapter.prepare(rows)
    reference, _ = official.prepare(rows)
    pixels = [cv2.imdecode(np.frombuffer(row['im'], np.uint8), cv2.IMREAD_COLOR) for row in rows]
    result = {'lines': len(rows), 'partition': 'uniformly spaced development sample; no test',
              'colored_lines': sum(bool(np.any(x[:, :, 0] != x[:, :, 1]) or np.any(x[:, :, 1] != x[:, :, 2])) for x in pixels),
              'downsampled_lines': sum(x.shape[0] > 48 for x in pixels),
              'upstream_resize_sha256': digest(args.openocr / 'openrec/preprocess/resize.py'),
              'source': adapter.meta['source'], 'omitted_auxiliary_tensors': adapter.meta['omitted_auxiliary_tensors'],
              'adapted_width_percentiles': np.percentile([x[0].shape[1] for x in adapted], [0, 50, 100]).tolist()}
    adapter.model.cuda()
    result['stock_adapted_batch16'] = evaluate(adapter, adapted, 'cuda', 16)
    result['stock_official_batch1'] = evaluate(official, reference, 'cuda', 1)
    adapter.model.cpu()
    checkpoint = torch.load(args.output / 'repsvtr/best.pt', map_location='cpu', weights_only=True)
    changes = [float((parameter.detach() - checkpoint['state_dict'][name]).abs().max())
               for name, parameter in adapter.model.named_parameters() if name.startswith('encoder.')]
    result['encoder_parameter_tensors'] = len(changes)
    result['changed_encoder_parameter_tensors'] = sum(value > 0 for value in changes)
    result['max_encoder_parameter_change'] = max(changes)
    assert any(value > 0 for value in changes), 'The encoder must have been fine-tuned'
    result['batch_norm_statistics_unchanged'] = all(torch.equal(value, checkpoint['state_dict'][name])
        for name, value in adapter.model.state_dict().items()
        if name.endswith(('running_mean', 'running_var', 'num_batches_tracked')))
    assert result['batch_norm_statistics_unchanged']
    adapter.extend_vocab(checkpoint['chars'][len(adapter.chars):])
    adapter.model.load_state_dict(checkpoint['state_dict'], strict=True)
    adapter.model.cuda()
    official.model, official.chars = adapter.model, adapter.chars
    result['trained_adapted_batch16'] = evaluate(adapter, adapted, 'cuda', 16)
    result['trained_adapted_batch1'] = evaluate(adapter, adapted, 'cuda', 1)
    result['trained_official_batch1'] = evaluate(official, reference, 'cuda', 1)
    write_json(args.output / 'repsvtr-audit.json', result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
