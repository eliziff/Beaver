"""Inference-only diagnosis of the stopped visual model; never resumes fitting."""
import argparse
import json
from pathlib import Path

import torch

from train_cpu_full_split import FullSplitModel,evaluate,rank
from train_cpu_split import pairs
from diagnose_cpu_full_split import localization
from train_doc_split import digest,write


def audit(root):
    torch.set_num_threads(1); torch.backends.cuda.matmul.allow_tf32=False; torch.backends.cudnn.allow_tf32=False
    base=root/'teacher-data'; out=root/'cpu-model/full-page-and-line'
    data=json.loads((base/'full-training.json').read_bytes()); internal=json.loads((base/'internal-training.json').read_bytes())['pages']
    coverage=json.loads((base/'private-gold-coverage.json').read_bytes())
    assert digest(base/'full-training.json')==coverage['edge_export_sha256']
    assert digest(base/'internal-training.json')==coverage['internal_export_sha256']
    device=torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model=FullSplitModel().to(device).eval(); model.load_state_dict(torch.load(out/'model.pt',map_location=device,weights_only=True))
    result=dict(origin='machine_test',run_id='stopped-visual-objective-audit',training_resumed=False,
        checkpoint_sha256=digest(out/'model.pt'),auditor_sha256=digest(Path(__file__)),splits={})
    for split in ('train','development'):
        edges,assets=pairs(data,split); pages=[p for p in internal if p['split']==split]
        for page in pages: assets[page['image']['sha256']]=page['image']
        edge,line,_,predictions=evaluate(model,edges,pages,assets,base,device)
        edge['split']=line['split']=split
        result['splits'][split]=dict(page_edges=edge,exact_lines=line,localization=localization(pages,predictions,split))
        write(out/'stopped-internal-audit.json',result)
        print(json.dumps(dict(split=split,page_edge_f1=rank(edge)[0],internal_f1=rank(line)[0],
            internal_ap=rank(line)[1],page_presence_f1=rank(result['splits'][split]['localization']['page_presence'])[0],
            gold_rank_quantiles=result['splits'][split]['localization']['gold_candidate_rank_quantiles'],
            recall_at_top_k=result['splits'][split]['localization']['exact_gold_recall_at_top_k_per_page'])),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    audit(parser.parse_args().root)
