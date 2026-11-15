import unittest

from blindbox import family_keys, metrics, stratified_sample


class OriginMetrics(unittest.TestCase):
    def test_small_cases_are_represented_before_sampling_more_from_a_large_case(self):
        rows=[{'set':'large','id':str(i)} for i in range(30)]+[{'set':'small','id':'only'}]
        selected=stratified_sample(rows,2,'seed')
        self.assertEqual({r['set'] for r in selected},{'large','small'})

    def test_changed_render_and_embedded_copy_remain_in_the_source_family(self):
        first={'family_id':'first','set':'matter','version_group':'account'}
        changed={'family_id':'changed-bytes','set':'matter','version_group':'account'}
        bundled={'family_id':'bundle','set':'matter','components':[{'family_id':'first'}]}
        self.assertTrue(family_keys(first)&family_keys(changed))
        self.assertTrue(family_keys(first)&family_keys(bundled))
        old={'family_id':'old-print','set':'matter','origin':'synthetic'}
        reprinted={'family_id':'new-print','set':'matter','origin':'synthetic'}
        self.assertTrue(family_keys(old)&family_keys(reprinted))

    def setUp(self):
        self.truth=[{'document_id':str(i),'synthetic':i>=2} for i in range(4)]

    def predictions(self, values):
        return [{'document_id':str(i),'synthetic_probability':p,'reason':'clue'} for i,p in enumerate(values)]

    def test_uninformative_probabilities_have_chance_rank_and_brier(self):
        value=metrics(self.predictions([.5]*4),self.truth)
        self.assertEqual((value['accuracy'],value['roc_auc'],value['brier']),(.5,.5,.25))

    def test_perfect_and_inverted_discrimination_remain_visible(self):
        correct=metrics(self.predictions([0,0,1,1]),self.truth)
        inverted=metrics(self.predictions([1,1,0,0]),self.truth)
        self.assertEqual((correct['accuracy'],correct['roc_auc'],correct['brier']),(1,1,0))
        self.assertEqual((inverted['accuracy'],inverted['roc_auc']),(0,0))

    def test_missing_duplicate_and_out_of_range_predictions_fail(self):
        for rows in (self.predictions([0,1]),self.predictions([0,0,1,1])+self.predictions([0]),self.predictions([-.1,0,1,1])):
            with self.assertRaises(ValueError):
                metrics(rows,self.truth)

    def test_full_set_reports_class_balance_without_naive_copy_intervals(self):
        truth=[{'document_id':str(i),'synthetic':i==3} for i in range(4)]
        result=metrics(self.predictions([0]*4),truth,independent=False)
        self.assertEqual(result['accuracy'],.75)
        self.assertEqual(result['balanced_accuracy'],.5)
        self.assertEqual(result['majority_class_accuracy'],.75)
        self.assertIsNone(result['accuracy_wilson_95'])


if __name__=='__main__':
    unittest.main()
