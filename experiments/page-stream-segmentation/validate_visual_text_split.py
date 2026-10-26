"""Reload the visual/text checkpoint and measure quality and CPU inference cost."""
import argparse
from pathlib import Path
import statistics
import time

import torch

from prepare_raw_ocr_split import read,load_raw_bank
from train_doc_split import digest,write
from train_cpu_split import pairs,image_pixels
from train_cpu_full_split import evaluate
from visual_text_split import VisualTextSplitModel


def validate(root):
    torch.set_num_threads(1)
    base=root/'teacher-data'; out=root/'cpu-model/visual-text'
    report=read(out/'report.json')
    assert digest(out/'model.pt')==report['model_sha256']
    assert digest(base/'raw-ocr/input-manifest.json')==report['raw_input_manifest_sha256']
    model=VisualTextSplitModel(load_raw_bank(base/'raw-ocr/input-manifest.json')).eval()
    model.load_state_dict(torch.load(out/'model.pt',map_location='cpu',weights_only=True))
    pages=[p for p in read(base/'raw-ocr/internal-training.json')['pages'] if p['split']=='development']
    edges,assets=pairs(read(base/'full-training.json'),'development')
    for page in pages: assets[page['image']['sha256']]=page['image']
    began=time.perf_counter()
    edge,line,_,_=evaluate(model,edges,pages,assets,base,torch.device('cpu'))
    seconds=time.perf_counter()-began; trials=[]; sample=pages[:16]
    with torch.inference_mode():
        for repeat in range(4):
            started=time.perf_counter()
            for page in sample:
                pixels=image_pixels(base/page['image']['path'],224,'quadrants')[None].float()
                model.predict_raw_page(pixels,model.raw_pages[page['sha256'],page['page']])
            if repeat: trials.append(time.perf_counter()-started)
    result=dict(origin='machine_test',run_id='visual-text-cpu-validation',page_edges=edge,internal_anchors=line,
        model_sha256=digest(out/'model.pt'),development_seconds=seconds,
        parameters=sum(p.numel() for p in model.parameters()),
        cpu_pages_per_second=len(sample)/statistics.median(trials),
        timing_includes='Saved-image decode/resize, visual encoder, text hashing/encoding and internal decisions; excludes OCR/PDF rasterization.',
        final_holdout_scored=False)
    write(out/'cpu-validation.json',result)
    print(result)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    validate(parser.parse_args().root)
