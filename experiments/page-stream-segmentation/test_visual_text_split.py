"""Invented OCR examples and synthetic pixels; no private document content."""
import unittest
from collections import Counter

import torch

from raw_ocr_split import normalize_extraction,raw_candidates,align_labels,hashed_features,edge_windows
from train_cpu_full_split import FullSplitModel,line_metrics,family_class_weights
from visual_text_split import VisualTextSplitModel


SHA='a'*64


def raw(text='N0T1CE',empty=False):
    return dict(source_sha256=SHA,pages=[dict(index=0,width=100,height=100,lines=[] if empty else [
        dict(id='r1',text=text,corrected='Notice of a different result',bbox=[10,20,90,25]),
        dict(id='r2',text='OCR m1stakes stay',bbox=[10,40,90,45])])])


class TextSplitTests(unittest.TestCase):
    def test_repeated_packet_does_not_dominate_family_balanced_loss(self):
        counts=Counter({('repeated',1):28,('single',1):1,('repeated',0):31,('single',0):4})
        weights=family_class_weights(counts)
        self.assertAlmostEqual(weights['repeated',1]*28,weights['single',1])
        self.assertAlmostEqual(sum(weights[k]*n for k,n in counts.items() if k[1]==0),
            sum(weights[k]*n for k,n in counts.items() if k[1]==1))

    def test_raw_errors_and_segmentation_survive_and_gold_is_rejected(self):
        page=normalize_extraction(raw(),SHA)[1]
        self.assertEqual(page['lines'][0]['text'],'N0T1CE')
        self.assertEqual([c['line_id'] for c in raw_candidates(page)],['r1','r2'])
        with self.assertRaises(ValueError): normalize_extraction(dict(typed=[],units=[],pages=[]),SHA)
        with self.assertRaises(ValueError): normalize_extraction(raw(),'b'*64)
        self.assertNotEqual(hashed_features('N0T1CE')[0],hashed_features('NOTICE')[0])

    def test_missing_ocr_boundary_is_not_inserted_or_hidden_in_metrics(self):
        page=normalize_extraction(raw(),SHA)[1]
        labels=align_labels(page,[dict(line_id='gold-missing',bbox=[.1,.7,.9,.75])])
        self.assertEqual(len(labels['unmatched_gold']),1)
        self.assertEqual(len(labels['candidates']),2)
        self.assertEqual(sum(c['label'] for c in labels['candidates']),0)
        candidates=[{**c,'sha256':SHA,'page':1} for c in labels['candidates']]
        result,_=line_metrics(candidates,[.1,.2],labels['unmatched_gold'])
        self.assertEqual(result['counts']['missed_splits'],1)
        self.assertEqual(result['precision_recall_curve']['best_f1_on_this_split']['f1'],0)

    def test_ocr_changed_ids_can_align_by_location_without_gold_text(self):
        page=normalize_extraction(raw(),SHA)[1]
        labels=align_labels(page,[dict(line_id='different-id',bbox=[.1,.205,.9,.255])])
        self.assertEqual(labels['candidates'][0]['line_id'],'r1')
        self.assertEqual(labels['candidates'][0]['gold_line_id'],'different-id')
        self.assertEqual(sum(c['label'] for c in labels['candidates']),1)
        self.assertEqual(labels['candidates'][0]['bbox'],[.1,.2,.9,.25])

    def test_empty_ocr_falls_back_to_visual_and_inference_needs_no_gold(self):
        torch.set_num_threads(1); model=VisualTextSplitModel({}).eval()
        page=normalize_extraction(raw(empty=True),SHA)[1]
        right={**page,'page':2}; model.raw_pages={(SHA,1):page,(SHA,2):right}
        vectors=torch.randn(2,2304); indices=torch.tensor([[0,1]])
        expected=FullSplitModel.classify(model,vectors,indices)
        actual=model.classify(vectors,indices,[dict(sha256=SHA,page=2)])
        torch.testing.assert_close(actual,expected,rtol=0,atol=0)
        page=normalize_extraction(raw(),SHA)[1]
        before=set(model.raw_pages)
        predicted=model.predict_raw_page(torch.zeros(1,5,3,224,224),page)
        self.assertEqual(len(predicted),2)
        self.assertTrue(all('label' not in p and 'gold_line_id' not in p for p in predicted))
        self.assertEqual(set(model.raw_pages),before)

    def test_text_and_visual_heads_receive_gradients_and_context_cannot_jump(self):
        torch.set_num_threads(1); page=normalize_extraction(raw(),SHA)[1]
        right={**page,'page':2}; model=VisualTextSplitModel({(SHA,1):page,(SHA,2):right})
        score=model.classify(torch.randn(2,2304),torch.tensor([[0,1]]),[dict(sha256=SHA,page=2)])
        line=model.classify_lines(torch.randn(1,3976),[dict(sha256=SHA,page=1,line_id='r1')])
        (score.sum()+line.sum()).backward()
        self.assertGreater(model.text_tower.embedding.weight.grad.abs().sum().item(),0)
        self.assertGreater(model.head[0].weight.grad.abs().sum().item(),0)
        self.assertGreater(model.line_head[1].weight.grad.abs().sum().item(),0)
        with self.assertRaises(ValueError): edge_windows(page,{**right,'page':3})


if __name__=='__main__': unittest.main()
