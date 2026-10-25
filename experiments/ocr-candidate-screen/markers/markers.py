"""Marker and note-call recognition: measure, fine-tune and export Indra student weights.

  markers.py measure --checkpoint BEST.pt --crops CROPS_DIR --split development --sample 300 --out OUT.json
  markers.py train --checkpoint BEST.pt --crops CROPS_DIR --data-root ARROW_DIR --output RUN_DIR [...]
  markers.py final --checkpoint BEST.pt [--baseline BEST.pt] --crops CROPS_DIR --data-root ARROW_DIR --out OUT.json

Gold text is the structure-gold v4 corrected line (OCR line + text_edits); note calls are
plain characters with gold reference spans, list markers gold marker spans.
"""
import argparse, collections, functools, io, json, math, os, random, sys, time, unicodedata
os.environ['HF_HUB_OFFLINE'] = '1'
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pyarrow.ipc as ipc
import torch
from rapidfuzz.distance import Levenshtein
from torch import nn
from torch.nn import functional as F

import screen
from screen import Adapter, normalized, batches, evaluate, freeze_batch_norm, read_rows, save_checkpoint, write_json, digest

# The trained weights derive from this upstream revision; never resolve a moving 'main'.
INDRA_REVISION = 'ed345c7f158eddbc7dee0c6a7269afb75a94f7e8'
screen.hf_hub_download = functools.partial(screen.hf_hub_download, revision=INDRA_REVISION)

SEED = 714


def read_crops(path):
    with open(path, 'rb') as source:
        reader = ipc.open_file(source)
        rows = []
        for i in range(reader.num_record_batches):
            rows.extend(reader.get_batch(i).column('lines').to_pylist())
    for row in rows:
        row['markers'] = json.loads(row['markers'])
        row['refs'] = json.loads(row['refs'])
    return rows


def usable(row):
    gold = row['text']
    if not gold.strip() or '�' in gold:
        return False
    g, o = normalized(gold), normalized(row['ocr'])
    return bool(g) and Levenshtein.distance(g, o) / len(g) <= 0.5


def is_target(row):
    return any(a == 0 for a, _ in row['markers']) or bool(row['refs'])


def offset_text(text):
    """The gold line with offsets kept: whitespace as one space, single-scalar NFKC folds."""
    out = []
    for c in text:
        if c.isspace():
            out.append(' ')
        else:
            n = unicodedata.normalize('NFKC', c)
            out.append(n if len(n) == 1 else c)
    return ''.join(out)


def span_status(ops, a, b, gold):
    """ok if every non-space gold char in [a, b) is matched equal; else dropped/substituted."""
    need = [i for i in range(a, b) if not gold[i].isspace()]
    if not need:
        return 'ok'
    kinds = []
    for i in need:
        kind = 'missing'
        for tag, s1, e1, _, _ in ops:
            if s1 <= i < e1:
                kind = tag
                break
        kinds.append(kind)
    if all(k == 'equal' for k in kinds):
        return 'ok'
    if all(k == 'delete' for k in kinds):
        return 'dropped'
    return 'substituted'


def marker_kind(text):
    t = text.strip()
    if not t:
        return 'blank'
    if all(not c.isalnum() for c in t):
        return 'symbol'
    core = t.strip('().[]')
    if core.isdigit() or all(p.isdigit() for p in core.split('.') if p):
        return 'numeric'
    if core.lower() and all(c in 'ivxlcdm' for c in core.lower()) and len(core) > 1:
        return 'roman'
    if len(core) <= 2 and core.isalpha():
        return 'letter'
    return 'other'


def score(rows, preds):
    agg = {'chars': 0, 'edits': 0, 'lines': len(rows), 'exact': 0}
    markers = collections.Counter()
    refs = collections.Counter()
    by_kind = collections.defaultdict(collections.Counter)
    ref_subs = collections.Counter()
    for row, pred in zip(rows, preds):
        g = normalized(row['text'])
        agg['chars'] += len(g)
        agg['edits'] += Levenshtein.distance(g, pred)
        agg['exact'] += g == pred
        gold = offset_text(row['text'])
        ops = Levenshtein.opcodes(gold, pred)
        for a, b in row['markers']:
            if a != 0:
                continue
            status = span_status(ops, a, b, gold)
            markers[status] += 1
            by_kind[marker_kind(row['text'][a:b])][status] += 1
        for a, b in row['refs']:
            status = span_status(ops, a, b, gold)
            refs[status] += 1
    agg['cer'] = agg['edits'] / max(1, agg['chars'])
    agg['exact_line_rate'] = agg['exact'] / max(1, agg['lines'])
    def rate(c):
        n = sum(c.values())
        return {'spans': n, 'errors': n - c['ok'], 'error_rate': (n - c['ok']) / n if n else None,
                **{k: v for k, v in c.items() if k != 'ok'}}
    agg['markers'] = rate(markers)
    agg['markers_by_kind'] = {k: rate(v) for k, v in sorted(by_kind.items())}
    agg['references'] = rate(refs)
    return agg


def predict(adapter, rows, key='im', size=32):
    prepared, _ = adapter.prepare([{'im': r[key], 'text': normalized(r['text'])} for r in rows])
    preds = [None] * len(prepared)
    adapter.model.eval()
    with torch.inference_mode():
        for indices in batches(prepared, size):
            logits, lengths = adapter.raw(*adapter.batch(prepared, indices, 'cuda'))
            for i, text in zip(indices, adapter.decode(logits, lengths)):
                preds[i] = text
    return preds


def load(checkpoint):
    adapter = Adapter('indra', SimpleNamespace())
    adapter.load_checkpoint(checkpoint)
    adapter.model.cuda().eval()
    return adapter


def sample_targets(rows, n):
    targets = [r for r in rows if is_target(r) and usable(r)]
    refs = [r for r in targets if r['refs']]
    others = [r for r in targets if not r['refs']]
    random.Random(SEED).shuffle(others)
    return refs + others[:max(0, n - len(refs))]


def cmd_measure(args):
    rows = read_crops(Path(args.crops) / f'{args.split}.arrow')
    chosen = sample_targets(rows, args.sample) if args.sample else [r for r in rows if is_target(r) and usable(r)]
    adapter = load(args.checkpoint)
    crop = predict(adapter, chosen)
    padded = predict(adapter, chosen, 'im_pad')
    pipeline = [normalized(r['ocr']) for r in chosen]
    result = {'split': args.split, 'lines': len(chosen), 'checkpoint_sha256': digest(args.checkpoint),
              'pipeline_cached_ocr': score(chosen, pipeline), 'crop': score(chosen, crop),
              'crop_padded_30pct': score(chosen, padded)}
    examples = []
    for r, p, c, q in zip(chosen, pipeline, crop, padded):
        gold = offset_text(r['text'])
        bad = [s for s in ([(a, b, 'ref') for a, b in r['refs']] + [(a, b, 'marker') for a, b in r['markers'] if a == 0])
               if span_status(Levenshtein.opcodes(gold, c), s[0], s[1], gold) != 'ok']
        if bad:
            examples.append({'kind': bad[0][2], 'span': r['text'][bad[0][0]:bad[0][1]], 'gold': r['text'][:90],
                             'pipeline': p[:90], 'crop': c[:90], 'padded': q[:90], 'id': f"{r['sha'][:8]}:{r['id']}"})
    random.Random(SEED).shuffle(examples)
    result['examples'] = sorted(examples[:40], key=lambda e: e['kind'])
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'examples'}, ensure_ascii=False, indent=1))


def gold_training_rows(rows, other_ratio, ref_repeat):
    rows = [r for r in rows if usable(r)]
    targets = [r for r in rows if is_target(r)]
    others = [r for r in rows if not is_target(r)]
    random.Random(SEED).shuffle(others)
    chosen = targets + [r for r in targets if r['refs']] * (ref_repeat - 1) + others[:int(len(targets) * other_ratio)]
    return [{'im': r['im'], 'text': normalized(r['text'])} for r in chosen], {
        'usable': len(rows), 'targets': len(targets), 'reference_lines': sum(bool(r['refs']) for r in targets),
        'others': min(len(others), int(len(targets) * other_ratio)), 'ref_repeat': ref_repeat}


def dev_report(adapter, arrow_dev, gold_dev):
    arrow = evaluate(adapter, arrow_dev, 'cuda', 16)
    preds = predict(adapter, gold_dev)
    gold = score(gold_dev, preds)
    return arrow, gold


def cmd_train(args):
    torch.manual_seed(SEED)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    adapter = load(args.checkpoint)
    arrow_train = read_rows(Path(args.data_root) / 'train.arrow')
    arrow_dev_rows = read_rows(Path(args.data_root) / 'eval.arrow')
    crops = Path(args.crops)
    gold_train, gold_info = gold_training_rows(read_crops(crops / 'train.arrow'), args.other_ratio, args.ref_repeat)
    extra_train = []
    if args.extra:
        extra_rows = read_crops(Path(args.extra))
        extra_train = [{'im': r['im'], 'text': normalized(r['text'])} for r in extra_rows if r['text'].strip()]
        gold_info['extra_lines'] = len(extra_train)
    gold_dev = [r for r in read_crops(crops / 'development.arrow') if is_target(r) and usable(r)]
    train_rows = arrow_train + gold_train + extra_train
    adapter.model.cpu()
    adapter.extend(train_rows)
    adapter.model.cuda()
    train, capped = adapter.prepare(train_rows, training=True)
    arrow_dev, _ = adapter.prepare(arrow_dev_rows)
    arrow0, gold0 = dev_report(adapter, arrow_dev, gold_dev)
    objective = lambda a, g: (a['cer'] + g['cer']) / 2
    best = objective(arrow0, gold0)
    result = {'checkpoint': args.checkpoint, 'checkpoint_sha256': digest(args.checkpoint), 'gold': gold_info,
              'arrow_train_lines': len(arrow_train), 'train_lines': len(train), 'width_capped': capped,
              'added_characters': adapter.meta.get('added_train_characters'),
              'protocol': {'lr': args.lr, 'epochs': args.epochs, 'batch_size': 16, 'seed': SEED, 'patience': args.patience,
                           'selection': 'mean of Arrow-dev CER and gold-dev marker/reference-line CER',
                           'batch_norm': 'frozen', 'test_used_for_selection': False},
              'baseline': {'arrow_dev': arrow0, 'gold_dev': gold0, 'objective': best}, 'epochs': [], 'best_epoch': 0}
    print(json.dumps({'baseline': result['baseline']}, ensure_ascii=False), flush=True)
    meta = dict(adapter.meta)
    save_checkpoint(output / 'best.pt', {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                                         'chars': adapter.chars, 'epoch': 0, 'metadata': meta})
    optimizer = torch.optim.AdamW(adapter.model.parameters(), lr=args.lr, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='min', factor=.5, patience=1, min_lr=1e-6)
    started = time.perf_counter()
    stale = 0
    for epoch in range(args.epochs):
        adapter.model.train()
        freeze_batch_norm(adapter.model)
        total = 0.0
        schedule = batches(train, 16, SEED + epoch)
        for indices in schedule:
            optimizer.zero_grad(set_to_none=True)
            logits, lengths = adapter.raw(*adapter.batch(train, indices, 'cuda'))
            labels = [[adapter.mapping[c] for c in train[i][1]] for i in indices]
            target = torch.tensor([c for row in labels for c in row], dtype=torch.long, device='cuda')
            loss = F.ctc_loss(logits.float().log_softmax(-1).transpose(0, 1), target, lengths.cpu(),
                              torch.tensor([len(x) for x in labels]), blank=0, zero_infinity=False)
            if not torch.isfinite(loss):
                raise ValueError('Non-finite CTC loss')
            loss.backward()
            nn.utils.clip_grad_norm_(adapter.model.parameters(), 5)
            optimizer.step()
            total += loss.item()
        arrow, gold = dev_report(adapter, arrow_dev, gold_dev)
        value = objective(arrow, gold)
        entry = {'epoch': epoch + 1, 'loss': total / len(schedule), 'lr': optimizer.param_groups[0]['lr'],
                 'arrow_dev': arrow, 'gold_dev': gold, 'objective': value,
                 'seconds': round(time.perf_counter() - started, 1)}
        result['epochs'].append(entry)
        if value < best - 1e-5:
            best, stale = value, 0
            result['best_epoch'] = epoch + 1
            save_checkpoint(output / 'best.pt', {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                                                 'chars': adapter.chars, 'epoch': epoch + 1, 'metadata': meta})
        else:
            stale += 1
        scheduler.step(value)
        result['training_seconds'] = time.perf_counter() - started
        write_json(output / 'result.json', result)
        print(json.dumps({'epoch': epoch + 1, 'loss': entry['loss'], 'arrow_dev_cer': arrow['cer'], 'gold_dev_cer': gold['cer'],
                          'markers': gold['markers']['error_rate'], 'refs': gold['references']['error_rate'],
                          'objective': value, 'best_epoch': result['best_epoch'], 'seconds': entry['seconds']}), flush=True)
        if stale >= args.patience:
            break
    result['completed'] = True
    write_json(output / 'result.json', result)


def cmd_final(args):
    """Held-out scoring of a selected checkpoint (and a baseline) on Arrow dev/test and gold crops."""
    out = {}
    for name, path in [('baseline', args.baseline), ('candidate', args.checkpoint)]:
        if not path:
            continue
        adapter = load(path)
        entry = {'checkpoint_sha256': digest(path)}
        for split, file in [('arrow_dev', 'eval.arrow'), ('arrow_test', 'test.arrow')]:
            prepared, _ = adapter.prepare(read_rows(Path(args.data_root) / file))
            entry[split] = evaluate(adapter, prepared, 'cuda', 16)
        for split in ['development', 'test']:
            rows = read_crops(Path(args.crops) / f'{split}.arrow')
            target = [r for r in rows if is_target(r) and usable(r)]
            other = [r for r in rows if not is_target(r) and usable(r)]
            entry[f'gold_{split}_targets'] = score(target, predict(adapter, target))
            entry[f'gold_{split}_targets_padded'] = score(target, predict(adapter, target, 'im_pad'))
            entry[f'gold_{split}_other'] = score(other, predict(adapter, other))
        out[name] = entry
        del adapter
        torch.cuda.empty_cache()
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(json.dumps(out, ensure_ascii=False, indent=1))


def cmd_export(args):
    """ONNX export (two-shape PyTorch parity), compact class-ID graph, CPU scores, and a model pack."""
    import shutil, hashlib
    import onnx
    from onnx import helper, TensorProto
    from evaluate import export, feed, score_onnx, session
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    adapter = Adapter('indra', SimpleNamespace())
    checkpoint = adapter.load_checkpoint(args.checkpoint)
    dev, _ = adapter.prepare(read_rows(Path(args.data_root) / 'eval.arrow'))
    runtime, parity = export(adapter, dev, out / 'recognizer.onnx', 2)
    model = onnx.load(out / 'recognizer.onnx')
    model.graph.node.append(helper.make_node('ArgMax', ['logits'], ['class_ids'], axis=2, keepdims=0))
    model.graph.output.append(helper.make_tensor_value_info('class_ids', TensorProto.INT64, ['batch', 'time']))
    onnx.checker.check_model(model)
    onnx.save(model, out / 'model.onnx')
    compact = session(out / 'model.onnx', 2)
    schedules = list(batches(dev, 16))
    for position in np.linspace(0, len(schedules) - 1, 4, dtype=int):
        inputs = feed(adapter, runtime, dev, schedules[position])
        logits, lengths = runtime.run(None, inputs)
        ids, lengths2 = compact.run(['class_ids', 'lengths'], inputs)
        np.testing.assert_array_equal(ids, logits.argmax(-1))
        np.testing.assert_array_equal(lengths, lengths2)
    def encodable(c):
        try:
            c.encode('utf-8')
            return True
        except UnicodeEncodeError:
            return False
    # A lone surrogate learned from noisy gold has no UTF-8 form; its class is left undecoded.
    write_json(out / 'codec.json', {c: [i] for i, c in enumerate(adapter.chars) if i and encodable(c)})
    test, _ = adapter.prepare(read_rows(Path(args.data_root) / 'test.arrow'))
    result = {'checkpoint_sha256': digest(args.checkpoint), 'selected_epoch': checkpoint['epoch'], 'onnx': parity,
              'compact_sha256': digest(out / 'model.onnx'), 'compact_parity_batches': 4, 'classes': len(adapter.chars),
              'arrow_dev_cpu': score_onnx(adapter, runtime, dev, 16), 'arrow_test_cpu': score_onnx(adapter, runtime, test, 16)}
    stock = Path(args.stock_pack)
    pack = out / 'pack'
    if pack.exists():
        shutil.rmtree(pack)
    manifest = json.loads((stock / 'manifest.json').read_text(encoding='utf-8'))
    detector = manifest['detector']['path']
    (pack / Path(detector).parent).mkdir(parents=True)
    shutil.copyfile(stock / detector, pack / detector)
    (pack / 'assets' / 'markers').mkdir(parents=True)
    shutil.copyfile(out / 'model.onnx', pack / 'assets' / 'markers' / 'model.onnx')
    shutil.copyfile(out / 'codec.json', pack / 'assets' / 'markers' / 'codec.json')
    entry = {'path': 'assets/markers/model.onnx', 'sha256': digest(pack / 'assets' / 'markers' / 'model.onnx')}
    for name in manifest['models']:
        manifest['models'][name] = {'cpu': entry, 'gpu': entry,
                                    'codec': {'path': 'assets/markers/codec.json', 'sha256': digest(pack / 'assets' / 'markers' / 'codec.json')}}
    (pack / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    write_json(out / 'export.json', result)
    print(json.dumps(result, indent=1))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    m = sub.add_parser('measure')
    m.add_argument('--checkpoint', required=True)
    m.add_argument('--crops', required=True)
    m.add_argument('--split', default='development')
    m.add_argument('--sample', type=int, default=300)
    m.add_argument('--out', required=True)
    t = sub.add_parser('train')
    t.add_argument('--checkpoint', required=True)
    t.add_argument('--crops', required=True)
    t.add_argument('--data-root', required=True)
    t.add_argument('--output', required=True)
    t.add_argument('--epochs', type=int, default=12)
    t.add_argument('--patience', type=int, default=4)
    t.add_argument('--lr', type=float, default=5e-5)
    t.add_argument('--other-ratio', type=float, default=1.0)
    t.add_argument('--ref-repeat', type=int, default=1)
    t.add_argument('--extra')
    f = sub.add_parser('final')
    f.add_argument('--checkpoint', required=True)
    f.add_argument('--baseline')
    f.add_argument('--crops', required=True)
    f.add_argument('--data-root', required=True)
    f.add_argument('--out', required=True)
    e = sub.add_parser('export')
    e.add_argument('--checkpoint', required=True)
    e.add_argument('--data-root', required=True)
    e.add_argument('--stock-pack', required=True)
    e.add_argument('--out', required=True)
    args = parser.parse_args()
    {'measure': cmd_measure, 'train': cmd_train, 'final': cmd_final, 'export': cmd_export}[args.command](args)


if __name__ == '__main__':
    main()
