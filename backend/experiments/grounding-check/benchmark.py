"""One complete-answer support check; pinned corpora, calibration and paired scoring."""
import argparse
import json
import math
import inspect
from importlib.metadata import version
import os
import queue
import subprocess
import threading
import time
from collections import defaultdict
from pathlib import Path

from corpus import digest, prepare, records

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parent.parent
MINICHECK_COMMIT = 'b58b9fa69acbd1015ec970fa65dd752413a053d2'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def encoded_slice(text, start, end):
    require(type(start) is int and type(end) is int and 0 <= start < end, 'invalid_span')
    encoded = text.encode('utf-16-le')
    require(end * 2 <= len(encoded), 'span_out_of_bounds')
    return encoded[start * 2:end * 2].decode('utf-16-le')


def validate(row):
    require(set(row) == {'id', 'group', 'split', 'slice', 'question', 'privacy', 'sources', 'evidence', 'answer'}, 'invalid_packet_fields')
    require(row['privacy'] in ('public', 'synthetic', 'private'), 'invalid_privacy')
    require(row['split'] in ('development', 'calibration', 'test'), 'invalid_split')
    require(all(isinstance(row[k], str) and row[k] for k in ('id', 'group', 'slice')), 'missing_identity')
    require(isinstance(row['question'], str), 'invalid_question')
    sources, evidence = {}, {}
    require(isinstance(row['sources'], list) and 0 < len(row['sources']) <= 100, 'invalid_sources')
    require(isinstance(row['evidence'], list) and len(row['evidence']) <= 1000, 'invalid_evidence')
    for source in row['sources']:
        require(set(source) == {'id', 'version', 'text', 'sha256'} and all(isinstance(source[k], str) and source[k] for k in source), 'invalid_source')
        require(source['id'] not in sources and isinstance(source['version'], str), 'duplicate_source')
        require(digest(source['text']) == source['sha256'], 'source_hash_mismatch')
        sources[source['id']] = source
    for item in row['evidence']:
        require(set(item) == {'id', 'source_id', 'version', 'start', 'end', 'text'}, 'invalid_evidence_fields')
        require(isinstance(item['id'], str) and item['id'], 'invalid_evidence_id')
        source = sources.get(item['source_id'])
        require(source and source['version'] == item['version'] and item['id'] not in evidence, 'foreign_evidence')
        require(encoded_slice(source['text'], item['start'], item['end']) == item['text'], 'inexact_evidence')
        evidence[item['id']] = item
    require(isinstance(row['answer'], list) and 0 < len(row['answer']) <= 256, 'empty_or_oversized_answer')
    for block in row['answer']:
        require(set(block) == {'text', 'evidence_ids'} and isinstance(block['text'], str) and block['text'].strip(), 'invalid_block')
        ids = block['evidence_ids']
        require(isinstance(ids, list) and all(isinstance(i, str) for i in ids) and len(ids) == len(set(ids)), 'duplicate_citation')
        require(all(i in evidence for i in ids), 'unknown_citation')
    return evidence


class Bridge:
    def __init__(self, provider=False):
        command = ['node'] + (['--import', 'tsx'] if provider else []) + [str(HERE / 'bridge.mjs')]
        self.process = subprocess.Popen(command, cwd=BACKEND, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        text=True, encoding='utf-8', bufsize=1)
        self.responses = queue.Queue()
        def read():
            for line in self.process.stdout:
                self.responses.put(line)
            self.responses.put(None)
        threading.Thread(target=read, daemon=True).start()

    def call(self, request, timeout=180):
        self.process.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
        self.process.stdin.flush()
        try:
            line = self.responses.get(timeout=timeout)
        except queue.Empty:
            self.close()
            raise ValueError('bridge_timeout') from None
        require(line is not None, 'bridge_exited')
        value = json.loads(line)
        require('error' not in value, value.get('error', 'bridge_error'))
        return value

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout):
            stream.close()


class MiniCheck:
    def __init__(self):
        from minicheck.minicheck import MiniCheck as Upstream
        self.engine = Upstream(model_name='flan-t5-large', batch_size=16).model
        self.identity = {'backend': 'minicheck', 'code': MINICHECK_COMMIT,
                         'model': 'lytang/MiniCheck-Flan-T5-Large',
                         'revision': self.engine.model.config._commit_hash, 'score_kind': 'support_score',
                         'dependencies': {name: version(name) for name in ('torch', 'transformers', 'accelerate')},
                         'package_code': digest([(p.name, p.read_text()) for p in sorted(Path(inspect.getfile(Upstream)).parent.glob('*.py'))])}
        require(self.identity['revision'], 'missing_model_revision')

    def predict(self, jobs, context):
        scores = [None] * len(jobs)
        indices = []
        for i, job in enumerate(jobs):
            text = 'predict: ' + self.engine.tokenizer.eos_token.join([job['document'], job['claim']])
            if len(self.engine.tokenizer(text, truncation=False)['input_ids']) <= self.engine.max_model_len:
                indices.append(i)
        if indices:
            # Use upstream batched inference, not its max-over-document-chunks aggregation.
            output = self.engine.inference([jobs[i]['document'] for i in indices], [jobs[i]['claim'] for i in indices])
            values = output['support_prob_per_chunk'].tolist()
            require(len(values) == len(indices), 'missing_model_scores')
            for i, value in zip(indices, values):
                scores[i] = float(value)
        return scores, {'usage': None, 'oversized_pairs': len(jobs) - len(indices)}


class Beaver:
    def __init__(self, bridge, model, allow_live, effort=None):
        require(allow_live and isinstance(model, str) and model.startswith(('codex:', 'claude-p:', 'ollama:')), 'authorized_flat_rate_or_local_model_required')
        self.bridge, self.model, self.effort = bridge, model, effort
        self.identity = {'backend': 'beaver', 'model': model, 'effort': effort, 'score_kind': 'categorical'}

    def predict(self, jobs, context):
        documents = {digest(job['document']): job['document'] for job in jobs}
        packet = {**context, 'evidence': documents, 'claims': [
            {'id': i, 'claim': job['claim'], 'evidence_id': digest(job['document'])} for i, job in enumerate(jobs)]}
        require(len(json.dumps(packet).encode()) <= 200_000, 'checker_context_limit')
        result = self.bridge.call({'op': 'check', 'model': self.model, 'allow_live': True,
                                   'effort': self.effort, 'packet': packet, 'timeout_ms': 120_000})
        verdicts = result.get('verdicts')
        valid = isinstance(verdicts, list) and len(verdicts) == len(jobs)
        valid = valid and all(isinstance(v, dict) and set(v) == {'id', 'verdict'} and type(v['id']) is int
                             and v['verdict'] in ('supported', 'unsupported', 'needs_context') for v in verdicts)
        valid = valid and {v['id'] for v in verdicts} == set(range(len(jobs)))
        if not valid:
            return [None] * len(jobs), {**result, 'error': 'invalid_verdicts'}
        by_id = {v['id']: v['verdict'] for v in verdicts}
        return [None if by_id[i] == 'needs_context' else float(by_id[i] == 'supported') for i in range(len(jobs))], result


def check_answer(row, predictor, bridge, citations=False):
    evidence = validate(row)
    split = bridge.call({'op': 'segment', 'texts': [b['text'] for b in row['answer']]})['segments']
    require(len(split) == len(row['answer']), 'missing_segmented_blocks')
    units, jobs = [], []
    for block_index, (block, segments) in enumerate(zip(row['answer'], split)):
        cursor = 0
        for segment in segments:
            require(segment['start'] == cursor and encoded_slice(block['text'], segment['start'], segment['end']) == segment['text'], 'segmentation_gap')
            cursor = segment['end']
            ids = block['evidence_ids']
            unit = {'block': block_index, **segment, 'evidence_ids': ids, 'joint': None, 'individual': [], 'without': []}
            def add(selected):
                index = len(jobs)
                jobs.append({'claim': segment['text'], 'document': '\n\n'.join(evidence[i]['text'] for i in selected)})
                return index
            if ids:
                unit['joint'] = add(ids)
                if citations and len(ids) > 1:
                    unit['individual'] = [add([i]) for i in ids]
                    unit['without'] = [add([other for other in ids if other != i]) for i in ids]
            units.append(unit)
        require(cursor == len(block['text'].encode('utf-16-le')) // 2, 'unchecked_answer_tail')
    require(units, 'empty_units')
    scores, receipt = predictor.predict(jobs, {'question': row['question'], 'answer_context': row['answer']}) if jobs else ([], {})
    require(len(scores) == len(jobs) and all(p is None or type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1 for p in scores), 'invalid_support_scores')
    for unit in units:
        unit['score'] = 0.0 if unit['joint'] is None else scores[unit['joint']]
        unit['individual'] = [scores[i] for i in unit['individual']]
        unit['without'] = [scores[i] for i in unit['without']]
        del unit['joint']
    complete = all(unit['score'] is not None for unit in units)
    return {'units': units, 'score': min(unit['score'] for unit in units) if complete else None,
            'receipt': receipt, 'pair_count': len(jobs)}


def citation_scores(units, threshold):
    # Adapted from ALCE compute_autoais; see THIRD_PARTY.md. Joint evidence first.
    supported, necessary, total, precision_known = 0, 0, 0, True
    for unit in units:
        count = len(unit['evidence_ids'])
        total += count
        if not count or unit['score'] is None or unit['score'] < threshold:
            continue
        supported += 1
        if count <= 1:
            necessary += count
        elif len(unit['individual']) != count or len(unit['without']) != count or any(v is None for v in unit['individual'] + unit['without']):
            precision_known = False
        else:
            necessary += sum(single >= threshold or excluded < threshold for single, excluded in zip(unit['individual'], unit['without']))
    return {'citation_recall': supported / len(units), 'citation_precision': (necessary / total if total else 0.0) if precision_known else None}


def code_hash():
    return digest([(name, (HERE / name).read_text()) for name in ('benchmark.py', 'bridge.mjs', 'corpus.py', 'requirements.txt')])


def run(args):
    require(args.limit >= 0, 'invalid_limit')
    rows = []
    boundaries = {}
    for row in records(args.input):
        if args.limit and len(rows) >= args.limit:
            break
        validate(row)
        require(args.backend != 'beaver' or row['privacy'] != 'private' or args.allow_private, 'private_transmission_not_authorized')
        for key in [row['group']] + [s['sha256'] for s in row['sources']]:
            require(key not in boundaries or boundaries[key] == row['split'], 'source_crosses_splits')
            boundaries[key] = row['split']
        rows.append(row)
    require(rows and len({r['id'] for r in rows}) == len(rows), 'empty_or_duplicate_input')
    directory = Path(args.out)
    directory.mkdir(parents=True, exist_ok=False)
    bridge = Bridge(provider=args.backend == 'beaver')
    try:
        predictor = MiniCheck() if args.backend == 'minicheck' else Beaver(bridge, args.model, args.allow_live, args.effort)
        meta = {'code': code_hash(), 'model': predictor.identity, 'input_sha256': digest(rows),
                'ids': [r['id'] for r in rows], 'citations': args.citations, 'status': 'running'}
        (directory / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
        with (directory / 'results.jsonl').open('x', encoding='utf-8') as out:
            for row in rows:
                start = time.monotonic()
                result = {'id': row['id'], 'input_sha256': digest(row)}
                try:
                    result.update(check_answer(row, predictor, bridge, args.citations))
                except Exception as error:
                    result.update(score=None, error=type(error).__name__)
                result['elapsed_ms'] = (time.monotonic() - start) * 1000
                out.write(json.dumps(result, ensure_ascii=False) + '\n')
                out.flush()
        meta['status'] = 'completed'
        (directory / 'meta.json').write_text(json.dumps(meta, indent=2) + '\n')
    finally:
        bridge.close()


def load_evaluation(inputs, gold_path, directory):
    meta = json.loads((Path(directory) / 'meta.json').read_text())
    planned = set(meta['ids'])
    require(len(planned) == len(meta['ids']), 'duplicate_planned_id')
    rows = [row for row in records(inputs) if row['id'] in planned]
    require(len(rows) == len(planned) and digest(rows) == meta['input_sha256'], 'changed_inputs')
    labels, results = {}, {}
    for target, path in ((labels, gold_path), (results, Path(directory) / 'results.jsonl')):
        for value in records(path):
            require(value['id'] not in target, 'duplicate_score_row')
            target[value['id']] = value
    require(set(results) <= planned, 'unplanned_predictions')
    observations = []
    for row in rows:
        gold, result = labels.get(row['id']), results.get(row['id'])
        require(gold and gold['input_sha256'] == digest(row) and type(gold['supported']) is bool, 'missing_or_stale_gold')
        require(not result or result['input_sha256'] == digest(row), 'stale_prediction')
        score = result.get('score') if result else None
        require(score is None or type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1, 'invalid_score')
        observations.append({'id': row['id'], 'group': row['group'], 'split': row['split'], 'slice': row['slice'],
                             'source_hashes': [s['sha256'] for s in row['sources']], 'gold': gold['supported'],
                             'score': score, 'elapsed_ms': result.get('elapsed_ms') if result else None,
                             'units': result.get('units') if result else None,
                             'usage': result.get('receipt', {}).get('usage') if result else None,
                             'error': result.get('error') if result else 'missing'})
    return meta, observations


def upper_bound(errors, count):
    from scipy.stats import beta
    return None if not count else 1.0 if errors == count else float(beta.ppf(.95, errors + 1, count - errors))


def summary(rows, threshold):
    import numpy as np
    require(rows and 0 < threshold <= 1, 'empty_score_set_or_invalid_threshold')
    passed = lambda r: r['score'] is not None and r['score'] >= threshold
    bad, good = [r for r in rows if not r['gold']], [r for r in rows if r['gold']]
    accepted = [r for r in rows if passed(r)]
    unsafe = [r for r in accepted if not r['gold']]
    groups = defaultdict(list)
    for row in accepted:
        groups[row['group']].append(row)
    unsafe_groups = sum(any(not r['gold'] for r in group) for group in groups.values())
    ratio = lambda x, n: x / n if n else None
    latencies = [r['elapsed_ms'] for r in rows if r['elapsed_ms'] is not None]
    correct = sum(r['score'] is not None and passed(r) == r['gold'] for r in rows)
    citations = [citation_scores(r['units'], threshold) for r in rows if r['units']]
    false_reject = sum(not passed(r) for r in good)
    detected = sum(r['score'] is not None and not passed(r) for r in bad)
    usages = [r.get('usage') for r in rows]
    return {'items': len(rows), 'groups': len({r['group'] for r in rows}), 'missing': sum(r['score'] is None for r in rows),
            'accuracy': correct / len(rows), 'coverage': len(accepted) / len(rows),
            'false_reassurance': ratio(len(unsafe), len(accepted)), 'unsupported_accepted': ratio(len(unsafe), len(bad)),
            'valid_pass_rate': ratio(sum(passed(r) for r in good), len(good)),
            'false_rejection': ratio(false_reject, len(good)), 'unsupported_detection': ratio(detected, len(bad)),
            'confusion': {'supported_pass': len(accepted) - len(unsafe), 'unsupported_pass': len(unsafe),
                          'supported_not_pass': false_reject, 'unsupported_detected': detected},
            'known_usage_items': sum(isinstance(u, dict) for u in usages),
            'known_input_tokens': sum(u['inputTokens'] for u in usages if isinstance(u, dict) and isinstance(u.get('inputTokens'), (int, float))) if any(isinstance(u, dict) and isinstance(u.get('inputTokens'), (int, float)) for u in usages) else None,
            'known_output_tokens': sum(u['outputTokens'] for u in usages if isinstance(u, dict) and isinstance(u.get('outputTokens'), (int, float))) if any(isinstance(u, dict) and isinstance(u.get('outputTokens'), (int, float)) for u in usages) else None,
            'accepted_groups': len(groups), 'unsafe_groups': unsafe_groups,
            'group_risk_upper95': upper_bound(unsafe_groups, len(groups)),
            'p95_ms': float(np.percentile(latencies, 95)) if latencies else None,
            **{key: float(np.mean([c[key] for c in citations if c[key] is not None])) if any(c[key] is not None for c in citations) else None
               for key in ('citation_recall', 'citation_precision')}}


def score(args):
    meta, rows = load_evaluation(args.input, args.gold, args.run)
    threshold = args.threshold
    policy = None
    if args.policy:
        policy = json.loads(Path(args.policy).read_text())
        require(policy['enabled'] and policy['code'] == meta['code'] and policy['model'] == meta['model'], 'incompatible_policy')
        require(all(r['split'] == 'test' for r in rows), 'policy_requires_test_split')
        require(not set(policy['groups']) & {r['group'] for r in rows}, 'calibration_group_overlap')
        require(not set(policy['sources']) & {s for r in rows for s in r['source_hashes']}, 'calibration_source_overlap')
        require({r['slice'] for r in rows} <= set(policy['slices']), 'uncalibrated_task_slice')
        threshold = policy['threshold']
    require(0 < threshold <= 1, 'invalid_threshold')
    slices = sorted({(r['split'], r['slice']) for r in rows})
    report = {'meta': meta, 'threshold': threshold, 'summary': summary(rows, threshold),
              'slices': {f'{split}:{name}': summary([r for r in rows if r['split'] == split and r['slice'] == name], threshold)
                         for split, name in slices}, 'observations': rows}
    if policy:
        report['meets_policy'] = all(s['group_risk_upper95'] is not None and s['group_risk_upper95'] <= policy['risk_limit']
                                     and (s['valid_pass_rate'] or 0) >= policy['valid_pass_limit'] for s in report['slices'].values())
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['summary'], indent=2))


def fit(args):
    meta, rows = load_evaluation(args.input, args.gold, args.run)
    require(all(r['split'] == 'calibration' for r in rows), 'fit_requires_calibration_split')
    require(0 < args.risk < 1 and 0 < args.valid_pass <= 1, 'invalid_policy_limits')
    options = []
    for threshold in (.5, .7, .8, .9, .95, .97, .99):
        result = summary(rows, threshold)
        per_slice = [summary([r for r in rows if r['slice'] == name], threshold) for name in {r['slice'] for r in rows}]
        if all(s['group_risk_upper95'] is not None and s['group_risk_upper95'] <= args.risk and (s['valid_pass_rate'] or 0) >= args.valid_pass for s in per_slice):
            options.append((result['coverage'], -threshold))
    policy = {'enabled': bool(options), 'threshold': -max(options)[1] if options else None,
              'code': meta['code'], 'model': meta['model'], 'groups': sorted({r['group'] for r in rows}),
              'sources': sorted({s for r in rows for s in r['source_hashes']}), 'slices': sorted({r['slice'] for r in rows}), 'risk_limit': args.risk, 'valid_pass_limit': args.valid_pass}
    Path(args.out).write_text(json.dumps(policy, indent=2) + '\n')
    print(json.dumps({k: v for k, v in policy.items() if k not in ('groups', 'sources')}, indent=2))


def compare(args):
    import numpy as np
    left, right = [json.loads(Path(path).read_text()) for path in (args.left, args.right)]
    require(left['meta']['input_sha256'] == right['meta']['input_sha256'], 'unpaired_inputs')
    a, b = left['observations'], right['observations']
    require([(r['id'], r['gold'], r['group']) for r in a] == [(r['id'], r['gold'], r['group']) for r in b], 'unpaired_gold')
    groups = defaultdict(list)
    for l, r in zip(a, b):
        valid = lambda row, t: row['score'] is not None and (row['score'] >= t) == row['gold']
        groups[l['group']].append(int(valid(r, right['threshold'])) - int(valid(l, left['threshold'])))
    differences = np.array([np.mean(values) for values in groups.values()])
    require(len(differences) >= 2, 'need_multiple_source_groups')
    rng = np.random.default_rng(20260919)
    samples = [float(np.mean(rng.choice(differences, len(differences), replace=True))) for _ in range(2000)]
    print(json.dumps({'groups': len(groups), 'group_macro_accuracy_delta': float(differences.mean()),
                      'paired_group_bootstrap95': np.quantile(samples, [.025, .975]).tolist()}, indent=2))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('prepare')
    p.add_argument('--out', required=True)
    p.add_argument('--dataset', choices=['contractnli', 'ragtruth'], action='append')
    p = commands.add_parser('run')
    p.add_argument('--input', required=True); p.add_argument('--out', required=True)
    p.add_argument('--backend', choices=['minicheck', 'beaver'], required=True)
    p.add_argument('--model'); p.add_argument('--effort'); p.add_argument('--allow-live', action='store_true')
    p.add_argument('--allow-private', action='store_true')
    p.add_argument('--limit', type=int, default=0); p.add_argument('--citations', action='store_true')
    for name in ('score', 'fit'):
        p = commands.add_parser(name)
        for field in ('input', 'gold', 'run', 'out'):
            p.add_argument(f'--{field}', required=True)
        if name == 'score':
            p.add_argument('--threshold', type=float, default=.5); p.add_argument('--policy')
        else:
            p.add_argument('--risk', type=float, default=.01); p.add_argument('--valid-pass', type=float, default=.95)
    p = commands.add_parser('compare')
    p.add_argument('--left', required=True); p.add_argument('--right', required=True)
    args = parser.parse_args()
    if args.command == 'prepare':
        print(json.dumps(prepare(args.out, args.dataset or ('contractnli', 'ragtruth')), indent=2))
    else:
        globals()[args.command](args)


if __name__ == '__main__':
    main()
