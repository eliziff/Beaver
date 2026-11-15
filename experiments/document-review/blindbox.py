"""Build anonymous origin probes and run packet-only blind Codex diagnostics."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shutil
import secrets
import subprocess
import sys
import time

import benchmark as b
from review_models import PROBE_SCHEMA


def family_keys(row):
    values={row['family_id']}
    if row.get('origin')=='synthetic' or row.get('synthetic') is True:
        values.add('authored-history:'+row['set'])
    values.update(component['family_id'] for field in ('components','embedded_copies') for component in row.get(field,[]))
    if row.get('version_group'):
        values.add(row['set']+':version:'+row['version_group'])
    return values


def stratified_sample(rows,count,seed):
    cases={}
    for row in b.shuffled(rows,seed):
        cases.setdefault(row['set'],[]).append(row)
    return [case[index] for index in range(max(map(len,cases.values()),default=0))
            for case in cases.values() if index<len(case)][:count]


def packet(sets, name, pairs, full_set=False, partition='development'):
    from prepare import pages_for_review
    root = b.PRIVATE/'blindbox'/name
    documents = root/'documents'
    if documents.exists() and any(documents.iterdir()):
        raise FileExistsError('Use a new named diagnostic arm or explicitly remove the old packet')
    inventories = {key:b.PRIVATE/'sets'/key/'inventory.json' for key in sets}
    rows = [dict(row,set=key) for key,path in inventories.items() for row in b.read(path)['documents']]
    if partition=='held_out':
        seen=set()
        for previous in (b.PRIVATE/'blindbox').glob('*/truth.json'):
            for row in b.read(previous)['documents']:
                if 'family_id' in row:
                    seen.update(row.get('family_ids') or family_keys(row))
                elif 'source_document_id' in row:
                    seen.add(row['source_document_id'])
        fresh=[row for row in rows if not family_keys(row)&seen]
        if full_set and len(fresh)!=len(rows):
            raise ValueError('A held-out full set contains previously exposed families; use fresh inputs')
        rows=fresh
    packet_seed=secrets.token_hex(32)
    if any(row.get('projection',{}).get('engine')!='legalpdf-read' for row in rows):
        raise ValueError('Finish common PDF projection for every selected set before making a blind packet')
    real = [r for r in rows if r['origin']=='real' and not r.get('inherits') and not r['components']]
    fake = [r for r in rows if r['origin']=='synthetic' and r['role']=='fictional_record']
    # Sample cases/record types before matching length and page count. Never select using detector results.
    families={r.get('version_group') or r['family_id']:r for r in b.shuffled(fake,packet_seed+':families')}
    fake = stratified_sample(list(families.values()),pairs,packet_seed+':strata')
    if not full_set and len(fake)<pairs:
        raise ValueError('Not enough fresh synthetic families for the requested pairs')
    selected,used = (list(rows) if full_set else []),set()
    for invented in ([] if full_set else fake):
        choices = [r for r in real if r['set']==invented['set'] and r['file_sha256'] not in used]
        if not choices:
            raise ValueError('Not enough fresh real controls for '+invented['set'])
        source=invented['provenance']
        if source['format']=='eml':
            kinds={'email','email_chain'}
        elif source['format']=='xlsx':
            kinds={'spreadsheet','financial_statement','chart'}
        elif source['kind']=='receipt':
            kinds={'invoice'}
        elif source['kind']=='notice':
            kinds={'notice','letter'}
        elif source['kind']=='text-message exchange':
            kinds={'text_messages','email','email_chain'}
        else:
            kinds={'letter','other','report'}
        match = min(choices,key=lambda r:5*(r['provenance'].get('kind') not in kinds)+
                    abs(math.log((len(r['text'])+100)/(len(invented['text'])+100)))+
                    .5*abs(r['metadata']['pages']-invented['metadata']['pages']))
        selected.extend([invented,match])
        used.add(match['file_sha256'])
    selected = b.shuffled(selected,packet_seed+':order')
    documents.mkdir(parents=True,exist_ok=True)
    truth, visible = [],[]
    for index,row in enumerate(selected):
        key = b.opaque_id(packet_seed,'anonymous:'+str(index))
        source = b.PRIVATE/row['file']
        shutil.copyfile(source,documents/(key+'.pdf'))
        (documents/(key+'.txt')).write_text(row['text'],encoding='utf-8')
        pages = pages_for_review(source,b.PRIVATE/'assets/blind-pages'/row['file_sha256'])
        pictures = documents/(key+'-pages')
        pictures.mkdir()
        for page in pages:
            shutil.copyfile(b.PRIVATE/page,pictures/Path(page).name)
        visible.append({'document_id':key,'file':key+'.pdf','text':key+'.txt','page_images':key+'-pages'})
        truth.append({'document_id':key,'synthetic':row['origin']=='synthetic',
                      'set':row['set'],'source_document_id':row['document_id'],'file_sha256':row['file_sha256'],
                      'family_id':row['family_id'],'family_ids':sorted(family_keys(row)),
                      'version_group':row.get('version_group')})
    b.dump(documents/'documents.json',visible)
    if full_set:
        (documents/'brief.txt').write_text(b.read(next(iter(inventories.values())))['brief'],encoding='utf-8')
    if os.name=='nt':
        subprocess.run(['powershell','-NoProfile','-File',str(b.HERE/'normalize_times.ps1'),str(documents)],check=True)
    b.dump(root/'truth.json',{'origin':'machine_test','run_id':b.RUN,
        'mode':'full_set' if full_set else 'matched_correlated_families',
        'independent_units':False,
        'partition':partition,
        'packet_seed':packet_seed,
        'inventories':{key:b.digest(path) for key,path in inventories.items()},'documents':truth})
    return root


def metrics(predictions, truth, *, independent=True):
    expected = {row['document_id']:row['synthetic'] for row in truth}
    observed = {row['document_id']:row for row in predictions}
    if len(predictions)!=len(expected) or observed.keys()!=expected.keys():
        raise ValueError('Blind predictions must cover exactly the anonymous packet')
    for row in predictions:
        if not 0<=row['synthetic_probability']<=1:
            raise ValueError('Invalid origin probability')
    n=len(expected)
    correct=sum((p['synthetic_probability']>=.5)==expected[p['document_id']] for p in predictions)
    yes=[observed[key]['synthetic_probability'] for key,value in expected.items() if value]
    no=[observed[key]['synthetic_probability'] for key,value in expected.items() if not value]
    auc=sum((p>q)+.5*(p==q) for p in yes for q in no)/(len(yes)*len(no))
    z=1.96
    center=(correct/n+z*z/(2*n))/(1+z*z/n)
    radius=z*math.sqrt(correct/n*(1-correct/n)/n+z*z/(4*n*n))/(1+z*z/n)
    return {'correct':correct,'n':n,'accuracy':correct/n,'roc_auc':auc,
        'balanced_accuracy':.5*(sum(p>=.5 for p in yes)/len(yes)+sum(p<.5 for p in no)/len(no)),
        'majority_class_accuracy':max(len(yes),len(no))/n,
        'brier':sum((p['synthetic_probability']-expected[p['document_id']])**2 for p in predictions)/n,
        'accuracy_wilson_95':[center-radius,center+radius] if independent else None,
        'binomial_one_sided_p':sum(math.comb(n,k) for k in range(correct,n+1))/2**n if independent else None,
        'qualification':'Exploratory diagnostic. Chance-level results do not establish indistinguishability. Copies, matched pairs and shared histories are correlated; intervals and binomial tests require explicitly independent source units.'}


def run(root, model, effort, timeout, prompt_path):
    from types import SimpleNamespace
    from pypdf import PdfReader
    from review_models import invoke, CONFIG
    root=root.resolve()
    protocol,output=root/'protocol',root/'output'
    protocol.mkdir(exist_ok=True)
    output.mkdir(exist_ok=True)
    if (root/'run.json').exists():
        raise FileExistsError('This diagnostic arm already has a receipt')
    frame=prompt_path.read_text('utf-8')
    files,images=[],[]
    for listed in b.read(root/'documents/documents.json'):
        key=listed['document_id']
        pdf=root/'documents'/listed['file']
        pages=sorted((root/'documents'/listed['page_images']).glob('*.jpg'))
        if not pages:
            raise ValueError('Missing complete page images: '+key)
        reader=PdfReader(pdf)
        if len(reader.pages)!=len(pages):
            raise ValueError('Incomplete page images: '+key)
        indices=list(range(len(images)+1,len(images)+len(pages)+1))
        images.extend(pages)
        stat=pdf.stat()
        files.append({'document_id':key,'file':listed['file'],
            'export_metadata':{'bytes':stat.st_size,'pages':len(reader.pages),
                'pdf_info':dict(reader.metadata or {}),'has_xmp':reader.xmp_metadata is not None,
                'mtime_ns':stat.st_mtime_ns,'hard_links':stat.st_nlink},
            'text':(root/'documents'/listed['text']).read_text('utf-8'),
            'attached_page_images':indices})
    brief=root/'documents/brief.txt'
    context='\n\nREVIEW INSTRUCTIONS PROVIDED WITH THE FILES\n'+brief.read_text('utf-8') if brief.exists() else ''
    prompt=frame+context+'\n\nANONYMOUS DOCUMENTS\n'+json.dumps(files,ensure_ascii=False)
    b.dump(protocol/'schema.json',PROBE_SCHEMA)
    (protocol/'prompt.txt').write_text(prompt,encoding='utf-8')
    receipt={'origin':'machine_test','run_id':b.RUN,'model':model,'effort':effort,'status':'running',
        'inspection_mode':'supplied_images_text_metadata','command_count':0,
        'config':CONFIG,'page_images':len(images),'documents':len(files),
        'qualification':'Packet-only blind diagnostic. Model tools are disabled; this does not satisfy a filesystem-agent inspection gate.',
        'prompt_sha256':b.digest(protocol/'prompt.txt'),'schema_sha256':b.digest(protocol/'schema.json'),
        'harness_sha256':b.digest(Path(__file__)),
        'truth_sha256':b.digest(root/'truth.json')}
    b.dump(root/'run.json',receipt)
    ids={row['document_id'] for row in files}
    def validate(response):
        rows=response['documents']
        if len(rows)!=len(ids) or {row['document_id'] for row in rows}!=ids:
            raise ValueError('Predictions must cover exactly the supplied anonymous documents')
        return rows
    started=time.monotonic()
    try:
        predictions=invoke(prompt,PROBE_SCHEMA,root/'calls',
            SimpleNamespace(model=model,effort=effort,timeout=timeout,attempts=1,max_calls=1),validate,images)
        b.dump(output/'predictions.json',{'documents':predictions})
        truth=b.read(root/'truth.json')
        results=metrics(predictions,truth['documents'],independent=truth['independent_units'])
        receipt.update(status='completed',predictions_sha256=b.digest(output/'predictions.json'),metrics=results)
    except BaseException as error:
        receipt.update(status='failed',error=str(error))
        raise
    finally:
        receipt['elapsed_seconds']=round(time.monotonic()-started,2)
        b.dump(root/'run.json',receipt)
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('prepare','run'))
    parser.add_argument('--name',required=True)
    parser.add_argument('--sets',nargs='+',default=['air-passengers','prisons'])
    parser.add_argument('--pairs',type=int,default=12)
    parser.add_argument('--full-set',action='store_true')
    parser.add_argument('--partition',choices=('development','held_out'),default='development')
    parser.add_argument('--model',default='gpt-6.1-sol')
    parser.add_argument('--effort',default='high')
    parser.add_argument('--timeout',type=int,default=900)
    parser.add_argument('--prompt-file',type=Path,default=b.HERE/'prompts/origin-packet.txt')
    args=parser.parse_args()
    if not args.name.replace('-','').isalnum() or not 1<=args.pairs<=40:
        parser.error('Use a simple diagnostic name and 1..40 matched pairs')
    if args.full_set and len(args.sets)!=1:
        parser.error('Inspect one full matter at a time')
    result=packet(args.sets,args.name,args.pairs,args.full_set,args.partition) if args.command=='prepare' else run(b.PRIVATE/'blindbox'/args.name,args.model,args.effort,args.timeout,args.prompt_file)
    print(json.dumps(str(result) if isinstance(result,Path) else result),flush=True)


if __name__=='__main__':
    main()
