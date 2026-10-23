"""Bounded, explicitly partitioned source-author/reviewer batches using existing runner."""
import hashlib,json,sys
from datetime import datetime,timezone
from types import SimpleNamespace
import fitz
import regulatory_expand as w

def context(rid):
    dest=w.OUT/'records'/rid;source=w.read_json(dest/'source.json');split=w.read_json(dest/'split.json');images=[]
    cache=w.OUT/'review'/rid;cache.mkdir(exist_ok=True,parents=True)
    pages=sorted(set(split['affidavit_pages']+source.get('source_review_extra_pages',[])+[e.get('cover_page') or e.get('stamp_page') or e['source_pages'][0] for e in split['exhibits']]))
    with fitz.open(w.HOME/source['canonical_source_path']) as doc:
        for n in pages:
            path=cache/f'batch-original-{n:04}.jpg'
            if not path.exists():doc[n-1].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).save(path)
            images.append(path)
    manifest=dict(record_id=rid,source_sha256=source['source_sha256'],complete_affidavit_source_pages=split['affidavit_pages'],original_image_pages=pages,exhibits=[])
    text='\nBEGIN RECORD '+rid+'\nSOURCE '+json.dumps(source)+'\nSPLIT '+json.dumps(split)+'\nCOMPLETE AFFIDAVIT\n'+(dest/'affidavit.txt').read_text(encoding='utf-8')
    for ex in split['exhibits']:
        path=dest/'files'/ex['file'];sha=hashlib.sha256(path.read_bytes()).hexdigest();content=path.with_suffix('.txt').read_text(encoding='utf-8')
        if len(content)<=24000 or ex['label'] in source.get('review_text_full_labels',[]):selected=content;bounds=dict(mode='full',characters=len(content))
        else:selected=content[:16000]+'\n[Middle text omitted from this bounded review; complete filed PDF/text retained]\n'+content[-8000:];bounds=dict(mode='head_tail',head_characters=16000,tail_characters=8000,total_characters=len(content))
        text+='\nEXHIBIT '+ex['label']+' FILE '+ex['file']+'\n'+selected
        with fitz.open(path) as doc:
            inspected=w.inspected_pages(source,ex,doc)
            text+='\nOUTPUT IMAGES '+str([(ex['file'],i+1) for i in inspected])
            for i in inspected:
                image=cache/f'batch-{sha[:12]}-{i+1:04}.jpg'
                if not image.exists():doc[i].get_pixmap(matrix=fitz.Matrix(1.2,1.2)).save(image)
                images.append(image)
            manifest['exhibits'].append(dict(file=ex['file'],pdf_sha256=sha,text_selection=bounds,inspected_output_image_pages=[i+1 for i in inspected],corresponding_source_pages=[ex['source_pages'][i] for i in inspected]))
    text+='\nEND RECORD '+rid+'\n'
    return text,images,manifest

def main(ids):
    if not ids or len(ids)!=len(set(ids)):raise ValueError('Provide distinct explicit record IDs')
    args=SimpleNamespace(model='gpt-6.1-sol',effort='medium',attempts=1,timeout=1500,max_calls=80)
    count=sum(len(w.read_json(p)['attempts']) for p in w.OUT.glob('calls/*/*/*/receipt.json'))
    if count>78:raise ValueError('Two-stage batch cannot fit remaining authorized80-attempt budget')
    budget={'calls':count};views=[];images=[];texts=[]
    for rid in ids:
        if (w.OUT/'records'/rid/'distractors.json').exists():raise ValueError('Explicit counterpart files require standard counterpart review: '+rid)
        if (w.OUT/'records'/rid/'gold.json').exists() and w.read_json(w.OUT/'records'/rid/'gold.json').get('gold_provenance'):raise ValueError('Already independently accepted: '+rid)
        text,imgs,manifest=context(rid);texts.append(text);images.extend(imgs);views.append(manifest)
    if len(images)>110 or sum(map(len,texts))>600000:raise ValueError('Batch exceeds selected-source review bounds')
    job='batch-'+hashlib.sha256(json.dumps(views,sort_keys=True).encode()).hexdigest()[:12];calls=w.OUT/'calls'/job;directory=w.OUT/'batches'/job;directory.mkdir(parents=True,exist_ok=True)
    w.atomic_json(directory/'source-views.json',views)
    item={'type':'object','properties':{'record_id':{'type':'string'},'accept':{'type':'boolean'},'gold_json':{'type':'string'},'reason':{'type':'string'}},'required':['record_id','accept','gold_json','reason'],'additionalProperties':False}
    schema=directory/'schema.json';w.atomic_json(schema,{'type':'object','properties':{'records':{'type':'array','items':item}},'required':['records'],'additionalProperties':False})
    instructions='Return {"records":[{"record_id":"...","accept":true,"gold_json":"serialized gold object","reason":"..."}]}. Each BEGIN/END RECORD block is a separate target affidavit. Never transfer quotations, events, labels or dates between records. Assess each separately; reject individual uncertain or easy records without rejecting sound peers. Return exactly one result for every requested record ID. A shared author/review call does not make the targets one affidavit.\n'
    prompt=f'origin: machine_test; run_id: {w.RUN}\n'+instructions+w.AUTHOR+'\nREQUESTED IDS '+json.dumps(ids)+'\n'+'\n'.join(texts)
    def shape(product):
        if {r['record_id'] for r in product['records']}!=set(ids) or len(product['records'])!=len(ids):raise ValueError('Missing, duplicate or unexpected record result')
        return product
    proposal=w.call(prompt,schema,images,calls/'author',args,shape,budget=budget,policy=w.POLICY)
    review=w.call('Independently review each proposed gold against its own complete affidavit and supplied original/output evidence. Correct the complete gold_json for each accepted record; do not merely agree.\n'+prompt+'\nPROPOSALS\n'+json.dumps(proposal),schema,images,calls/'review',args,shape,budget=budget,policy=w.POLICY)
    receipts={phase:next((calls/phase).glob('*/receipt.json')).relative_to(w.OUT).as_posix() for phase in ['author','review']}
    summary=dict(origin='machine_test',run_id=w.RUN,accepted=[],rejected=[],model_call_attempts=budget['calls'],batch_source_views=(directory/'source-views.json').relative_to(w.OUT).as_posix())
    baseline=set()
    for root in [w.HOME/'benchmarks/court-record-exhibits/records',w.ROOT/'benchmarks/court-record-exhibits/records',w.OUT/'records']:
        for path in root.glob('*/gold.json'):
            gold=w.read_json(path)
            if root==w.OUT/'records' and not gold.get('gold_provenance'):continue
            baseline.add((gold.get('deponent','').casefold(),gold.get('sworn_date','')))
    for result in review['records']:
        rid=result['record_id'];dest=w.OUT/'records'/rid
        if not result['accept']:summary['rejected'].append(dict(record_id=rid,reason=result['reason']));continue
        try:
            gold=w.align_anchors(json.loads(result['gold_json']),(dest/'affidavit.txt').read_text(encoding='utf-8'));assert gold['record_id']==rid
            if (gold.get('deponent','').casefold(),gold.get('sworn_date','')) in baseline:raise ValueError('Deponent/execution identity already in baseline')
            w.atomic_json(dest/'gold.json',gold);errors=w.verify.check(str(dest))
            if errors:raise ValueError('; '.join(errors))
            gold['gold_provenance']=dict(label='Codex independently source-reviewed gold (hard tier)',origin='machine_test',run_id=w.RUN,model=args.model,effort=args.effort,method='Separate author and independent reviewer calls for an explicitly partitioned batch. Complete target affidavit and exact selected source/output evidence recorded separately for this record. No per-record call receipt fabricated.',recorded=datetime.now(timezone.utc).date().isoformat(),author_receipt=receipts['author'],review_receipt=receipts['review'],review_reason=result['reason'],batch_id=job)
            w.atomic_json(dest/'gold.json',gold);w.atomic_json(dest/'review-selection.json',next(v for v in views if v['record_id']==rid));summary['accepted'].append(rid)
            baseline.add((gold.get('deponent','').casefold(),gold.get('sworn_date','')))
        except Exception as exc:
            (dest/'gold.json').unlink(missing_ok=True);summary['rejected'].append(dict(record_id=rid,reason='Independent output failed literal/structural validation: '+str(exc)))
    w.atomic_json(w.OUT/(f'summary-{job}.json'),summary);print(json.dumps(summary),flush=True)

if __name__=='__main__':main(sys.argv[1:])
