import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from benchmark import (Beaver, Bridge, MiniCheck, check_answer, citation_scores, compare,
                       fit, load_evaluation, score, summary, upper_bound, validate)
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
                source_hashes=[digest(group)], elapsed_ms=10, units=None)


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
        with self.assertRaisesRegex(ValueError, 'invalid_support_scores'):
            check_answer(example(), Scores([1]), self.bridge)

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
            self.assertEqual(row['split'], 'test')

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


if __name__ == '__main__':
    unittest.main()
