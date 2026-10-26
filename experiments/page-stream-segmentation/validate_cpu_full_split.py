"""Independently reload the joint model and score both tasks on desktop CPU."""
import argparse
import json
from pathlib import Path
import time

import torch

from train_cpu_full_split import FullSplitModel, evaluate, selected_candidates
from train_cpu_split import image_pixels,pairs
from train_doc_split import digest,write


def validate(root):
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False; torch.backends.cudnn.allow_tf32=False
    base=root/'teacher-data'; out=root/'cpu-model/full-page-and-line'
    report=json.loads((out/'report.json').read_bytes())
    assert report['model_sha256']==digest(out/'model.pt')
    model=FullSplitModel().eval()
    model.load_state_dict(torch.load(out/'model.pt',map_location='cpu',weights_only=True))
    data=json.loads((base/'full-training.json').read_bytes())
    pages=[p for p in json.loads((base/'internal-training.json').read_bytes())['pages'] if p['split']=='development']
    edges,assets=pairs(data,'development')
    for page in pages: assets[page['image']['sha256']]=page['image']
    began=time.perf_counter()
    edge_result,line_result,_,_=evaluate(model,edges,pages,assets,base,torch.device('cpu'))
    elapsed=time.perf_counter()-began
    differences=[]
    with torch.inference_mode():
        for page in pages[:12]:
            pixels=image_pixels(base/page['image']['path'],224,'quadrants')[None].float()
            candidates=selected_candidates([page])
            cpu=model.lines(model.visual(pixels),candidates).sigmoid()
            model.cuda()
            gpu=model.lines(model.visual(pixels.cuda()),candidates).sigmoid().cpu()
            model.cpu()
            differences.append((cpu-gpu).abs().max().item())
    discrepancy=max(differences)
    assert discrepancy<1e-4, 'CPU/GPU line-probability discrepancy'
    result=dict(origin='machine_test',run_id='cpu-full-page-line-validation',model_sha256=report['model_sha256'],
        cpu_page_edges=edge_result,cpu_internal_anchors=line_result,development_seconds=elapsed,
        maximum_line_probability_gpu_cpu_error=discrepancy,final_holdout_opened=False)
    write(out/'cpu-validation.json',result)
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    validate(parser.parse_args().root)
