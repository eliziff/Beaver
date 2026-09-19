import copy
import contextlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from benchmark import (Beaver, Bridge, MiniCheck, check_answer, citation_scores, compare,
                       fit, load_evaluation, score, summary, upper_bound, validate, select_rows, replay_units, answer_errors, localization)
from corpus import contract_cases, digest, packet, ragtruth_cases, utf16_len


class Scores:
    def __init__(self, values):
        self.values, self.jobs = values, []

    def predict(self, jobs, context):
        self.jobs = jobs
        return self.values, {'usage': None}


def example(text='The duty survives. The term is five years.', source='The duty survives for five years.'):
    return packet('answer-1', 'source-1', 'test', 'legal', source, text, 'What survives?')


def observation(identifier, group, gold, value, split='test'):
    return dict(id=identifier, group=group, gold=gold, score=value, split=split, slice='legal',
                source_hashes=[digest(group)], source_ids=[group], gold_sha256=digest([identifier, gold]),
                elapsed_ms=10, units=None)


class GroundingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = Bridge()

    @classmethod
    def tearDownClass(cls):
        cls.bridge.close()

    def test_exact_unicode_spans_and_all_text_checked(self):
        row = example('  The duty survives.\n\nThe firm 🦫 must pay.  \n')
        fake = Scores([1, 0])
        result = check_answer(row, fake, self.bridge)
        self.assertEqual(result['score'], 0)
        self.assertEqual(''.join(u['text'] for u in result['units']), row['answer'][0]['text'])
        self.assertEqual(result['units'][-1]['end'], utf16_len(row['answer'][0]['text']))
        self.assertEqual(len(fake.jobs), 2)
        row['evidence'][0]['end'] -= 1
        with self.assertRaisesRegex(ValueError, 'inexact'):
            validate(row)

    def test_uncited_tail_cannot_pass(self):
        row = example('The duty survives.')
        row['answer'].append({'text': 'The fee is $500.', 'evidence_ids': []})
        result = check_answer(row, Scores([1]), self.bridge)
        self.assertEqual(result['score'], 0)
        self.assertEqual(citation_scores(result['units'], .5)['citation_recall'], .5)
        row['answer'][-1]['evidence_ids'] = ['invented']
        with self.assertRaisesRegex(ValueError, 'unknown_citation'):
            validate(row)

    def test_missing_verdict_does_not_accept_answer(self):
        result = check_answer(example(), Scores([1, None]), self.bridge)
        self.assertIsNone(result['score'])
        invalid = check_answer(example(), Scores([1]), self.bridge)
        self.assertIsNone(invalid['score'])
        self.assertEqual(len(invalid['units']), 2)
        self.assertTrue(all(u['score'] is None for u in invalid['units']))

    def test_joint_evidence_and_alce_precision(self):
        row = example('Both conditions apply.', 'Condition A. Condition B.')
        row['evidence'] = [dict(row['evidence'][0], id='a', start=0, end=12, text='Condition A.'),
                           dict(row['evidence'][0], id='b', start=13, end=25, text='Condition B.')]
        row['answer'][0]['evidence_ids'] = ['a', 'b']
        # Joint support succeeds, neither citation suffices alone: both are needed.
        fake = Scores([1, 0, 0, 0, 0])
        result = check_answer(row, fake, self.bridge, citations=True)
        self.assertEqual(fake.jobs[0]['document'], 'Condition A.\n\nCondition B.')
        self.assertEqual(citation_scores(result['units'], .5), {'citation_recall': 1, 'citation_precision': 1})
        # A alone supports; B contributes nothing.
        result = check_answer(row, Scores([1, 1, 0, 0, 1]), self.bridge, citations=True)
        self.assertEqual(citation_scores(result['units'], .5)['citation_precision'], .5)

    def test_missing_precision_scores_do_not_truncate_recall(self):
        units = [{'evidence_ids': ['a', 'b'], 'score': 1, 'individual': [], 'without': []},
                 {'evidence_ids': ['a'], 'score': 1, 'individual': [], 'without': []}]
        self.assertEqual(citation_scores(units, .5), {'citation_recall': 1, 'citation_precision': None})

    def test_multisentence_conjunction_table_and_empty_segmentation(self):
        row = example('| Item | Answer |\n| --- | --- |\n| Term | Five years. |\n')
        split = self.bridge.call({'op': 'segment', 'texts': [row['answer'][0]['text']]})['segments'][0]
        result = check_answer(row, Scores([1] * len(split)), self.bridge)
        self.assertEqual(''.join(u['text'] for u in result['units']), row['answer'][0]['text'])
        class Incomplete:
            def call(self, request):
                return {'segments': [[{'start': 0, 'end': 4, 'text': 'The '}]]}
        with self.assertRaisesRegex(ValueError, 'unchecked_answer_tail'):
            check_answer(example(), Scores([1]), Incomplete())

    def test_beaver_invalid_duplicate_and_out_of_order_verdicts(self):
        class FakeBridge:
            def __init__(self, value):
                self.value = value
            def call(self, request):
                self.request = request
                return self.value
        jobs = [{'claim': 'A', 'document': 'source'}, {'claim': 'B', 'document': 'source'}]
        bridge = FakeBridge({'verdicts': [{'id': 1, 'verdict': 'unsupported'}, {'id': 0, 'verdict': 'supported'}]})
        predictor = Beaver(bridge, 'ollama:local', True)
        self.assertEqual(predictor.predict(jobs, {})[0], [1, 0])
        self.assertEqual(len(bridge.request['packet']['evidence']), 1)
        bridge.value['verdicts'][0]['id'] = 0
        self.assertEqual(predictor.predict(jobs, {})[0], [None, None])
        with self.assertRaisesRegex(ValueError, 'authorized'):
            Beaver(bridge, 'api:paid', True)

    def test_minicheck_uses_pair_scores_and_refuses_truncation(self):
        import numpy as np
        class Tokenizer:
            eos_token = '</s>'
            def __call__(self, text, truncation):
                self.truncation = truncation
                return {'input_ids': list(range(len(text)))}
        class Engine:
            tokenizer = Tokenizer()
            max_model_len = 40
            def inference(self, docs, claims):
                self.pairs = list(zip(docs, claims))
                return {'max_support_prob': 1, 'support_prob_per_chunk': np.array([.2, .9])}
        predictor = MiniCheck.__new__(MiniCheck)
        predictor.engine = Engine()
        result, receipt = predictor.predict([{'document': 'A', 'claim': 'B'}, {'document': 'C', 'claim': 'D'},
                                             {'document': 'X' * 100, 'claim': 'E'}], {})
        self.assertEqual(result, [.2, .9, None])
        self.assertEqual(receipt['oversized_pairs'], 1)
        self.assertFalse(predictor.engine.tokenizer.truncation)

    def test_metrics_do_not_credit_failures_as_detection(self):
        rows = [observation('a', 'g1', True, 1), observation('b', 'g1', False, 1),
                observation('c', 'g2', False, None), observation('d', 'g3', False, 0),
                observation('e', 'g4', True, None)]
        result = summary(rows, .5)
        self.assertEqual(result['accuracy'], .4)
        self.assertEqual(result['false_reassurance'], .5)
        self.assertEqual(result['unsupported_detection'], 1 / 3)
        self.assertEqual(result['valid_pass_rate'], .5)
        self.assertEqual(result['accepted_groups'], 1)
        self.assertEqual(result['unsafe_groups'], 1)
        self.assertEqual(result['confusion']['unsupported_missing'], 1)
        with self.assertRaisesRegex(ValueError, 'invalid_threshold'):
            summary(rows, 0)
        self.assertGreater(upper_bound(0, 60), .048)
        self.assertLess(upper_bound(0, 300), .01)

    def test_corpus_importers_preserve_splits_text_and_separate_labels(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with zipfile.ZipFile(root / 'contract.zip', 'w') as z:
                for split in ('train', 'dev', 'test'):
                    doc = {'id': split, 'text': 'A 🦫 duty.', 'spans': [[2, 3]],
                           'annotation_sets': [{'annotations': {'nda-1': {'choice': 'Entailment', 'spans': [0]},
                                                               'nda-2': {'choice': 'NotMentioned', 'spans': []}}}]}
                    z.writestr(f'data/{split}.json', json.dumps({'documents': [doc], 'labels': {
                        'nda-1': {'hypothesis': 'There is a duty.'}, 'nda-2': {'hypothesis': 'There is a fee.'}}}))
            pairs = list(contract_cases(root / 'contract.zip'))
            self.assertEqual({r['split'] for r, _ in pairs}, {'development', 'calibration', 'test'})
            self.assertEqual(pairs[0][1]['spans'][0], {'start': 2, 'end': 4, 'text': '🦫'})
            for row, gold in pairs:
                validate(row)
                self.assertNotIn('supported', json.dumps(row))
                self.assertIn('supported', gold)
            (root / 'sources').write_text(json.dumps({'source_id': '1', 'task_type': 'QA',
                'source_info': {'question': 'What?', 'passages': 'The term is five years.'}}) + '\n')
            (root / 'responses').write_text(json.dumps({'id': 'x', 'source_id': '1', 'quality': 'good',
                'split': 'test', 'response': 'Five years. 🦫 Nine years.', 'labels': [
                    {'start': 14, 'end': 25, 'label_type': 'conflict'}]}) + '\n')
            # A bounded original answer-label span is required.
            value = json.loads((root / 'responses').read_text())
            value['labels'][0]['end'] = len(value['response'])
            (root / 'responses').write_text(json.dumps(value) + '\n')
            row, gold = next(ragtruth_cases(root / 'sources', root / 'responses'))
            validate(row)
            self.assertEqual(row['answer'][0]['text'], value['response'])
            self.assertFalse(gold['supported'])
            self.assertEqual(gold['span_scope'], 'answer')
            self.assertIsNotNone(answer_errors(row, gold))
            self.assertEqual(pairs[0][1]['span_scope'], 'source')
            self.assertEqual(row['split'], 'test')
            value['labels'][0]['text'] = 'Wrong source offsets'
            (root / 'responses').write_text(json.dumps(value) + '\n')
            with self.assertRaisesRegex(ValueError, 'inexact_ragtruth_span'):
                list(ragtruth_cases(root / 'sources', root / 'responses'))

    def test_gold_binding_missing_predictions_and_locked_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            row = example()
            (root / 'input').write_text(json.dumps(row) + '\n')
            gold = {'id': row['id'], 'input_sha256': digest(row), 'supported': True}
            (root / 'gold').write_text(json.dumps(gold) + '\n')
            meta = {'ids': [row['id']], 'input_sha256': digest([row]), 'code': 'c', 'model': 'm'}
            (root / 'meta.json').write_text(json.dumps(meta))
            (root / 'results.jsonl').write_text('')
            _, rows = load_evaluation(root / 'input', root / 'gold', root)
            self.assertIsNone(rows[0]['score'])
            args = SimpleNamespace(input=root / 'input', gold=root / 'gold', run=root, out=root / 'report',
                                   risk=.01, valid_pass=.95, threshold=.5, policy=None)
            with self.assertRaisesRegex(ValueError, 'calibration_split'):
                fit(args)
            policy = {'enabled': True, 'code': 'c', 'model': 'm', 'groups': [row['group']], 'sources': [],
                      'slices': ['legal'], 'threshold': .5, 'risk_limit': .01, 'valid_pass_limit': .95}
            (root / 'policy').write_text(json.dumps(policy)); args.policy = root / 'policy'
            with self.assertRaisesRegex(ValueError, 'group_overlap'):
                score(args)
            gold['input_sha256'] = 'stale'
            (root / 'gold').write_text(json.dumps(gold) + '\n')
            with self.assertRaisesRegex(ValueError, 'stale_gold'):
                load_evaluation(root / 'input', root / 'gold', root)

    def test_sampling_keeps_complete_groups_and_is_independent_of_file_order(self):
        rows = [packet(f'{g}:{i}', f'g{g}', 'test', 'legal', f'Source {g}.', 'A claim.')
                for g in range(12) for i in range(3)]
        selected = select_rows(rows, groups=4, seed=17)
        self.assertEqual(selected, select_rows(list(reversed(rows)), groups=4, seed=17))
        self.assertEqual(len(selected), 12)
        self.assertEqual(len({r['group'] for r in selected}), 4)
        self.assertNotEqual(selected, select_rows(rows, groups=4, seed=18))
        other = packet('other', 'other', 'test', 'other-task', 'Another source.', 'Another claim.')
        self.assertIn(other, select_rows(rows + [other], groups=1))
        # Even a leak outside the eventual sample must be refused; versions are not independent sources.
        leaked = copy.deepcopy(rows[-1])
        leaked.update(id='leak', group='different', split='calibration')
        leaked['sources'][0].update(text='Changed version.', sha256=digest('Changed version.'), version='v2')
        leaked['evidence'] = []
        leaked['answer'][0]['evidence_ids'] = []
        with self.assertRaisesRegex(ValueError, 'source_crosses_splits'):
            select_rows(rows + [leaked], groups=1)

    def test_replay_rejects_changed_citations_scores_and_missing_text(self):
        row = example()
        result = check_answer(row, Scores([1, 0]), self.bridge)
        self.assertEqual(replay_units(row, result, False), result['units'])
        for mutation, message in (
            (lambda r: r.update(score=1), 'answer_score'),
            (lambda r: r['units'].pop(), 'answer_tail'),
            (lambda r: r['units'][0].update(evidence_ids=[]), 'unit_citations'),
            (lambda r: r['units'][0].update(text='Forged'), 'unit_text'),
            (lambda r: r['units'][0].update(score=float('nan')), 'unit_score')):
            changed = copy.deepcopy(result)
            mutation(changed)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                replay_units(row, changed, False)
        with self.assertRaisesRegex(ValueError, 'missing_checked_units'):
            replay_units(row, {'score': 1}, False)

    def test_localization_distinguishes_finding_the_error_from_rejecting_the_answer(self):
        row = example('The firm 🦫 pays. The term is nine years.')
        text = row['answer'][0]['text']
        start = utf16_len(text[:text.index('nine')])
        gold = {'supported': False, 'span_scope': 'answer',
                'spans': [{'block': 0, 'start': start, 'end': start + 4, 'text': 'nine'}]}
        errors = answer_errors(row, gold)
        result = check_answer(row, Scores([0, 1]), self.bridge)
        observed = {**observation('a', 'g1', False, 0), 'units': result['units'], 'error_spans': errors}
        report = summary([observed], .5)
        self.assertEqual(report['unsupported_detection'], 1)
        self.assertEqual(report['localization']['unit_recall'], 0)
        self.assertEqual(report['localization']['clean_unit_retention'], 0)
        self.assertEqual(report['localization']['error_span_hit_recall'], 0)
        observed['units'] = check_answer(row, Scores([1, 0]), self.bridge)['units']
        self.assertEqual(localization([observed], .5)['unit_f1'], 1)
        observed['units'][1]['score'] = None
        self.assertEqual(localization([observed], .5)['unit_recall'], 0)
        observed['units'] = None
        self.assertEqual(localization([observed], .5)['error_span_hit_recall'], 0)
        self.assertEqual(localization([observed], .5)['unsegmented_answers'], 1)
        self.assertIsNone(answer_errors(row, {**gold, 'span_scope': 'source'}))
        with self.assertRaisesRegex(ValueError, 'changed_gold_span'):
            answer_errors(row, {**gold, 'spans': [{**errors[0], 'start': start - 1}]})

    def test_citation_failures_stay_in_denominators_and_partial_checks_resolve(self):
        units = check_answer(example(), Scores([1, None]), self.bridge)['units']
        self.assertIsNone(citation_scores(units, .5)['citation_precision'])
        good = {**observation('a', 'g1', True, 1), 'units': check_answer(example(), Scores([1, 1]), self.bridge)['units']}
        rows = [good, observation('b', 'g2', False, None)]
        report = summary(rows, .5)
        self.assertEqual(report['citation_recall'], .5)
        self.assertEqual(report['citation_checked_items'], 1)
        self.assertEqual(report['citation_precision_scored_items'], 1)
        self.assertIsNone(report['citation_precision'])
        both = [{'evidence_ids': ['a', 'b'], 'score': 1, 'individual': [1, None], 'without': [None, 0]}]
        self.assertEqual(citation_scores(both, .5)['citation_precision'], 1)

    def test_cli_scoring_and_rate_comparisons_use_frozen_gold(self):
        import subprocess
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rows = [packet(f'a{i}', f'g{i}', 'test', 'legal', f'Source {i}.', 'The duty survives.') for i in range(4)]
            gold = [{'id': r['id'], 'input_sha256': digest(r), 'supported': i % 2 == 0} for i, r in enumerate(rows)]
            (root / 'input').write_text(''.join(json.dumps(r) + '\n' for r in rows))
            (root / 'gold').write_text(''.join(json.dumps(r) + '\n' for r in gold))
            for name, scores in [('left', [1, 1, 1, 0]), ('right', [1, 0, 1, 0])]:
                directory = root / name
                directory.mkdir()
                meta = {'ids': [r['id'] for r in reversed(rows)], 'input_sha256': digest(list(reversed(rows))),
                        'code': 'c', 'model': 'm', 'citations': False, 'status': 'completed'}
                (directory / 'meta.json').write_text(json.dumps(meta))
                results = [{**check_answer(r, Scores([value]), self.bridge), 'id': r['id'],
                            'input_sha256': digest(r), 'elapsed_ms': 10} for r, value in zip(rows, scores)]
                (directory / 'results.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in results))
                subprocess.run(['python', str(Path(__file__).with_name('benchmark.py')), 'score',
                                '--input', str(root / 'input'), '--gold', str(root / 'gold'), '--run', str(directory),
                                '--out', str(root / f'{name}.json')], check=True, capture_output=True, text=True)
            args = SimpleNamespace(left=root / 'left.json', right=root / 'right.json', metric='unsupported_accepted')
            with contextlib.redirect_stdout(io.StringIO()) as out:
                compare(args)
            result = json.loads(out.getvalue())
            self.assertEqual(result['right_minus_left'], -.5)
            self.assertEqual(result['groups'], 4)
            # Undefined conditional bootstrap draws are counted, not silently treated as zero.
            self.assertGreater(result['undefined_resamples'], 0)
            args.metric = 'accuracy'
            with contextlib.redirect_stdout(io.StringIO()) as out:
                compare(args)
            self.assertEqual(json.loads(out.getvalue())['right_minus_left'], .25)
            right = json.loads(args.right.read_text())
            right['observations'][0]['gold_sha256'] = 'changed'
            args.right.write_text(json.dumps(right))
            with self.assertRaisesRegex(ValueError, 'unpaired_gold'):
                compare(args)

    def test_locked_policy_cannot_drop_tasks_or_reuse_another_source_version(self):
        from unittest.mock import patch
        rows = [observation('a', 'test-group', True, 1)]
        meta = {'status': 'completed', 'code': 'c', 'model': 'm'}
        policy = {'enabled': True, 'code': 'c', 'model': 'm', 'groups': ['cal-group'],
                  'sources': ['cal-hash'], 'source_ids': ['test-group'], 'slices': ['legal', 'other'],
                  'threshold': .5, 'risk_limit': .01, 'valid_pass_limit': .95}
        with tempfile.TemporaryDirectory() as temp, patch('benchmark.load_evaluation', return_value=(meta, rows)):
            path = Path(temp) / 'policy'
            path.write_text(json.dumps(policy))
            args = SimpleNamespace(input=None, gold=None, run=None, threshold=.5, policy=path, out=Path(temp) / 'out')
            with self.assertRaisesRegex(ValueError, 'source_identity_overlap'):
                score(args)
            policy['source_ids'] = ['different-source']
            path.write_text(json.dumps(policy))
            with self.assertRaisesRegex(ValueError, 'task_slice'):
                score(args)
        calibration = [observation(str(i), f'cal-{i}', i < 300, .9 if i < 300 else .8, 'calibration') for i in range(600)]
        heldout = [observation(str(i), f'test-{i}', i < 300, .9 if i < 300 else .8) for i in range(600)]
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            args = SimpleNamespace(input=None, gold=None, run=None, risk=.01, valid_pass=.95, out=Path(temp) / 'policy')
            with patch('benchmark.load_evaluation', return_value=(meta, calibration)):
                fit(args)
            fitted = json.loads(args.out.read_text())
            self.assertTrue(fitted['enabled'])
            self.assertEqual(fitted['threshold'], .9)
            args.policy, args.out, args.threshold = args.out, Path(temp) / 'report', .5
            with patch('benchmark.load_evaluation', return_value=(meta, heldout)):
                score(args)
            self.assertTrue(json.loads(args.out.read_text())['meets_policy'])
            with patch('benchmark.load_evaluation', return_value=({**meta, 'status': 'running'}, heldout)):
                score(args)
            self.assertFalse(json.loads(args.out.read_text())['meets_policy'])

    def test_pair_preflight_and_provider_failure_are_bounded(self):
        row = example('The duty survives. ' * 513)
        fake = Scores([])
        with self.assertRaisesRegex(ValueError, 'checker_pair_limit'):
            check_answer(row, fake, self.bridge)
        self.assertEqual(fake.jobs, [])
        class Broken:
            def predict(self, jobs, context):
                raise TimeoutError('provider unavailable')
        result = check_answer(example(), Broken(), self.bridge)
        self.assertEqual(result['error'], 'TimeoutError')
        self.assertIsNone(result['score'])
        self.assertEqual(len(result['units']), 2)
        self.assertTrue(all(u['score'] is None for u in result['units']))
        runtime = self.bridge.call({'op': 'runtime'})
        self.assertEqual(set(runtime), {'node', 'icu', 'unicode', 'locale'})
        self.assertTrue(all(isinstance(v, str) and v for v in runtime.values()))


if __name__ == '__main__':
    unittest.main()
