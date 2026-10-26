"""Invented page identities test independent-run boundary extraction."""
import unittest
import tempfile
from pathlib import Path
from PIL import Image
import torch
from train_cpu_split import pairs, image_pixels, CpuBoundaryModel
from validate_cpu_split import stream_pages


class CpuPairTests(unittest.TestCase):
    def test_four_page_context_masks_sequence_edges_without_joining_runs(self):
        def case(pages,targets):
            return dict(sha256='invented-packet',split='train',gold_panel='invented',targets=targets,
                images=[dict(page=p,sha256='image-'+str(p)) for p in pages])
        rows,_=pairs({'cases':[case([1,2,3],{'2':0}),case([9,10,11],{'10':1,'11':0})]},'train',4)
        self.assertEqual([(r['before'],r['left'],r['right'],r['after']) for r in rows],
            [(None,'image-1','image-2','image-3'),(None,'image-9','image-10','image-11'),
             ('image-9','image-10','image-11',None)])

    def test_streaming_uses_one_page_lookahead_and_flushes_last_boundary(self):
        class Recorder:
            context=4
            def __init__(self): self.outputs=[]
            def encode(self,pixels): return pixels[:,0,0,0,None]
            def boundary(self,left,right,before,after,present):
                self.outputs.append((before.item(),left.item(),right.item(),after.item(),present.tolist()[0]))
        with tempfile.TemporaryDirectory() as folder:
            paths=[]
            for value in (30,60,90,120):
                path=Path(folder)/(str(value)+'.png')
                Image.new('RGB',(4,4),(value,0,0)).save(path)
                paths.append(path)
            model=Recorder()
            stream_pages(model,paths,224,'full')
            self.assertEqual(model.outputs,[(0,30,60,90,[0.,1.]),(30,60,90,120,[1.,1.]),
                (60,90,120,0,[1.,0.])])

    def test_tile_detail_preserves_whole_page_spatial_channel_order(self):
        model=CpuBoundaryModel()
        model.features=torch.nn.Identity()
        model.mean.zero_()
        model.std.fill_(1)
        whole=torch.tensor([[[0.,32.],[64.,96.]],[[128.,160.],[192.,224.]],[[4.,8.],[12.,16.]]])
        tiles=[whole[:,y,x,None,None].expand(3,2,2) for y,x in ((0,0),(0,1),(1,0),(1,1))]
        views=torch.stack([whole,*tiles])[None]
        with torch.no_grad():
            actual=model.encode(views)
        torch.testing.assert_close(actual,whole.flatten()[None]/255)

    def test_richer_resolution_preserves_page_top_and_bottom(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'invented-page.png'
            image=Image.new('RGB',(12,24),'red')
            image.paste('blue',(0,12,12,24))
            image.save(path)
            pixels=image_pixels(path,448)
            self.assertEqual(tuple(pixels.shape),(3,448,448))
            self.assertEqual(pixels[:,0,0].tolist(),[255,0,0])
            self.assertEqual(pixels[:,-1,-1].tolist(),[0,0,255])

    def test_known_seams_only_and_no_join_across_omitted_documents(self):
        def case(pages,targets,split='train'):
            return dict(sha256='invented-packet',split=split,gold_panel='invented',targets=targets,
                images=[dict(page=p,sha256='image-'+str(p)) for p in pages])
        dataset={'cases':[case([1,2,3],{'2':0}),case([9,10,11],{'10':1,'11':0}),
            case([20,21],{'21':1},'development')]}
        rows,assets=pairs(dataset,'train')
        self.assertEqual([(r['left'],r['right'],r['label']) for r in rows],
            [('image-1','image-2',0),('image-9','image-10',1),('image-10','image-11',0)])
        self.assertNotIn('image-3',assets)
        self.assertNotIn('image-20',assets)


if __name__=='__main__':
    unittest.main()
