"""Reviewed corrections for source stamps extending beyond OCR text blocks."""
import pathlib,json,fitz

BASE=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada/jccf')

def main():
    record=BASE/'records/nsarb-sk-urpride-9713d7fbbe';p=record/'split.json';split=json.loads(p.read_text(encoding='utf-8'))
    for exhibit in split['exhibits']:
        if exhibit.get('reviewed_residual_stamp_mask'):continue
        path=record/'files'/exhibit['file']
        with fitz.open(path) as doc:
            page=doc[0];bounds=[.56,.07,.91,.145];r=fitz.Rect(bounds[0]*page.rect.width,bounds[1]*page.rect.height,bounds[2]*page.rect.width,bounds[3]*page.rect.height)
            page.add_redact_annot(r,fill=(1,1,1));page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS);page.draw_rect(r,fill=(1,1,1),color=None,overlay=True);doc.saveIncr()
            import sys
            sys.path.insert(0,'benchmarks/court-record-exhibits');import split as primitives
            path.with_suffix('.txt').write_text(primitives.text_of(doc),encoding='utf-8')
        exhibit['reviewed_residual_stamp_mask']={'source_page':exhibit['stamp_page'],'output_page':1,'rect_fraction':bounds,'reason':'Date and blue commissioner signature remnants above the policy body; visible source policy issue dates remain in the footer.'}
    p.write_text(json.dumps(split,indent=2),encoding='utf-8')

if __name__=='__main__':main()
