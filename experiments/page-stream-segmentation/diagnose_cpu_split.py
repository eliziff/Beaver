"""Measure compact-model fit and domain transfer on train/development only."""
import argparse
from collections import Counter
import json
from pathlib import Path

import torch

from train_cpu_split import CpuBoundaryModel, pairs, image_pixels, evaluate
from train_doc_split import selection, digest, write
from score_doc_split import score


def at_threshold(rows, probabilities, threshold):
    counts = Counter()
    for row in rows:
        p = probabilities[row['sha256'],str(row['page'])]
        counts[row['label'],int(p>=threshold)] += 1
    tp,fp,fn,tn = counts[1,1],counts[0,1],counts[1,0],counts[0,0]
    return dict(tp=tp,fp=fp,fn=fn,tn=tn,f1=2*tp/(2*tp+fp+fn),accuracy=(tp+tn)/len(rows))


def diagnose(root):
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False
    torch.backends.cudnn.allow_tf32=False
    torch.set_float32_matmul_precision('highest')
    dataset=selection(root/'teacher-data/training.json')
    training,assets=pairs(dataset,'train')
    development,more=pairs(dataset,'development')
    assets.update(more)
    keys=sorted(assets)
    lookup={key:i for i,key in enumerate(keys)}
    pixels=torch.stack([image_pixels(root/'teacher-data'/assets[key]['path']) for key in keys])
    model=CpuBoundaryModel()
    model.load_state_dict(torch.load(root/'cpu-model/model.pt',map_location='cpu',weights_only=True))
    model.cuda().eval()
    threshold=json.loads((root/'cpu-model/cpu-validation.json').read_text())['development']['precision_recall_curve']['best_f1_on_this_split']['threshold']
    results={}
    for split,rows in [('train',training),('development',development)]:
        _,predictions=evaluate(model,rows,lookup,pixels,torch.device('cuda'))
        probabilities={(s['sha256'],p):v for s in predictions['sources'] for p,v in s['probabilities'].items()}
        scored=score(dataset,predictions,split)
        results[split]=dict(at_development_threshold=at_threshold(rows,probabilities,threshold),
            average_precision=scored['precision_recall_curve']['average_precision'],
            best_f1_on_this_split=scored['precision_recall_curve']['best_f1_on_this_split'],
            panels={panel:at_threshold([r for r in rows if r['panel']==panel],probabilities,threshold)
                for panel in sorted({r['panel'] for r in rows})})
        if split=='development':
            audit=json.loads((root/'native-fit/task-definition-audit/samples.json').read_text())
            results['previous_audit_cases']=[dict(audit_id=s['audit_id'],
                current_gold=next(r['label'] for r in rows if r['sha256']==s['sha256'] and r['page']==s['page']),
                probability=probabilities[s['sha256'],str(s['page'])]) for s in audit['samples']]
    report=dict(origin='machine_test',run_id='cpu-model-fit-diagnosis',model_sha256=digest(root/'cpu-model/model.pt'),
        dataset_sha256=digest(root/'teacher-data/training.json'),development_threshold=threshold,results=results,
        unique_page_images=len(keys),final_holdout_opened=False)
    write(root/'cpu-model/diagnosis.json',report)
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    diagnose(parser.parse_args().root)
