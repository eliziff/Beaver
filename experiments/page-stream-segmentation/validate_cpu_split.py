"""Verify saved CPU predictions and page-by-page speed without opening holdout."""
import argparse
import json
import statistics
import time
from collections import deque

import torch
from pathlib import Path

from train_cpu_split import CpuBoundaryModel, pairs, image_pixels, evaluate
from train_doc_split import selection, digest, write


def stream_pages(model, paths, size, views):
    buffer=deque(maxlen=4)
    for path in paths:
        current=model.encode(image_pixels(path,size,views)[None].float())
        buffer.append(current)
        if model.context==2 and len(buffer)>=2:
            model.boundary(buffer[-2],buffer[-1])
        elif model.context==4 and len(buffer)>=3:
            before=buffer[-4] if len(buffer)==4 else torch.zeros_like(current)
            present=torch.tensor([[float(len(buffer)==4),1.]])
            model.boundary(buffer[-3],buffer[-2],before,current,present)
    if model.context==4 and len(buffer)>=2:
        before=buffer[-3] if len(buffer)>=3 else torch.zeros_like(buffer[-1])
        present=torch.tensor([[float(len(buffer)>=3),0.]])
        model.boundary(buffer[-2],buffer[-1],before,torch.zeros_like(buffer[-1]),present)


def validate(root, output=None):
    out = output or root/'cpu-model'
    report = json.loads((out/'report.json').read_text())
    size = report['image_size']
    views = report['views']
    context = report['context']
    if report['dataset_sha256'] != digest(root/'teacher-data/training.json'):
        raise ValueError('CPU validation dataset changed')
    dataset = selection(root/'teacher-data/training.json')
    rows,assets = pairs(dataset,'development',context)
    keys = sorted(assets)
    lookup = {key:i for i,key in enumerate(keys)}
    paths = [root/'teacher-data'/assets[key]['path'] for key in keys]
    for key,path in zip(keys,paths):
        if digest(path)!=key:
            raise ValueError('CPU validation image changed')
    pixels = torch.stack([image_pixels(path,size,views) for path in paths])
    model = CpuBoundaryModel(context=context)
    model.load_state_dict(torch.load(out/'model.pt',map_location='cpu',weights_only=True))
    model.eval()
    torch.set_num_threads(4)
    result,predictions = evaluate(model,rows,lookup,pixels,torch.device('cpu'))
    expected = json.loads((out/'development.json').read_text())
    flatten = lambda data:{(s['sha256'],p):v for s in data['sources'] for p,v in s['probabilities'].items()}
    before,after = flatten(expected),flatten(predictions)
    assert before.keys()==after.keys()
    max_error = max(abs(before[k]-after[k]) for k in before)
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.set_float32_matmul_precision('highest')
    model.cuda()
    _,strict_predictions = evaluate(model,rows,lookup,pixels,torch.device('cuda'))
    strict = flatten(strict_predictions)
    strict_error = max(abs(strict[k]-after[k]) for k in after)
    assert strict_error<1e-4, strict_error
    model.cpu().eval()
    speed = {}
    with torch.inference_mode():
        for threads in (1,4):
            torch.set_num_threads(threads)
            trials = []
            for trial in range(4):
                began = time.perf_counter()
                stream_pages(model,paths[:16],size,views)
                if trial:
                    trials.append(time.perf_counter()-began)
            elapsed = statistics.median(trials)
            speed[str(threads)] = dict(pages=16,median_seconds=elapsed,
                pages_per_second=16/elapsed,milliseconds_per_page=1000*elapsed/16)
    receipt = dict(origin='machine_test',run_id='cpu-split-validation',model_sha256=digest(out/'model.pt'),
        max_original_gpu_cpu_probability_error=max_error,
        max_full_precision_gpu_cpu_probability_error=strict_error,
        development=result,streaming_cpu_speed=speed,
        context=context,lookahead_pages=1 if context==4 else 0,
        scope='Saved-page decode, resize, normalization, CPU visual encoder and context classifier; excludes PDF rendering',
        final_holdout_opened=False)
    write(out/'cpu-validation.json',receipt)
    print(json.dumps(receipt,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    validate(args.root,args.output)
