"""Comparator checks: failures must remain visible and chain levels must not be confused."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest

from compare_versions import below_normal, iter_rows, report
from document_gold import align_reference, origin_matches


class AlignmentChecks(unittest.TestCase):
    def test_ibid_chain_can_name_immediate_reference_or_book(self):
        # Martin notes 2, 10, 11: source-backed identities, not parser-generated expectations.
        part = {'ref_target_footnote_id': '10',
                'ref_target_citation_part_text': 'Martin, Legal Ethics and the Attorney General, supra note 2 at 17-18.',
                'ref_chain_origin_footnote_id': '2',
                'ref_chain_origin_citation_part_text': 'Legal Ethics and the Attorney General: A Canadian Analysis'}
        immediate = {'note': '10', 'evidence': 'supra note 2'}
        self.assertTrue(origin_matches(part, immediate))
        self.assertFalse(origin_matches(part, immediate, root_only=True))
        self.assertFalse(origin_matches(part, {'note': '3', 'evidence': 'Legal Ethics'}))

    def test_repeated_ibid_is_not_arbitrarily_matched(self):
        status, parts = align_reference('Ibid. Ibid.', 'Ibid.', [{'citation_part_text': 'Ibid.'}] * 2)
        self.assertEqual(status, 'source_absent_or_repeated')
        self.assertFalse(parts)

    def test_split_reference_keeps_every_overlapping_part(self):
        note = 'Madu and Madu penalty, supra note 19.'
        parts = [{'citation_part_text': 'Madu'}, {'citation_part_text': 'and Madu penalty, supra note 19.'}]
        status, matches = align_reference(note, note, parts)
        self.assertEqual(status, 'split_reference')
        self.assertEqual(len(matches), 2)
        status, matches = align_reference(note, note, [{'citation_part_text': 'Invented source'}])
        self.assertEqual(status, 'output_not_source_aligned')
        self.assertFalse(matches)

    def test_changed_missing_and_failed_records_are_not_equal(self):
        saved = Path(__file__).with_name('private_comparison') / 'components-01/baseline-aggressive.jsonl'
        if not saved.exists():
            self.skipTest('Private original-code receipt is not distributed')
        original = next(r for r in iter_rows(saved) if r['id'].startswith('split:1e9c8e'))
        changed = copy.deepcopy(original)
        changed['output']['fields'][-1]['short_form'] = 'ller'
        failed = {'id': 'failed', 'kind': 'split', 'status': 'error', 'error': 'native panic'}
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            for mode in ('safe', 'aggressive'):
                for arm, records in [('baseline', [original, failed, {**original, 'id': 'missing'}]),
                                     ('candidate', [changed, failed])]:
                    (out / f'{arm}-{mode}.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in records), encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()):
                report(out)
            result = json.loads((out / 'summary.json').read_text())
            self.assertEqual(result['counts']['safe:split:different'], 1)
            self.assertEqual(result['counts']['safe:split:error_or_missing'], 2)
            self.assertFalse(result['preservation_established'])


if __name__ == '__main__':
    below_normal()
    unittest.main()
