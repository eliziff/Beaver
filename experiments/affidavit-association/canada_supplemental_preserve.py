"""Replay reviewed content boundaries while retaining all underlying document pagination."""
import pathlib,json,hashlib,fitz,sys
import canada_supplemental_author as a
O=a.OUT
def main():
    for rid,spec in a.SPECS.items():
        d=O/'pending'/rid;target=O/'records'/rid;parts=json.loads((d/'sources.json').read_text(encoding='utf-8'));by={p['attachment']:p for p in parts};spl=json.loads((target/'split.json').read_text(encoding='utf-8'));files={e['label']:e['file'] for e in spl['exhibits']};audits=[]
        for label,att,first,cover,para,kind,desc,*last in spec['ex']:
            prepared=d/f'native-wrapper-{att}.pdf';sourcepath=prepared if prepared.exists() else pathlib.Path(by[att]['path']);end=last[0] if last else by[att]['pages'];pages=list(range(first+int(cover),end+1));path=target/'files'/files[label]
            with fitz.open(sourcepath) as source,a.split.clean_copy(source,[p-1 for p in pages],preserve_filing_dates=True) as doc:
                path.write_bytes(doc.tobytes(garbage=4,deflate=True));texts=[]
                for i,page in enumerate(doc):texts.append(f'[page {i+1}]\n'+(a.split.tesseract_cli(page) if page.get_images() else page.get_text()))
                path.with_suffix('.txt').write_text('\n'.join(texts),encoding='utf-8')
            audits.append({'label':label,'source_sha256':by[att]['sha256'],'prepared_source_sha256':hashlib.sha256(sourcepath.read_bytes()).hexdigest(),'source_pages':pages,'output_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'method':'Exact manually source-reviewed complete filed content span; native filing wrappers handled by source-registered operator preprocessing; source-internal document pagination retained. No record_folios heuristic applied.'})
        spl['faithful_content_replay']=audits;a.dump(target/'split.json',spl);a.dump(d/'faithful-content-replay.json',audits);print(rid,len(audits),flush=True)
if __name__=='__main__':main()
