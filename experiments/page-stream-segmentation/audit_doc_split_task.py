"""Prepare a private, purposive development error review; never changes gold."""
import argparse
import hashlib
import json
import os
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

from train_doc_split import digest, selection, write


def prepare(root, legal_root):
    dataset = selection(root/'teacher-data/training.json')
    report = json.loads((root/'native-fit/report.json').read_text())
    tau = report['stages'][-1]['development']['precision_recall_curve']['best_f1_on_this_split']['threshold']
    predictions = json.loads((root/'native-fit/head/development.json').read_text())
    probabilities = {(s['sha256'],int(p)):v for s in predictions['sources'] for p,v in s['probabilities'].items()}
    stock = json.loads((root/'native-fit/stock-development.json').read_text())
    stock_probabilities = {(s['sha256'],int(p)):v for s in stock['sources'] for p,v in s['probabilities'].items()}
    candidates = []
    for case in dataset['cases']:
        if case['split'] != 'development':
            continue
        for page, label in case['targets'].items():
            page = int(page)
            candidates.append({'sha256':case['sha256'],'page':page,'gold':label,
                'probability':probabilities[case['sha256'],page],
                'stock_probability':stock_probabilities[case['sha256'],page],
                'family_id':case['family_id'],'panel':case['gold_panel'],
                'context_pages':[i['page'] for i in case['images']]})
    selected, used = [], set()
    for panel in sorted({c['panel'] for c in candidates}):
        rows = [c for c in candidates if c['panel']==panel]
        categories = [
            ('miss-at-selected-threshold',lambda c:c['gold']==1 and c['probability']<tau,False),
            ('miss-at-half',lambda c:c['gold']==1 and c['probability']<.5,False),
            ('false-split',lambda c:c['gold']==0 and c['probability']>=tau,True),
            ('false-split',lambda c:c['gold']==0 and c['probability']>=tau,True),
            ('correct-split',lambda c:c['gold']==1 and c['probability']>=tau,False),
            ('correct-continuation',lambda c:c['gold']==0 and c['probability']<tau,True)]
        for category, predicate, reverse in categories:
            options = [c for c in rows if predicate(c) and (c['sha256'],c['page']) not in used]
            if not options:
                continue
            options.sort(key=lambda c:(c['probability'],c['sha256'],c['page']),reverse=reverse)
            different = [c for c in options if c['family_id'] not in {s['family_id'] for s in selected if s['panel']==panel}]
            choice = dict((different or options)[0])
            choice.update(audit_id=len(selected)+1,category=category)
            selected.append(choice)
            used.add((choice['sha256'],choice['page']))
    home = Path(os.environ['LOCALAPPDATA'])/'OpenLegalData'
    paths = {d['sha256']:Path(d['path']) for d in json.loads((legal_root/'authoring-manifest-all.json').read_text())['documents']}
    paths.update({r['sha256']:home/r['relative'] for r in json.loads((root/'teacher-source-paths.json').read_text())['sources']})
    needed = {s['sha256'] for s in selected if s['sha256'] not in paths or not paths[s['sha256']].is_file()}
    paths.update({p.stem:p for p in (home/'corpus').rglob('*.pdf') if p.stem in needed})
    out = root/'native-fit/task-definition-audit'
    out.mkdir(exist_ok=True)
    for sample in selected:
        sha, page = sample['sha256'], sample['page']
        path = paths[sha]
        if digest(path) != sha:
            raise ValueError('Audit source PDF differs')
        sample['pdf_path'] = str(path)
        with pymupdf.open(path) as pdf:
            canvas = Image.new('RGB',(1600,1120),'#dedede')
            draw = ImageDraw.Draw(canvas)
            sample['text_context'] = []
            for column,p in enumerate((page-1,page)):
                pix = pdf[p-1].get_pixmap(matrix=pymupdf.Matrix(1.5,1.5),alpha=False)
                image = Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
                image.thumbnail((780,1050))
                canvas.paste(image,(column*800+(800-image.width)//2,55))
                draw.text((column*800+12,20),'Audit '+str(sample['audit_id'])+' | physical page '+str(p),fill='black')
            canvas.save(out/('case-'+str(sample['audit_id'])+'.jpg'),quality=90)
            for p in range(max(min(sample['context_pages']),page-2),min(max(sample['context_pages']),page+1)+1):
                sample['text_context'].append({'page':p,'text':pdf[p-1].get_text('text')})
    write(out/'samples.json',{'origin':'machine_test','run_id':'doc-split-task-definition-audit',
        'dataset_sha256':digest(root/'teacher-data/training.json'),'selected_threshold':tau,
        'sampling':'Purposive development errors plus difficult successes; not an accuracy estimate or independent gold.',
        'gold_changed':False,'final_holdout_opened':False,'samples':selected})
    print(json.dumps([{k:s[k] for k in ('audit_id','panel','category','gold','probability','page')} for s in selected],indent=2))


if __name__=='__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--legal-split-root',type=Path,required=True)
    args = parser.parse_args()
    prepare(args.root,args.legal_split_root)
