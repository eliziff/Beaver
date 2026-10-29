"""Joint page-edge and exact line-anchor visual splitter; desktop GPU training.

Both heads share the compact MobileNet encoder. Line ROIs reuse quadrant feature
maps rather than running a CNN once per candidate. Only reviewed lines are used.
"""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import random
import statistics
import time

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

from train_cpu_split import CpuBoundaryModel, image_pixels, pairs, indices_for, metric, rank
from train_doc_split import digest, write


def region_pool(maps,boxes,size):
    """Aligned ROI sampling with two samples per bin, using portable PyTorch ops."""
    height,width=size
    result=maps.new_zeros((len(boxes),maps.shape[1],height,width))
    fractions_x=(torch.arange(width*2,device=maps.device,dtype=maps.dtype)+.5)/(width*2)
    fractions_y=(torch.arange(height*2,device=maps.device,dtype=maps.dtype)+.5)/(height*2)
    for batch in boxes[:,0].long().unique():
        own=(boxes[:,0].long()==batch).nonzero().flatten()
        selected=boxes[own]
        x=selected[:,1,None]+fractions_x*(selected[:,3]-selected[:,1])[:,None]
        y=selected[:,2,None]+fractions_y*(selected[:,4]-selected[:,2])[:,None]
        grid=torch.stack((x[:,None,:].expand(-1,height*2,-1),y[:,:,None].expand(-1,-1,width*2)),dim=-1)*2-1
        values=F.grid_sample(maps[batch:batch+1],grid.reshape(1,-1,width*2,2),
            mode='bilinear',padding_mode='border',align_corners=False)
        values=values.reshape(maps.shape[1],len(own),height,2,width,2).mean(dim=(3,5)).permute(1,0,2,3)
        result=result.index_copy(0,own,values)
    return result


class FullSplitModel(CpuBoundaryModel):
    new_parameter_prefixes=('line_head.',)
    def __init__(self):
        super().__init__(context=2)
        self.line_head=nn.Sequential(nn.LayerNorm(3976),nn.Linear(3976,64),
            nn.ReLU(),nn.Dropout(.2),nn.Linear(64,1))

    def visual(self,pixels):
        batch,views,channels,height,width=pixels.shape
        value=(pixels.reshape(batch*views,channels,height,width)/255-self.mean)/self.std
        early=None
        for index,layer in enumerate(self.features):
            value=layer(value)
            if index==1: early=value.reshape(batch,views,*value.shape[1:])
        maps=value.reshape(batch,views,*value.shape[1:])
        whole=self.pool(maps[:,0]).flatten(1)
        tiles=F.adaptive_avg_pool2d(maps[:,1:].flatten(0,1),(1,1)).flatten(1)
        tiles=tiles.reshape(batch,4,maps.shape[2]).transpose(1,2).flatten(1)
        def stitch(values):
            return torch.cat((torch.cat((values[:,1],values[:,2]),dim=3),
                torch.cat((values[:,3],values[:,4]),dim=3)),dim=2)
        return (whole+tiles)*.5,stitch(early),stitch(maps)

    def line_features(self,visual,candidates):
        embedding,early,deep=visual
        # Candidate boxes are normalized to the physical source page.
        # Adjacent strips expose heading/whitespace changes above and below it.
        boxes=torch.tensor([c['bbox'] for c in candidates],device=embedding.device)
        ids=torch.tensor([c['batch'] for c in candidates],device=embedding.device)
        x0,y0,x1,y1=boxes.unbind(1)
        geometry=torch.stack((x0,y0,x1,y1,x1-x0,y1-y0,(x0+x1)/2,(y0+y1)/2),1)
        strips=[]
        for start,end in (((y0-.08).clamp(min=0),y0),(y0,(y0+.08).clamp(max=1))):
            strips.append(torch.stack((ids,torch.zeros_like(y0),start,torch.ones_like(y0),end),1))
        values=[]
        for maps,size in ((early,(2,8)),(deep,(1,1))):
            for strip in strips:
                values.append(region_pool(maps,strip,size).flatten(1))
        return torch.cat([*values,embedding[ids],geometry],1)

    def lines(self,visual,candidates):
        return self.classify_lines(self.line_features(visual,candidates),candidates)

    def classify_lines(self,features,candidates):
        return self.line_head(features).squeeze(1)

    def classify(self,vectors,indices,rows=None):
        return super().classify(vectors,indices)


def selected_candidates(pages,training=False):
    result=[]
    for batch,page in enumerate(pages):
        candidates=page['candidates']
        if training:
            positive=[c for c in candidates if c['label']]
            negative=[c for c in candidates if not c['label']]
            candidates=positive+random.sample(negative,min(24,len(negative)))
        result.extend({**c,'batch':batch,'sha256':page['sha256'],'page':page['page'],
            'family_id':page.get('family_id',page['sha256'])} for c in candidates)
    return result


def line_metrics(candidates,probabilities,unmatched=()):
    rows=[dict(sha256=c['sha256'],page=str(c['page'])+':'+c['line_id'],label=c['label'],
        panel='exact-internal-line-anchor',line_id=c['line_id']) for c in candidates]
    # metric operates on decisions; line_id is retained separately in predictions.
    result,predictions=metric(rows,probabilities,'development')
    if unmatched:
        from score_doc_split import curve
        missed=len(unmatched); counts=result['counts']; counts['missed_splits']=counts.get('missed_splits',0)+missed
        tp,fp,fn=counts.get('true_splits',0),counts.get('false_splits',0),counts['missed_splits']
        result.update(known_seams=result['known_seams']+missed,unreachable_gold_starts=missed,
            recall=tp/(tp+fn),f1=2*tp/(2*tp+fp+fn),
            precision_recall_curve=curve(dict(enumerate(c['label'] for c in candidates)),dict(enumerate(probabilities)),missed))
        result['coverage']=result['scored_seams']/result['known_seams']
    result['limitations']='Exact source/page/line-ID decisions on reviewed pages; threshold selected on development.'
    return result,predictions


def evaluate(model,edges,line_pages,assets,base,device):
    model.eval(); keys=sorted(assets); lookup={key:i for i,key in enumerate(keys)}
    vectors=torch.zeros((len(keys),2304),device=device)
    line_by_image={}
    for page in line_pages: line_by_image.setdefault(page['image']['sha256'],[]).append(page)
    candidates=[]; probabilities=[]
    with torch.inference_mode():
        for start in range(0,len(keys),12):
            own=keys[start:start+12]
            pixels=torch.stack([image_pixels(base/assets[key]['path'],224,'quadrants') for key in own]).to(device,dtype=torch.float32)
            visual=model.visual(pixels); vectors[start:start+len(own)]=visual[0]
            selected=[]
            for batch,key in enumerate(own):
                for page in line_by_image.get(key,[]):
                    selected.extend({**c,'batch':batch,'sha256':page['sha256'],
                        'page':page['page']} for c in page['candidates'])
            if selected:
                probabilities.extend(model.lines(visual,selected).sigmoid().cpu().tolist())
                candidates.extend(selected)
        edge_prob=[]
        for start in range(0,len(edges),128):
            rows=edges[start:start+128]
            edge_prob.extend(model.classify(vectors,torch.tensor(indices_for(rows,lookup,2),device=device),rows).sigmoid().cpu().tolist())
    edge_result,edge_predictions=metric(edges,edge_prob,'development')
    line_result,line_predictions=line_metrics(candidates,probabilities,[a for p in line_pages for a in p.get('unmatched_gold',[])])
    return edge_result,line_result,edge_predictions,line_predictions


def cache_visual(model,line_pages,assets,base,device):
    """Frozen-stage features stay in GPU memory; no duplicate image/model cache."""
    model.eval(); keys=sorted(assets); lookup={k:i for i,k in enumerate(keys)}
    vectors=torch.empty((len(keys),2304),device=device)
    line_values=torch.empty((sum(len(p['candidates']) for p in line_pages),3976),device=device,dtype=torch.float16)
    by_image={}
    for page in line_pages: by_image.setdefault(page['image']['sha256'],[]).append(page)
    candidates=[]; offset=0
    with torch.inference_mode():
        for start in range(0,len(keys),12):
            own=keys[start:start+12]
            pixels=torch.stack([image_pixels(base/assets[key]['path'],224,'quadrants') for key in own]).to(device,dtype=torch.float32)
            visual=model.visual(pixels); vectors[start:start+len(own)]=visual[0]
            selected=[]
            for batch,key in enumerate(own):
                for page in by_image.get(key,[]):
                    selected.extend({**c,'batch':batch,'sha256':page['sha256'],'page':page['page']} for c in page['candidates'])
            if selected:
                values=model.line_features(visual,selected)
                line_values[offset:offset+len(selected)]=values.half(); offset+=len(selected); candidates.extend(selected)
    assert offset==len(line_values)
    line_lookup={(c['sha256'],c['page'],c['line_id']):i for i,c in enumerate(candidates)}
    assert len(line_lookup)==len(candidates)
    return dict(vectors=vectors,lookup=lookup,line_values=line_values,candidates=candidates,line_lookup=line_lookup,
        unmatched=[a for p in line_pages for a in p.get('unmatched_gold',[])])


def evaluate_cached(model,edges,cache):
    model.eval(); edge_prob=[]; line_prob=[]; device=cache['vectors'].device
    with torch.inference_mode():
        for start in range(0,len(edges),256):
            rows=edges[start:start+256]
            indices=torch.tensor(indices_for(rows,cache['lookup'],2),device=device)
            edge_prob.extend(model.classify(cache['vectors'],indices,rows).sigmoid().cpu().tolist())
        for start in range(0,len(cache['line_values']),1024):
            line_prob.extend(model.classify_lines(cache['line_values'][start:start+1024].float(),cache['candidates'][start:start+1024]).sigmoid().cpu().tolist())
    edge_result,edge_predictions=metric(edges,edge_prob,'development')
    line_result,line_predictions=line_metrics(cache['candidates'],line_prob,cache['unmatched'])
    return edge_result,line_result,edge_predictions,line_predictions


def family_class_weights(counts):
    """Equal total loss mass per class, then per family within that class."""
    families=Counter(label for family,label in counts if counts[family,label])
    if set(families)!={0,1}: raise ValueError('Family-balanced fitting requires both target classes')
    total=sum(counts.values())
    return {key:total/(2*families[key[1]]*count) for key,count in counts.items() if count}


def train(root,epochs,model_factory=FullSplitModel,output_name='full-page-and-line',internal_path=None,initial_checkpoint=None,family_balanced=False):
    seed=7319; random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False; torch.backends.cudnn.allow_tf32=False
    assert torch.cuda.is_available(), 'Desktop GPU is required for fitting'
    device=torch.device('cuda'); base=root/'teacher-data'; out=root/'cpu-model'/output_name
    out.mkdir(parents=True,exist_ok=True)
    internal_path=internal_path or base/'internal-training.json'
    dataset=json.loads((base/'full-training.json').read_bytes())
    internal=json.loads(internal_path.read_bytes())
    assert all(c['split'] in ('train','development') for c in dataset['cases']+internal['pages'])
    train_edges,train_assets=pairs(dataset,'train'); dev_edges,dev_assets=pairs(dataset,'development')
    family_by_source={c['sha256']:c['family_id'] for c in dataset['cases']}
    for row in train_edges+dev_edges: row['family_id']=family_by_source[row['sha256']]
    train_lines=[p for p in internal['pages'] if p['split']=='train']
    dev_lines=[p for p in internal['pages'] if p['split']=='development']
    for pages,assets in ((train_lines,train_assets),(dev_lines,dev_assets)):
        for page in pages: assets[page['image']['sha256']]=page['image']
    train_families={c['family_id'] for c in dataset['cases']+internal['pages'] if c['split']=='train'}
    dev_families={c['family_id'] for c in dataset['cases']+internal['pages'] if c['split']=='development'}
    assert not train_families&dev_families
    for key,asset in {**train_assets,**dev_assets}.items(): assert digest(base/asset['path'])==key
    model=model_factory().to(device)
    initial=initial_checkpoint or root/'cpu-model/quadrants-224/model.pt'
    missing,unexpected=model.load_state_dict(torch.load(initial,map_location=device,weights_only=True),strict=False)
    assert not unexpected and all(k.startswith(model.new_parameter_prefixes) for k in missing)
    positive=sum(r['label'] for r in train_edges)
    edge_loss=nn.BCEWithLogitsLoss(pos_weight=torch.tensor(math.sqrt((len(train_edges)-positive)/positive),device=device))
    # Positive-page oversampling and separate head losses prevent dilution by line negatives.
    line_loss=nn.BCEWithLogitsLoss(pos_weight=torch.tensor(8.,device=device))
    edge_weights=family_class_weights(Counter((r['family_id'],r['label']) for r in train_edges)) if family_balanced else None
    def balanced_loss(logits,rows,weights):
        labels=torch.tensor([r['label'] for r in rows],device=device,dtype=torch.float32)
        mass=torch.tensor([weights[r['family_id'],r['label']] for r in rows],device=device)
        return (F.binary_cross_entropy_with_logits(logits,labels,reduction='none')*mass).mean()
    history=[]; best=None; began=time.perf_counter(); train_cache=dev_cache=None
    for stage,count in (('heads',20),('joint',epochs)):
        if stage=='joint':
            model.load_state_dict(torch.load(out/'model.pt',map_location=device,weights_only=True))
            train_cache=dev_cache=None; torch.cuda.empty_cache()
        for parameter in model.features.parameters(): parameter.requires_grad_(stage=='joint')
        if stage=='heads':
            print(json.dumps(dict(stage='cache-frozen-features',training_pages=len(train_assets),development_pages=len(dev_assets))),flush=True)
            train_cache=cache_visual(model,train_lines,train_assets,base,device)
            dev_cache=cache_visual(model,dev_lines,dev_assets,base,device)
        optimizer=torch.optim.AdamW([
            dict(params=model.features.parameters(),lr=1e-5),
            dict(params=[p for name,p in model.named_parameters() if not name.startswith('features.')],lr=3e-4)],weight_decay=.001)
        last_improvement=0
        for epoch in range(count+1):
            if epoch:
                model.train(); model.features.eval()
                edge_order=list(train_edges); random.shuffle(edge_order)
                positive_pages=[p for p in train_lines if any(c['label'] for c in p['candidates'])]
                line_order=list(train_lines)+positive_pages*8; random.shuffle(line_order)
                line_weights=None
                if family_balanced:
                    counts=Counter()
                    for page in line_order:
                        positive_count=sum(c['label'] for c in page['candidates'])
                        counts[page['family_id'],1]+=positive_count
                        counts[page['family_id'],0]+=min(24,len(page['candidates'])-positive_count)
                    line_weights=family_class_weights(counts)
                edge_batch,line_batch=(64,32) if train_cache else (12,6)
                tasks=[('edge',edge_order[i:i+edge_batch]) for i in range(0,len(edge_order),edge_batch)]
                tasks+=[('line',line_order[i:i+line_batch]) for i in range(0,len(line_order),line_batch)]
                random.shuffle(tasks)
                for kind,rows in tasks:
                    optimizer.zero_grad(set_to_none=True)
                    if kind=='edge':
                        if train_cache:
                            logits=model.classify(train_cache['vectors'],torch.tensor(indices_for(rows,train_cache['lookup'],2),device=device),rows)
                        else:
                            keys=sorted({r[k] for r in rows for k in ('left','right')}); lookup={k:i for i,k in enumerate(keys)}
                            pixels=torch.stack([image_pixels(base/train_assets[key]['path'],224,'quadrants') for key in keys]).to(device,dtype=torch.float32)
                            logits=model.classify(model.visual(pixels)[0],torch.tensor(indices_for(rows,lookup,2),device=device),rows)
                        loss=(balanced_loss(logits,rows,edge_weights) if family_balanced else
                            edge_loss(logits,torch.tensor([r['label'] for r in rows],device=device,dtype=torch.float32)))
                    else:
                        candidates=selected_candidates(rows,True)
                        if not candidates: continue
                        if train_cache:
                            indices=torch.tensor([train_cache['line_lookup'][c['sha256'],c['page'],c['line_id']] for c in candidates],device=device)
                            logits=model.classify_lines(train_cache['line_values'][indices].float(),candidates)
                        else:
                            pixels=torch.stack([image_pixels(base/p['image']['path'],224,'quadrants') for p in rows]).to(device,dtype=torch.float32)
                            logits=model.lines(model.visual(pixels),candidates)
                        loss=(balanced_loss(logits,candidates,line_weights) if family_balanced else
                            line_loss(logits,torch.tensor([c['label'] for c in candidates],device=device,dtype=torch.float32)))
                    assert torch.isfinite(loss)
                    loss.backward(); nn.utils.clip_grad_norm_(model.parameters(),1.,error_if_nonfinite=True); optimizer.step()
            edge_result,line_result,edge_predictions,line_predictions=(evaluate_cached(model,dev_edges,dev_cache) if dev_cache
                else evaluate(model,dev_edges,dev_lines,dev_assets,base,device))
            selection=(rank(edge_result)[0]+rank(line_result)[0])/2
            point=dict(stage=stage,epoch=epoch,page_edge_f1=rank(edge_result)[0],page_edge_ap=rank(edge_result)[1],
                internal_anchor_f1=rank(line_result)[0],internal_anchor_ap=rank(line_result)[1],seconds=time.perf_counter()-began)
            history.append(point); print(json.dumps(point),flush=True)
            if best is None or selection>best['selection']:
                best=dict(selection=selection,stage=stage,epoch=epoch,page_edges=edge_result,internal_anchors=line_result)
                last_improvement=epoch
                torch.save({k:v.detach().cpu() for k,v in model.state_dict().items()},out/'model.pt')
                write(out/'development-edges.json',edge_predictions); write(out/'development-lines.json',line_predictions)
            write(out/'progress.json',dict(history=history,best=best))
            if epoch-last_improvement>=5: break
    model.load_state_dict(torch.load(out/'model.pt',map_location=device,weights_only=True))
    edge_result,line_result,edge_predictions,line_predictions=evaluate(model,dev_edges,dev_lines,dev_assets,base,device)
    write(out/'development-edges.json',edge_predictions); write(out/'development-lines.json',line_predictions)
    # Frozen historical development slice measures comparability on the same 517 seams.
    old=json.loads((base/'training.json').read_bytes()); fixed_edges,fixed_assets=pairs(old,'development')
    for page in dev_lines: fixed_assets[page['image']['sha256']]=page['image']
    fixed,_,_,_=evaluate(model,fixed_edges,dev_lines,fixed_assets,base,device)
    model.cpu().eval(); torch.set_num_threads(1)
    sample=dev_lines[:16]; timings=[]
    with torch.inference_mode():
        for repeat in range(3):
            started=time.perf_counter()
            for page in sample:
                pixels=image_pixels(base/page['image']['path'],224,'quadrants')[None].float()
                visual=model.visual(pixels); model.lines(visual,selected_candidates([page]))
            if repeat: timings.append(time.perf_counter()-started)
    report=dict(origin='machine_test',run_id='cpu-full-page-and-line-gold',seed=seed,private_gold_commit=saved['commit'],
        dataset_sha256=digest(base/'full-training.json'),internal_gold_sha256=digest(base/'internal-training.json'),
        internal_inputs_sha256=digest(internal_path),model_class=type(model).__name__,
        trainer_sha256=digest(Path(__file__)),model_sha256=digest(out/'model.pt'),
        parameters=sum(p.numel() for p in model.parameters()),model_bytes=(out/'model.pt').stat().st_size,
        initialization_sha256=digest(initial),training_edges=len(train_edges),development_edges=len(dev_edges),
        training_internal_starts=sum(c['label'] for p in train_lines for c in p['candidates']),
        development_internal_starts=sum(c['label'] for p in dev_lines for c in p['candidates']),
        best=best,history=history,fixed_development_page_edges=fixed,family_balanced_loss=family_balanced,
        final_development=dict(page_edges=edge_result,internal_anchors=line_result),
        recipe='Train heads on frozen quadrant features (20 epochs maximum), then joint encoder/head fitting; five-epoch patience per stage. Frozen line cache float16; final inference full float32.',
        cpu_pages_per_second_including_line_scoring=len(sample)/statistics.median(timings),
        seconds=time.perf_counter()-began,final_holdout_scored=False,
        limitations='Single seed; development-selected thresholds. Exact line anchors; saved-image CPU timing excludes PDF rendering and line extraction.')
    write(out/'report.json',report)
    print(json.dumps({k:report[k] for k in ('best','cpu_pages_per_second_including_line_scoring','seconds')},indent=2),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--epochs',type=int,default=12)
    args=parser.parse_args(); train(args.root,args.epochs)
