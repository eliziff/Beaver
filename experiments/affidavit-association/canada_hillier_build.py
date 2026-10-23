"""Build the source-reviewed Ontario pair and real same-author report distractors."""
import pathlib,json,hashlib,shutil,fitz
import canada_jccf as lane
w=lane.w

def counterpart(target,peer,label):
    source=w.OUT/'records'/peer;dest=w.OUT/'records'/target;meta=w.read_json(source/'source.json');lane.lane.canada_masks.apply(source,w.ROOT/meta['ocr_derivative']);split=w.read_json(source/'split.json');ex=next(e for e in split['exhibits'] if e['label']==label);path=source/'files'/ex['file'];sha=hashlib.sha256(path.read_bytes()).hexdigest();folder=dest/'distractors';folder.mkdir(exist_ok=True);name='doc-'+sha[:12]+'.pdf';shutil.copyfile(path,folder/name);shutil.copyfile(path.with_suffix('.txt'),(folder/name).with_suffix('.txt'))
    item={'file':'distractors/'+name,'text_file':'distractors/'+pathlib.Path(name).with_suffix('.txt').name,'sha256':sha,'review_status':'accepted','source_sha256':meta['source_sha256'],'source_url':meta['url'],'source_pages':ex['source_pages'],'relationship':'same_author_other_proceeding','source_record_id':peer,'reviewed_masks':{k:v for k,v in ex.items() if 'mask' in k or k in ['cover_page','stamp_page']},'source_review_method':'Complete source-boundary review and substantive report identity review; standalone certification covers removed; correlated native AB folios pixel-masked without body loss.'}
    w.atomic_json(dest/'distractors.json',[item]);m=w.read_json(dest/'source.json');m['actual_mixed_folder_counterparts']=[dict(item,content=(folder/name).with_suffix('.txt').read_text(encoding='utf-8'),identifying_affidavit=(source/'affidavit.txt').read_text(encoding='utf-8'))];w.atomic_json(dest/'source.json',m)

def main():
    data=w.read_json(w.OUT/'hillier-boundaries.json');assert data['accept'];manifests=json.loads(data['gold_json'])['records'];prepared=w.read_json(w.OUT/'prepared.json')
    for m in manifests:
        rid=m['record_id'];row=next(r for r in data['source_inventory'] if r['record_id']==rid);record=w.OUT/'records'/rid;(record/'files').mkdir(parents=True,exist_ok=True);ocr=pathlib.Path(row['ocr_derivative']);exhibits=[]
        with fitz.open(ocr) as source:
            aff=w.split.clean_copy(source,[p-1 for p in m['affidavit_pages']]);aff.save(record/'affidavit.pdf',garbage=4,deflate=True);(record/'affidavit.txt').write_text(w.split.text_of(aff),encoding='utf-8')
            for ex in m['exhibits']:
                assert not any(s['body_overlap'] for s in ex['stamp_masks']);assert not ex['stamp_masks'];doc=w.split.clean_copy(source,[p-1 for p in ex['source_pages']]);name='doc-'+hashlib.sha256((rid+ex['label']).encode()).hexdigest()[:10]+'.pdf';doc.save(record/'files'/name,garbage=4,deflate=True);(record/'files'/pathlib.Path(name).with_suffix('.txt')).write_text(w.split.text_of(doc),encoding='utf-8');exhibits.append(dict(ex,file=name))
        w.atomic_json(record/'split.json',{'record_id':rid,'affidavit_pages':m['affidavit_pages'],'exhibits':exhibits,'leak_audit':[],'boundary_review_notes':m['notes']});w.atomic_json(record/'source.json',dict(row,source_sha256=row['sha256'],canonical_source_path=row['path'],ocr_derivative=str(ocr.relative_to(w.ROOT)),ocr_derivative_sha256=hashlib.sha256(ocr.read_bytes()).hexdigest(),page_range=[1,row['page_count']],source_pages=row['page_count'],jurisdiction='on',origin='machine_test',run_id=w.RUN,boundary_review_receipt='jccf/hillier-boundaries.json'));lane.lane.canada_masks.apply(record,ocr);prepared.append(dict(row,record_id=rid))
    w.atomic_json(w.OUT/'prepared.json',prepared)
    counterpart('on-hillier-kettner2022','nsarb-mb-gateway-70ca2ca0ec','B');counterpart('nsarb-mb-gateway-70ca2ca0ec','on-hillier-kettner2022','A');counterpart('on-hillier-warren2022','nsarb-mb-gateway-3c342b0a90','B');counterpart('nsarb-mb-gateway-3c342b0a90','on-hillier-warren2022','C')
    print('Built Ontario 1- and 3-exhibit records and four actual report-version distractors')

if __name__=='__main__':main()
