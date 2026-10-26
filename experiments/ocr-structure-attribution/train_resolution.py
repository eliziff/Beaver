"""Resolution recognizer fine-tunes through the existing marker-training harness.

The same frozen crops, targets, seed and training recipe are used in each
arm. This isolates recognition resolution before adding the expanded gold.
Both arms share the harness's preprocessing; native input parity is a later gate.
"""
import argparse
from collections import Counter
import gc
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace

os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ['HF_HUB_OFFLINE'] = '1'


def glyph_score(rows, predictions):
    import unicodedata
    from rapidfuzz.distance import Levenshtein
    import markers
    total = Counter()
    for row, prediction in zip(rows, predictions, strict=True):
        text = markers.offset_text(row['text'])
        marked = set()
        for start, end in row['refs'] + [span for span in row['markers'] if span[0] == 0]:
            marked.update(range(start, end))
        chosen = {i for i, c in enumerate(text) if i in marked or c.isdigit() or unicodedata.category(c)[0] in 'PS'}
        chosen = {i for i in chosen if not text[i].isspace()}
        total['target_characters'] += len(chosen)
        for op in Levenshtein.editops(text, prediction):
            if op.tag != 'insert' and op.src_pos in chosen:
                total[op.tag] += 1
            elif op.tag == 'insert':
                if op.src_pos in chosen and op.src_pos-1 in chosen:
                    total['internal_insertions'] += 1
                elif prediction[op.dest_pos].isdigit() or unicodedata.category(prediction[op.dest_pos])[0] in 'PS':
                    total['other_glyph_insertions'] += 1
                elif prediction[op.dest_pos].isalpha() and (op.src_pos in marked or op.src_pos-1 in marked):
                    total['mark_boundary_letter_insertions'] += 1
    total['selected_character_errors'] = (total['replace'] + total['delete'] + total['internal_insertions'] +
        total['other_glyph_insertions'] + total['mark_boundary_letter_insertions'])
    total['metric_version'] = 2
    return dict(total)


def converge(args, markers, adapter, output, height, original_dev, protocol):
    import torch
    from torch import nn
    from torch.nn import functional as F
    rows = markers.read_rows(args.data_root/'train.arrow')
    gold, info = markers.gold_training_rows(markers.read_crops(args.crops/'train.arrow'), 1., 4)
    rows += gold
    adapter.model.cpu()
    adapter.extend(rows)
    adapter.model.cuda()
    train, capped = adapter.prepare(rows, training=True)
    arrow, _ = adapter.prepare(markers.read_rows(args.data_root/'eval.arrow'))
    targets = [r for r in markers.read_crops(args.crops/'development.arrow') if markers.is_target(r) and markers.usable(r)]
    optimizer = torch.optim.AdamW(adapter.model.parameters(), lr=5e-5, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, mode='min', factor=.5, patience=2, min_lr=1e-6)
    result = {'protocol': protocol, 'height': height, 'gold': info, 'train_lines': len(train),
              'width_capped': capped, 'epochs': [], 'best_epoch': 0, 'best_glyph_epoch': 0}
    best = best_glyph = float('inf')
    stale, start_epoch = 0, 0

    def state(epoch, complete=False):
        return {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                'chars': adapter.chars, 'metadata': dict(adapter.meta), 'epoch': epoch,
                'optimizer': optimizer.state_dict(), 'scheduler': scheduler.state_dict(),
                'torch_rng': torch.get_rng_state(), 'cuda_rng': torch.cuda.get_rng_state(),
                'result': result, 'best': best, 'best_glyph': best_glyph, 'stale': stale,
                'protocol': protocol, 'complete': complete}

    last = output/'last.pt'
    if last.exists():
        saved = torch.load(last, map_location='cpu', weights_only=True)
        if saved['protocol'] != protocol:
            raise ValueError('Existing run has a different protocol')
        if saved.get('complete'):
            print(json.dumps({'height': height, 'already_complete': True}), flush=True)
            return
        adapter.model.load_state_dict(saved['state_dict'], strict=True)
        optimizer.load_state_dict(saved['optimizer'])
        scheduler.load_state_dict(saved['scheduler'])
        torch.set_rng_state(saved['torch_rng'])
        torch.cuda.set_rng_state(saved['cuda_rng'])
        result, best, best_glyph, stale, start_epoch = (saved[k] for k in ['result','best','best_glyph','stale','epoch'])
    else:
        a, g = original_dev(adapter, arrow, targets)
        result['baseline'] = {'arrow_dev': a, 'gold_dev': g}
        value = g['glyphs']['selected_character_errors']/g['glyphs']['target_characters']
        best_glyph = value
        if a['cer'] <= args.body_baseline + args.body_tolerance:
            best = value
            markers.save_checkpoint(output/'best.pt', state(0))
        markers.save_checkpoint(output/'best-glyph.pt', state(0))
        markers.write_json(output/'result.json', result)

    started = time.perf_counter()
    for epoch in range(start_epoch, args.epochs):
        adapter.model.train()
        markers.freeze_batch_norm(adapter.model)
        loss_sum = 0.
        schedule = markers.batches(train, 16, markers.SEED + epoch)
        for indices in schedule:
            optimizer.zero_grad(set_to_none=True)
            logits, lengths = adapter.raw(*adapter.batch(train, indices, 'cuda'))
            labels = [[adapter.mapping[c] for c in train[i][1]] for i in indices]
            values = torch.tensor([c for line in labels for c in line], dtype=torch.long, device='cuda')
            loss = F.ctc_loss(logits.float().log_softmax(-1).transpose(0, 1), values, lengths.cpu(),
                torch.tensor([len(line) for line in labels]), blank=0, zero_infinity=False)
            if not torch.isfinite(loss):
                raise ValueError('Non-finite CTC loss')
            loss.backward()
            nn.utils.clip_grad_norm_(adapter.model.parameters(), 5)
            optimizer.step()
            loss_sum += loss.item()
        a, g = original_dev(adapter, arrow, targets)
        value = g['glyphs']['selected_character_errors']/g['glyphs']['target_characters']
        eligible = a['cer'] <= args.body_baseline + args.body_tolerance
        entry = {'epoch': epoch+1, 'loss': loss_sum/len(schedule), 'lr': optimizer.param_groups[0]['lr'],
                 'arrow_dev': a, 'gold_dev': g, 'glyph_error_rate': value, 'body_guard_passed': eligible,
                 'seconds_this_session': round(time.perf_counter()-started, 1)}
        result['epochs'].append(entry)
        if value < best_glyph:
            best_glyph = value
            result['best_glyph_epoch'] = epoch+1
            markers.save_checkpoint(output/'best-glyph.pt', state(epoch+1))
        if eligible and value < best:
            best, stale = value, 0
            result['best_epoch'] = epoch+1
            markers.save_checkpoint(output/'best.pt', state(epoch+1))
        else:
            stale += 1
        scheduler.step(value if eligible else 1+a['cer'])
        complete = epoch+1 >= args.epochs or (epoch+1 >= args.min_epochs and stale >= args.patience)
        result['completed'] = complete
        markers.save_checkpoint(last, state(epoch+1, complete))
        markers.write_json(output/'result.json', result)
        print(json.dumps({'height': height, 'epoch': epoch+1, 'glyphs': g['glyphs'],
            'arrow_cer': a['cer'], 'body_guard_passed': eligible, 'best_epoch': result['best_epoch'],
            'stale': stale, 'lr': entry['lr'], 'seconds': entry['seconds_this_session']}), flush=True)
        if complete:
            break


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--harness', type=Path, required=True)
    parser.add_argument('--checkpoint', type=Path, required=True)
    parser.add_argument('--crops', type=Path, required=True)
    parser.add_argument('--data-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--epochs', type=int, default=2)
    parser.add_argument('--heights', type=int, nargs='+', default=[32, 64], choices=[32, 64, 96, 128])
    parser.add_argument('--converge', action='store_true')
    parser.add_argument('--min-epochs', type=int, default=10)
    parser.add_argument('--patience', type=int, default=6)
    parser.add_argument('--body-baseline', type=float, default=.011936381458293809)
    parser.add_argument('--body-tolerance', type=float, default=.0005)
    args = parser.parse_args()
    sys.path.insert(0, str(args.harness.resolve()))
    import markers
    import torch
    from torch import nn
    from torch.nn import functional as F
    torch.set_num_threads(2)
    if not torch.cuda.is_available():
        raise ValueError('This experiment requires the desktop CUDA GPU')
    original_load, original_score, original_dev = markers.load, markers.score, markers.dev_report
    args.out.mkdir(parents=True, exist_ok=True)
    protocol = {'checkpoint_sha256': markers.digest(args.checkpoint), 'heights': args.heights,
                'epochs': args.epochs, 'seed': markers.SEED, 'glyph_metrics': 'selected mark characters, digits and punctuation; digit insertions also reported',
                'checkpoint_for_comparison': 'last.pt, fixed epoch budget',
                'training_data': 'same existing human journal train and frozen corrected native-box crop train',
                'selection_data': 'development only; test not opened',
                'native_preprocessing_parity': 'not established; both arms share the same existing crop preparation'}
    if args.converge:
        protocol.update({'minimum_epochs': args.min_epochs, 'patience': args.patience,
                         'checkpoint_for_comparison': 'best glyph score passing body-text guard',
                         'glyph_metric_version': 2, 'body_baseline': args.body_baseline,
                         'body_tolerance': args.body_tolerance,
                         'training_input_sha256': {str(p): markers.digest(p) for p in
                             [args.data_root/'train.arrow',args.data_root/'eval.arrow',
                              args.crops/'train.arrow',args.crops/'development.arrow']}})
    (args.out/'protocol.json').write_text(json.dumps(protocol, indent=2)+'\n', encoding='utf-8')
    for height in args.heights:
        output = args.out/('height'+str(height))
        output.mkdir(exist_ok=True)

        def load(path):
            adapter = original_load(path)
            if height != 32:
                old = adapter.model.stem
                new = nn.Conv2d(old.in_channels, old.out_channels, (height, 4), stride=(height, 4)).cuda()
                with torch.no_grad():
                    new.weight.copy_(F.interpolate(old.weight, size=(height, 4), mode='bilinear', align_corners=False)*(32/height))
                    new.bias.copy_(old.bias)
                adapter.model.stem = new
            adapter.height = height
            adapter.meta['recognition_resolution_experiment'] = {'height': height, 'stem_initialization': 'vertical interpolation, sum-preserving'}
            return adapter

        def score(rows, predictions):
            result = original_score(rows, predictions)
            result['glyphs'] = glyph_score(rows, predictions)
            return result

        def dev(adapter, arrow, gold):
            a, g = original_dev(adapter, arrow, gold)
            markers.save_checkpoint(output/'last.pt', {'state_dict': {k: v.cpu() for k, v in adapter.model.state_dict().items()},
                'chars': adapter.chars, 'metadata': dict(adapter.meta)})
            print(json.dumps({'height': height, 'glyphs': g['glyphs'], 'references': g['references'],
                              'markers': g['markers'], 'body_guard_arrow_cer': a['cer']}), flush=True)
            return a, g

        markers.load, markers.score, markers.dev_report = load, score, dev
        print(json.dumps({'starting_height': height, 'gpu': torch.cuda.get_device_name(0)}), flush=True)
        if args.converge:
            torch.manual_seed(markers.SEED)
            converge(args, markers, load(args.checkpoint), output, height, original_dev, protocol)
        else:
            markers.cmd_train(SimpleNamespace(checkpoint=str(args.checkpoint), crops=str(args.crops),
                data_root=str(args.data_root), output=str(output), epochs=args.epochs, patience=args.epochs+1,
                lr=5e-5, other_ratio=1., ref_repeat=4, extra=None))
        gc.collect()
        torch.cuda.empty_cache()
    markers.load, markers.score, markers.dev_report = original_load, original_score, original_dev


if __name__ == '__main__':
    main()
