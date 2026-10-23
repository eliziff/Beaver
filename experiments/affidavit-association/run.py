"""Compare cheap, frozen and newly fine-tuned association on the same mixed folders."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import sys
import time

import numpy as np
from scipy.optimize import linear_sum_assignment, minimize
from scipy.special import log_softmax, softmax

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from data import read, digest, targets, order, restore_texts
from chunks import ChunkPlan


def objective(scores, truth):
    """Unmatched files are row negatives, with no fictitious column target."""
    rows = truth / np.maximum(truth.sum(1, keepdims=True), 1)
    columns = truth / np.maximum(truth.sum(0, keepdims=True), 1)
    mask = truth.sum(0) > 0
    loss = -(rows * log_softmax(scores, axis=1)).sum() / len(rows)
    loss -= (columns * log_softmax(scores, axis=0)).sum() / mask.sum()
    gradient = (softmax(scores, axis=1) - rows) / len(rows)
    gradient += (softmax(scores, axis=0) * mask - columns) / mask.sum()
    return loss, gradient


def fit(features, records):
    all_values = np.concatenate([features[r['record']].reshape(-1, features[r['record']].shape[-1]) for r in records])
    mean, scale = all_values.mean(0), all_values.std(0) + 1e-6
    xs = [(features[r['record']] - mean) / scale for r in records]
    ys = [targets(r) for r in records]
    def evaluate(weights):
        loss, gradient = .01 * weights @ weights, .02 * weights
        for x, y in zip(xs, ys):
            value, ds = objective(x @ weights, y)
            loss += value / len(xs)
            gradient += np.einsum('ijk,ij->k', x, ds) / len(xs)
        return loss, gradient
    result = minimize(evaluate, np.zeros(all_values.shape[-1]), jac=True, method='L-BFGS-B', options={'maxiter': 500})
    if not result.success:
        raise ValueError('Association head did not converge: ' + result.message)
    return {'mean': mean, 'scale': scale, 'weights': result.x}


def predict(model, features):
    return {rid: ((x - model['mean']) / model['scale']) @ model['weights'] for rid, x in features.items()}


def metrics(records, scores):
    correct = strict_correct = total = distractor_picks = sibling_picks = 0
    per_record = {}
    groups = {}
    for r in records:
        matrix = scores[r['record']]
        expected = targets(r)
        rows, columns = linear_sum_assignment(-matrix)
        good = int(expected[rows, columns].sum())
        strict = sum(r['truth'].get(r['files'][j]) == r['labels'][i] for i, j in zip(rows, columns))
        roles = [r['candidate_provenance'][j]['role'] for j in columns]
        per_record[r['record']] = {'correct': good, 'exact_source_labels': strict, 'labels': len(r['labels']),
                                   'distractor_picks': sum(role != 'exhibit' for role in roles),
                                   'sibling_picks': roles.count('sibling')}
        correct += good; strict_correct += strict; total += len(r['labels'])
        group = groups.setdefault(r['group'], [0, 0])
        group[0] += good; group[1] += len(r['labels'])
        distractor_picks += per_record[r['record']]['distractor_picks']
        sibling_picks += roles.count('sibling')
    return {'correct': correct, 'labels': total, 'assigned_accuracy': correct / max(total, 1),
            'exact_source_label_accuracy': strict_correct / max(total, 1),
            'macro_record_accuracy': float(np.mean([v['correct'] / v['labels'] for v in per_record.values()])) if per_record else None,
            'macro_proceeding_accuracy': float(np.mean([good / labels for good, labels in groups.values()])) if groups else None,
            'distractor_picks': distractor_picks, 'sibling_picks': sibling_picks, 'per_record': per_record}


def balanced(records, limit):
    """Keep all new training gold, cap legacy insolvency and oversized proceedings."""
    new = sorted([r for r in records if r['new']], key=lambda r: order(r['record']))
    chosen = list(new)
    families = Counter(r['group'] for r in new)
    insolvency = sum('insolven' in r['subject'].casefold() or 'receivership' in r['subject'].casefold() for r in new)
    for r in sorted([r for r in records if not r['new']], key=lambda r: order(r['record'])):
        if len(chosen) >= limit: break
        is_insolvency = 'insolven' in r['subject'].casefold() or 'receivership' in r['subject'].casefold()
        if families[r['group']] >= 8 or is_insolvency and insolvency >= limit // 4:
            continue
        chosen.append(r); families[r['group']] += 1; insolvency += is_insolvency
    return chosen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--bench', type=Path, required=True, help='Existing court-record-exhibits benchmark source directory')
    parser.add_argument('--train-limit', type=int, default=300)
    parser.add_argument('--epochs', type=float, default=2)
    options = parser.parse_args()
    # One process and one CPU worker; reuse the existing GPU environment and HF cache.
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
    import torch
    torch.set_num_threads(1)
    torch.manual_seed(0); random.seed(0); np.random.seed(0)
    torch.cuda.manual_seed_all(0)
    if not torch.cuda.is_available(): raise RuntimeError('The existing CUDA training host is required')
    sys.path[:0] = [str(options.bench / 'assoc'), str(options.bench)]
    import feats2
    import feats3
    import ft_eg2 as neural
    neural.EPOCHS = options.epochs
    frozen = read(options.inputs)
    train, test = balanced(frozen['train'], options.train_limit), frozen['test']
    assert not {r['group'] for r in train} & {r['group'] for r in test}, 'Proceeding leakage'
    options.output.mkdir(parents=True, exist_ok=True)
    for root, names, destination in (
        (HERE, ('run.py', 'data.py', 'ft_eg2.py', 'feats_neural.py', 'chunks.py'), 'source'),
        (options.bench, [p.relative_to(options.bench) for p in options.bench.rglob('*.py')], 'source/benchmark'),
    ):
        for name in names:
            target = options.output / destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
    records = train + test
    restore_texts(records, frozen['documents'])
    receipt = {'origin': 'machine_test', 'run_id': frozen['run_id'], 'input_sha256': digest(options.inputs),
               'source_sha256s': {name: digest(HERE / name) for name in ('run.py', 'data.py', 'ft_eg2.py', 'feats_neural.py', 'chunks.py')},
               'benchmark_source_sha256s': {str(p.relative_to(options.bench)): digest(p)
                                           for p in options.bench.rglob('*.py')},
               'config': {'epochs': options.epochs, 'rank': neural.R, 'max_length': neural.MAXLEN,
                          'max_files_per_step': neural.MAXFILES, 'encode_batch_size': neural.ENCODE_BATCH,
                          'seed': 0, 'modalities': ['text']},
               'train_ids': [r['record'] for r in train], 'test_ids': [r['record'] for r in test],
               'new_train': sum(r['new'] for r in train), 'new_test': sum(r['new'] for r in test),
               'gold_coverage': {key: frozen.get(key) for key in ('new_records', 'new_records_with_association_queries',
                                                                'new_source_exhibits', 'new_eligible_exhibits',
                                                                'new_source_gold_coverage', 'records_without_association_queries')},
               'training_subjects': dict(Counter(r['subject'] for r in train)),
               'data_diagnostics': {'train_groups': len({r['group'] for r in train}),
                                    'test_groups': len({r['group'] for r in test}),
                                    'candidate_roles': dict(Counter(p['role'] for r in records for p in r['candidate_provenance'])),
                                    'distinct_source_distractors_with_identical_text_view': sum(p.get('same_text_view_as_target', False)
                                                                                             for r in records for p in r['candidate_provenance']),
                                    'targets_in_identical_text_groups': sum(
                                        count for r in records for count in Counter(t for f, t in zip(r['files'], r['texts'])
                                                                                   if f in r['truth']).values() if count > 1),
                                    'unfound_reference_labels': sum(not r['ctx'][l].get('found', True) for r in records for l in r['labels']),
                                    'nearly_empty_target_texts': sum(len(t.strip()) < 50 for r in records
                                                                   for f, t in zip(r['files'], r['texts']) if f in r['truth'])},
               'status': 'running', 'results': {}}
    def save():
        (options.output / 'receipt.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    save()
    cheap = {}
    for r in records:
        page_counts = {f: 1 for f in r['files']}  # Page-count features intentionally omitted below.
        sim, fields, _, _, names, _ = feats2.record_feats(r, page_counts)
        keep = [i for i, name in enumerate(names) if 'pages' not in name]
        segments, _ = feats3.record_feats(r)
        cheap[r['record']] = np.concatenate([sim, fields[:, :, keep], segments], axis=2)
    np.savez_compressed(options.output / 'cheap.npz', **cheap)
    def compare(name, extra=None):
        features = cheap if extra is None else {k: np.concatenate([cheap[k], extra[k]], axis=2) for k in cheap}
        model = fit(features, train)
        np.savez_compressed(options.output / (name + '-head.npz'), **model)
        scores = predict(model, {r['record']: features[r['record']] for r in test})
        np.savez_compressed(options.output / (name + '-scores.npz'), **scores)
        receipt['results'][name] = metrics(test, scores)
        receipt['results'][name]['new_gold'] = metrics([r for r in test if r['new']], scores)
        receipt['results'][name]['with_sibling_distractors'] = metrics(
            [r for r in test if any(p['role'] == 'sibling' for p in r['candidate_provenance'])], scores)
        save()
        print(name, receipt['results'][name]['assigned_accuracy'], flush=True)
    compare('cheap')
    started = time.time()
    model, adapter = neural.load_model()
    from huggingface_hub import snapshot_download
    snapshot = Path(snapshot_download('google/embeddinggemma-2', local_files_only=True))
    receipt['base_model'] = {'id': 'google/embeddinggemma-2',
                             'revision': snapshot.name,
                             'artifacts': {p.relative_to(snapshot).as_posix(): digest(p)
                                           for p in snapshot.rglob('*') if p.is_file() and p.suffix in {'.json', '.safetensors'}},
                             'torch': torch.__version__, 'prompts': model.prompts}
    save()
    model.eval()
    plan = ChunkPlan(model.tokenizer, model.prompts, neural.MAXLEN)
    frozen_features = {}
    vector_cache = neural.cache_vectors(model, records, 'frozen vectors', plan)
    receipt['chunk_coverage'] = plan.summary()
    receipt['config']['document_scoring'] = 'All full-text chunks: mean query-to-document MaxSim plus pooled cosine'
    receipt['config']['training_chunk_selection'] = 'Random query chunk; most relevant full-source document chunk under the frozen encoder (positive query for targets, any query for negatives)'
    save()
    for i, r in enumerate(records):
        frozen_features[r['record']] = neural.features(r, vector_cache)
        if i % 25 == 0: print('frozen features', i, '/', len(records), flush=True)
    np.savez_compressed(options.output / 'frozen.npz', **frozen_features)
    compare('frozen', frozen_features)
    losses, trace = neural.train(model, adapter, train, plan, vector_cache)
    (options.output / 'training-chunks.json').write_text(json.dumps(trace), encoding='utf-8')
    vector_cache.clear()
    adapter.save_pretrained(options.output / 'adapter')
    receipt['training_loss'] = {'steps': len(losses), 'first_50': float(np.mean(losses[:50])),
                                'last_50': float(np.mean(losses[-50:]))}
    tuned_features = {}
    vector_cache = neural.cache_vectors(model, records, 'tuned vectors', plan)
    for i, r in enumerate(records):
        tuned_features[r['record']] = neural.features(r, vector_cache)
        if i % 25 == 0: print('tuned features', i, '/', len(records), flush=True)
    np.savez_compressed(options.output / 'tuned.npz', **tuned_features)
    compare('tuned', tuned_features)
    receipt['artifact_sha256s'] = {p.relative_to(options.output).as_posix(): digest(p)
                                  for p in options.output.rglob('*') if p.is_file() and p.name != 'receipt.json'}
    receipt.update(status='complete', seconds=time.time() - started,
                   cuda_peak_allocated_mib=torch.cuda.max_memory_allocated() / 1024 ** 2)
    save()


if __name__ == '__main__':
    main()
