"""Author source page selections and independent gold from compact scanned filings."""
import hashlib, json, os, re, sys
from pathlib import Path
from types import SimpleNamespace
import fitz
import regulatory_expand as w

PREFIXES=['ab95e370c168','fd87a753267d','887bb77043d4','b72a5268945b','5c06be511326','904e188c7380','a054655dc480','993ab1fd5b0e','6f94e2c1aad6','887b5d0ece4c','c7adef47fee1','8facabaaa95b','c4ccb97490a9','7eae0cb659aa','37f5b5e3c61c','2e632e4184b7','2695c9898f26','56633f0d3fcf']
PLAN='''Independently establish the exact affidavit body and outer exhibit boundaries from ALL original source page images, in physical page order. Return plan_json as JSON {"affidavit_pages":[1,2],"exhibits":[{"label":"A","source_pages":[4,5],"cover_page":3,"blanks":{"4":[[0.8,0.94,0.94,0.98]]}}]}. Pages are one-based physical PDF pages. Exclude separate submissions, backing sheets and other affidavits; include all content pages of each exhibit AS FILED. Source pages must not overlap between exhibits or affidavit. Cover pages are omitted; a stamp on content is masked using blanks (fractions of displayed page). Remove ALL outer assignment stamps, added record folios and filing identifiers from exhibit pages, including scanned pixels; preserve substantive evidence, embedded original pagination and nested older exhibits. Provide exact tight mask rectangles with a little safe white margin, not whole bands through content. Use an empty blanks object when no masks needed. These selections will be materialized then independently reviewed. Every exhibit file is deterministically doc-<sha256(recordid+label)[:8]>.pdf; use those exact supplied names in gold. Return accept=false if no reliable affidavit with attached evidence or genuine difficulty can be established. A complete filed excerpt is allowed. A foreign province outside BC/ON/federal courts/tribunals belongs to another lane: reject it. Do not call an unfiled unsigned draft a sworn affidavit.\n'''

def name(rid,label):return 'doc-'+hashlib.sha256((rid+label).encode()).hexdigest()[:8]+'.pdf'

def materialize(row,plan,gold):
    rid='reg-'+row['sha256'][:12];dest=w.OUT/'records'/rid;dest.mkdir(parents=True,exist_ok=True);(dest/'files').mkdir(exist_ok=True)
    old_split=w.read_json(dest/'split.json') if (dest/'split.json').exists() else {'exhibits':[]}
    assert gold['record_id']==rid
    used=set(plan['affidavit_pages']);assert used
    source={'record_id':rid,'url':row['url'],'source_sha256':row['sha256'],'source_pages':row['pages'],'canonical_source_path':row['path'],'document_title':row['label'],'retrieved':w.retrieved(row),'origin':'machine_test','run_id':w.RUN}
    split={'record_id':rid,'affidavit_pages':plan['affidavit_pages'],'exhibits':[],'leak_audit':[],'preparation_manifest':'preparation.json'}
    with fitz.open(w.HOME/row['path']) as doc:
        aff=w.split.clean_copy(doc,[n-1 for n in plan['affidavit_pages']]);target=dest/'affidavit.pdf';target.unlink(missing_ok=True);aff.save(target,garbage=4,deflate=True)
        text=w.split.text_of(aff,ocr=True,cli=True);(dest/'affidavit.txt').write_text(text,encoding='utf-8');aff.close()
        for ex in plan['exhibits']:
            pages=ex['source_pages'];assert pages and not (set(pages)&used);assert all(1<=n<=len(doc) for n in pages);used.update(pages)
            masks={}
            for key,rects in ex.get('blanks',{}).items():
                n=int(key);assert n in pages;page=doc[n-1];un=page.derotation_matrix
                assert all(0<=a<c<=1 and 0<=b<d<=1 for a,b,c,d in rects)
                masks[n-1]=[list(fitz.Rect(a*page.rect.width,b*page.rect.height,c*page.rect.width,d*page.rect.height)*un) for a,b,c,d in rects]
            pdf=w.split.clean_copy(doc,[n-1 for n in pages],blank=masks)
            file=name(rid,ex['label']);target=dest/'files'/file;target.unlink(missing_ok=True);pdf.save(target,garbage=4,deflate=True)
            target.with_suffix('.txt').write_text(w.split.text_of(pdf,ocr=True,cli=True),encoding='utf-8');pdf.close()
            split['exhibits'].append({'label':ex['label'],'file':file,'source_pages':pages,'cover_page':ex.get('cover_page'),'stamp_page':None,'blanks':ex.get('blanks',{})})
    expected={x['file'] for x in split['exhibits']}
    for ex in old_split['exhibits']:
        old=ex['file']
        if old not in expected and re.fullmatch(r'doc-[a-z0-9]+\.pdf',old):
            (dest/'files'/old).unlink(missing_ok=True);(dest/'files'/Path(old).with_suffix('.txt')).unlink(missing_ok=True)
    for k,v in [('source.json',source),('split.json',split),('preparation.json',plan),('gold.json',gold)]:w.atomic_json(dest/k,v)
    return dest

def main():
    out=w.OUT;schema=out/'visual-schema.json';w.atomic_json(schema,{'type':'object','properties':{'accept':{'type':'boolean'},'plan_json':{'type':'string'},'gold_json':{'type':'string'},'reason':{'type':'string'}},'required':['accept','plan_json','gold_json','reason'],'additionalProperties':False})
    shard=os.environ.get('REGULATORY_SHARD','');index,count=(map(int,shard.split('/')) if shard else (0,1))
    belongs=lambda rid:w.shard_bucket(rid,count)==index
    args=SimpleNamespace(model='gpt-6.1-sol',effort='medium',attempts=2,timeout=1500,max_calls=80//count)
    budget={'calls':sum(len(w.read_json(p)['attempts']) for p in out.glob('calls/*/*/*/receipt.json') if belongs(p.relative_to(out/'calls').parts[0]))}
    target=out/(f'summary-{index}.json' if shard else 'summary.json');summary=w.read_json(target if target.exists() else out/'summary.json')
    completed=set(summary['accepted'])|{x['record_id'] for x in summary['rejected']}
    recovery=w.read_json(out/'recover.json') if (out/'recover.json').exists() else []
    completed-=set(recovery)
    baseline=set()
    for root in [w.HOME/'benchmarks/court-record-exhibits/records',w.ROOT/'benchmarks/court-record-exhibits/records']:
        for p in root.glob('*/gold.json'):
            g=w.read_json(p);baseline.add((re.sub(r'\W','',g.get('deponent','').casefold()),g.get('sworn_date','')))
    rows=[x for x in w.read_json(out/'sources.json') if any(x['sha256'].startswith(p) for p in PREFIXES) or 'reg-'+x['sha256'][:12] in recovery]
    rows.sort(key=lambda x:(0 if 'reg-'+x['sha256'][:12] in recovery else 1,PREFIXES.index(next((p for p in PREFIXES if x['sha256'].startswith(p)),PREFIXES[0]))))
    for row in rows:
        rid='reg-'+row['sha256'][:12]
        if not belongs(rid):continue
        if rid in completed:continue
        if budget['calls']>=args.max_calls:break
        image_dir=out/'review'/rid;image_dir.mkdir(parents=True,exist_ok=True);images=[];text=''
        with fitz.open(w.HOME/row['path']) as doc:
            for i,page in enumerate(doc,1):
                path=image_dir/f'original-{i:04}.jpg'
                if not path.exists():page.get_pixmap(matrix=fitz.Matrix(1.4,1.4)).save(path)
                images.append(path)
                t=page.get_text()
                if i<=18 and len(t.split())<30:t=w.split.tesseract_cli(page)
                text+=f'\nSOURCE PAGE {i}\n'+t
        prompt=f'origin: machine_test; run_id: {w.RUN}\nRecord id: {rid}\nSOURCE '+json.dumps(row)+'\n'+PLAN+w.AUTHOR+'\nORIGINAL PAGES are attached in physical order.\nEXTRACTED TEXT (first18 scanned pages OCR):\n'+text
        def validate(value):
            if not value['accept']:return value
            plan=json.loads(value['plan_json']);g=json.loads(value['gold_json'])
            identity=(re.sub(r'\W','',g.get('deponent','').casefold()),g.get('sworn_date',''))
            if identity in baseline:return {'accept':False,'plan_json':'','gold_json':'','reason':'Duplicate baseline deponent and sworn date.'}
            for e in g['exhibits']:
                e['file']=name(rid,e['label'])
            value['gold_json']=json.dumps(g,ensure_ascii=False)
            dest=materialize(row,plan,g);g=w.align_anchors(g,(dest/'affidavit.txt').read_text(encoding='utf-8'));value['gold_json']=json.dumps(g,ensure_ascii=False);w.atomic_json(dest/'gold.json',g);errors=w.verify.check(str(dest))
            if errors:raise ValueError('; '.join(errors))
            return value
        try:
            product=None
            if rid in recovery:
                responses=sorted((out/'calls'/rid).glob('*author/*/attempt-*/last-message.json'),key=lambda p:p.stat().st_mtime,reverse=True)
                for response in responses:
                    candidate=w.read_json(response)
                    if candidate.get('accept') and candidate.get('gold_json'):
                        product=candidate;break
                if product is None:raise ValueError('Recovery has no usable original author response')
                if 'plan_json' not in product:
                    spl=w.read_json(out/'records'/rid/'split.json');product['plan_json']=json.dumps({'affidavit_pages':spl['affidavit_pages'],'exhibits':[{'label':e['label'],'source_pages':e['source_pages'],'cover_page':e.get('cover_page'),'blanks':{}} for e in spl['exhibits']]})
                plan=json.loads(product['plan_json']);g=json.loads(product['gold_json'])
                for e in g['exhibits']:e['file']=name(rid,e['label'])
                dest=materialize(row,plan,g);g=w.align_anchors(g,(dest/'affidavit.txt').read_text(encoding='utf-8'));product['gold_json']=json.dumps(g,ensure_ascii=False)
            else:
                product=w.call(prompt,schema,images,out/'calls'/rid/'visual-author',args,validate,budget=budget,policy=w.POLICY)
            if product['accept']:
                dest=out/'records'/rid;plan=json.loads(product['plan_json']);g=json.loads(product['gold_json']);review_images=images.copy()
                context='\nAFFIDAVIT TEXT\n'+(dest/'affidavit.txt').read_text(encoding='utf-8')
                for ex in w.read_json(dest/'split.json')['exhibits']:
                    file=dest/'files'/ex['file'];version=hashlib.sha256(file.read_bytes()).hexdigest()[:12]
                    context+='\nEXHIBIT '+ex['label']+' '+ex['file']+'\n'+file.with_suffix('.txt').read_text(encoding='utf-8')
                    with fitz.open(file) as doc:
                        for i,page in enumerate(doc,1):
                            path=image_dir/f'{file.stem}-{version}-{i:04}.jpg'
                            if not path.exists():page.get_pixmap(matrix=fitz.Matrix(1.4,1.4)).save(path)
                            review_images.append(path)
                    context+='\nCONTENT IMAGES: '+ex['file']+' pages 1 through '+str(len(ex['source_pages']))
                review='Independently audit the proposed association+chronology and its page selections/masks. Every output content page is shown after original affidavit/cover pages. Check substantive identity, outer-label/folio leaks, date conflicts, every label, all narrated dated events. Correct gold or masks/ranges as necessary using full plan_json and gold_json; reject genuine uncertainty. Gold quotes must copy supplied affidavit OCR EXACTLY.\n'+prompt.split('ORIGINAL PAGES')[0]+context+'\nPROPOSED PLAN\n'+product['plan_json']+'\nPROPOSED GOLD\n'+product['gold_json']
                product=w.call(review,schema,review_images,out/'calls'/rid/'visual-review',args,validate,budget=budget,policy=w.POLICY)
            if product['accept']:
                dest=out/'records'/rid;g=json.loads(product['gold_json']);g['gold_provenance']={'label':'Codex independently source-reviewed gold (hard tier)','origin':'machine_test','run_id':w.RUN,'model':args.model,'effort':args.effort,'recorded':w.datetime.now().astimezone().date().isoformat(),'method':'Author and separate reviewer read every original page image and every anonymous exhibit content image with extracted/OCR text; quotations/labels/dates verified','review_reason':product['reason']};w.atomic_json(dest/'gold.json',g)
                if rid not in summary['accepted']:summary['accepted'].append(rid)
            else:
                (out/'records'/rid/'gold.json').unlink(missing_ok=True);summary['rejected'].append({'record_id':rid,'reason':product['reason']})
        except Exception as e:
            (out/'records'/rid/'gold.json').unlink(missing_ok=True);summary['rejected'].append({'record_id':rid,'reason':str(e)[-1500:]})
        summary['model_call_attempts']=budget['calls'];w.atomic_json(target,summary);print('visual',rid,'accepted',len(summary['accepted']),'calls',budget['calls'],flush=True)
        if rid in recovery:
            summary.setdefault('reopened_history',[]).append({'record_id':rid,'reason':'Original author response retained; corrected full-original and anonymous-content source review with OCR evidence-anchor validation.'});recovery.remove(rid);w.atomic_json(target,summary)

if __name__=='__main__':main()
