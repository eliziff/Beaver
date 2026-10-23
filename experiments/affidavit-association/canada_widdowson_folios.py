"""Remove source-correlated scanned filing folios missed by OCR at section ends."""
import json,pathlib,fitz
import canada_expand as lane
w=lane.workflow
def main():
    record=w.OUT/'jccf/records/nsarb-ab-academic-2a09149718';meta=w.read_json(record/'split.json')
    with fitz.open(w.ROOT/w.read_json(record/'source.json')['ocr_derivative']) as original:
        for ex in meta['exhibits']:
            path=record/'files'/ex['file']
            with fitz.open(path) as doc:
                for n,p in enumerate(ex['source_pages']):
                    rect=fitz.Rect(290,771,325,792)
                    # The filed source prints its compiled folio in this reserved bottom-centre margin.
                    # Refuse if OCR identifies substantive words in the proposed margin.
                    words=[x for x in original[p-1].get_text('words') if fitz.Rect(x[:4]).intersects(rect)]
                    assert all(x[4].isdecimal() for x in words),(p,words)
                    page=doc[n];page.add_redact_annot(rect,fill=(1,1,1));page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS);page.draw_rect(rect,fill=(1,1,1),color=None)
                    ex.setdefault('source_correlated_folio_margin_masks',{})[str(p)]=list(rect)
                doc.saveIncr();path.with_suffix('.txt').write_text(w.split.text_of(doc),encoding='utf-8')
    meta['folio_margin_mask_basis']='Original compiled source folio equals source-page number at bottom centre; OCR misses last-page numerals. Full reserved margin masked only where no substantive OCR intersects; final independent source/image review required.'
    w.atomic_json(record/'split.json',meta)
if __name__=='__main__':main()

