"""Remove reviewed misplaced native filing overlays without painting over their scan.

PyMuPDF documents fill=False as transparent and images=0/graphics=0 as preservation:
https://pymupdf.readthedocs.io/en/latest/page.html#Page.add_redact_annot
Only source hashes explicitly registered in the private record manifest are processed.
Image-byte preservation alone does not establish rendering fidelity: one registered
historical scan renders blank after this operation and remains rejected. Every use
therefore requires an independent review of the materialized page images.
"""
import hashlib
import json
import re
import sys

import fitz
from us_expand import ROOT,OUT,dump
sys.path.insert(0,str(ROOT/'benchmarks/court-record-exhibits'))
import split


STAMP=re.compile(r'^\s*Case:?\s+\S+.*\bDocument\s+\d+(?:-\d+)?\s+.*\bFiled\s+\d{1,2}/\d{1,2}/\d{2,4}\s+.*\bPage(?:\s+\d+)?',re.I)
DATE=re.compile(r'\bFiled\s+\d{1,2}/\d{1,2}/\d{2,4}\b',re.I)


def image_hashes(doc,page):
    return [hashlib.sha256(doc.extract_image(x[0])['image']).hexdigest() for x in page.get_images(full=True)]


def remove_overlays(doc,pages):
    audit=[]
    for n in pages:
        page=doc[n]
        lines=[line for block in page.get_text('dict')['blocks'] for line in block.get('lines',[])]
        stamps=[line for line in lines if STAMP.match(''.join(s['text'] for s in line['spans']))]
        if not stamps:
            if any(split.ECF_HEADER.match(''.join(s['text'] for s in line['spans'])) for line in lines):
                raise ValueError('Identifying native filing wrapper remains outside the reviewed stamp grammar')
            continue
        originals=image_hashes(doc,page)
        removals=[]
        for line in stamps:
            text=''.join(s['text'] for s in line['spans'])
            bounds=fitz.Rect(line['bbox'])
            date=DATE.search(text).group()
            dates=[r for r in page.search_for(date) if r.intersects(bounds)]
            if len(dates)!=1:
                raise ValueError('Filing date is not uniquely bound to its exact native stamp')
            keep=dates[0]
            if bounds.width>=bounds.height:
                pieces=[fitz.Rect(bounds.x0,bounds.y0,keep.x0-.5,bounds.y1),fitz.Rect(keep.x1+.5,bounds.y0,bounds.x1,bounds.y1)]
            else:
                pieces=[fitz.Rect(bounds.x0,bounds.y0,bounds.x1,keep.y0-.5),fitz.Rect(bounds.x0,keep.y1+.5,bounds.x1,bounds.y1)]
            pieces=[r for r in pieces if not r.is_empty]
            for other in lines:
                if other in stamps:
                    continue
                if any(fitz.Rect(other['bbox']).intersects(r) for r in pieces):
                    raise ValueError('Native stamp intersects substantive native text; manual source handling required')
            for rectangle in pieces:
                page.add_redact_annot(rectangle,fill=False,cross_out=False)
            removals.append({'header':text,'kept_date':date,'kept_date_rect':list(keep),'removed_native_rects':[list(r) for r in pieces]})
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,graphics=fitz.PDF_REDACT_LINE_ART_NONE)
        if image_hashes(doc,page)!=originals:
            raise ValueError('Native-only removal altered underlying source image bytes')
        if any(STAMP.match(line) for line in page.get_text().splitlines()):
            raise ValueError('Native identifying stamp remains after removal')
        audit.append({'output_page':n+1,'underlying_image_sha256s':originals,'native_only_no_fill':True,'removals':removals})
    return audit


def apply(target,directory):
    config=OUT/'record-native-headers.json'
    allowed=set(json.loads(config.read_text(encoding='utf8')).get(target.name,[])) if config.exists() else set()
    if not allowed:
        return
    path=target/'split.json'
    manifest=json.loads(path.read_text(encoding='utf8'))
    processed=[]
    for exhibit in manifest['exhibits']:
        offset=0
        pages=[]
        for part in exhibit['source_files']:
            if part['file'].removesuffix('.pdf') in allowed:
                pages.extend(range(offset,offset+len(part['pages'])))
            offset+=len(part['pages'])
        if not pages:
            continue
        pdf=target/'files'/exhibit['file']
        before=hashlib.sha256(pdf.read_bytes()).hexdigest()
        with fitz.open(pdf) as doc:
            audit=remove_overlays(doc,pages)
            data=doc.tobytes(garbage=4,deflate=True)
            text=split.text_of(doc)
        pdf.write_bytes(data)
        pdf.with_suffix('.txt').write_text(text,encoding='utf8')
        processed.append({'file':exhibit['file'],'before_sha256':before,'after_sha256':hashlib.sha256(data).hexdigest(),'audit':audit})
    manifest['native_filing_overlay_processing']={'tool':'experiments/affidavit-association/us_native_headers.py',
       'method':'Exact registered source hashes; remove only native Case/Document/Page glyphs anywhere on page, retain original Filed-date glyphs, no fill, preserve source image bytes and vector graphics.',
       'registered_source_sha256s':sorted(allowed),'files':processed}
    dump(path,manifest)
    dump(directory/'native-filing-overlay-audit.json',manifest['native_filing_overlay_processing'])


if __name__=='__main__':
    from pathlib import Path
    record=Path(sys.argv[1]).resolve()
    apply(record,OUT/'work'/record.name)
