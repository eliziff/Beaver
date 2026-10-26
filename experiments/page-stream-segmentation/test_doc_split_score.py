"""Invented sparse review scope: omitted pages never become negative targets."""
import unittest

from score_doc_split import score


class TeacherScoreTests(unittest.TestCase):
    def test_sparse_targets_and_both_error_types(self):
        dataset = {'cases': [{'sha256': 'invented-packet', 'split': 'development',
                             'targets': {'12': 1, '13': 0, '42': 1, '43': 0}}]}
        predictions = {'sources': [{'sha256': 'invented-packet',
            'probabilities': {'12': .9, '13': .8, '42': .2, '43': .1}}]}
        result = score(dataset,predictions,'development')
        self.assertEqual(result['known_seams'],4)
        self.assertEqual(result['f1'],.5)
        self.assertEqual(result['counts']['false_splits'],1)
        self.assertEqual(result['counts']['missed_splits'],1)
        self.assertAlmostEqual(result['precision_recall_curve']['average_precision'],5/6)
        self.assertEqual(result['precision_recall_curve']['best_f1_on_this_split']['f1'],.8)
        del predictions['sources'][0]['probabilities']['42']
        self.assertEqual(score(dataset,predictions,'development')['coverage'],.75)


if __name__ == '__main__':
    unittest.main()
