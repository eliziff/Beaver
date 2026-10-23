"""Replay reviewed running-folio pixel masks on scanned benchmark derivatives."""
import pathlib,json,fitz,sys,os,re
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[2]/'benchmarks/court-record-exhibits'))
import split

def apply(record,ocr):
    meta=json.loads((record/'split.json').read_text(encoding='utf-8'))
    if meta.get('folio_pixel_mask_version')==2:return
    source_meta=json.loads((record/'source.json').read_text(encoding='utf-8'))
    with fitz.open(ocr) as source:
        detected=split.record_folios(source,0,len(source)-1)
        masks={}
        for page,rects in detected.items():
            words=source[page].get_text('words')
            masks[page]=[fitz.Rect(word[:4])+(-2,-2,2,2) for word in words
                         if word[4].isdecimal() and any(fitz.Rect(word[:4]).intersects(r+(-2,-2,2,2)) for r in rects)]
        original=pathlib.Path(os.path.expandvars(r'%LOCALAPPDATA%/OpenLegalData'))/source_meta['canonical_source_path']
        with fitz.open(original) as native:
            assert len(native)==len(source)
            for page,rects in split.record_folios(native,0,len(native)-1).items():
                sx,sy=source[page].rect.width/native[page].rect.width,source[page].rect.height/native[page].rect.height
                for word in native[page].get_text('words'):
                    if word[4].isdecimal() and any(fitz.Rect(word[:4]).intersects(r+(-2,-2,2,2)) for r in rects):
                        masks.setdefault(page,[]).append(fitz.Rect(word[0]*sx,word[1]*sy,word[2]*sx,word[3]*sy)+(-2,-2,2,2))
            series={}
            for page,p in enumerate(native):
                for word in p.get_text('words'):
                    match=re.fullmatch(r'AB(\d+)',word[4])
                    if match and not .12*p.rect.height<word[1]<.88*p.rect.height:series.setdefault(int(match[1])-page,[]).append((page,word))
            for hits in series.values():
                if len(hits)<3:continue
                for page,word in hits:
                    sx,sy=source[page].rect.width/native[page].rect.width,source[page].rect.height/native[page].rect.height
                    masks.setdefault(page,[]).append(fitz.Rect(word[0]*sx,word[1]*sy,word[2]*sx,word[3]*sy)+(-2,-2,2,2))
        for ex in meta['exhibits']:
            path=record/'files'/ex['file']
            with fitz.open(path) as doc:
                retained={}
                for output_page,source_page in enumerate(ex['source_pages']):
                    rectangles=masks.get(source_page-1,[])
                    if not rectangles:continue
                    retained[str(source_page)]=[list(r) for r in rectangles]
                    page=doc[output_page]
                    for rectangle in rectangles:page.add_redact_annot(rectangle,fill=(1,1,1))
                    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
                    for rectangle in rectangles:page.draw_rect(rectangle+(-4,-1,4,1),fill=(1,1,1),color=None,overlay=True)
                if retained:
                    doc.saveIncr()
                    ex['folio_pixel_masks']=retained
                    ex['folio_mask_provenance']='Source page-correlated marginal integer sequence; full source OCR glyph rectangle pixel-masked to remove compiled filing order.'
                (path.with_suffix('.txt')).write_text(split.text_of(doc),encoding='utf-8')
    meta['folio_pixel_masks_applied']=True
    meta['folio_pixel_mask_version']=2
    (record/'split.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')

if __name__=='__main__':
    root=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada')
    for source in root.glob('**/records/*/source.json'):
        m=json.loads(source.read_text(encoding='utf-8'))
        apply(source.parent,pathlib.Path(m['ocr_derivative']))
