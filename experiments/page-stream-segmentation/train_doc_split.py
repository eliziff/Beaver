"""Doc-split-v1 adaptation from explicit, reviewed teacher targets.

The v2 manifest includes the desktop's reviewed legal-structure split gold.
PDF inventories are rejected. Only saved teacher images are processed. Text is
prepared separately for native multimodal adaptation; both encoders stay frozen.
"""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import time

import numpy as np
import torch
from doc_split_model import recover


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.partial')
    try:
        temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def selection(path):
    dataset = json.loads(path.read_text(encoding='utf-8'))
    if dataset.get('schema_version') != 'doc-split-teacher.v2' or not dataset.get('source_artifacts'):
        raise ValueError('An explicit reviewed teacher-target manifest is required; PDF inventories are not training data')
    families, sources, seen, seams = {}, {}, set(), set()
    for case in dataset['cases']:
        key, split = case['case_id'], case['split']
        if (key in seen or split not in ('train', 'development', 'test')
                or families.setdefault(case['family_id'], split) != split
                or sources.setdefault(case['sha256'], split) != split):
            raise ValueError('Teacher example repeated or source family crosses partitions')
        seen.add(key)
        pages = [image['page'] for image in case['images']]
        if not pages or pages != list(range(pages[0], pages[-1]+1)) or not case['targets']:
            raise ValueError('Teacher context must be contiguous and have explicit targets')
        if case['sha256'] in dataset.get('valid_page_runs', {}):
            if not any(first <= pages[0] <= pages[-1] <= last
                       for first, last in dataset['valid_page_runs'][case['sha256']]):
                raise ValueError('Teacher context crosses an omitted document')
        for page, label in case['targets'].items():
            seam = case['sha256'], int(page)
            if (str(int(page)) != page or int(page) not in pages[1:]
                    or type(label) is not int or label not in (0, 1) or seam in seams):
                raise ValueError('Teacher targets must identify unique binary original-page seams')
            seams.add(seam)
    return dataset


def prepare(args):
    import onnxruntime as ort
    from PIL import Image
    dataset = selection(args.dataset)
    identity = {'image_encoder_sha256': digest(args.out / 'upstream/image_model.onnx'),
                'preprocessing': 'teacher RGB 512x512; normalized to [-1,1]', 'text_input': False}
    cache = args.out / 'teacher-features'
    cache.mkdir(exist_ok=True)
    identity_file = cache / 'identity.json'
    if identity_file.exists() and json.loads(identity_file.read_text()) != identity:
        raise ValueError('Frozen teacher feature identity changed')
    write(identity_file, identity)
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    if 'CUDAExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('CUDA ONNX Runtime required for visual feature extraction')
    session = ort.InferenceSession(str(args.out / 'upstream/image_model.onnx'), options,
        providers=[('CUDAExecutionProvider', {'use_tf32': 0, 'gpu_mem_limit': 3 * 1024**3}), 'CPUExecutionProvider'])
    if 'CUDAExecutionProvider' not in session.get_providers():
        raise RuntimeError('Visual encoder fell back to CPU')
    images = {image['sha256']: image for c in dataset['cases'] for image in c['images']}
    pending, hashes = [], {}
    started = time.perf_counter()
    for sha, image in images.items():
        path = (args.dataset.parent / image['path']).resolve()
        if not path.is_relative_to(args.dataset.parent.resolve()) or digest(path) != sha:
            raise ValueError('Teacher image path or hash differs')
        target, receipt = cache / (sha + '.npy'), cache / (sha + '.json')
        if target.exists() and receipt.exists() and json.loads(receipt.read_text())['sha256'] == digest(target):
            hashes[sha] = digest(target)
        else:
            pending.append((sha, path))
    for start in range(0, len(pending), args.batch):
        batch = pending[start:start+args.batch]
        pixels = []
        for _, path in batch:
            with Image.open(path) as image:
                if image.size != (512, 512):
                    raise ValueError('Teacher image preprocessing changed')
                pixels.append((np.asarray(image.convert('RGB'), dtype=np.float32) / 255 - .5) / .5)
        values = session.run(['image_embed'], {'pixel_values': np.stack(pixels).transpose(0, 3, 1, 2).copy()})[0]
        for (sha, _), value in zip(batch, values):
            target = cache / (sha + '.npy')
            np.save(target, value)
            hashes[sha] = digest(target)
            write(cache / (sha + '.json'), {'sha256': hashes[sha]})
        if start % 100 == 0:
            print(json.dumps({'images_prepared': min(start+args.batch, len(pending)), 'new_images': len(pending)}), flush=True)
    write(args.out / (args.dataset.stem + '-preparation.json'), {'dataset_sha256': digest(args.dataset),
        'identity': identity, 'feature_hashes': hashes, 'onnxruntime': ort.__version__,
        'host': socket.gethostname(), 'seconds': time.perf_counter()-started, 'preparer_sha256': digest(Path(__file__))})


def examples(args):
    dataset = selection(args.dataset)
    receipt = json.loads((args.out / (args.dataset.stem + '-preparation.json')).read_text())
    if receipt['dataset_sha256'] != digest(args.dataset):
        raise ValueError('Prepared teacher dataset changed')
    parts = {}
    for case in dataset['cases']:
        embeddings = []
        for image in case['images']:
            path = args.out / 'teacher-features' / (image['sha256'] + '.npy')
            if digest(path) != receipt['feature_hashes'][image['sha256']]:
                raise ValueError('Frozen teacher features changed')
            embeddings.append(np.load(path))
        pages = [image['page'] for image in case['images']]
        targets = torch.tensor([case['targets'].get(str(p), -1) for p in pages], device='cuda', dtype=torch.float32)
        count = len(pages)
        inputs = {'v_img': torch.tensor(np.stack(embeddings)[None], device='cuda'),
                  'v_txt': torch.zeros((1, count, 384), device='cuda'),
                  'gate': torch.zeros((1, count), device='cuda'), 'mask': torch.ones((1, count), device='cuda')}
        parts.setdefault(case['split'], []).append({'case': case, 'targets': targets, 'inputs': inputs})
    return dataset, parts


def evaluate(model, rows):
    model.eval()
    total, count, sources = 0., 0, {}
    with torch.inference_mode():
        for row in rows:
            logits = model(**row['inputs'])[0]
            keep = row['targets'] >= 0
            total += torch.nn.functional.binary_cross_entropy_with_logits(logits[keep], row['targets'][keep], reduction='sum').item()
            count += int(keep.sum())
            own = sources.setdefault(row['case']['sha256'], {})
            for image, probability in zip(row['case']['images'], torch.sigmoid(logits).cpu().tolist()):
                if str(image['page']) in row['case']['targets']:
                    own[str(image['page'])] = probability
    return total / count, {'sources': [{'sha256': sha, 'probabilities': p} for sha, p in sources.items()]}


def train(args):
    from fit_doc_split import train as fit
    fit(args)


def test(args):
    from fit_doc_split import native_examples, measure
    _, parts = native_examples(args)
    if set(parts) != {'test'}:
        raise ValueError('Final comparison requires the separate test manifest')
    for name, path in [('stock', args.out / 'upstream/head.onnx'), ('finetuned', args.out / 'native-fit/head/head.onnx')]:
        _, predictions = measure(recover(path).cuda(), parts['test'])
        write(args.out / ('teacher-test-' + name + '.json'), predictions)
    write(args.out / 'test-receipt.json', {'dataset_sha256': digest(args.dataset),
        'frozen_candidate_sha256': digest(args.out / 'native-fit/head/head.onnx'), 'training_sha256': digest(args.out / 'native-fit/report.json')})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'prepare-text', 'train', 'test'))
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--batch', type=int, default=2)
    parser.add_argument('--epochs', type=int, default=20)
    parser.add_argument('--learning-rate', type=float, default=1e-6)
    parser.add_argument('--classifier-epochs', type=int, default=30)
    parser.add_argument('--seams-per-step', type=int, default=128)
    parser.add_argument('--seed', type=int, default=7241)
    parser.add_argument('--legal-split-root', type=Path)
    args = parser.parse_args()
    if (args.batch < 1 or args.epochs < 1 or args.learning_rate <= 0
            or args.classifier_epochs < 1 or args.seams_per_step < 1):
        parser.error('Batch, epochs and learning rate must be positive')
    args.out.mkdir(parents=True, exist_ok=True)
    if args.command == 'prepare-text':
        from fit_doc_split import prepare_text
        if args.legal_split_root is None:
            parser.error('--legal-split-root is required for text preparation')
        prepare_text(args)
    else:
        {'prepare': prepare, 'train': train, 'test': test}[args.command](args)
