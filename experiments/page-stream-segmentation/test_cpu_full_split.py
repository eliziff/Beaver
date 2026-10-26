"""Independently invented pages/anchors; no private gold fixtures."""
import unittest
import tempfile
from pathlib import Path
from PIL import Image
import torch

from prepare_cpu_full_gold import internal_pages
from train_cpu_full_split import FullSplitModel, line_metrics, selected_candidates,region_pool,cache_visual,evaluate,evaluate_cached
from train_doc_split import digest


class FullSplitTests(unittest.TestCase):
    def test_frozen_cache_matches_direct_decisions_and_trains_new_head(self):
        torch.set_num_threads(1)
        model=FullSplitModel().eval()
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory); assets={}; keys=[]
            for index in range(2):
                path=base/(str(index)+'.png')
                Image.new('RGB',(64,80),(40+index*30,90,160)).save(path)
                key=digest(path); keys.append(key); assets[key]=dict(path=path.name,page=index+1,sha256=key)
            pages=[dict(sha256='invented',page=1,image=assets[keys[0]],candidates=[
                dict(line_id='line-a',bbox=[.1,.2,.8,.25],label=1),dict(line_id='line-b',bbox=[.1,.6,.8,.65],label=0)])]
            edges=[dict(sha256='invented',page=2,left=keys[0],right=keys[1],label=1,panel='invented')]
            cache=cache_visual(model,pages,assets,base,torch.device('cpu'))
            direct=evaluate(model,edges,pages,assets,base,torch.device('cpu'))
            cached=evaluate_cached(model,edges,cache)
            for direct_predictions,cached_predictions in zip(direct[2:],cached[2:]):
                a=direct_predictions['sources'][0]['probabilities']; b=cached_predictions['sources'][0]['probabilities']
                self.assertEqual(a.keys(),b.keys())
                self.assertLess(max(abs(a[k]-b[k]) for k in a),.001)
            model.line_head(cache['line_values'].float()).sum().backward()
            self.assertGreater(model.line_head[-1].weight.grad.abs().sum().item(),0)

    def test_portable_pool_matches_independent_native_cpu_operator(self):
        from torchvision.ops import roi_align
        maps=torch.randn(2,3,17,23)
        boxes=torch.tensor([[0,0.,.1,1.,.4],[1,.2,.5,.8,1.],[0,.3,.2,.5,.6]])
        scale=torch.tensor([1,23,17,23,17])
        expected=roi_align(maps,boxes*scale,(2,8),sampling_ratio=2,aligned=True)
        torch.testing.assert_close(region_pool(maps,boxes,(2,8)),expected,atol=3e-6,rtol=3e-5)
    def test_internal_gold_preserves_exact_anchor_and_known_negatives(self):
        frame={'lines':[dict(id='a',page=1,text='HEADER'),dict(id='b',page=1,text='Memo'),dict(id='c',page=1,text='Body')]}
        part={'document_starts':[dict(line_id='b',page=1,text='Memo')]}
        result=internal_pages(part,frame,{'a':[0,0,1,.1],'b':[0,.2,1,.3],'c':[0,.4,1,.5]},{1})
        self.assertEqual([(c['line_id'],c['label']) for c in result[0]['candidates']],[('b',1),('c',0)])
        with self.assertRaises(ValueError): internal_pages(part,frame,{'c':[0,.4,1,.5]},{1})

    def test_multiple_internal_starts_are_independent_decisions(self):
        candidates=[dict(sha256='invented',page=2,line_id=k,label=v) for k,v in [('a',1),('b',0),('c',1)]]
        result,_=line_metrics(candidates,[.9,.1,.8])
        self.assertEqual(result['known_seams'],3)
        self.assertEqual(result['counts']['true_splits'],2)
        self.assertEqual(result['f1'],1.)

    def test_sampled_training_lines_always_keep_all_positives(self):
        page=dict(sha256='invented',page=1,candidates=[dict(line_id=str(i),label=int(i in (27,49))) for i in range(60)])
        candidates=selected_candidates([page],True)
        self.assertEqual(len(candidates),26)
        self.assertEqual(sum(c['label'] for c in candidates),2)

    def test_shared_encoder_and_line_head_have_real_gradients(self):
        torch.set_num_threads(1)
        model=FullSplitModel().eval()
        pixels=torch.randint(0,256,(2,5,3,224,224),dtype=torch.uint8).float()
        visual=model.visual(pixels)
        torch.testing.assert_close(visual[0],model.encode(pixels))
        candidates=[dict(batch=0,bbox=[.1,.3,.9,.32]),dict(batch=1,bbox=[.2,.7,.8,.73])]
        logits=model.lines(visual,candidates)
        self.assertEqual(tuple(logits.shape),(2,))
        logits.sum().backward()
        self.assertGreater(model.features[0][0].weight.grad.abs().sum().item(),0)
        self.assertGreater(model.line_head[-1].weight.grad.abs().sum().item(),0)


if __name__=='__main__': unittest.main()
