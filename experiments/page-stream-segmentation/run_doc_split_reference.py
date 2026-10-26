"""Convert reviewed packet gold and run the official local v1 computation.

Uses separate valid document runs, original physical order, and the original
PDF's embedded text. No OCR service, hosted demo or private model is contacted.
Saved teacher images use the exact published image preprocessing. Frozen image
embeddings are reused only after verifying asset/model hashes and input tensors.
"""
import argparse
import json
from pathlib import Path
import time

import numpy as np
from PIL import Image
import torch  # Existing CUDA libraries; no training or dependency changes.
import onnxruntime as ort
import pymupdf
from transformers import AutoTokenizer

from doc_split_reference import BatchedEncoder, VerifiedImageCache, load_reference
from score_doc_split import score
from train_doc_split import digest, selection, write


def page_records(count, images, targets, texts):
    """Retain physical page IDs, reset positions and exclude the run's first page."""
    pages = sorted(images)
    if not pages or pages != list(range(pages[0], pages[0]+count)):
        raise ValueError('Native sequence conversion requires contiguous original pages')
    return [{'position':i,'physical_page':p,'image':images[p], 'page_text':texts[i],
             'boundary':1 if i==0 else targets.get(str(p)),
             'loss_mask':i>0 and str(p) in targets} for i,p in enumerate(pages)]


def run(args):
    root, base = args.root, args.root/'teacher-data'
    original = selection(base/'training.json')
    cases = [c for c in original['cases'] if c['split']==args.split and c['gold_panel']=='reviewed-legal-structure-splits']
    scoring = {'cases':cases}
    documents = {d['sha256']:d for d in json.loads((args.legal_split_root/'authoring-manifest-all.json').read_text())['documents']}
    prepared = json.loads((root/'training-preparation.json').read_text())
    upstream = json.loads((root/'upstream.json').read_text())
    for name in ('image_model.onnx','text_model.onnx','head.onnx','tokenizer.json','crf.json'):
        if digest(root/'upstream'/name)!=upstream['files'][name]:
            raise ValueError('Pinned model or tokenizer changed: '+name)
    if prepared['identity']['image_encoder_sha256']!=digest(root/'upstream/image_model.onnx'):
        raise ValueError('Cached images use different encoder weights')
    reference = load_reference(root/'upstream-demo/app.py')
    options = ort.SessionOptions()
    options.intra_op_num_threads=1
    if args.provider=='cuda' and 'CUDAExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('CUDA requested; install a compatible GPU runtime instead of running on CPU')
    providers=[('CUDAExecutionProvider',{'use_tf32':0,'gpu_mem_limit':3*1024**3}),'CPUExecutionProvider'] if args.provider=='cuda' else ['CPUExecutionProvider']
    text_session=ort.InferenceSession(str(root/'upstream/text_model.onnx'),options,providers=providers)
    text = BatchedEncoder(text_session,batch=4)
    head = ort.InferenceSession(str(root/'upstream/head.onnx'),options,providers=providers)
    if args.provider=='cuda' and any(s.get_providers()[0]!='CUDAExecutionProvider' for s in (text_session,head)):
        raise RuntimeError('Requested CUDA model session fell back to CPU')
    tokenizer = AutoTokenizer.from_pretrained(root/'upstream',local_files_only=True)
    crf = json.loads((root/'upstream/crf.json').read_text())
    grouped = {}
    for case in cases:
        packet = grouped.setdefault(case['sequence_id'],{'sha256':case['sha256'],'images':{},'targets':{},'family_id':case['family_id']})
        packet['targets'].update(case['targets'])
        for image in case['images']:
            packet['images'][image['page']]=image
    out=root/'reference'/args.provider
    out.mkdir(parents=True,exist_ok=True)
    predictions={'native':[],'visual_control':[]}
    conversion=[]
    numerical_checks={}
    began=time.perf_counter()
    for number,(sequence_id,packet) in enumerate(grouped.items(),1):
        sha=packet['sha256']
        source=documents[sha]
        pdf_path=Path(source['path'])
        if digest(pdf_path)!=sha:
            raise ValueError('Gold source PDF differs')
        with pymupdf.open(pdf_path) as pdf:
            if len(pdf)!=source['pages']:
                raise ValueError('Gold source page count differs')
            texts=[pdf[p-1].get_text('text') or '' for p in sorted(packet['images'])]
        count=len(packet['images'])
        rows=page_records(count,packet['images'],packet['targets'],texts)
        if len(rows)>1024:
            raise ValueError('Packet exceeds the released positional encoding; do not silently window it')
        images,features=[],[]
        for row in rows:
            asset=row['image']
            image_path=base/asset['path']
            if digest(image_path)!=asset['sha256']:
                raise ValueError('Teacher image changed')
            feature_path=root/'teacher-features'/(asset['sha256']+'.npy')
            if digest(feature_path)!=prepared['feature_hashes'][asset['sha256']]:
                raise ValueError('Cached visual feature changed')
            with Image.open(image_path) as image:
                images.append(image.convert('RGB').copy())
            features.append(np.load(feature_path))
        image_cache=VerifiedImageCache(images,features)
        if not numerical_checks:
            # Independently run the real encoder to validate reuse of the old cache.
            image_session=ort.InferenceSession(str(root/'upstream/image_model.onnx'),options,providers=providers)
            if args.provider=='cuda' and image_session.get_providers()[0]!='CUDAExecutionProvider':
                raise RuntimeError('Image parity session fell back to CPU')
            pixels=np.stack([(np.asarray(im,dtype=np.float32)/255-.5)/.5 for im in images[:2]]).transpose(0,3,1,2).copy()
            encoded=image_session.run(['image_embed'],{'pixel_values':pixels})[0]
            expected=np.stack(features[:2])
            np.testing.assert_allclose(encoded,expected,rtol=3e-4,atol=3e-4)
            numerical_checks['image_cache_max_error']=float(np.max(np.abs(encoded-expected)))
            del image_session
            tokens=tokenizer(['query: '+(t or ' ') for t in texts[:3]],padding=True,truncation=True,max_length=512,return_tensors='np')
            tokens={k:tokens[k].astype(np.int64) for k in ('input_ids','attention_mask')}
            direct=text_session.run(['text_embed'],tokens)[0]
            batched=BatchedEncoder(text_session,batch=1).run(['text_embed'],tokens)[0]
            np.testing.assert_allclose(direct,batched,rtol=3e-4,atol=3e-4)
            numerical_checks['text_batch_max_error']=float(np.max(np.abs(direct-batched)))
        obj={'img':image_cache,'txt':text,'head':head,'tok':tokenizer,'crf':crf}
        for mode in predictions:
            pages=list(zip(images,texts if mode=='native' else ['']*len(texts)))
            result=reference['predict_pages'](pages,obj,min_conf=50)
            own={str(r['physical_page']):float(result['confidence'][r['position']]) for r in rows if r['loss_mask']}
            predictions[mode].append({'sha256':sha,'probabilities':own})
        conversion.append({'stream_id':sequence_id,'family_id':packet['family_id'],'pages':len(rows),
            'known_seams':sum(r['loss_mask'] for r in rows),'text_pages':sum(bool(t.strip()) for t in texts),
            'verified_encoder_inputs':image_cache.verified,'pdf_sha256':sha})
        # Persist the actual converted data privately, including unknown/first-page masks.
        with (out/(sequence_id+'.jsonl')).open('w',encoding='utf-8') as stream:
            for row in rows:
                stream.write(json.dumps({'stream_id':sequence_id,'source':'reviewed-legal-structure-splits',**row},ensure_ascii=False)+'\n')
        print(json.dumps({'packets':number,'of':len(grouped),'pages':sum(c['pages'] for c in conversion),
                          'seconds':round(time.perf_counter()-began,1)}),flush=True)
    reports={}
    for mode,sources in predictions.items():
        value={'sources':sources}
        write(out/('predictions-'+mode+'.json'),value)
        reports[mode]=score(scoring,value,args.split)
        write(out/('score-'+mode+'.json'),reports[mode])
    report={'origin':'machine_test','run_id':'doc-split-official-inference-reference',
        'dataset_sha256':digest(base/'training.json'),'runner_sha256':digest(Path(__file__)),
        'official_source_sha256':digest(root/'upstream-demo/app.py'),'conversion':conversion,
        'provider':args.provider,'onnxruntime':ort.__version__,'numerical_checks':numerical_checks,
        'scores':reports,'seconds':time.perf_counter()-began,'final_holdout_opened':False,
        'scope':'Exact official numerical AST, separate valid document runs, original embedded PDF text, CRF and beta calibration. '
                'Uses verified saved teacher image embeddings; this differs from the UI PDF renderer, not model image preprocessing. '
                'Only the legal-structure development subset is compared; no held-out test or new fine-tune.'}
    write(out/'report.json',report)
    print(json.dumps({'scores':reports,'seconds':report['seconds']},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--legal-split-root',type=Path,required=True)
    parser.add_argument('--split',choices=('train','development'),default='development')
    parser.add_argument('--provider',choices=('cuda','cpu'),default='cuda')
    run(parser.parse_args())
