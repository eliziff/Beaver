"""Small trainable lexical branch added to the CPU visual splitter."""
import torch
from torch import nn

from raw_ocr_split import edge_windows,line_windows,hashed_features,raw_candidates
from train_cpu_full_split import FullSplitModel


class RawTextTower(nn.Module):
    def __init__(self,buckets=32768,width=32):
        super().__init__(); self.buckets=buckets; self.width=width
        self.embedding=nn.EmbeddingBag(buckets,width,mode='sum',include_last_offset=True)
        self.norm=nn.LayerNorm(width)
        nn.init.normal_(self.embedding.weight,std=.02)

    def forward(self,groups):
        device=self.embedding.weight.device; ids=[]; weights=[]; offsets=[0]; stats=[]; present=[]; cache={}
        for group in groups:
            for text in group:
                if text not in cache: cache[text]=hashed_features(text,self.buckets)
                keys,values,extra=cache[text]
                ids.extend(keys); weights.extend(values); offsets.append(len(ids)); stats.append(extra); present.append(bool(text.strip()))
        encoded=self.embedding(torch.tensor(ids,device=device,dtype=torch.long),
            torch.tensor(offsets,device=device,dtype=torch.long),per_sample_weights=torch.tensor(weights,device=device,dtype=torch.float32))
        vectors=torch.cat((self.norm(encoded),torch.tensor(stats,device=device,dtype=torch.float32)),1)
        masks=torch.tensor(present,device=device,dtype=torch.float32).reshape(len(groups),-1)
        return torch.cat((vectors.reshape(len(groups),-1),masks),1),masks.any(1).float()


class VisualTextSplitModel(FullSplitModel):
    new_parameter_prefixes=('line_head.','text_tower.','edge_text_head.','line_text_head.')

    def __init__(self,raw_pages=None):
        super().__init__(); self.raw_pages={} if raw_pages is None else raw_pages; self.text_tower=RawTextTower()
        window_width=self.text_tower.width+7
        def head(windows):
            return nn.Sequential(nn.LayerNorm(window_width*windows),nn.Linear(window_width*windows,64),
                nn.ReLU(),nn.Dropout(.1),nn.Linear(64,1))
        self.edge_text_head=head(4); self.line_text_head=head(3)

    def classify(self,vectors,indices,rows=None,raw_pages=None):
        if rows is None: raise ValueError('Visual/text inference requires raw page context')
        bank=self.raw_pages if raw_pages is None else raw_pages
        groups=[edge_windows(bank[r['sha256'],r['page']-1],bank[r['sha256'],r['page']]) for r in rows]
        text,present=self.text_tower(groups)
        return super().classify(vectors,indices,rows)+self.edge_text_head(text).flatten()*present

    def classify_lines(self,features,candidates,raw_pages=None):
        bank=self.raw_pages if raw_pages is None else raw_pages
        groups=[line_windows(bank[c['sha256'],c['page']],c['line_id']) for c in candidates]
        if not groups: return features.new_empty((0,))
        text,present=self.text_tower(groups)
        return super().classify_lines(features,candidates)+self.line_text_head(text).flatten()*present

    @torch.inference_mode()
    def predict_raw_page(self,pixels,page):
        """Deployment path: proposals and text come entirely from recognition."""
        visual=self.visual(pixels)
        candidates=[{**c,'batch':0,'sha256':page['source_sha256'],'page':page['page']} for c in raw_candidates(page)]
        if not candidates: return []
        logits=self.classify_lines(self.line_features(visual,candidates),candidates,{(page['source_sha256'],page['page']):page})
        return [{**c,'probability':float(p)} for c,p in zip(candidates,logits.sigmoid().detach().cpu())]

    @torch.inference_mode()
    def predict_raw_edge(self,pixels,left,right):
        edge_windows(left,right)
        bank={(p['source_sha256'],p['page']):p for p in (left,right)}
        rows=[dict(sha256=right['source_sha256'],page=right['page'])]
        indices=torch.tensor([[0,1]],device=pixels.device)
        return float(self.classify(self.encode(pixels),indices,rows,bank).sigmoid()[0])

    def forward(self,pixels,indices,rows):
        return self.classify(self.encode(pixels),indices,rows)
