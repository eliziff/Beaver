"""Measure fit/generalization and source-image geometry, without changing gold."""
import argparse
import json
from pathlib import Path
import shutil

import numpy as np
from PIL import Image
import torch

from train_cpu_full_split import FullSplitModel,evaluate
from train_cpu_split import pairs,metric
from train_doc_split import digest,write


def geometry(base,internal):
    ink=[]
    for page in internal:
        positives=[c for c in page['candidates'] if c['label']]
        if not positives: continue
        with Image.open(base/page['image']['path']) as image:
            image=image.convert('L'); width,height=image.size
            for candidate in positives:
                x0,y0,x1,y1=candidate['bbox']
                crop=np.asarray(image.crop((int(x0*width),int(y0*height),max(int(x0*width)+1,int(x1*width)),
                    max(int(y0*height)+1,int(y1*height)))))
                ink.append(float((crop<200).mean()))
    return dict(internal_positive_box_count=len(ink),
        positive_box_ink_fraction_quantiles=np.quantile(ink,[0,.25,.5,.75,1]).tolist(),
        positive_boxes_with_no_dark_pixels=sum(value==0 for value in ink))


def localization(pages,predictions,split='development'):
    probabilities={s['sha256']:s['probabilities'] for s in predictions['sources']}
    rows=[]; scores=[]; ranks=[]
    for page in pages:
        candidates=page['candidates']; source=probabilities[page['sha256']]
        values=[source[str(page['page'])+':'+c['line_id']] for c in candidates]
        rows.append(dict(sha256=page['sha256'],page=page['page'],label=int(any(c['label'] for c in candidates)),panel='internal-page-presence'))
        scores.append(max(values))
        order=sorted(range(len(candidates)),key=lambda i:values[i],reverse=True)
        rank_by_index={i:rank+1 for rank,i in enumerate(order)}
        ranks.extend(rank_by_index[i] for i,c in enumerate(candidates) if c['label'])
    presence,_=metric(rows,scores,split)
    presence['limitations']='Internal split exists somewhere on the page; does not measure exact localization.'
    return dict(page_presence=presence,positive_anchor_count=len(ranks),
        exact_gold_recall_at_top_k_per_page={str(k):sum(r<=k for r in ranks)/len(ranks) for k in (1,3,5)},
        gold_candidate_rank_quantiles=np.quantile(ranks,[0,.5,.9,1]).tolist())


def diagnose(root):
    torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False; torch.backends.cudnn.allow_tf32=False
    base=root/'teacher-data'; out=root/'cpu-model/full-page-and-line'
    report=json.loads((out/'report.json').read_bytes())
    model=FullSplitModel().cuda().eval()
    model.load_state_dict(torch.load(out/'model.pt',map_location='cuda',weights_only=True))
    data=json.loads((base/'full-training.json').read_bytes())
    internal=json.loads((base/'internal-training.json').read_bytes())['pages']
    pages=[p for p in internal if p['split']=='train']
    edges,assets=pairs(data,'train')
    for page in pages: assets[page['image']['sha256']]=page['image']
    edge_result,line_result,_,training_line_predictions=evaluate(model,edges,pages,assets,base,torch.device('cuda'))
    edge_result['split']=line_result['split']='train'
    geometry_result=geometry(base,internal)
    source_dir=out/'source'; source_dir.mkdir(exist_ok=True)
    hashes={}
    for name in ('train_cpu_full_split.py','train_cpu_split.py','train_doc_split.py','score_doc_split.py',
        'prepare_cpu_full_gold.py','prepare_structure_split_gold.py','register_split_gold.py',
        'index_structure_split_gold.py','corpus_store.py','run_full_training.py',
        'validate_cpu_full_split.py','verify_full_gold_store.py',Path(__file__).name):
        if name=='corpus_store.py':
            from register_split_gold import corpus_store
            source=Path(corpus_store.__file__)
        else: source=Path(__file__).parent/name
        shutil.copyfile(source,source_dir/name); hashes[name]=digest(source)
    assert hashes['train_cpu_full_split.py']==report['trainer_sha256']
    coverage=json.loads((base/'private-gold-coverage.json').read_bytes())
    assert coverage['edge_export_sha256']==report['dataset_sha256']
    assert coverage['internal_export_sha256']==report['internal_gold_sha256']
    result=dict(origin='machine_test',run_id='cpu-full-fit-diagnostic',model_sha256=digest(out/'model.pt'),
        training_page_edges=edge_result,training_internal_anchors=line_result,
        training_localization=localization(pages,training_line_predictions,'train'),
        development_localization=localization([p for p in internal if p['split']=='development'],
            json.loads((out/'development-lines.json').read_bytes())),
        **geometry_result,
        source_hashes=hashes,private_gold_coverage_verified=True,final_holdout_scored=False)
    write(out/'fit-diagnostic.json',result)
    print(json.dumps(result,indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--geometry-only',action='store_true')
    args=parser.parse_args()
    if args.geometry_only:
        base=args.root/'teacher-data'
        print(json.dumps(geometry(base,json.loads((base/'internal-training.json').read_bytes())['pages'])))
    else: diagnose(args.root)
