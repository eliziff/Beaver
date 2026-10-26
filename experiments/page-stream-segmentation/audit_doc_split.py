"""Audit the converter and original experiment before interpreting model quality.

Runs on the desktop against frozen training/development artifacts only. Does not
replace the candidate or open the final holdout. Tiny-fit weights stay in memory.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import random
import re
import time
from types import SimpleNamespace

import numpy as np
from PIL import Image
import torch

from doc_split_model import recover
from score_doc_split import score
from train_doc_split import digest, evaluate, examples, write


def verify_targets(root, dataset):
    base = root / 'teacher-data'
    parts = json.loads((base / 'legal-split-receipts/authoring-splits.json').read_text())['sources']
    documents = json.loads((base / 'legal-split-receipts/authoring-manifest-all.json').read_text())['documents']
    lengths = {d['sha256']: d['pages'] for d in documents}
    starts = {p['sha256']: {s for s in p['document_starts'] if type(s) is int} for p in parts}
    legacy = json.loads((base / 'teacher-training.json').read_text())['cases']
    old_labels = {(c['sha256'], str(c['right_page'])): c['label'] for c in legacy}
    checked, page_identities, pixel_checks = 0, set(), set()
    for case in dataset['cases']:
        for page, label in case['targets'].items():
            expected = int(int(page) in starts[case['sha256']]) if case['gold_panel'] == 'reviewed-legal-structure-splits' else old_labels[case['sha256'], page]
            if label != expected:
                raise ValueError('Teacher-to-target conversion mismatch')
            checked += 1
        for image in case['images']:
            origin = image['teacher_image'].replace('\\', '/')
            match = re.search(r'/annotations/([0-9a-f]{64})/pages/page-(\d+)-', '/' + origin)
            if not match or (match[1], int(match[2])) != (case['sha256'], image['page']):
                raise ValueError('Image and target original-page identity differ')
            page_identities.add((case['sha256'], image['page']))
            if case['gold_panel'] == 'reviewed-legal-structure-splits' and len(pixel_checks) < 32 and image['sha256'] not in pixel_checks:
                with Image.open(image['teacher_image']) as original, Image.open(base / image['path']) as converted:
                    np.testing.assert_array_equal(np.asarray(original.convert('RGB').resize((512,512))), np.asarray(converted))
                pixel_checks.add(image['sha256'])
    return {'gold_targets_checked': checked, 'original_page_identities_checked': len(page_identities),
            'saved_image_preprocessing_checks': len(pixel_checks), 'mismatches': 0}, lengths


def packet_rows(rows, lengths):
    sources = {}
    for row in rows:
        if row['case']['gold_panel'] != 'reviewed-legal-structure-splits':
            continue
        sha = row['case']['sha256']
        own = sources.setdefault(row['case']['sequence_id'], {'images': {}, 'features': {}, 'targets': {}, 'case': row['case']})
        for i, image in enumerate(row['case']['images']):
            own['images'][image['page']] = image
            own['features'][image['page']] = row['inputs']['v_img'][0,i]
        own['targets'].update(row['case']['targets'])
    result = []
    for sha, source in sources.items():
        pages = sorted(source['images'])
        count = len(pages)
        if pages != list(range(pages[0],pages[0]+count)) or count > 1024:
            raise ValueError('Full packet cannot be represented faithfully')
        images = [source['images'][p] for p in pages]
        inputs = {'v_img': torch.stack([source['features'][p] for p in pages])[None],
                  'v_txt': torch.zeros((1,count,384), device='cuda'), 'gate': torch.zeros((1,count),device='cuda'),
                  'mask': torch.ones((1,count),device='cuda')}
        case = {**source['case'], 'images': images, 'targets': source['targets']}
        targets = torch.tensor([source['targets'].get(str(p),-1) for p in pages], device='cuda', dtype=torch.float32)
        result.append({'case':case,'inputs':inputs,'targets':targets})
    return result


def crf_probability(logits, parameters):
    """Independent two-state forward/backward implementation of released CRF."""
    transition = np.asarray(parameters['trans'])
    emissions = np.column_stack((np.zeros(len(logits)), logits))
    forward, backward = np.zeros_like(emissions), np.zeros_like(emissions)
    forward[0] = np.asarray(parameters['start']) + emissions[0]
    backward[-1] = np.asarray(parameters['end'])
    for i in range(1,len(logits)):
        forward[i] = emissions[i] + np.logaddexp.reduce(forward[i-1][:,None]+transition,axis=0)
    for i in range(len(logits)-2,-1,-1):
        backward[i] = np.logaddexp.reduce(transition+emissions[i+1][None]+backward[i+1][None],axis=1)
    joint = forward+backward
    return np.exp(joint[:,1]-np.logaddexp.reduce(joint,axis=1))


def score_rows(model, rows, parameters=None):
    data = {'cases':[r['case'] for r in rows]}
    if parameters is None:
        loss, predictions = evaluate(model, rows)
    else:
        model.eval()
        sources = {}
        with torch.inference_mode():
            for row in rows:
                logits = model(**row['inputs'])[0].cpu().numpy()
                probabilities = crf_probability(logits, parameters)
                own = sources.setdefault(row['case']['sha256'],{})
                for image, probability in zip(row['case']['images'],probabilities):
                    if str(image['page']) in row['case']['targets']:
                        own[str(image['page'])] = float(probability)
        loss = None
        predictions = {'sources':[{'sha256':sha,'probabilities':values} for sha,values in sources.items()]}
    result = score(data,predictions,rows[0]['case']['split'])
    return {'loss':loss, **result}


def tiny_fit(root, rows):
    chosen, used = [], set()
    for label in (1,0):
        count = 0
        for row in sorted(rows,key=lambda r:r['case']['case_id']):
            if row['case']['family_id'] in used:
                continue
            found = next((p for p,v in row['case']['targets'].items() if v==label),None)
            if found is None:
                continue
            targets = torch.full_like(row['targets'],-1)
            index = [i['page'] for i in row['case']['images']].index(int(found))
            targets[index] = label
            chosen.append({**row,'case':{**row['case'],'targets':{found:label}},'targets':targets})
            used.add(row['case']['family_id'])
            count += 1
            if count == 8:
                break
    torch.manual_seed(17291)
    random.seed(17291)
    model = recover(root/'upstream/head.onnx').cuda()
    for p in model.proj_txt.parameters():
        p.requires_grad_(False)
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),lr=1e-4,weight_decay=0)
    initial = score_rows(model,chosen)
    history = []
    began = time.perf_counter()
    for step in range(1,801):
        row = chosen[(step-1)%len(chosen)]
        model.train()
        optimizer.zero_grad(set_to_none=True)
        keep = row['targets']>=0
        loss = torch.nn.functional.binary_cross_entropy_with_logits(model(**row['inputs'])[0][keep],row['targets'][keep])
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(),1.,error_if_nonfinite=True)
        optimizer.step()
        if step%len(chosen)==0:
            measured = score_rows(model,chosen)
            history.append({'steps':step,'loss':measured['loss'],'f1':measured['f1']})
            if measured['f1']==1 and measured['loss']<.02:
                break
    return {'seams':len(chosen),'families':len(used),'learning_rate':1e-4,'initial':initial,
            'final':score_rows(model,chosen),'history':history,'seconds':time.perf_counter()-began,
            'scope':'Training-only sanity check; diagnostic weights were not saved or substituted for candidate.'}


def audit(root):
    torch.set_num_threads(1)
    torch.set_float32_matmul_precision('highest')
    torch.backends.mha.set_fastpath_enabled(False)
    torch.backends.cuda.enable_flash_sdp(False)
    torch.backends.cuda.enable_mem_efficient_sdp(False)
    torch.backends.cuda.enable_cudnn_sdp(False)
    dataset, parts = examples(SimpleNamespace(out=root,dataset=root/'teacher-data/training.json'))
    conversion, lengths = verify_targets(root,dataset)
    whole = packet_rows(parts['development'],lengths)
    parameters = json.loads((root/'upstream/crf.json').read_text())
    results = {}
    for name,path in [('stock',root/'upstream/head.onnx'),('finetuned',root/'head-finetuned.onnx')]:
        model = recover(path).cuda()
        results[name] = {split:score_rows(model,rows) for split,rows in parts.items()}
        windowed = [r for r in parts['development'] if r['case']['gold_panel']=='reviewed-legal-structure-splits']
        results[name]['legal_development_windowed'] = score_rows(model,windowed)
        results[name]['legal_development_full_packet'] = score_rows(model,whole)
        results[name]['legal_development_full_packet_crf'] = score_rows(model,whole,parameters)
        print(json.dumps({'stage':name,'train_f1':results[name]['train']['f1'],
                          'development_f1':results[name]['development']['f1'],
                          'full_packet_f1':results[name]['legal_development_full_packet']['f1']}),flush=True)
        del model
    result = {'origin':'machine_test','run_id':'doc-split-converter-audit',
        'dataset_sha256':digest(root/'teacher-data/training.json'),'auditor_sha256':digest(Path(__file__)),
        'conversion':conversion,'results':results,'tiny_fit':tiny_fit(root,parts['train']),
        'final_holdout_opened':False,'scope':'Frozen visual features only; does not yet test OCR/text encoder inputs.'}
    target = root/'audit/converter-audit.json'
    write(target,result)
    print(json.dumps({'conversion':conversion,'tiny_fit_final':result['tiny_fit']['final'],
                      'tiny_fit_steps':result['tiny_fit']['history'][-1]['steps']}),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    audit(parser.parse_args().root)
