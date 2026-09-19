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

from corpus import digest, prepare, records, utf16_len

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


def select_rows(rows, groups=0, seed=20260919):
    require(type(groups) is int and groups >= 0, 'invalid_group_limit')
    require(rows and len({r['id'] for r in rows}) == len(rows), 'empty_or_duplicate_input')
    boundaries, strata = {}, defaultdict(set)
    for row in rows:
        validate(row)
        keys = [('group', row['group'])] + [key for source in row['sources']
                for key in (('source', source['id']), ('hash', source['sha256']))]
        for key in keys:
            require(key not in boundaries or boundaries[key] == row['split'], 'source_crosses_splits')
            boundaries[key] = row['split']
        strata[row['split'], row['slice']].add(row['group'])
    rank = lambda group: (digest([seed, group]), group)
    selected = {g for values in strata.values() for g in sorted(values, key=rank)[:groups or None]}
    return sorted((row for row in rows if row['group'] in selected),
                  key=lambda row: (row['split'], row['slice'], rank(row['group']), row['id']))


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
    pair_characters = 0
    for block_index, (block, segments) in enumerate(zip(row['answer'], split)):
        cursor = 0
        for segment in segments:
            require(segment['start'] == cursor and encoded_slice(block['text'], segment['start'], segment['end']) == segment['text'], 'segmentation_gap')
            cursor = segment['end']
            ids = block['evidence_ids']
            unit = {'block': block_index, **segment, 'evidence_ids': ids, 'joint': None, 'individual': [], 'without': []}
            def add(selected):
                nonlocal pair_characters
                pair_characters += len(segment['text']) + sum(len(evidence[i]['text']) for i in selected)
                require(len(jobs) < 512 and pair_characters <= 2_000_000, 'checker_pair_limit')
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
    try:
        scores, receipt = predictor.predict(jobs, {'question': row['question'], 'answer_context': row['answer']}) if jobs else ([], {})
        require(len(scores) == len(jobs) and all(p is None or type(p) in (int, float) and math.isfinite(p) and 0 <= p <= 1 for p in scores), 'invalid_support_scores')
    except Exception as error:
        scores, receipt = [None] * len(jobs), {'error': type(error).__name__}

    for unit in units:
        unit['score'] = 0.0 if unit['joint'] is None else scores[unit['joint']]
        unit['individual'] = [scores[i] for i in unit['individual']]
        unit['without'] = [scores[i] for i in unit['without']]
        del unit['joint']
    complete = all(unit['score'] is not None for unit in units)
    return {'units': units, 'score': min(unit['score'] for unit in units) if complete else None,
            'receipt': receipt, 'pair_count': len(jobs), 'error': receipt.get('error')}


def citation_scores(units, threshold):
    # Adapted from ALCE compute_autoais; see THIRD_PARTY.md. Joint evidence first.
    supported, necessary, total, precision_known = 0, 0, 0, True
    for unit in units:
        count = len(unit['evidence_ids'])
        total += count
        if count and unit['score'] is None:
            precision_known = False
        if not count or unit['score'] is None or unit['score'] < threshold:
            continue
        supported += 1
        if count <= 1:
            necessary += count
        elif len(unit['individual']) != count or len(unit['without']) != count:
            precision_known = False
        else:
            for single, excluded in zip(unit['individual'], unit['without']):
                if single is not None and single >= threshold or excluded is not None and excluded < threshold:
                    necessary += 1
                elif single is None or excluded is None:
                    precision_known = False
    return {'citation_recall': supported / len(units), 'citation_precision': (necessary / total if total else 0.0) if precision_known else None}


def code_hash():
    return digest([(name, (HERE / name).read_text()) for name in ('benchmark.py', 'bridge.mjs', 'corpus.py', 'requirements.txt')])


def run(args):
    rows = select_rows(list(records(args.input)), args.groups, args.seed)
    require(args.backend != 'beaver' or args.allow_private or all(r['privacy'] != 'private' for r in rows),
            'private_transmission_not_authorized')
    directory = Path(args.out)
    directory.mkdir(parents=True, exist_ok=False)
    bridge = Bridge(provider=args.backend == 'beaver')
    try:
        predictor = MiniCheck() if args.backend == 'minicheck' else Beaver(bridge, args.model, args.allow_live, args.effort)
        meta = {'code': code_hash(), 'model': {**predictor.identity, 'runtime': bridge.call({'op': 'runtime'}), 'citations': args.citations},
                'sampling': {'groups_per_slice': args.groups, 'seed': args.seed}, 'input_sha256': digest(rows),
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


def replay_units(row, result, citations):
    units = result.get('units') if result else None
    if units is None:
        require(not result or result.get('score') is None and result.get('error'), 'missing_checked_units')
        return None
    require(isinstance(units, list) and units, 'empty_checked_units')
    cursors = [0] * len(row['answer'])
    previous = 0
    for unit in units:
        block = unit['block']
        require(type(block) is int and previous <= block < len(cursors), 'invalid_unit_block')
        previous = block
        require(unit['start'] == cursors[block] and
                encoded_slice(row['answer'][block]['text'], unit['start'], unit['end']) == unit['text'], 'changed_unit_text')
        cursors[block] = unit['end']
        require(unit['evidence_ids'] == row['answer'][block]['evidence_ids'], 'changed_unit_citations')
        count = len(unit['evidence_ids']) if citations and len(unit['evidence_ids']) > 1 else 0
        require(len(unit['individual']) == len(unit['without']) == count, 'missing_citation_checks')
        values = [unit['score']] + unit['individual'] + unit['without']
        require(all(v is None or type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 1 for v in values), 'invalid_unit_score')
        require(unit['evidence_ids'] or unit['score'] == 0, 'uncited_unit_pass')
    require(cursors == [utf16_len(b['text']) for b in row['answer']], 'unchecked_answer_tail')
    aggregate = min(u['score'] for u in units) if all(u['score'] is not None for u in units) else None
    require(result.get('score') == aggregate, 'changed_answer_score')
    return units


def answer_errors(row, gold):
    require(gold.get('span_scope') in (None, 'source', 'answer'), 'invalid_gold_span_scope')
    if gold.get('span_scope') != 'answer':
        return None
    spans = gold['spans']
    require(isinstance(spans, list) and gold['supported'] == (not spans), 'inconsistent_error_spans')
    seen = set()
    for span in spans:
        block = span['block']
        require(type(block) is int and 0 <= block < len(row['answer']), 'invalid_gold_block')
        require(encoded_slice(row['answer'][block]['text'], span['start'], span['end']) == span['text'], 'changed_gold_span')
        key = (block, span['start'], span['end'])
        require(key not in seen, 'duplicate_gold_span')
        seen.add(key)
    return spans


def overlaps(unit, span):
    return unit['block'] == span['block'] and unit['start'] < span['end'] and span['start'] < unit['end']


def localization(rows, threshold):
    annotated = [r for r in rows if r.get('error_spans') is not None]
    if not annotated:
        return None
    counts = defaultdict(int)
    hits, spans = 0, 0
    for row in annotated:
        errors, units = row['error_spans'], row['units'] or []
        flagged = [u for u in units if u['score'] is not None and u['score'] < threshold]
        spans += len(errors)
        hits += sum(any(overlaps(u, e) for u in flagged) for e in errors)
        for unit in units:
            truth = 'unsupported' if any(overlaps(unit, e) for e in errors) else 'supported'
            outcome = 'missing' if unit['score'] is None else 'flagged' if unit['score'] < threshold else 'passed'
            counts[truth + '_' + outcome] += 1
    ratio = lambda a, b: a / b if b else None
    tp, fp = counts['unsupported_flagged'], counts['supported_flagged']
    positives = tp + counts['unsupported_passed'] + counts['unsupported_missing']
    negatives = fp + counts['supported_passed'] + counts['supported_missing']
    return {'annotated_answers': len(annotated), 'unsegmented_answers': sum(not r['units'] for r in annotated),
            'unit_confusion': dict(counts), 'unit_precision': ratio(tp, tp + fp),
            'unit_recall': ratio(tp, positives), 'unit_f1': ratio(2 * tp, positives + tp + fp),
            'clean_unit_retention': ratio(counts['supported_passed'], negatives),
            'error_spans': spans, 'error_span_hits': hits, 'error_span_hit_recall': ratio(hits, spans)}


def load_evaluation(inputs, gold_path, directory):
    meta = json.loads((Path(directory) / 'meta.json').read_text())
    planned = set(meta['ids'])
    require(len(planned) == len(meta['ids']), 'duplicate_planned_id')
    rows = [row for row in records(inputs) if row['id'] in planned]
    require(len(rows) == len(planned) == len({r['id'] for r in rows}), 'changed_inputs')
    by_id = {r['id']: r for r in rows}
    rows = [by_id[i] for i in meta['ids']]
    require(digest(rows) == meta['input_sha256'], 'changed_inputs')
    labels, results = {}, {}
    for target, path in ((labels, gold_path), (results, Path(directory) / 'results.jsonl')):
        for value in records(path):
            require(value['id'] not in target, 'duplicate_score_row')
            target[value['id']] = value
    require(set(results) <= planned, 'unplanned_predictions')
    observations = []
    for row in rows:
        validate(row)
        gold, result = labels.get(row['id']), results.get(row['id'])
        require(gold and gold['input_sha256'] == digest(row) and type(gold['supported']) is bool, 'missing_or_stale_gold')
        require(not result or result['input_sha256'] == digest(row), 'stale_prediction')
        score = result.get('score') if result else None
        require(score is None or type(score) in (int, float) and math.isfinite(score) and 0 <= score <= 1, 'invalid_score')
        units = replay_units(row, result, meta.get('citations', False))
        errors = answer_errors(row, gold)
        observations.append({'id': row['id'], 'group': row['group'], 'split': row['split'], 'slice': row['slice'],
                             'source_hashes': [s['sha256'] for s in row['sources']], 'source_ids': [s['id'] for s in row['sources']],
                             'gold': gold['supported'], 'gold_sha256': digest(gold), 'error_spans': errors,
                             'score': score, 'elapsed_ms': result.get('elapsed_ms') if result else None,
                             'units': units,
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
    citations = [citation_scores(r['units'], threshold) if r['units'] else
                 {'citation_recall': 0.0, 'citation_precision': None} for r in rows]
    false_reject = sum(not passed(r) for r in good)
    detected = sum(r['score'] is not None and not passed(r) for r in bad)
    usages = [r.get('usage') for r in rows]
    return {'items': len(rows), 'groups': len({r['group'] for r in rows}), 'missing': sum(r['score'] is None for r in rows),
            'accuracy': correct / len(rows), 'coverage': len(accepted) / len(rows),
            'missing_rate': sum(r['score'] is None for r in rows) / len(rows),
            'false_reassurance': ratio(len(unsafe), len(accepted)), 'unsupported_accepted': ratio(len(unsafe), len(bad)),
            'valid_pass_rate': ratio(sum(passed(r) for r in good), len(good)),
            'false_rejection': ratio(false_reject, len(good)), 'unsupported_detection': ratio(detected, len(bad)),
            'confusion': {'supported_pass': len(accepted) - len(unsafe), 'unsupported_pass': len(unsafe),
                          'supported_not_pass': false_reject, 'unsupported_detected': detected,
                          'unsupported_missing': sum(r['score'] is None for r in bad)},
            'known_usage_items': sum(isinstance(u, dict) for u in usages),
            'known_input_tokens': sum(u['inputTokens'] for u in usages if isinstance(u, dict) and isinstance(u.get('inputTokens'), (int, float))) if any(isinstance(u, dict) and isinstance(u.get('inputTokens'), (int, float)) for u in usages) else None,
            'known_output_tokens': sum(u['outputTokens'] for u in usages if isinstance(u, dict) and isinstance(u.get('outputTokens'), (int, float))) if any(isinstance(u, dict) and isinstance(u.get('outputTokens'), (int, float)) for u in usages) else None,
            'accepted_groups': len(groups), 'unsafe_groups': unsafe_groups,
            'group_risk_upper95': upper_bound(unsafe_groups, len(groups)),
            'p95_ms': float(np.percentile(latencies, 95)) if latencies else None,
            'localization': localization(rows, threshold),
            'citation_recall': float(np.mean([c['citation_recall'] for c in citations])),
            'citation_checked_items': sum(bool(r['units']) for r in rows),
            'citation_precision_scored_items': sum(c['citation_precision'] is not None for c in citations),
            'citation_precision': float(np.mean([c['citation_precision'] for c in citations]))
                                  if all(c['citation_precision'] is not None for c in citations) else None}



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
        require(not set(policy['source_ids']) & {s for r in rows for s in r['source_ids']}, 'calibration_source_identity_overlap')
        require({r['slice'] for r in rows} == set(policy['slices']), 'missing_or_uncalibrated_task_slice')
        threshold = policy['threshold']
    require(0 < threshold <= 1, 'invalid_threshold')
    slices = sorted({(r['split'], r['slice']) for r in rows})
    report = {'meta': meta, 'threshold': threshold, 'summary': summary(rows, threshold),
              'slices': {f'{split}:{name}': summary([r for r in rows if r['split'] == split and r['slice'] == name], threshold)
                         for split, name in slices}, 'observations': rows}
    if policy:
        report['meets_policy'] = meta.get('status') == 'completed' and all(s['group_risk_upper95'] is not None and s['group_risk_upper95'] <= policy['risk_limit']
                                     and (s['valid_pass_rate'] or 0) >= policy['valid_pass_limit'] for s in report['slices'].values())
    Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['summary'], indent=2))


def fit(args):
    meta, rows = load_evaluation(args.input, args.gold, args.run)
    require(all(r['split'] == 'calibration' for r in rows), 'fit_requires_calibration_split')
    require(meta.get('status') == 'completed', 'fit_requires_completed_run')
    require(0 < args.risk < 1 and 0 < args.valid_pass <= 1, 'invalid_policy_limits')
    options = []
    for threshold in (.5, .7, .8, .9, .95, .97, .99):
        result = summary(rows, threshold)
        per_slice = [summary([r for r in rows if r['slice'] == name], threshold) for name in {r['slice'] for r in rows}]
        if all(s['group_risk_upper95'] is not None and s['group_risk_upper95'] <= args.risk and (s['valid_pass_rate'] or 0) >= args.valid_pass for s in per_slice):
            options.append((result['coverage'], -threshold))
    policy = {'enabled': bool(options), 'threshold': -max(options)[1] if options else None,
              'code': meta['code'], 'model': meta['model'], 'groups': sorted({r['group'] for r in rows}),
              'source_ids': sorted({s for r in rows for s in r['source_ids']}),
              'sources': sorted({s for r in rows for s in r['source_hashes']}), 'slices': sorted({r['slice'] for r in rows}), 'risk_limit': args.risk, 'valid_pass_limit': args.valid_pass}
    Path(args.out).write_text(json.dumps(policy, indent=2) + '\n')
    print(json.dumps({k: v for k, v in policy.items() if k not in ('groups', 'sources')}, indent=2))


def compare(args):
    import numpy as np
    left, right = [json.loads(Path(path).read_text()) for path in (args.left, args.right)]
    require(left['meta']['input_sha256'] == right['meta']['input_sha256'], 'unpaired_inputs')
    a, b = left['observations'], right['observations']
    require([(r['id'], r['gold_sha256'], r['group']) for r in a] ==
            [(r['id'], r['gold_sha256'], r['group']) for r in b], 'unpaired_gold')
    require([r['id'] for r in a] == left['meta']['ids'] and [r['id'] for r in b] == right['meta']['ids']
            and len(a) == len({r['id'] for r in a}), 'changed_report_population')
    metric = args.metric
    def counts(row, threshold):
        passed = row['score'] is not None and row['score'] >= threshold
        if metric == 'valid_pass_rate':
            return [int(passed and row['gold']), int(row['gold'])]
        if metric == 'unsupported_accepted':
            return [int(passed and not row['gold']), int(not row['gold'])]
        if metric == 'false_reassurance':
            return [int(passed and not row['gold']), int(passed)]
        value = passed if metric == 'coverage' else row['score'] is None if metric == 'missing_rate' else \
            row['score'] is not None and passed == row['gold']
        return [int(value), 1]
    groups = defaultdict(lambda: np.zeros(4))
    for l, r in zip(a, b):
        groups[l['group']] += counts(l, left['threshold']) + counts(r, right['threshold'])
    values = np.array(list(groups.values()))
    require(len(values) >= 2, 'need_multiple_source_groups')
    def difference(total):
        return float(total[2] / total[3] - total[0] / total[1]) if total[1] and total[3] else None
    delta = difference(values.sum(axis=0))
    require(delta is not None, 'metric_has_empty_denominator')
    rng = np.random.default_rng(20260919)
    samples = [difference(values[rng.integers(len(values), size=len(values))].sum(axis=0)) for _ in range(2000)]
    defined = [v for v in samples if v is not None]
    print(json.dumps({'metric': metric, 'groups': len(groups), 'right_minus_left': delta,
                      'undefined_resamples': len(samples) - len(defined),
                      'paired_group_bootstrap95': np.quantile(defined, [.025, .975]).tolist()
                       if len(defined) >= .95 * len(samples) else None}, indent=2))


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
    p.add_argument('--groups', type=int, default=0, help='Source groups per split/task; zero selects all')
    p.add_argument('--seed', type=int, default=20260919); p.add_argument('--citations', action='store_true')
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
    p.add_argument('--metric', choices=['accuracy', 'valid_pass_rate', 'unsupported_accepted',
                                      'false_reassurance', 'coverage', 'missing_rate'], default='accuracy')
    args = parser.parse_args()
    if args.command == 'prepare':
        print(json.dumps(prepare(args.out, args.dataset or ('contractnli', 'ragtruth')), indent=2))
    else:
        globals()[args.command](args)


if __name__ == '__main__':
    main()
