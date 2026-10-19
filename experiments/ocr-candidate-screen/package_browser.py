"""Stage the two selected exports and their exact learned codecs for browser packaging."""

import argparse
import hashlib
import json
from pathlib import Path
import shutil


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trained-root', required=True, type=Path)
    parser.add_argument('--assets-root', required=True, type=Path)
    parser.add_argument('--models', nargs='+', choices=['indra', 'crnn'], default=['indra', 'crnn'])
    parser.add_argument('--speed', action='store_true', help='Stage the separate Indra speed experiment without replacing Quality weights')
    args = parser.parse_args()
    if args.speed and args.models != ['indra']:
        parser.error('--speed requires --models indra')
    evaluation = json.loads((args.trained_root / 'evaluation.json').read_text(encoding='utf-8'))
    for name in args.models:
        source = args.trained_root / name
        expected = evaluation['models'][name]
        assert digest(source / 'best.pt') == expected['checkpoint_sha256']
        assert digest(source / 'recognizer.onnx') == expected['onnx']['sha256']
        # Reuse the learned codec on machines which only have inference dependencies.
        codec_path = source / 'codec.json'
        if not codec_path.exists():
            import torch

            checkpoint = torch.load(source / 'best.pt', map_location='cpu', weights_only=True)
            assert checkpoint['epoch'] == expected['selected_epoch']
            chars = checkpoint['chars']
            assert chars[0] == '' and len(set(chars)) == len(chars)
            codec_path.write_text(json.dumps({char: [i] for i, char in enumerate(chars) if i}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            del checkpoint
        target = args.assets_root / (name + ('-speed' if args.speed else ''))
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / 'recognizer.onnx', target / 'model.onnx')
        shutil.copyfile(codec_path, target / 'codec.json')
        provenance = {
            'recognizer': name,
            'selected_epoch': expected['selected_epoch'],
            'checkpoint_sha256': expected['checkpoint_sha256'],
            'model_sha256': digest(target / 'model.onnx'),
            'codec_sha256': digest(target / 'codec.json'),
            'source': json.loads((source / 'model-source.json').read_text(encoding='utf-8')),
        }
        if args.speed:
            provenance['input_width_scale'] = evaluation['protocol']['input_width_scale']
        (target / 'source.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({'recognizer': name, 'model_bytes': (target / 'model.onnx').stat().st_size, 'codec_bytes': (target / 'codec.json').stat().st_size, 'model_sha256': provenance['model_sha256']}), flush=True)


if __name__ == '__main__':
    main()
