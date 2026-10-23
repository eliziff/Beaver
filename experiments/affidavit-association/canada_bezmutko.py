"""Reviewed boundaries for the handwritten, partially overlapping exhibit stamps."""
import pathlib,json,hashlib,fitz,numpy as np
import canada_masks
import regulatory_expand as w

BASE=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada/jccf').resolve()
RID='nsarb-sk-urpride-939cc0ca7b'

def main():
    row=next(r for r in w.read_json(BASE/'sources.json') if r['sha256'].startswith('939cc0ca7b'))
    original=w.HOME/row['path'];ocr=BASE/'ocr'/f'{RID}.pdf';dest=BASE/'records'/RID;(dest/'files').mkdir(parents=True,exist_ok=True)
    # Read directly on source page images; the email's stamp crosses black text.
    bounds=[('A',4,26,[.52,.60,.94,.76]),('B',27,28,[.51,.80,.91,.95]),('C',29,30,[.53,.21,.94,.35]),('D',31,35,[.32,.11,.70,.25]),('E',36,42,[.44,.21,.85,.36])]
    exhibits=[]
    with fitz.open(ocr) as source:
        affidavit=w.split.clean_copy(source,[0,1]);affidavit.save(dest/'affidavit.pdf',garbage=4,deflate=True);(dest/'affidavit.txt').write_text(w.split.text_of(affidavit),encoding='utf-8')
        for label,first,last,fractions in bounds:
            pages=list(range(first-1,last));doc=w.split.clean_copy(source,pages)
            page=doc[0];rect=fitz.Rect(fractions[0]*page.rect.width,fractions[1]*page.rect.height,fractions[2]*page.rect.width,fractions[3]*page.rect.height)
            if label=='B':
                pix=page.get_pixmap(dpi=180,alpha=False);arr=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,3).copy();x0,y0,x1,y1=[round(v*180/72) for v in rect]
                roi=arr[y0:y1,x0:x1];blue=(roi[:,:,2].astype(int)-roi[:,:,0]>12)&(roi[:,:,2].astype(int)-roi[:,:,1]>5);assert blue.sum()>100;roi[blue]=255
                replacement=fitz.Pixmap(fitz.csRGB,pix.width,pix.height,arr.tobytes(),False)
                width,height=page.rect.width,page.rect.height;doc.delete_page(0);page=doc.new_page(pno=0,width=width,height=height);page.insert_image(page.rect,pixmap=replacement)
                removal={'method':'blue_ink_only','dpi':180,'rgb_predicate':'B-R>12 and B-G>5','rect_fraction':fractions,'preserves':'Every pixel outside the reviewed stamp rectangle and every non-blue pixel inside it is unchanged.'}
            else:
                page.add_redact_annot(rect,fill=(1,1,1));page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS);removal={'method':'pixel_blank','rect_fraction':fractions}
            name='doc-'+hashlib.sha256((RID+label).encode()).hexdigest()[:8]+'.pdf';doc.save(dest/'files'/name,garbage=4,deflate=True);(dest/'files'/pathlib.Path(name).with_suffix('.txt')).write_text(w.split.text_of(doc),encoding='utf-8')
            exhibits.append({'label':label,'file':name,'source_pages':list(range(first,last+1)),'cover_page':None,'stamp_page':first,'reviewed_stamp_removal':removal})
    w.atomic_json(dest/'split.json',{'record_id':RID,'affidavit_pages':[1,2],'divider_pages':[3],'exhibits':exhibits,'leak_audit':[],'boundary_provenance':'Source image review of A-E handwritten exhibit stamps and exact substantive document transitions; no inferred missing pages.'})
    w.atomic_json(dest/'source.json',dict(row,record_id=RID,source_sha256=row['sha256'],source_file=original.name,page_range=[1,42],source_pages=42,canonical_source_path=row['path'],ocr_derivative=str(ocr.relative_to(w.ROOT)),ocr_derivative_sha256=hashlib.sha256(ocr.read_bytes()).hexdigest(),origin='machine_test',run_id='affidavit-association-canada-20261022',retrieved='2026-10-22'))
    canada_masks.apply(dest,ocr)
    rows=w.read_json(BASE/'prepared.json');rows=[r for r in rows if r['record_id']!=RID];rows.append(dict(row,record_id=RID));w.atomic_json(BASE/'prepared.json',rows)
    print('prepared reviewed',RID,len(exhibits))

if __name__=='__main__':main()
