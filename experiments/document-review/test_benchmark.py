"""Invented scoring outcomes; no real court data or model calls."""
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import benchmark as b
from review_models import reconcile, source_anchors


def entry(identity, relevance='relevant', privilege='none', family=None):
    return dict(document_id=identity, relevance=relevance, privilege=privilege,
        date=None, title='Review document', description='A document about an invented dispute.',
        reason='It concerns the disputed delivery.', evidence=['Delivery'], family_id=family or identity,origin='synthetic')


class ReviewScoring(unittest.TestCase):
    def test_level_two_requires_a_different_filing_in_the_same_case(self):
        item={'id':'sample','seed':'filing-a'}
        filing=[{'record':'filing-a','group':'case','text_key':str(i)} for i in range(30)]
        with self.assertRaisesRegex(ValueError,'sibling'):
            b.choose(item,filing)
        other=[{'record':'filing-b','group':'case','text_key':'other'}]
        primary,second=b.choose(item,filing+other)
        self.assertEqual(len(primary),16)
        self.assertEqual(second,other)

    def test_invented_variants_cannot_inherit_genuine_source_dates(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(b,'PRIVATE',Path(temporary)):
            b.dump(b.PRIVATE/'intake.json',{'documents':[{'record':'r','text_key':'family',
                'source_gold':{'date':'2020-01-01'},'source_gold_sha256':'sha'}]})
            rows=[dict(entry('real',family='family'),origin='real',provenance={'record':'r'}),
                  dict(entry('variant',family='family'),origin='synthetic',provenance={'record':'r'})]
            anchors=source_anchors({'documents':rows})
            self.assertEqual(set(anchors),{'real'})

    def test_reviewed_mask_covers_the_folio_word_and_preserves_adjacent_date(self):
        pages=[{'lines':[{'words':[{'text':'2020-12-23','bbox':[20,5,100,22]},
                                   {'text':'374','bbox':[580,5,604,22]}]}]}]
        applied=b.reviewed_word_masks(pages,{0:[[590,8,591,9]]})[0]
        self.assertIn([579,4,605,23],applied)
        self.assertTrue(all(rect[0]>500 for rect in applied))

    def setUp(self):
        self.gold = {'status': 'accepted', 'documents': [entry('a'), entry('b', 'irrelevant'),
            entry('c', privilege='withhold'), entry('d', privilege='redact')]}

    def test_perfect_and_missing(self):
        self.assertEqual(b.score(self.gold, self.gold['documents'])['designation_score'], 100)
        result = b.score(self.gold, [])
        self.assertEqual(result['designation_score'], 0)
        self.assertEqual(result['missing_documents'], 4)
        self.assertEqual(result['missing_privilege_decisions'], 2)

    def test_all_irrelevant_does_not_hide_failures(self):
        preds = [dict(r, relevance='irrelevant', privilege='none') for r in self.gold['documents']]
        result = b.score(self.gold, preds)
        self.assertEqual(result['relevance']['recall'], 0)
        self.assertEqual(result['privilege_release_errors'], 2)
        self.assertLess(result['designation_score'], 40)

    def test_uncertain_privilege_does_not_erase_a_clear_relevance_error(self):
        self.gold['documents'].append(entry('e', privilege='uncertain'))
        preds = deepcopy(self.gold['documents'])
        preds[-1]['relevance'] = 'irrelevant'
        result = b.score(self.gold, preds)
        self.assertEqual(result['relevance_adjudicated'], 5)
        self.assertEqual(result['privilege_adjudicated'], 4)
        self.assertEqual(result['relevance']['recall'], .75)
        self.assertLess(result['designation_score'], 100)

    def test_protected_recall_distinguishes_retention_from_correct_designation(self):
        preds = [dict(r, privilege='withhold') if r['privilege']=='redact' else r for r in self.gold['documents']]
        result = b.score(self.gold, preds)
        self.assertEqual(result['privilege']['recall'], 1)
        self.assertEqual(result['privilege_release_errors'], 0)
        self.assertLess(result['designation_score'], 100)

    def test_exact_copies_cannot_inflate_family_accuracy(self):
        base = {'status': 'accepted', 'documents': [entry('a'), entry('b')]}
        wrong = [entry('a'), entry('b', 'irrelevant')]
        reference = b.score(base, wrong)['family_balanced_joint_accuracy']
        for i in range(20):
            base['documents'].append(entry(str(i), family='a'))
            wrong.append(entry(str(i), family='a'))
        result = b.score(base, wrong)
        self.assertEqual(result['family_balanced_joint_accuracy'], reference)
        self.assertGreater(result['joint_accuracy'], reference)

    def test_foreign_and_repeated_ids_are_invalid(self):
        for preds in ([entry('foreign')], [entry('a'), entry('a')]):
            with self.assertRaises(ValueError):
                b.score(self.gold, preds)

    def test_level_scoring_excludes_higher_level_files(self):
        gold=dict(self.gold,documents=[dict(row,level=i+1) for i,row in enumerate(self.gold['documents'][:3])])
        selected=b.level_gold(gold,1)
        self.assertEqual(b.score(selected,[gold['documents'][0]])['designation_score'],100)
        with self.assertRaisesRegex(ValueError,'unknown prediction'):
            b.score(selected,gold['documents'])

    def test_missing_matters_prevent_a_partial_suite_average(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(b,'PRIVATE',Path(temporary)), patch.object(b,'spec',return_value=[{'id':'one'},{'id':'two'}]):
            folder=b.PRIVATE/'sets/one'
            b.dump(folder/'inventory.json',{'documents':[]})
            rows=[dict(entry('a'),level=1)]
            gold={'status':'accepted','inventory_sha256':b.digest(folder/'inventory.json'),'documents':rows}
            b.dump(folder/'gold.json',gold)
            for level in (1,2,3):
                b.dump(folder/f'candidate-level-{level}.json',{'inventory_sha256':gold['inventory_sha256'],'documents':rows})
            result=b.report()
            self.assertEqual(result['aggregate'][0]['scored_sets'],1)
            self.assertIsNone(result['aggregate'][0]['designation_score'])

    def test_unreviewed_gold_is_not_a_benchmark_result(self):
        with self.assertRaisesRegex(ValueError, 'independent review'):
            b.score(dict(self.gold, status='pending'), [])

    def test_agreeing_ocr_dates_do_not_override_independent_source_evidence(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(b,'PRIVATE',Path(temporary)):
            folder=b.PRIVATE/'sets/sample'
            row=dict(entry('a'),level=1,date='2019-06',provenance={'record':'reviewed-record'},origin='real')
            inventory={'documents':[row]}
            b.dump(folder/'inventory.json',inventory)
            b.dump(b.PRIVATE/'intake.json',{'documents':[
                {'record':'reviewed-record','text_key':'a','source_gold':{'date':'2019-06-07'},'source_gold_sha256':'reviewed-source'},
                {'record':'other-record','text_key':'a','source_gold':{'date':'2001-01-01'},'source_gold_sha256':'other-source'}]})
            for seat in ('author','reviewer'):
                b.dump(folder/(seat+'.json'),{'inventory_sha256':b.digest(folder/'inventory.json'),'documents':[row]})
            self.assertEqual(reconcile({'id':'sample'})['disagreements'],1)
            self.assertEqual(b.read(folder/'gold.json')['status'],'pending_adjudication')
            self.assertEqual(b.read(folder/'disagreements.json')[0]['source_identification']['date'],'2019-06-07')
            b.dump(folder/'adjudications.json',{'inventory_sha256':b.digest(folder/'inventory.json'),
                'decisions':[{'document_id':'a','fields':{'date':'2019-06-07'},'basis':'Invented test page confirms the day.'}]})
            self.assertEqual(reconcile({'id':'sample'})['disagreements'],0)
            self.assertEqual(b.read(folder/'gold.json')['documents'][0]['date'],'2019-06-07')

    def test_quality_accepts_paraphrases_but_caps_wrong_reasoning(self):
        preds = deepcopy(self.gold['documents'])
        preds[0].update(title='Delivery record', description='A delivery record.', privilege='withhold')
        judgments = [dict(document_id=r['document_id'], date=2, title=2, description=2, explanation=2) for r in preds]
        self.assertEqual(b.quality_score(self.gold, preds, judgments), 96.875)
        with self.assertRaisesRegex(ValueError, 'Missing quality'):
            b.quality_score(self.gold, preds, judgments[:-1])

    def test_bundle_dates_accept_supported_components_and_reject_invented_dates(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(b,'PRIVATE',Path(temporary)):
            folder=b.PRIVATE/'sets/sample'
            first=dict(entry('a'),level=3,date='2019-07-31',provenance={})
            second=dict(entry('b'),level=3,date='2019-08-12',provenance={})
            bundle=dict(entry('c'),level=3,date='2019-07-31',provenance={},components=[{'document_id':'a'},{'document_id':'b'}])
            b.dump(folder/'inventory.json',{'documents':[first,second,bundle]})
            b.dump(b.PRIVATE/'intake.json',{'documents':[]})
            for seat,date in (('author','2019-08-12'),('reviewer','2019-07-31')):
                b.dump(folder/(seat+'.json'),{'inventory_sha256':b.digest(folder/'inventory.json'),
                    'documents':[first,second,dict(bundle,date=date)]})
            self.assertEqual(reconcile({'id':'sample'})['disagreements'],0)
            self.assertEqual(b.read(folder/'gold.json')['documents'][-1]['accepted_dates'],['2019-07-31','2019-08-12'])
            for seat in ('author','reviewer'):
                b.dump(folder/(seat+'.json'),{'inventory_sha256':b.digest(folder/'inventory.json'),
                    'documents':[first,second,dict(bundle,date='2019-08-13')]})
            self.assertEqual(reconcile({'id':'sample'})['disagreements'],1)

    def test_date_boundary(self):
        for date in ('2026-02-30', '2026-13', 'yesterday'):
            with self.assertRaises(ValueError):
                b.validate_entry(dict(entry('a'), date=date))
        for date in ('2026', '2026-11', '2026-11-08', None):
            b.validate_entry(dict(entry('a'), date=date))

    def test_evidence_can_include_a_page_locator(self):
        text = 'The remaining balance is $120,000.'
        self.assertTrue(b.evidence_matches(text, ['Letter, page 2: "The remaining balance is $120,000."']))
        self.assertFalse(b.evidence_matches(text, ['Letter, page 2: "The remaining balance is $12,000."']))
        self.assertTrue(b.evidence_matches('garbled OCR',['Page 1: the letter is dated June 7, 2019.'],page_count=2))
        self.assertFalse(b.evidence_matches('garbled OCR',['Page 3: the letter is dated June 7, 2019.'],page_count=2))


if __name__ == '__main__':
    unittest.main()
