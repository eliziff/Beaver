"""Replay explicit corrected exhibit ranges and outer record-folio masks."""
import collections, json, sys
from pathlib import Path
import fitz
import regulatory_expand as work

CUTOFFS={'reg-489a1e0ee0a6':{'P':83},'reg-186781300924':{'J':198},'reg-b2f4b0e67101bb':{'C':494},'reg-b2f4b0e67101f1':{'C':558},'reg-769b5f446f009a':{'C':241},'reg-a1954f722166':{'N':82},'reg-0c0d3a10e900a2':{'E':183}}
AFFIDAVIT_STARTS={'reg-b2f4b0e67101f1':496,'reg-186781300924':6}
VECTOR_ONLY={'reg-0c0d3a10e900a2':[15,9,267,21]}
DROPS={'reg-61e71d37abce':{9,39,55},'reg-cf28cc0e43a9':{17,22,27,33,42,47,51}}

def repair(rid):
    dest=work.OUT/'records'/rid;source=work.read_json(dest/'source.json');split=work.read_json(dest/'split.json')
    manifest=dest/'preparation.json'
    if manifest.exists(): plan=work.read_json(manifest)
    else:
        masks={};positions=collections.defaultdict(list)
        with fitz.open(work.HOME/source['canonical_source_path']) as doc:
            for n,page in enumerate(doc,1):
                for word in page.get_text('words'):
                    text=word[4]
                    if not text.isdecimal() or abs(int(text)-n)>12:continue
                    rect=fitz.Rect(word[:4]);shown=rect*page.rotation_matrix
                    x=(shown.x0+shown.x1)/2/page.rect.width;y=(shown.y0+shown.y1)/2/page.rect.height
                    if .12<x<.88 and .12<y<.88:continue
                    positions[(round(x,1),round(y,1))].append((n,list(rect)))
            for items in positions.values():
                if len(items)>=5:
                    for n,rect in items:masks.setdefault(str(n),[]).append(rect)
        plan={'source_sha256':source['source_sha256'],'source_path':source['canonical_source_path'],
              'affidavit_pages':split['affidavit_pages'],'exhibits':split['exhibits'],
              'outer_folio_rects':masks,'cutoffs':CUTOFFS.get(rid,{}),
              'reason':'Corrected separate-submissions boundary from independent source review; remove isolated outer folios in repeated margin positions tracking physical record order, including rotated pages.'}
        work.atomic_json(manifest,plan)
    plan['drop_pages']=sorted(set(plan.get('drop_pages',[]))|DROPS.get(rid,set()))
    plan['cutoffs'].update(CUTOFFS.get(rid,{}))
    drops=set(plan['drop_pages'])
    with fitz.open(work.HOME/plan['source_path']) as doc:
        if rid in AFFIDAVIT_STARTS:
            plan['affidavit_pages']=list(range(AFFIDAVIT_STARTS[rid],max(plan['affidavit_pages'])+1));split['affidavit_pages']=plan['affidavit_pages']
            affidavit=work.split.clean_copy(doc,[n-1 for n in plan['affidavit_pages']]);work.atomic_write(dest/'affidavit.pdf',affidavit.tobytes(garbage=4,deflate=True));(dest/'affidavit.txt').write_text(work.split.text_of(affidavit),encoding='utf-8');affidavit.close()
        for ex in plan['exhibits']:
            pages=[n for n in ex['source_pages'] if n<=plan['cutoffs'].get(ex['label'],10**9) and n not in drops]
            masks={n-1:[fitz.Rect(r) for r in plan['outer_folio_rects'].get(str(n),[])] for n in pages}
            if ex.get('stamp_page') in pages:
                _,_,rects=work.split.cover_label(doc[ex['stamp_page']-1]);masks.setdefault(ex['stamp_page']-1,[]).extend(rects)
            pdf=work.split.clean_copy(doc,[n-1 for n in pages],masks)
            if rid in VECTOR_ONLY:
                rect=fitz.Rect(VECTOR_ONLY[rid])
                for page in pdf:
                    text=page.get_text();images=[pdf.extract_image(x[0])['image'] for x in page.get_images()]
                    page.add_redact_annot(rect,fill=False,cross_out=False)
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,text=fitz.PDF_REDACT_TEXT_NONE)
                    assert page.get_text()==text,'Vector-only packet removal altered native substantive text'
                    assert [pdf.extract_image(x[0])['image'] for x in page.get_images()]==images,'Vector-only packet removal altered embedded images'
                plan['vector_only_removal']={'rect':VECTOR_ONLY[rid],'source_pages':[n for e in plan['exhibits'] for n in e['source_pages'] if n<=plan['cutoffs'].get(e['label'],10**9)],'images':'preserved byte-for-byte','native_text':'preserved exactly','fill':False,'source_inspection':'review/hammett-headers.png','documentation':'https://pymupdf.readthedocs.io/en/latest/page.html#Page.apply_redactions','purpose':'Remove outlined outer packet ID without obscuring overlapping original webpage pixels or text.'}
            target=dest/'files'/ex['file'];target.unlink(missing_ok=True);pdf.save(target,garbage=4,deflate=True)
            target.with_suffix('.txt').write_text(work.split.text_of(pdf),encoding='utf-8');pdf.close()
            ex['source_pages']=pages
            if ex.get('stamp_page') in drops:ex['cover_page']=ex.pop('stamp_page');ex['stamp_page']=None
    split['exhibits']=plan['exhibits'];split['preparation_manifest']='preparation.json';split['reviewed_source_cutoffs']=plan['cutoffs'];split['outer_folio_rects']=plan['outer_folio_rects']
    work.atomic_json(manifest,plan)
    work.atomic_json(dest/'split.json',split)
    if 'page_range' in source:
        source['page_range']=[min(split['affidavit_pages']),max(n for ex in split['exhibits'] for n in ex['source_pages'])];work.atomic_json(dest/'source.json',source)
    print(rid,'replayed',len(split['exhibits']),'exhibits',sum(len(x['source_pages']) for x in split['exhibits']),'pages')

if __name__=='__main__':
    for rid in sys.argv[1:]:repair(rid)
