"""Review an explicitly source-corrected rejected author candidate, preserving receipts."""
import pathlib,json,hashlib,sys
import canada_expand as lane
w=lane.workflow

def main():
    rid=sys.argv[1] if len(sys.argv)>1 else 'nsarb-2023-1b134e9721'; dest=w.OUT/'records'/rid
    attempts=list((w.OUT/'calls'/rid/'author').glob('*/attempt-*/last-message.json'))
    candidate=w.read_json(attempts[-1]);gold=json.loads(candidate['gold_json'])
    affidavit=(dest/'affidavit.txt').read_text(encoding='utf-8')
    if rid=='nsarb-2023-aee7c8a264':
        before=gold['exhibits'][1]['references'][0]['quote'];prefix='Attached to this Affidavit as Exhibit B is the';start=affidavit.index(prefix);end=affidavit.index(', which',start);after=affidavit[start:end]
        gold['exhibits'][1]['references'][0]['quote']=after;pointer='/exhibits/1/references/0/quote';page=3;reason='Restore exact source line-break whitespace after the hyphen in the report title.'
    else:
        before=gold['events'][-1]['quote'];after='| was linked \nwith Garnet Brooks using video conferencing technology.';gold['events'][-1]['quote']=after;pointer='/events/21/quote';page=6;reason='Preserve literal OCR pipe rather than silently replacing it with I.'
    assert after in affidavit
    correction={'record_id':rid,'source_page':page,'pointer':pointer,'proposed':before,'corrected':after,'reason':reason,'author_response':str(attempts[-1].relative_to(w.OUT))}
    correction_path=w.OUT/f'{rid}-quote-correction.json';w.atomic_json(correction_path,correction)
    w.atomic_json(dest/'gold.json',gold);errors=w.verify.check(str(dest));assert not errors,errors
    proposal=json.dumps(gold,ensure_ascii=False)
    spl=w.read_json(dest/'split.json');source=w.read_json(dest/'source.json')
    image_dir=w.OUT/'review'/rid;image_dir.mkdir(parents=True,exist_ok=True);images=[]
    row=next(r for r in w.read_json(w.OUT/'prepared.json') if r['record_id']==rid)
    with w.fitz.open(w.HOME/row['path']) as doc:
        pages=sorted(set(spl['affidavit_pages']+[e['cover_page'] or e['stamp_page'] or e['source_pages'][0] for e in spl['exhibits']]))
        for n in pages:
            p=image_dir/f'source-{n:04}.jpg'
            if not p.exists():doc[n-1].get_pixmap(matrix=w.fitz.Matrix(1.2,1.2)).save(p)
            images.append(p)
    context='\nSOURCE '+json.dumps(source)+'\nSPLIT '+json.dumps(spl)+'\nAFFIDAVIT\n'+affidavit
    for ex in spl['exhibits']:
        path=dest/'files'/ex['file'];context+='\nEXHIBIT '+ex['label']+' FILE '+ex['file']+'\n'+path.with_suffix('.txt').read_text(encoding='utf-8')
        with w.fitz.open(path) as doc:
            pages=sorted({0,len(doc)-1}|{i for i,p in enumerate(doc) if len(p.get_text().split())<12})
            context+='\nCONTENT IMAGES '+str([(ex['file'],i+1) for i in pages])
            for i in pages:
                p=image_dir/f'{path.stem}-{hashlib.sha256(path.read_bytes()).hexdigest()[:12]}-{i+1:04}.jpg'
                if not p.exists():doc[i].get_pixmap(matrix=w.fitz.Matrix(1.2,1.2)).save(p)
                images.append(p)
    assert len(context)<650000 and len(images)<=110
    args=w.SimpleNamespace(model='gpt-6.1-sol',effort='high',attempts=1,timeout=1200,max_calls=80)
    budget={'calls':sum(len(w.read_json(p)['attempts']) for p in w.OUT.glob('**/receipt.json'))}
    def validate(value):
        if value['accept']:
            g=json.loads(value['gold_json']);w.atomic_json(dest/'gold.json',g)
            errors=w.verify.check(str(dest))
            if errors:raise ValueError('; '.join(errors))
        return value
    prompt='origin: machine_test; run_id: '+w.RUN+'\nIndependently review this author candidate and explicit literal-OCR quote correction. Verify meaning, dates, mappings and all source evidence; return corrected complete gold_json or reject. Previous author validation failed only on this literal quotation.\n'+w.AUTHOR+context+'\nEXPLICIT CORRECTION\n'+json.dumps(correction)+'\nPROPOSED GOLD\n'+proposal
    result=w.call(prompt,w.OUT/'schema.json',images,w.OUT/'calls'/rid/'review-corrected-quote',args,validate,budget=budget,policy=w.POLICY)
    summary=w.read_json(w.OUT/'summary.json')
    if result['accept']:
        g=json.loads(result['gold_json']);g['gold_provenance']={'origin':'machine_test','run_id':w.RUN,'model':args.model,'effort':args.effort,'method':'Original author call, explicit source-aligned OCR quote correction receipt, independent full source/exhibit review. Prior rejection preserved.','review_reason':result['reason']}
        w.atomic_json(dest/'gold.json',g)
        if rid not in summary['accepted']:summary['accepted'].append(rid)
        summary.setdefault('corrected_review_history',[]).append({'record_id':rid,'correction':correction_path.name,'status':'accepted'})
    else:summary['rejected'].append({'record_id':rid,'reason':result['reason']})
    summary['model_call_attempts']=budget['calls'];w.atomic_json(w.OUT/'summary.json',summary)
    print(result['accept'],result['reason'],flush=True)

if __name__=='__main__':main()
