"""Native multimodal adaptation on frozen page encoders and separate valid runs."""
import json
import math
import os
from pathlib import Path
import random
import time

import numpy as np
import torch

from doc_split_model import recover, export_head, parity
from score_doc_split import score
from train_doc_split import digest, examples, selection, write


def prepare_text(args):
    import onnxruntime as ort
    import pymupdf
    from transformers import AutoTokenizer

    dataset = selection(args.dataset)
    sources = {}
    for case in dataset['cases']:
        sources.setdefault(case['sha256'], set()).update(i['page'] for i in case['images'])
    manifest = args.legal_split_root / 'authoring-manifest-all.json'
    paths = {d['sha256']: Path(d['path']) for d in json.loads(manifest.read_text())['documents']}
    home = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData'
    source_paths = args.out/'teacher-source-paths.json'
    for source in json.loads(source_paths.read_text())['sources']:
        path = (home/source['relative']).resolve()
        if not path.is_relative_to(home.resolve()):
            raise ValueError('Teacher PDF path escapes OpenLegalData')
        if source['sha256'] in sources and path.is_file():
            paths[source['sha256']] = path
    needed = {sha for sha in sources if sha not in paths or not paths[sha].is_file()}
    for path in (home/'corpus').rglob('*.pdf'):
        if path.stem in needed:
            paths[path.stem] = path
    missing = [sha for sha in sources if sha not in paths or not paths[sha].is_file()]
    if missing:
        raise ValueError('Canonical source PDFs missing for text preparation: '+str(len(missing)))
    if 'CUDAExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('CUDA text encoder required')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(args.out/'upstream/text_model.onnx'), options,
        providers=[('CUDAExecutionProvider', {'use_tf32':0, 'gpu_mem_limit':3*1024**3}), 'CPUExecutionProvider'])
    if session.get_providers()[0] != 'CUDAExecutionProvider':
        raise RuntimeError('Text encoder fell back to CPU')
    tokenizer = AutoTokenizer.from_pretrained(args.out/'upstream', local_files_only=True)
    cache = args.out/'native-text'
    cache.mkdir(exist_ok=True)
    receipts = {}
    began = time.perf_counter()
    text_pages = total = 0
    for number, (sha, pages) in enumerate(sorted(sources.items()), 1):
        if digest(paths[sha]) != sha:
            raise ValueError('Source PDF hash differs')
        pages = sorted(pages)
        with pymupdf.open(paths[sha]) as pdf:
            texts = [pdf[p-1].get_text('text') or '' for p in pages]
        gate = np.array([bool(t.strip()) for t in texts], dtype=np.float32)
        vectors = []
        for start in range(0, len(texts), 4):
            tokens = tokenizer(['query: '+(t or ' ') for t in texts[start:start+4]],
                padding=True, truncation=True, max_length=512, return_tensors='np')
            vectors.append(session.run(['text_embed'], {k:tokens[k].astype(np.int64)
                for k in ('input_ids','attention_mask')})[0])
        target = cache/(sha+'.npz')
        np.savez(target, pages=np.array(pages), vectors=np.concatenate(vectors)*gate[:,None], gate=gate)
        receipts[sha] = {'sha256':digest(target), 'pages':len(pages), 'text_pages':int(gate.sum())}
        total += len(pages)
        text_pages += int(gate.sum())
        if number % 10 == 0:
            print(json.dumps({'text_sources':number, 'of':len(sources), 'pages':total}), flush=True)
    write(cache/(args.dataset.stem+'-preparation.json'), {
        'origin':'machine_test', 'run_id':'doc-split-native-text', 'dataset_sha256':digest(args.dataset),
        'text_encoder_sha256':digest(args.out/'upstream/text_model.onnx'),
        'tokenizer_sha256':digest(args.out/'upstream/tokenizer.json'),
        'preprocessing':'Official query prefix, truncation 512, embedded PDF text, whitespace presence gate',
        'sources':receipts, 'pages':total, 'text_pages':text_pages,
        'provider':session.get_providers()[0], 'seconds':time.perf_counter()-began})


def native_examples(args):
    dataset, parts = examples(args)
    cache = args.out/'native-text'
    receipt = json.loads((cache/(args.dataset.stem+'-preparation.json')).read_text())
    if (receipt['dataset_sha256'] != digest(args.dataset)
            or receipt['text_encoder_sha256'] != digest(args.out/'upstream/text_model.onnx')
            or receipt['tokenizer_sha256'] != digest(args.out/'upstream/tokenizer.json')):
        raise ValueError('Native text preparation differs from dataset/model')
    features = {}
    for sha, source in receipt['sources'].items():
        path = cache/(sha+'.npz')
        if digest(path) != source['sha256']:
            raise ValueError('Native text features changed')
        with np.load(path) as values:
            features[sha] = {int(p):(v.copy(),float(g)) for p,v,g in
                zip(values['pages'],values['vectors'],values['gate'])}
    for rows in parts.values():
        for row in rows:
            values = [features[row['case']['sha256']][i['page']] for i in row['case']['images']]
            row['inputs']['v_txt'] = torch.tensor(np.stack([v for v,g in values])[None],device='cuda')
            row['inputs']['gate'] = torch.tensor([[g for v,g in values]],device='cuda')
    return dataset, parts


def batches(rows, limit):
    group, count = [], 0
    for row in rows:
        group.append(row)
        count += int((row['targets'] >= 0).sum())
        if count >= limit:
            yield group, count
            group, count = [], 0
    if group:
        yield group, count


def loss_sum(logits, targets):
    keep = targets >= 0
    return torch.nn.functional.binary_cross_entropy_with_logits(logits[keep],targets[keep],reduction='sum')


def measure(model, rows, crf=None):
    from audit_doc_split import crf_probability
    model.eval()
    sources = []
    total = count = 0
    with torch.inference_mode():
        for row in rows:
            logits = model(**row['inputs'])[0]
            total += float(loss_sum(logits,row['targets']))
            count += int((row['targets'] >= 0).sum())
            probabilities = (crf_probability(logits.cpu().numpy(),crf) if crf else torch.sigmoid(logits).cpu().numpy())
            sources.append({'sha256':row['case']['sha256'],'probabilities':{
                str(image['page']):float(p) for image,p in zip(row['case']['images'],probabilities)
                if str(image['page']) in row['case']['targets']}})
    split = rows[0]['case']['split']
    predictions = {'sources':sources}
    result = score({'cases':[r['case'] for r in rows]},predictions,split)
    result['loss'] = total/count
    return result, predictions


def quality(result):
    curve = result['precision_recall_curve']
    return curve['average_precision'], curve['best_f1_on_this_split']['f1']


def configure(model, stage):
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(stage == 'head' or name.startswith('head.3.'))
    # A frozen representation must remain fixed, including dropout.
    model.eval() if stage == 'classifier' else model.train()


def fit_stage(args, model, parts, stage, epochs, lr):
    folder = args.out/'native-fit'/stage
    folder.mkdir(parents=True,exist_ok=True)
    configure(model,stage)
    parameters = [p for p in model.parameters() if p.requires_grad]
    trainable = sum(p.numel() for p in parameters)
    optimizer = torch.optim.AdamW(parameters,lr=lr,weight_decay=.01)
    estimated_steps = max(1,math.ceil(sum(int((r['targets']>=0).sum()) for r in parts['train'])/args.seams_per_step)*epochs)
    warmup = max(1,int(.1*estimated_steps))
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer,
        lambda step: min((step+1)/warmup,max(0.,(estimated_steps-step)/max(1,estimated_steps-warmup))))
    best, predictions = measure(model,parts['development'])
    best_epoch, history = 0, []
    torch.save({k:v.detach().cpu() for k,v in model.state_dict().items()},folder/'head.pt')
    write(folder/'development.json',predictions)
    began = time.perf_counter()
    for epoch in range(1,epochs+1):
        configure(model,stage)
        order = list(parts['train'])
        random.shuffle(order)
        for group, count in batches(order,args.seams_per_step):
            optimizer.zero_grad(set_to_none=True)
            for row in group:
                loss = loss_sum(model(**row['inputs'])[0],row['targets'])/count
                if not torch.isfinite(loss):
                    raise ValueError('Nonfinite native training loss')
                loss.backward()
            torch.nn.utils.clip_grad_norm_(parameters,1.,error_if_nonfinite=True)
            optimizer.step()
            scheduler.step()
        current, predictions = measure(model,parts['development'])
        point = {'epoch':epoch,'loss':current['loss'],'average_precision':quality(current)[0],
            'development_best_f1':quality(current)[1],'f1_at_half':current['f1'],'seconds':time.perf_counter()-began}
        history.append(point)
        if quality(current) > quality(best):
            best, best_epoch = current, epoch
            torch.save({k:v.detach().cpu() for k,v in model.state_dict().items()},folder/'head.pt')
            write(folder/'development.json',predictions)
        write(folder/'progress.json',{'stage':stage,'best_epoch':best_epoch,'history':history})
        print(json.dumps({'stage':stage,**point,'best_epoch':best_epoch}),flush=True)
        if epoch-best_epoch >= 6:
            break
    model.load_state_dict(torch.load(folder/'head.pt',weights_only=True))
    export_head(model,args.out/'upstream/head.onnx',folder/'head.onnx')
    write(folder/'parity.json',parity(folder/'head.onnx','cuda'))
    return {'stage':stage,'best_epoch':best_epoch,'trainable_parameters':trainable,'learning_rate':lr,
        'history':history,'development':best,'seconds':time.perf_counter()-began}


def train(args):
    import onnxruntime as ort
    if not torch.cuda.is_available():
        raise RuntimeError('Desktop CUDA GPU required')
    torch.set_num_threads(1)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    folder = args.out/'native-fit'
    folder.mkdir(exist_ok=True)
    write(folder/'stock-parity.json',parity(args.out/'upstream/head.onnx','cuda'))
    dataset, parts = native_examples(args)
    if set(parts) != {'train','development'}:
        raise ValueError('Only train/development may enter adaptation')
    model = recover(args.out/'upstream/head.onnx').cuda()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    session = ort.InferenceSession(str(args.out/'upstream/head.onnx'),options,
        providers=[('CUDAExecutionProvider',{'use_tf32':0}),'CPUExecutionProvider'])
    if session.get_providers()[0] != 'CUDAExecutionProvider':
        raise RuntimeError('Native parity session fell back to CPU')
    checks = []
    model.eval()
    with torch.inference_mode():
        for split, rows in parts.items():
            row = max(rows,key=lambda r:len(r['case']['images']))
            inputs = {k:v.cpu().numpy() for k,v in row['inputs'].items()}
            expected = session.run(['boundary_logit'],inputs)[0]
            actual = model(**row['inputs']).cpu().numpy()
            np.testing.assert_allclose(actual,expected,rtol=3e-4,atol=1e-4)
            checks.append({'split':split,'pages':len(row['case']['images']),
                'max_logit_error':float(np.max(np.abs(actual-expected)))})
    del session
    write(folder/'native-input-parity.json',checks)
    stock, stock_predictions = measure(model,parts['development'])
    write(folder/'stock-development.json',stock_predictions)
    stages = [fit_stage(args,model,parts,'classifier',args.classifier_epochs,1e-4),
              fit_stage(args,model,parts,'head',args.epochs,args.learning_rate)]
    selected = stages[-1]
    # Each stage retains its incoming checkpoint if no development improvement occurs.
    crf = json.loads((args.out/'upstream/crf.json').read_text())
    panels = {panel:measure(model,[r for r in parts['development'] if r['case']['gold_panel']==panel])[0]
              for panel in sorted({r['case']['gold_panel'] for r in parts['development']})}
    report = {'origin':'machine_test','run_id':'doc-split-native-staged-adaptation','seed':args.seed,
        'dataset_sha256':digest(args.dataset),'trainer_sha256':digest(Path(__file__)),
        'model_code_sha256':digest(Path(__file__).with_name('doc_split_model.py')),
        'image_preparation_sha256':digest(args.out/'training-preparation.json'),
        'preparation_sha256':digest(args.out/'native-text/training-preparation.json'),
        'upstream_head_sha256':digest(args.out/'upstream/head.onnx'),
        'selected_model_sha256':digest(folder/'head/head.onnx'),
        'selection':'Development average precision, then development best F1; stock eligible as epoch zero',
        'loss':'Unweighted raw-logit BCE; sum over known seams divided by seams per accumulated optimizer batch',
        'seams_per_step':args.seams_per_step,'stock':stock,'stages':stages,'selected_stage':selected['stage'],
        'selected_train':measure(model,parts['train'])[0],'selected_development_by_panel':panels,
        'selected_development_crf':measure(model,parts['development'],crf)[0],
        'final_holdout_opened':False,'gpu':torch.cuda.get_device_name(),
        'limitations':'Single-seed development selection; threshold diagnostics are not held-out accuracy. '
            'Frozen visual/text encoders, embedded PDF text only, released CRF fixed, beta calibration not reused.'}
    write(folder/'report.json',report)
    print(json.dumps({'stock':stock,'selected':selected['development'],'selected_train':report['selected_train']},indent=2),flush=True)
