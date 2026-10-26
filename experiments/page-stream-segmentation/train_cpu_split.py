"""Small visual page-boundary model, trained on desktop, measured on CPU.

Backbone: torchvision MobileNetV3 Small ImageNet weights. The entire page is
resized, preserving headers/footers; spatial pooling keeps four page quadrants.
No doc-split-v1 encoder, OCR, hosted inference or final-holdout access is used.
"""
import argparse
import json
import math
from pathlib import Path
import random
import statistics
import time

import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.nn import functional as F
from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights

from score_doc_split import score
from train_doc_split import selection, digest, write


def pairs(dataset, split, context=2):
    rows, assets = [], {}
    for case in dataset['cases']:
        if case['split'] != split:
            continue
        images = {i['page']:i for i in case['images']}
        for p, label in case['targets'].items():
            p = int(p)
            left, right = images[p-1], images[p]
            assets.update({i['sha256']:i for i in (left,right)})
            row=dict(left=left['sha256'],right=right['sha256'],label=label,
                sha256=case['sha256'],page=p,panel=case['gold_panel'])
            if context==4:
                for name,page in (('before',p-2),('after',p+1)):
                    row[name]=images[page]['sha256'] if page in images else None
                    if page in images:
                        assets[images[page]['sha256']]=images[page]
            rows.append(row)
    return rows, assets


def context_keys(row, context):
    return [row['left'],row['right']] if context==2 else [row['before'],row['left'],row['right'],row['after']]


def indices_for(rows, lookup, context, local=None):
    result=[]
    for row in rows:
        indices=[]
        for key in context_keys(row,context):
            index=-1 if key is None else lookup[key]
            indices.append(local[index] if local is not None and index>=0 else index)
        result.append(indices)
    return result


class CpuBoundaryModel(nn.Module):
    def __init__(self, pretrained=False, context=2):
        super().__init__()
        weights = MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        self.features = mobilenet_v3_small(weights=weights).features
        self.pool = nn.AdaptiveAvgPool2d((2,2))
        self.norm = nn.LayerNorm(2304)
        self.context=context
        self.head = nn.Sequential(nn.Linear(9216 if context==2 else 13826,64),nn.ReLU(),nn.Dropout(.2),nn.Linear(64,1))
        self.register_buffer('mean',torch.tensor([.485,.456,.406])[None,:,None,None])
        self.register_buffer('std',torch.tensor([.229,.224,.225])[None,:,None,None])

    def encode(self, pixels):
        if pixels.ndim==5:
            count,views,channels,height,width=pixels.shape
            maps=self.features((pixels.reshape(count*views,channels,height,width)/255-self.mean)/self.std)
            maps=maps.reshape(count,views,*maps.shape[1:])
            whole=self.pool(maps[:,0]).flatten(1)
            tiles=F.adaptive_avg_pool2d(maps[:,1:].flatten(0,1),(1,1)).flatten(1)
            tiles=tiles.reshape(count,4,maps.shape[2]).transpose(1,2).flatten(1)
            return (whole+tiles)*.5
        return self.pool(self.features((pixels/255-self.mean)/self.std)).flatten(1)

    def boundary(self, left, right, before=None, after=None, present=None):
        left, right = self.norm(left), self.norm(right)
        features=[left,right,right-left,right*left]
        if self.context==4:
            features=[self.norm(before)*present[:,0,None],left,right,
                self.norm(after)*present[:,1,None],right-left,right*left,present]
        return self.head(torch.cat(features,dim=1)).flatten()

    def classify(self, vectors, indices):
        if self.context==2:
            return self.boundary(vectors[indices[:,0]],vectors[indices[:,1]])
        present=(indices[:,[0,3]]>=0).float()
        return self.boundary(vectors[indices[:,1]],vectors[indices[:,2]],
            vectors[indices[:,0].clamp_min(0)],vectors[indices[:,3].clamp_min(0)],present)

    def forward(self, pixels, indices):
        vectors = self.encode(pixels)
        return self.classify(vectors,indices)


def image_pixels(path, size=224, views='full'):
    with Image.open(path) as image:
        image=image.convert('RGB')
        crops=[image]
        if views=='quadrants':
            width,height=image.size
            crops += [image.crop(box) for box in ((0,0,width//2,height//2),
                (width//2,0,width,height//2),(0,height//2,width//2,height),(width//2,height//2,width,height))]
        values=[torch.from_numpy(np.asarray(crop.resize((size,size),Image.Resampling.BILINEAR)).copy()).permute(2,0,1)
                for crop in crops]
    return values[0] if views=='full' else torch.stack(values)


def metric(rows, probabilities, split):
    cases, sources = {}, {}
    for row,p in zip(rows,probabilities):
        cases.setdefault(row['sha256'],dict(sha256=row['sha256'],split=split,targets={}))['targets'][str(row['page'])]=row['label']
        sources.setdefault(row['sha256'],{})[str(row['page'])]=float(p)
    predictions = {'sources':[dict(sha256=sha,probabilities=p) for sha,p in sources.items()]}
    return score({'cases':list(cases.values())},predictions,split),predictions


def rank(result):
    curve = result['precision_recall_curve']
    return curve['best_f1_on_this_split']['f1'],curve['average_precision']


def evaluate(model, rows, lookup, pixels, device):
    model.eval()
    ids = sorted({lookup[key] for r in rows for key in context_keys(r,model.context) if key is not None})
    vectors = torch.zeros((len(lookup),2304),device=device)
    with torch.inference_mode():
        for start in range(0,len(ids),32):
            own = ids[start:start+32]
            values = model.encode(pixels[own].to(device,dtype=torch.float32))
            vectors[own]=values
        probabilities = []
        for start in range(0,len(rows),128):
            batch = rows[start:start+128]
            indices=torch.tensor(indices_for(batch,lookup,model.context),device=device)
            probabilities.extend(torch.sigmoid(model.classify(vectors,indices)).cpu().tolist())
    return metric(rows,probabilities,'development')


def train(root, epochs=8, size=224, output=None, views='full', context=2):
    seed = 7319
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False
    torch.backends.cudnn.allow_tf32=False
    torch.set_float32_matmul_precision('highest')
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    out = output or root/'cpu-model'
    out.mkdir(parents=True,exist_ok=True)
    torch.hub.set_dir(str(root/'cpu-model/upstream'))
    dataset = selection(root/'teacher-data/training.json')
    if any(c['split']=='test' for c in dataset['cases']):
        raise ValueError('Final holdout cannot enter model fitting')
    training, assets = pairs(dataset,'train',context)
    development, more = pairs(dataset,'development',context)
    assets.update(more)
    keys = sorted(assets)
    lookup = {key:i for i,key in enumerate(keys)}
    pixels = []
    for key in keys:
        path = root/'teacher-data'/assets[key]['path']
        if digest(path)!=key:
            raise ValueError('Teacher image changed')
        pixels.append(image_pixels(path,size,views))
    pixels = torch.stack(pixels)
    model = CpuBoundaryModel(pretrained=True,context=context).to(device)
    positives = sum(r['label'] for r in training)
    weight = math.sqrt((len(training)-positives)/positives)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=torch.tensor(weight,device=device))
    best, best_stage, best_epoch, history = None,None,0,[]
    began = time.perf_counter()
    cached = None
    for stage, count in [('classifier',20),('joint',epochs)]:
        for p in model.features.parameters():
            p.requires_grad_(stage=='joint')
        if stage=='classifier':
            model.eval()
            with torch.inference_mode():
                cached = torch.cat([model.encode(pixels[i:i+32].to(device,dtype=torch.float32)).cpu()
                    for i in range(0,len(pixels),32)]).to(device)
            cached = cached.clone()
        else:
            model.load_state_dict(torch.load(out/'model.pt',map_location=device,weights_only=True))
            cached = None
        optimizer = torch.optim.AdamW([
            {'params':model.features.parameters(),'lr':1e-5},
            {'params':list(model.norm.parameters())+list(model.head.parameters()),'lr':3e-4}],weight_decay=.001)
        stage_best_epoch = 0
        batch_size = 64 if cached is not None else 16
        for epoch in range(1,count+1):
            model.train()
            # Small batches must not replace pretrained normalization statistics.
            model.features.eval()
            order = list(training)
            random.shuffle(order)
            for start in range(0,len(order),batch_size):
                rows = order[start:start+batch_size]
                optimizer.zero_grad(set_to_none=True)
                if cached is not None:
                    indices=torch.tensor(indices_for(rows,lookup,context),device=device)
                    logits = model.classify(cached,indices)
                else:
                    own = sorted({lookup[key] for r in rows for key in context_keys(r,context) if key is not None})
                    local = {idx:i for i,idx in enumerate(own)}
                    indices = torch.tensor(indices_for(rows,lookup,context,local),device=device)
                    logits = model(pixels[own].to(device,dtype=torch.float32),indices)
                loss = loss_fn(logits,torch.tensor([r['label'] for r in rows],device=device,dtype=torch.float32))
                if not torch.isfinite(loss):
                    raise ValueError('Nonfinite CPU-model training loss')
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(),1.,error_if_nonfinite=True)
                optimizer.step()
            result,predictions = evaluate(model,development,lookup,pixels,device)
            if best is None or rank(result)>rank(best):
                best,best_stage,best_epoch = result,stage,epoch
                stage_best_epoch = epoch
                torch.save({k:v.detach().cpu() for k,v in model.state_dict().items()},out/'model.pt')
                write(out/'development.json',predictions)
            point = dict(stage=stage,epoch=epoch,best_stage=best_stage,best_epoch=best_epoch,
                f1_at_half=result['f1'],best_f1=rank(result)[0],average_precision=rank(result)[1],seconds=time.perf_counter()-began)
            history.append(point)
            write(out/'progress.json',dict(history=history))
            print(json.dumps(point),flush=True)
            if epoch-stage_best_epoch>=5:
                break
    model.load_state_dict(torch.load(out/'model.pt',map_location='cpu',weights_only=True))
    model.cpu().eval()
    # Include PNG decoding, resize, normalization, encoder and adjacent-page head.
    sample = [root/'teacher-data'/assets[key]['path'] for key in keys[:16]]
    speed = {}
    with torch.inference_mode():
        for threads in (1,4):
            torch.set_num_threads(threads)
            trials = []
            for trial in range(4):
                started = time.perf_counter()
                values = model.encode(torch.stack([image_pixels(p,size,views) for p in sample]).float())
                indices=torch.tensor([[i-2 if i>=2 else -1,i-1,i,i+1 if i+1<len(values) else -1]
                    if context==4 else [i-1,i] for i in range(1,len(values))])
                model.classify(values,indices)
                elapsed = time.perf_counter()-started
                if trial: trials.append(elapsed)
            speed[str(threads)] = dict(pages=len(sample),median_seconds=statistics.median(trials),
                pages_per_second=len(sample)/statistics.median(trials))
    stock = json.loads((root/'native-fit/stock-development.json').read_text())
    stock_result = score(dataset,stock,'development')
    report = dict(origin='machine_test',run_id='cpu-visual-split-baseline',seed=seed,
        dataset_sha256=digest(root/'teacher-data/training.json'),trainer_sha256=digest(Path(__file__)),
        model_sha256=digest(out/'model.pt'),parameters=sum(p.numel() for p in model.parameters()),
        model_bytes=(out/'model.pt').stat().st_size,backbone='torchvision MobileNetV3 Small ImageNet1K V1',
        image_size=size,views=views,context=context,full_precision_cuda=True,
        preprocessing='Full-page RGB bilinear resize, ImageNet normalization, 2x2 spatial pooling',
        class_positive_weight=weight,selection='Development best boundary F1, then average precision',
        training_seams=len(training),development_seams=len(development),best_stage=best_stage,best_epoch=best_epoch,
        development=best,stock_doc_split_on_corrected_gold=stock_result,history=history,cpu_speed=speed,
        seconds=time.perf_counter()-began,training_device=str(device),final_holdout_opened=False,
        limitations='Single seed, development-selected threshold. CPU speed includes saved-image decoding and visual inference, excludes PDF rendering. No OCR or document association.')
    write(out/'report.json',report)
    print(json.dumps({k:report[k] for k in ('parameters','model_bytes','best_stage','best_epoch','development','stock_doc_split_on_corrected_gold','cpu_speed')},indent=2))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--epochs',type=int,default=8)
    parser.add_argument('--size',type=int,choices=(224,448),default=224)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--views',choices=('full','quadrants'),default='full')
    parser.add_argument('--context',type=int,choices=(2,4),default=2)
    args = parser.parse_args()
    if args.views=='quadrants' and args.size!=224:
        parser.error('Quadrant views use the pretrained 224-pixel scale')
    train(args.root,args.epochs,args.size,args.output,args.views,args.context)
