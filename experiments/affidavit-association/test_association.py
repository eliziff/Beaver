import unittest
import random
import json
from pathlib import Path
import tempfile
import re
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np

from data import packets, targets, assign_folds, accepted_gold, text_key, freeze_texts, restore_texts, association_views, digest, visible_text, legacy_document_keys, source_identity, load_record
from run import objective, metrics, balanced
from audit_expansion import iso, referring_key, original_key, prior_keys, geography_errors, peer_review_errors, legacy_referring_key, source_parts, counted_attempts
from chunks import ChunkPlan


class WordTokenizer:
    def __call__(self, text, **kwargs):
        return {'offset_mapping': [(m.start(), m.end()) for m in re.finditer(r'\S+', text)]}

    def encode(self, text, add_special_tokens=True, **kwargs):
        return list(range(len(re.findall(r'\S+', text)) + (2 if add_special_tokens else 0)))


def example(name, group, text):
    context = {'seg': ['A parcel inventory', 'was attached'], 'item': '', 'main': 'inventory', 'paragraph': 'inventory'}
    return {'record': name, 'group': group, 'files': ['original.pdf'], 'texts': [text], 'labels': ['A'],
            'truth': {'original.pdf': 'A'}, 'acceptable': {'original.pdf': ['A']}, 'ctx': {'A': context},
            'new': False, 'subject': 'construction'}


class AssociationTests(unittest.TestCase):
    def test_runner_scheduling_rows_do_not_double_count_metered_attempts(self):
        entries = [
            {'job_id': 'invented-runner-job', 'runner_call': True, 'phase': 'review'},
            {'status': 'failed', 'usage': {}},
            {'status': 'complete', 'usage': {'input_tokens': 40}},
            {'job_id': 'invented-direct-job', 'runner_call': False, 'phase': 'author'},
            {'job_id': 'invented-preparation', 'runner_call': False, 'phase': 'source_preparation'},
            {'status': 'unknown'},
        ]
        self.assertEqual(counted_attempts(entries), 4)

    def test_text_only_counterpart_uses_reviewed_text_and_original_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'source.json').write_text('{}', encoding='utf-8')
            (directory / 'affidavit.txt').write_text('1. Exhibit A is the bridge survey.', encoding='utf-8')
            (directory / 'survey.txt').write_text('Complete bridge survey.', encoding='utf-8')
            text = directory / 'revised-survey.txt'
            text.write_text('Complete revised bridge survey.', encoding='utf-8')
            counterpart = {'file': 'counterpart.pdf', 'text_file': text.name, 'text_sha256': digest(text),
                           'source_sha256': 'e' * 64, 'sha256': 'f' * 64, 'source_pages': [8, 9],
                           'source_url': 'https://example.org/invented-survey-record.pdf',
                           'same_proceeding': True, 'review_status': 'accepted'}
            (directory / 'distractors.json').write_text(json.dumps([counterpart]), encoding='utf-8')
            gold = {'record_id': 'invented-survey', 'exhibits': [{'label': 'A', 'source_sha256': 'e' * 64, 'source_pages': [4]}]}
            views = [{'label': 'A', 'file': 'target.pdf', 'text_file': 'survey.txt'}]
            record, _ = load_record(directory, gold, views)
            self.assertEqual(record['other_documents'][-1], ('counterpart.pdf', 'Complete revised bridge survey.', True))
            self.assertEqual(record['document_keys']['counterpart.pdf'], source_identity({
                'label': 'counterpart', 'source_sha256': 'e' * 64, 'source_pages': [8, 9]}))
            self.assertFalse((directory / 'counterpart.pdf').exists())
            text.write_text('Changed derivative.', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Changed distractor text'):
                load_record(directory, gold, views)
            counterpart.pop('file')
            (directory / 'distractors.json').write_text(json.dumps([counterpart]), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'missing its document file identity'):
                load_record(directory, gold, views)

    def test_original_identity_retains_multiple_exhibit_cover_pages(self):
        exhibit = {'label': 'A', 'source_sha256': 'd' * 64, 'source_pages': [5, 6],
                   'source_cover_pages': [3, 4]}
        complete = dict(exhibit, source_pages=[3, 4, 5, 6], source_cover_pages=[])
        self.assertEqual(source_identity(exhibit), source_identity(complete))
        self.assertEqual(original_key(source_parts(exhibit)), original_key(source_parts(complete)))
        self.assertNotEqual(source_identity(exhibit), source_identity(dict(exhibit, source_cover_pages=[])))

    def test_legacy_original_identity_uses_body_pages_not_all_attachments(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / 'source.json').write_text(json.dumps({'source_sha256': 'c' * 64,
                'url': 'https://example.org/invented-bridge-pack.pdf'}), encoding='utf-8')
            (directory / 'split.json').write_text(json.dumps({'affidavit_pages': [3, 4],
                'exhibits': [{'label': 'A', 'source_pages': [6, 7]}]}), encoding='utf-8')
            self.assertEqual(legacy_referring_key(directory), original_key([{'sha256': 'c' * 64, 'pages': [4, 3]}]))
            self.assertNotEqual(legacy_referring_key(directory), original_key([{'sha256': 'c' * 64, 'pages': [3, 4, 6, 7]}]))

    def test_pending_or_self_review_does_not_count_as_independent_gold(self):
        scope = {'run_id': 'invented-bridge-batch', 'require_peer_review': True}
        jobs = {'author-job': {'phase': 'author', 'status': 'completed', 'agent': 'author'},
                'review-job': {'phase': 'review', 'status': 'completed', 'agent': 'reviewer'}}
        gold = {'author_provenance': {'run_id': scope['run_id'], 'agent': 'author', 'job_id': 'author-job'},
                'independent_source_review': {'status': 'pending'}}
        self.assertTrue(peer_review_errors(gold, scope, jobs))
        gold['independent_source_review'] = {'status': 'accepted', 'agent': 'reviewer', 'job_id': 'review-job'}
        self.assertFalse(peer_review_errors(gold, scope, jobs))
        jobs['review-job']['agent'] = 'author'
        gold['independent_source_review']['agent'] = 'author'
        self.assertTrue(peer_review_errors(gold, scope, jobs))
        self.assertFalse(peer_review_errors(gold, {}, {}))

    def test_canadian_batch_rejects_foreign_and_unspecified_proceedings(self):
        scope = {'country': 'CA', 'allowed_jurisdictions': ['federal', 'mb']}
        self.assertFalse(geography_errors({'country': 'CA', 'jurisdiction': 'MB'}, scope))
        self.assertTrue(geography_errors({'country': 'US', 'jurisdiction': 'federal'}, scope))
        self.assertTrue(geography_errors({'jurisdiction': 'mb'}, scope))
        self.assertTrue(geography_errors({'country': 'CA', 'jurisdiction': 'us'}, scope))
        self.assertFalse(geography_errors({'jurisdiction': 'us'}, {}))

    def test_new_batch_detects_prior_gold_under_new_ids_and_page_order(self):
        body = 'I, Nell Cormorant, describe a bridge inspection on September 7, 2031.'
        original = {'sha256': 'b' * 64, 'pages': [4, 5], 'cover_pages': [3]}
        texts, originals = prior_keys({'records': [{'record_id': 'invented-bridge',
            'referring_text_sha256': referring_key(body), 'referring_parts': [original]}]})
        self.assertEqual(texts[referring_key(body)], 'invented-bridge')
        self.assertEqual(originals[original_key([dict(original, pages=[5, 3, 4], cover_pages=[])])], 'invented-bridge')
        self.assertNotIn(original_key([dict(original, pages=[6, 7])]), originals)
        self.assertIsNone(original_key([]))

    def test_original_page_identity_survives_absent_legacy_split_pdf(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source = {'source_sha256': 'a' * 64, 'url': 'https://example.org/invented-survey.pdf'}
            split = {'affidavit_pages': [1, 2], 'exhibits': [{'label': 'A', 'file': 'anonymous.pdf', 'source_pages': [4, 5], 'cover_page': 3}]}
            for name, value in [('source', source), ('split', split)]:
                (directory / (name + '.json')).write_text(json.dumps(value), encoding='utf-8')
            keys = legacy_document_keys(directory, ['anonymous.pdf'], ['Full survey notes.'])
            expected = source_identity({'label': 'A', 'source_sha256': 'a' * 64, 'source_pages': [3, 4, 5]})
            self.assertEqual(keys['anonymous.pdf'], expected)

    def test_model_text_contains_evidence_and_preserves_original_pagination(self):
        text = '[page 1]\n[Rotated image text transcription]\nRated load: 21 tonnes.\nPAGE 2 OF 2'
        self.assertEqual(visible_text(text), 'Rated load: 21 tonnes.\nPAGE 2 OF 2')

    def test_distinct_original_scans_remain_distractors_with_empty_text(self):
        rows = [example('invented-east', 'harbour', ''), example('invented-west', 'harbour', '')]
        for i, row in enumerate(rows): row['document_keys'] = {'original.pdf': 'original-source-' + str(i)}
        folder = packets(rows, sibling_limit=1, unrelated_limit=0)[0]
        self.assertEqual(len(folder['files']), 2)
        self.assertEqual([p['role'] for p in folder['candidate_provenance']].count('sibling'), 1)
        self.assertEqual(sum(map(sum, targets(folder))), 1)

    def test_all_reference_paragraphs_and_late_evidence_are_retained(self):
        import refs
        text = '\n'.join(f'{n}. Exhibit A describes inspection {n}. ' + 'Measurements continued. ' * 300 + f'Final correction {n}: {20+n} tonnes.'
                         for n in range(1, 6))
        context = refs.build({'labels': ['A']}, text)['A']['paragraph']
        self.assertGreater(len(context), 30000)
        for n in range(1, 6): self.assertIn(f'Final correction {n}: {20+n} tonnes.', context)

    def test_model_coverage_preserves_missing_source_labels_and_rejects_changed_text(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            gold = {'record_id': 'invented-harbour', 'exhibits': [{'label': 'A'}, {'label': 'B'}]}
            path = directory / 'source-gold.json'
            path.write_text(json.dumps(gold), encoding='utf-8')
            text = directory / 'complete.txt'
            text.write_text('Full inspection report ends with a capacity correction.', encoding='utf-8')
            manifest = {'review_status': 'accepted', 'source_gold_sha256': digest(path), 'views': [
                {'label': 'A', 'file': 'anonymous.pdf', 'eligible': True, 'text_file': 'complete.txt', 'text_sha256': digest(text)},
                {'label': 'B', 'eligible': False, 'reason': 'Sealed attachment; no public file'}]}
            (directory / 'model-views.json').write_text(json.dumps(manifest), encoding='utf-8')
            views, unavailable, _ = association_views(directory, path, gold)
            self.assertEqual([v['label'] for v in views], ['A'])
            self.assertEqual(unavailable[0]['label'], 'B')
            text.write_text('Incomplete report.', encoding='utf-8')
            with self.assertRaises(ValueError): association_views(directory, path, gold)
            self.assertEqual(json.loads(path.read_text()), gold)

    def test_complete_document_storage_is_lossless_and_shared(self):
        text = 'Routine inspection notes. ' * 1500 + 'Final correction: rating 21 tonnes.'
        rows = [example('cedar', 'harbour', text), example('maple', 'quarry', text)]
        documents = freeze_texts(rows)
        self.assertEqual(len(documents), 1)
        restore_texts(rows, documents)
        self.assertTrue(all(r['texts'] == [text] for r in rows))

    def test_chunks_cover_complete_unicode_text_within_actual_token_budget(self):
        text = 'Survey αβ correction measurements. ' * 1000 + 'Final signed finding: 21 tonnes.'
        plan = ChunkPlan(WordTokenizer(), {'Document': 'document: '}, max_length=32, overlap=4)
        parts = plan.parts(text, 'Document')
        self.assertGreater(len(parts), 100)
        self.assertEqual(parts[0]['characters'][0], 0)
        self.assertEqual(parts[-1]['characters'][1], len(text))
        self.assertTrue(all(part['encoded_tokens'] <= 32 for part in parts))
        self.assertTrue(any('Final signed finding: 21 tonnes.' in part['text'] for part in parts))
    def test_final_inventory_cannot_resurrect_withheld_shard_records(self):
        with tempfile.TemporaryDirectory() as temporary:
            expansion = Path(temporary)
            lane = expansion / 'lane'
            record = lane / 'records/cedar'
            record.mkdir(parents=True)
            (record / 'gold.json').write_text('{"record_id":"cedar"}', encoding='utf-8')
            (lane / 'summary.json').write_text(json.dumps({'accepted': ['cedar']}), encoding='utf-8')
            history = lane / 'old-shard'
            history.mkdir()
            (history / 'summary.json').write_text(json.dumps({'accepted': ['birch']}), encoding='utf-8')
            self.assertEqual(list(accepted_gold(expansion)), ['cedar'])

    def test_dotted_letter_labels_keep_their_own_reference_context(self):
        import refs
        labels = ['VV.2', 'VV.3', 'VV.10', 'VV.11']
        text = ('1. The inspection certificates are attached as Exhibits VV.2 through VV.11.\n'
                '2. Exhibit VV.10 is the crane load certificate signed on May 8, 2028.\n'
                '3. Exhibit VV.11 is the later correction dated June 3, 2028.\n')
        contexts = refs.build({'labels': labels}, text)
        self.assertTrue(all(contexts[label]['found'] for label in labels))
        self.assertIn('crane load certificate', contexts['VV.10']['main'])
        self.assertIn('later correction', contexts['VV.11']['main'])

    def test_explicit_exhibit_prefix_in_inventory_keeps_reference_identity(self):
        import refs
        contexts = refs.build({'labels': ['Exhibit 2', 'Exhibit 10']},
                             '1. Exhibit 2 is the inspection log.\n2. Exhibit 10 is the corrected register.\n')
        self.assertTrue(contexts['Exhibit 2']['found'])
        self.assertTrue(contexts['Exhibit 10']['found'])
        self.assertIn('corrected register', contexts['Exhibit 10']['main'])

    def test_new_gold_is_distributed_without_splitting_proceedings(self):
        rows = [example('r%d' % n, 'matter%d' % (n // 2), 'text') for n in range(20)]
        for row in rows: row['new'] = True
        folds = assign_folds(rows)
        self.assertEqual(len(folds), 10)
        self.assertEqual(sorted(folds.values()), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4])

    def test_gold_dates_preserve_precision_and_reject_impossible_dates(self):
        for value in ('', None, '1864', '2024-02', '2024-02-29'): iso(value)
        for value in ('2023-02-29', '2024-13', '2024-04-31'):
            with self.assertRaises(ValueError): iso(value)

    def test_refiling_a_document_does_not_make_new_gold(self):
        body = 'I, Rowan Pike, affirmed that the crane inspection occurred on June 4, 2029.'
        self.assertEqual(referring_key('Filed on 06/10/2029\n' + body),
                         referring_key('Filed 06/12/2029\n' + body))
        self.assertNotEqual(referring_key(body), referring_key(body.replace('June 4', 'June 5')))

    def test_distractors_are_sourced_deduplicated_and_anonymous(self):
        a = example('cedar', 'harbour', ' '.join('inventory%d' % n for n in range(40)))
        a['texts'][0] = '[page 7]\n' + a['texts'][0]
        duplicate = example('birch', 'harbour', a['texts'][0])
        sibling = example('maple', 'harbour', ' '.join('shipment%d' % n for n in range(40)))
        other = example('spruce', 'quarry', ' '.join('invoice%d' % n for n in range(40)))
        r = packets([a, duplicate, sibling, other])[0]
        self.assertEqual(sorted(p['role'] for p in r['candidate_provenance']), ['exhibit', 'other_matter', 'sibling'])
        self.assertTrue(all(f.startswith('item-') for f in r['files']))
        self.assertTrue(all('[page ' not in t for t in r['texts']))
        self.assertEqual(targets(r).sum(), 1)
        self.assertEqual(a['files'], ['original.pdf'])
        self.assertEqual(r, packets([a, duplicate, sibling, other])[0])

    def test_reviewed_counterpart_is_included_without_another_gold_target(self):
        a = example('cedar', 'harbour', ' '.join('inventory%d' % n for n in range(40)))
        a['other_documents'] = [('affidavit.pdf', ' '.join('narration%d' % n for n in range(40))),
                                ('distractors/revised.pdf', ' '.join('revision%d' % n for n in range(40)))]
        r = packets([a])[0]
        self.assertEqual(sorted(p['role'] for p in r['candidate_provenance']), ['exhibit', 'sibling'])
        self.assertEqual(targets(r).sum(), 1)

    def test_other_proceeding_counterpart_is_not_reported_as_sibling(self):
        a = example('cedar', 'harbour', ' '.join('inventory%d' % n for n in range(40)))
        a['other_documents'] = [('distractors/revised.pdf', ' '.join('revision%d' % n for n in range(40)), False)]
        r = packets([a])[0]
        self.assertEqual(sorted(p['role'] for p in r['candidate_provenance']), ['exhibit', 'other_matter'])

    def test_truncated_near_twins_remain_distractors_when_full_documents_differ(self):
        head = ' '.join('inspection%d' % n for n in range(40))
        a, b = example('cedar', 'harbour', head), example('maple', 'harbour', head)
        a['document_keys'] = {'original.pdf': text_key(head + ' Correction: load rating 18 tonnes.')}
        b['document_keys'] = {'original.pdf': text_key(head + ' Correction: load rating 21 tonnes.')}
        r = packets([a, b])[0]
        distractors = [p for p in r['candidate_provenance'] if p['role'] == 'sibling']
        self.assertEqual(len(distractors), 1)
        self.assertTrue(distractors[0]['same_text_view_as_target'])

    def test_rectangular_loss_gradient_and_twin_targets(self):
        scores = np.array([[.3, -.2, .8, -.4], [.1, .4, .2, -.1]])
        truth = np.array([[1., 0., 1., 0.], [0., 1., 0., 0.]])
        loss, gradient = objective(scores, truth)
        numerical = np.zeros_like(scores)
        for index in np.ndindex(scores.shape):
            delta = np.zeros_like(scores); delta[index] = 1e-5
            numerical[index] = (objective(scores + delta, truth)[0] - objective(scores - delta, truth)[0]) / 2e-5
        np.testing.assert_allclose(gradient, numerical, atol=1e-8)
        stronger_distractor = scores.copy(); stronger_distractor[:, -1] += 2
        self.assertGreater(objective(stronger_distractor, truth)[0], loss)

    def test_assignment_counts_sibling_false_positives(self):
        a = example('cedar', 'harbour', ' '.join('inventory%d' % n for n in range(40)))
        b = example('maple', 'harbour', ' '.join('shipment%d' % n for n in range(40)))
        r = packets([a, b])[0]
        scores = np.array([[1. if p['role'] == 'sibling' else 0. for p in r['candidate_provenance']]])
        result = metrics([r], {r['record']: scores})
        self.assertEqual(result['correct'], 0)
        self.assertEqual(result['sibling_picks'], 1)

    def test_single_target_trains_against_sibling_negatives(self):
        from ft_eg2 import sample_record
        a = example('cedar', 'harbour', ' '.join('inventory%d' % n for n in range(40)))
        b = example('maple', 'harbour', ' '.join('shipment%d' % n for n in range(40)))
        queries, documents, truth = sample_record(packets([a, b])[0], random.Random(0), device='cpu')
        self.assertEqual(len(queries), 1)
        self.assertEqual(len(documents), 2)
        self.assertEqual(truth.sum().item(), 1)

    def test_vector_reuse_preserves_query_and_document_prompt_meanings(self):
        import torch
        import ft_eg2
        r = example('cedar', 'harbour', 'inventory')
        def encode(model, texts, prompt):
            values = torch.tensor([[len(t) + 1., 1. if prompt == 'SearchQuery' else 20.] for t in texts])
            return values / values.norm(dim=1, keepdim=True)
        with patch.object(ft_eg2, 'embed', side_effect=encode):
            model = SimpleNamespace(tokenizer=WordTokenizer(), prompts={'SearchQuery': 'query: ', 'Document': 'document: '})
            plan = ChunkPlan(model.tokenizer, model.prompts)
            cache = ft_eg2.cache_vectors(model, [r], 'check', plan)
            first = ft_eg2.features(r, cache)
            repeated = ft_eg2.features(r, cache)
            expected = float((encode(None, ['inventory'], 'SearchQuery') @ encode(None, ['inventory'], 'Document').T)[0, 0])
        np.testing.assert_array_equal(first, repeated)
        self.assertAlmostEqual(first[0, 0, 12], expected)

    def test_late_evidence_contributes_to_full_document_match(self):
        import torch
        import ft_eg2
        text = 'Routine inspection notes. ' * 1000
        r = example('cedar', 'harbour', text + 'Final rating 21 tonnes.')
        r['files'].append('other.pdf'); r['texts'].append(text + 'Final rating 18 tonnes.')
        r['ctx']['A'] = {'seg': ['rating 21 tonnes', 'rating 21 tonnes'], 'item': 'rating 21 tonnes',
                         'main': 'rating 21 tonnes', 'paragraph': 'rating 21 tonnes'}
        model = SimpleNamespace(tokenizer=WordTokenizer(), prompts={'SearchQuery': 'query: ', 'Document': 'document: '})
        def encode(model, texts, prompt):
            return torch.tensor([[1., 0.] if '21' in text else [0., 1.] for text in texts])
        with patch.object(ft_eg2, 'embed', side_effect=encode):
            cache = ft_eg2.cache_vectors(model, [r], 'check', ChunkPlan(model.tokenizer, model.prompts, 64, 8))
        scores = ft_eg2.features(r, cache)
        self.assertGreater(scores[0, 0, 0], scores[0, 1, 0])

    def test_balancing_keeps_new_gold_and_caps_legacy_proceedings(self):
        rows = [example('r%d' % n, 'large' if n < 15 else str(n), 'text') for n in range(30)]
        rows[0]['new'] = True
        selected = balanced(rows, 20)
        self.assertIn(rows[0], selected)
        self.assertLessEqual(sum(r['group'] == 'large' for r in selected), 8)


if __name__ == '__main__':
    unittest.main()
