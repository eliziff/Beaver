"""Prepare previously unannotated sworn bodies in existing compiled sources for review."""
import collections, re, subprocess, sys
import fitz
import regulatory_expand as w

PRIORITY=['9630566b50','fa231246ff','9f0e7564e3','a0ef75385e','af023a5bd9','a38c0975a4','6063abbebb','2093c7a2d0','f453fdf45f','8553e8f25a','68bc74497f','7ee145f980','c39bb8c13e','dd6f203c6f','52f11fb7e4','301bb554cc']

def main():
    groups=collections.defaultdict(list)
    for row in w.read_json(w.ROOT/'benchmarks/local-data/affidavit-association/source-leads.json'):
        if w.os.environ.get('REGULATORY_LEAD_SHA') and not row['sha256'].startswith(w.os.environ['REGULATORY_LEAD_SHA']):continue
        excluded=re.search(r'(?i)CCAA|receiver|insolvenc|proposal|Mizrahi|Ruscetta|Blasutti|Paladin|Iovate|Aziz|Gatzka|GrowthWorks',row.get('label',''))
        if not excluded and (row.get('jurisdiction') in {'on','bc','ca'} or any(row['sha256'].startswith(p) for p in PRIORITY)):groups[row['sha256']].append(row)
    prepared=w.read_json(w.OUT/'prepared.json');ids={x['record_id'] for x in prepared}
    known=collections.defaultdict(set)
    for root in [w.HOME/'benchmarks/court-record-exhibits/records',w.ROOT/'benchmarks/court-record-exhibits/records']:
        for file in root.glob('*/source.json'):
            s=w.read_json(file);sp=file.with_name('split.json')
            if sp.exists():known[s.get('source_sha256')].update(w.read_json(sp).get('affidavit_pages',[]))
    for sha,leads in groups.items():
        source=leads[0];path=w.HOME/source['path']
        if not path.exists():
            print('unavailable canonical path',sha[:12],flush=True);continue
        with fitz.open(path) as doc:
            covers=[(i+1,*w.split.cover_label(p)[:2]) for i,p in enumerate(doc)];covers=[x for x in covers if x[1]]
            def body_start(lead):
                first=lead['page'];heading=re.search(r'(?i)affidavit\s+of\s+([^\n]{5,80})',lead['text'])
                if first>1 and heading and heading.group(1).casefold() in doc[first-2].get_text().casefold() and len(doc[first-2].get_text())<2500:first-=1
                if first>1:
                    previous=doc[first-2].get_text();compact=re.sub(r'\s+','',previous).upper()
                    if previous.lstrip().lower().startswith('court file') and 'SUPERIORCOURTOFJUSTICE' in compact and 'BETWEEN:' in compact:first-=1
                return first
            allstarts=sorted({body_start(x) for x in leads})
            for lead in sorted(leads,key=lambda x:x['page']):
                first=body_start(lead);after=[c for c in covers if first<c[0]<=first+70 and c[1]=='A']
                if not after:continue
                cover=after[0][0]
                if cover-first>40:continue
                if set(range(first,cover))&known[sha]:continue
                nextbody=min((p for p in set(allstarts)|known[sha] if p>cover),default=len(doc)+1)
                nexta=min((p for p,l,whole in covers if p>cover and l=='A'),default=len(doc)+1)
                last=min(nextbody-1,nexta-1,len(doc))
                cs=[x for x in covers if cover<=x[0]<=last]
                if len(cs)<2 or len({x[1] for x in cs})!=len(cs) or last-first>400:continue
                rid='reg-'+sha[:10]+f'{lead["page"]:04x}'
                dest=w.OUT/'records'/rid
                if (dest/'exclusion.json').exists():continue
                if rid in ids:
                    meta=w.read_json(dest/'source.json');sp=w.read_json(dest/'split.json')
                    if meta['page_range']==[first,last]:continue
                    assert not (w.OUT/'calls'/rid).exists(), 'A called source needs explicit reviewed repair'
                    sp['affidavit_pages']=list(range(first,max(sp['affidavit_pages'])+1))
                    affidavit=w.split.clean_copy(doc,[n-1 for n in sp['affidavit_pages']]);w.atomic_write(dest/'affidavit.pdf',affidavit.tobytes(garbage=4,deflate=True));(dest/'affidavit.txt').write_text(w.split.text_of(affidavit),encoding='utf-8');affidavit.close()
                    folios=w.split.record_folios(doc,0,len(doc)-1)
                    for ex in sp['exhibits']:
                        pages=[n for n in ex['source_pages'] if first<=n<=last];assert pages
                        masks={n-1:list(folios.get(n-1,[])) for n in pages}
                        if ex.get('stamp_page') in pages:masks.setdefault(ex['stamp_page']-1,[]).extend(w.split.cover_label(doc[ex['stamp_page']-1])[2])
                        pdf=w.split.clean_copy(doc,[n-1 for n in pages],masks);target=dest/'files'/ex['file'];w.atomic_write(target,pdf.tobytes(garbage=4,deflate=True));target.with_suffix('.txt').write_text(w.split.text_of(pdf),encoding='utf-8');pdf.close();ex['source_pages']=pages
                    meta['page_range']=[first,last];w.atomic_json(dest/'source.json',meta);w.atomic_json(dest/'split.json',sp)
                    for row in prepared:
                        if row['record_id']==rid:row['pages']=last-first+1
                    w.atomic_json(w.OUT/'prepared.json',prepared);print('corrected',rid,first,last,flush=True);continue
                result=subprocess.run([sys.executable,str(w.ROOT/'benchmarks/court-record-exhibits/split.py'),str(path),rid,'--pages',f'{first}-{last}','--out',str(w.OUT/'records')],capture_output=True,text=True,encoding='utf-8')
                if result.returncode:continue
                split=w.read_json(dest/'split.json')
                if len(split['exhibits'])<2:continue
                labels=[ex['label'] for ex in split['exhibits']]
                if labels!=[chr(ord('A')+i) for i in range(len(labels))]:
                    w.atomic_json(dest/'exclusion.json',{'origin':'machine_test','run_id':w.RUN,'reason':'Automatic split omitted leading or intermediate exhibit assignments; requires explicit complete source-boundary authoring','observed_labels':labels});continue
                meta=w.read_json(dest/'source.json');meta.update(url=source['url'],canonical_source_path=source['path'],document_title=source.get('label',''),retrieved=None,acquisition_note='Existing canonical corpus source; historical acquisition date retained in corpus.sqlite, not guessed.',origin='machine_test',run_id=w.RUN)
                w.atomic_json(dest/'source.json',meta)
                prepared.append({'sha256':sha,'path':source['path'],'pages':last-first+1,'label':source.get('label','')+f' — distinct body at physical page {first}','url':source['url'],'record_id':rid})
                ids.add(rid);w.atomic_json(w.OUT/'prepared.json',prepared)
                print('nested',rid,first,last,len(split['exhibits']),len(split['leak_audit']),flush=True)

if __name__=='__main__':main()
