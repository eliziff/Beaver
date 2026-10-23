"""Small invented-source check for page ownership and masking boundaries."""
import hashlib, tempfile
from pathlib import Path
import fitz
import regulatory_expand as w
import regulatory_visual as visual

def main():
    body='1. The revised bearing placement was confirmed in the signed engineering sketch on 3 February 2024.'
    gold={'exhibits':[{'references':[{'paragraph':11,'quote':'The revised bearing placement was confirmed in the signed engineering sketch on 3 February 2024. Extra OCR tail'}]}],'events':[]}
    aligned=w.align_anchors(gold,body)
    assert aligned['exhibits'][0]['references'][0]['quote'] in w.verify.fold(body)
    assert aligned['paragraphs_by_eye']==[11] and aligned['extraction_anchor_alignment']
    scratch=w.ROOT/'.tmp';scratch.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='regulatory-selfcheck-',dir=scratch) as tmp:
        root=Path(tmp);w.HOME=root;w.OUT=root/'output';w.retrieved=lambda row:None
        doc=fitz.open()
        for text in ['Invented affidavit\n1. On 3 February 2024 I received the engineering sketch.','EXHIBIT A: invented certification','Invented engineering sketch: revised bearing placement.']:
            page=doc.new_page();page.insert_text((50,80),text)
        source=root/'source.pdf';doc.save(source);doc.close()
        sha=hashlib.sha256(source.read_bytes()).hexdigest();rid='reg-'+sha[:12]
        row={'sha256':sha,'path':'source.pdf','pages':3,'url':'https://example.invalid/invented-source.pdf','label':'Independently invented technical affidavit'}
        plan={'affidavit_pages':[1],'exhibits':[{'label':'A','source_pages':[3],'cover_page':2,'blanks':{}}]}
        dest=visual.materialize(row,plan,{'record_id':rid})
        with fitz.open(dest/'files'/visual.name(rid,'A')) as result:
            assert len(result)==1 and 'revised bearing' in result[0].get_text() and 'EXHIBIT A' not in result[0].get_text()
        for invalid in [{'affidavit_pages':[1],'exhibits':[{'label':'A','source_pages':[1],'blanks':{}}]}, {'affidavit_pages':[1],'exhibits':[{'label':'A','source_pages':[3],'blanks':{'3':[[-.1,0,.3,.5]]}}]}]:
            try:visual.materialize(row,invalid,{'record_id':rid})
            except AssertionError:pass
            else:raise AssertionError('Invalid ownership or mask was accepted')
    print('Page selection, cover exclusion, overlapping ownership and mask-boundary checks passed.')

if __name__=='__main__':main()
