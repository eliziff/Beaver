"""Build the explicitly partial, source-preserving Widdowson association record."""
import pathlib,json,hashlib,os,shutil,fitz
import canada_jccf as lane
w=lane.w

def main():
    rid='nsarb-ab-academic-2a09149718';record=w.OUT/'records'/rid;assert record.resolve().is_relative_to(w.OUT)
    result=w.read_json(w.OUT/'widdowson-boundaries.json');assert result['accept'];manifest=json.loads(result['gold_json']);excluded=[e for e in manifest['exhibits'] if any(m['body_overlap'] for m in e['stamp_masks'])];assert {e['label'] for e in excluded}=={'B','D','V'}
    ocr=w.OUT/'ocr'/f'{rid}.pdf';old=w.read_json(record/'split.json');newfiles=record/'projection-files';newfiles.mkdir(exist_ok=True);exhibits=[]
    with fitz.open(ocr) as source:
        aff=w.split.clean_copy(source,[p-1 for p in manifest['affidavit_pages']]);aff.save(record/'affidavit.projection.pdf',garbage=4,deflate=True);(record/'affidavit.projection.txt').write_text(w.split.text_of(aff),encoding='utf-8')
        for e in manifest['exhibits']:
            if e in excluded:continue
            masks={}
            for m in e['stamp_masks']:
                assert not m['body_overlap'];p=m['source_page']-1;r=source[p].rect;box=m['rect_fraction'];masks.setdefault(p,[]).append([box[0]*r.width,box[1]*r.height,box[2]*r.width,box[3]*r.height])
            pages=[p-1 for p in e['source_pages']];doc=w.split.clean_copy(source,pages,blank=masks);name='doc-'+hashlib.sha256((rid+e['label']).encode()).hexdigest()[:10]+'.pdf';doc.save(newfiles/name,garbage=4,deflate=True);(newfiles/pathlib.Path(name).with_suffix('.txt')).write_text(w.split.text_of(doc),encoding='utf-8')
            exhibits.append({'label':e['label'],'file':name,'source_pages':e['source_pages'],'cover_page':e['cover_page'],'stamp_page':e['stamp_page'] if e['stamp_page'] in e['source_pages'] else None,'reviewed_stamp_masks':e['stamp_masks'],'source_content_identity':e['content_identity']})
    known={e['file'] for e in old['exhibits']};known|={str(pathlib.Path(n).with_suffix('.txt')) for n in list(known)};files=record/'files';assert all(p.name in known for p in files.iterdir())
    for p in files.iterdir():assert p.resolve().is_relative_to(record);p.unlink()
    for p in newfiles.iterdir():shutil.move(p,files/p.name)
    newfiles.rmdir();os.replace(record/'affidavit.projection.pdf',record/'affidavit.pdf');os.replace(record/'affidavit.projection.txt',record/'affidavit.txt')
    split={'record_id':rid,'affidavit_pages':manifest['affidavit_pages'],'exhibits':exhibits,'leak_audit':[],'association_scope':'partial_source_projection','source_exhibit_inventory':manifest['exhibits'],'source_exhibit_exclusions':[{'label':e['label'],'source_pages':e['source_pages'],'reason':'Outer certification ink overlaps substantive body; immutable original retains the evidence; excluded from evaluated target and distractor files.'} for e in excluded]}
    w.atomic_json(record/'split.json',split);meta=w.read_json(record/'source.json');meta.update(association_scope=split['association_scope'],source_exhibit_inventory=split['source_exhibit_inventory'],source_exhibit_exclusions=split['source_exhibit_exclusions'],source_review_extra_pages=[p for e in excluded for p in e['source_pages']],boundary_receipt='jccf/widdowson-boundaries.json');w.atomic_json(record/'source.json',meta);lane.lane.canada_masks.apply(record,ocr)
    print('Partial source projection:',len(exhibits),'evaluated;',len(excluded),'explicit exclusions;',len(manifest['affidavit_pages']),'affidavit pages')

if __name__=='__main__':main()
