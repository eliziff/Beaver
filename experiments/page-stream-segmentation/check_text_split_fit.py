"""Bounded training-subset capacity check; never saves or promotes fitted weights."""
import torch
from torch import nn

from prepare_raw_ocr_split import read,load_raw_bank
from train_cpu_full_split import cache_visual
from train_doc_split import write
from visual_text_split import VisualTextSplitModel


def check(root,steps=200):
    torch.manual_seed(7319); torch.set_num_threads(1)
    torch.backends.cuda.matmul.allow_tf32=False; torch.backends.cudnn.allow_tf32=False
    base=root/'teacher-data'; raw=base/'raw-ocr'; bank=load_raw_bank(raw/'input-manifest.json')
    pages=[]; families=set()
    for page in read(raw/'internal-training.json')['pages']:
        key=page['sha256'],page['page']
        if page['split']!='train' or bank[key]['recognition_source'].lower()!='ocr': continue
        if not any(c['label'] for c in page['candidates']) or page['family_id'] in families: continue
        pages.append(page); families.add(page['family_id'])
        if len(pages)==8: break
    if len(pages)<2: raise ValueError('Need at least two independent training families with actual OCR positives for the fit check')
    device=torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model=VisualTextSplitModel(bank).to(device)
    missing,unexpected=model.load_state_dict(torch.load(root/'cpu-model/full-page-and-line/model.pt',map_location=device,weights_only=True),strict=False)
    assert not unexpected and all(k.startswith(model.new_parameter_prefixes) for k in missing)
    for parameter in model.features.parameters(): parameter.requires_grad_(False)
    assets={p['image']['sha256']:p['image'] for p in pages}
    cached=cache_visual(model,pages,assets,base,device); rows=[]
    for page in pages:
        positives=[c for c in cached['candidates'] if c['sha256']==page['sha256'] and c['page']==page['page'] and c['label']]
        negatives=[c for c in cached['candidates'] if c['sha256']==page['sha256'] and c['page']==page['page'] and not c['label']]
        rows.extend(positives+negatives[:8])
    indices=torch.tensor([cached['line_lookup'][c['sha256'],c['page'],c['line_id']] for c in rows],device=device)
    features=cached['line_values'][indices].float(); labels=torch.tensor([c['label'] for c in rows],device=device,dtype=torch.float32)
    positive=int(labels.sum()); loss_fn=nn.BCEWithLogitsLoss(pos_weight=torch.tensor((len(rows)-positive)/positive,device=device))
    optimizer=torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],lr=1e-3,weight_decay=.001)
    f1=0.
    for step in range(1,steps+1):
        model.train(); model.features.eval(); optimizer.zero_grad(set_to_none=True)
        loss=loss_fn(model.classify_lines(features,rows),labels)
        assert torch.isfinite(loss)
        loss.backward(); nn.utils.clip_grad_norm_(model.parameters(),1.); optimizer.step()
        if step%10==0:
            model.eval()
            with torch.inference_mode(): predicted=model.classify_lines(features,rows).sigmoid()>=.5
            tp=int((predicted&(labels==1)).sum()); fp=int((predicted&(labels==0)).sum()); fn=positive-tp
            f1=2*tp/(2*tp+fp+fn)
            if f1>=.95: break
    result=dict(origin='machine_test',run_id='text-internal-tiny-fit',examples=len(rows),positive_starts=positive,
        independent_training_families=len(families),steps=step,f1_at_half=f1,passed=f1>=.95,
        weights_saved=False,scope='Training-subset capacity check only; not a generalization estimate.')
    write(root/'cpu-model/visual-text/tiny-fit.json',result)
    del optimizer,model,cached,features
    if device.type=='cuda': torch.cuda.empty_cache()
    return result
