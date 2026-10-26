"""Inventory raw production extraction caches and align labels onto OCR proposals.

This does not OCR PDFs, consult corrected gold text, or fabricate missing inputs.
An additional source manifest can supply other production OCR exports.
"""
import argparse
from collections import Counter
import gzip
import json
import os
from pathlib import Path
import re

from raw_ocr_split import normalize_extraction,align_labels
from train_doc_split import digest,write


def read(path):
    raw=path.read_bytes()
    return json.loads(gzip.decompress(raw) if path.suffix=='.gz' else raw)


def load_raw_bank(manifest_path):
    manifest=read(manifest_path)
    if manifest['schema']!='split-raw-inputs.v1': raise ValueError('Expected a raw recognition input manifest')
    bank={}
    for source in manifest['sources']:
        path=(manifest_path.parent/source['path']).resolve()
        if digest(path)!=source['artifact_sha256']: raise ValueError('Raw recognition artifact changed')
        pages=normalize_extraction(read(path),source['sha256'])
        for page,value in pages.items(): bank[source['sha256'],page]=value
    return bank


def prepare(root,fable,additional_manifest=None):
    base=root/'teacher-data'; out=base/'raw-ocr'; out.mkdir(exist_ok=True)
    edges=read(base/'full-training.json'); gold=read(base/'internal-training.json')
    needed={c['sha256'] for c in edges['cases']}|{p['sha256'] for p in gold['pages']}
    available={}
    for path in sorted(fable.glob('*/inputs/*.json.gz')):
        sha=path.name.removesuffix('.json.gz')
        if not re.fullmatch('[0-9a-f]{64}',sha) or sha not in needed: continue
        batch=path.parent.parent.name
        priority=int(batch[1:]) if re.fullmatch('b[0-9]+',batch) else 0
        if sha not in available or priority>available[sha][0]: available[sha]=(priority,path)
    if additional_manifest:
        for source in read(additional_manifest)['sources']:
            if source['sha256'] in needed:
                available[source['sha256']]=(1000,(additional_manifest.parent/source['path']).resolve())
    sources=[]
    for sha,(_,path) in sorted(available.items()):
        normalize_extraction(read(path),sha)
        sources.append(dict(sha256=sha,path=Path(os.path.relpath(path,out)).as_posix(),artifact_sha256=digest(path),
            producer='production-extraction-cache',source_binding='producer-source-cache-key'))
    manifest_path=out/'input-manifest.json'
    write(manifest_path,dict(schema='split-raw-inputs.v1',origin='machine_test',run_id='raw-ocr-input-inventory',
        sources=sources,missing_sources=sorted(needed-available.keys()),
        feature_contract='Raw text and boxes only. No corrected text, gold units, gold segmentation or structure features.'))
    bank=load_raw_bank(manifest_path)
    missing_pages=set(); required_pages={(p['sha256'],p['page']) for p in gold['pages']}
    for case in edges['cases']:
        for page in case['targets']:
            for p in (int(page)-1,int(page)):
                required_pages.add((case['sha256'],p))
                if (case['sha256'],p) not in bank: missing_pages.add((case['sha256'],p))
    unknown={}
    augmentation=base/'structure-gold-augmentation.json'
    if augmentation.exists():
        for item in read(augmentation)['ambiguous_unit_starts']:
            unknown.setdefault((item['sha256'],item['page']),[]).append(item['line_id'])
    pages=[]; missing_anchors=0; mask_failures=[]; masked_anchors=0
    for page in gold['pages']:
        key=page['sha256'],page['page']; anchors=[c for c in page['candidates'] if c['label']]
        if key not in bank:
            missing_pages.add(key); missing_anchors+=len(anchors); continue
        try: labels=align_labels(bank[key],anchors,unknown.get(key,()))
        except ValueError:
            mask_failures.append(dict(sha256=key[0],page=key[1])); masked_anchors+=len(anchors); continue
        pages.append({**{k:v for k,v in page.items() if k not in ('candidates','frame_sha256')},**labels})
    total=sum(c['label'] for p in gold['pages'] for c in p['candidates'])
    matched=sum(c['label'] for p in pages for c in p['candidates'])
    unrepresented=sum(len(p['unmatched_gold']) for p in pages)
    assert matched+unrepresented+missing_anchors+masked_anchors==total
    coverage=dict(origin='machine_test',run_id='raw-ocr-boundary-coverage',required_sources=len(needed),
        raw_sources=len(sources),missing_sources=len(needed-available.keys()),missing_pages=len(missing_pages),
        annotated_internal_starts=total,matched_starts=matched,ocr_unrepresentable_starts=unrepresented,
        starts_missing_raw_input=missing_anchors,unknown_mask_failures=mask_failures,
        starts_on_unscorable_pages=masked_anchors,
        raw_candidate_count=sum(len(p['candidates']) for p in pages),
        page_input_sources=dict(Counter(p['recognition_source'] for p in bank.values())),
        required_page_input_sources=dict(Counter(bank[k]['recognition_source'] if k in bank else 'missing' for k in required_pages)),
        matched_starts_by_input_source=dict(Counter(bank[p['sha256'],p['page']]['recognition_source']
            for p in pages for c in p['candidates'] if c['label'])),
        input_contract='raw-ocr-only',
        non_ocr_required_pages=sum(k in bank and bank[k]['recognition_source'].lower()!='ocr' for k in required_pages),
        complete=not (missing_pages or mask_failures or needed-available.keys()) and all(bank[k]['recognition_source'].lower()=='ocr' for k in required_pages),
        input_manifest_sha256=digest(manifest_path),gold_sha256=digest(base/'internal-training.json'))
    write(out/'internal-training.json',dict(schema='raw-ocr-split-targets.v1',pages=pages,
        gold_sha256=coverage['gold_sha256'],input_manifest_sha256=coverage['input_manifest_sha256']))
    coverage['raw_targets_sha256']=digest(out/'internal-training.json')
    write(out/'coverage.json',coverage)
    print(json.dumps({k:v for k,v in coverage.items() if k not in ('unknown_mask_failures','gold_sha256','input_manifest_sha256')},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--fable',required=True,type=Path); parser.add_argument('--additional-manifest',type=Path)
    args=parser.parse_args(); prepare(args.root,args.fable,args.additional_manifest)
