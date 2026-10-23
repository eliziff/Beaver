"""Materialize actual, source-reviewed peer versions as anonymous distractors."""
import pathlib,json,shutil,hashlib

ROOT=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada/ns_followup')

def main():
    pairs=[('nsarb-2023-25b11f8333','B','nsarb-2023-3d3e2f41f5','A'),('nsarb-2023-2189c30409','A','nsarb-2023-20c8720f44','A')]
    for left,ll,right,rl in pairs:
        for target,peer,label in [(left,right,rl),(right,left,ll)]:
            dest=ROOT/'records'/target;source=ROOT/'records'/peer;sp=json.loads((source/'split.json').read_text(encoding='utf-8'));meta=json.loads((source/'source.json').read_text(encoding='utf-8'));ex=next(e for e in sp['exhibits'] if e['label']==label);pdf=source/'files'/ex['file'];sha=hashlib.sha256(pdf.read_bytes()).hexdigest();folder=dest/'distractors';folder.mkdir(exist_ok=True);filename='doc-'+sha[:12]+'.pdf';shutil.copyfile(pdf,folder/filename);shutil.copyfile(pdf.with_suffix('.txt'),(folder/filename).with_suffix('.txt'))
            item={'file':'distractors/'+filename,'text_file':'distractors/'+pathlib.Path(filename).with_suffix('.txt').name,'sha256':sha,'source_sha256':meta['source_sha256'],'source_url':meta['url'],'source_pages':ex['source_pages'],'source_record_id':peer,'relationship':'same_proceeding','reviewed_masks':{k:v for k,v in ex.items() if 'mask' in k or k in ['cover_page','stamp_page']},'source_review_receipts':str((ROOT/'calls'/peer/'author').as_posix()),'reason':'Actual same-expert earlier/later document from the same proceeding; target source and counterpart remain separate.'}
            item['review_status']='accepted';item['source_review_method']='Source author inspected original boundaries and actual stripped content, confirming identities; target gold rejected only because sibling evidence had not been supplied. Neutral counterpart acceptance does not claim accepted association gold.'
            (dest/'distractors.json').write_text(json.dumps([item],indent=2),encoding='utf-8')
            targetmeta=json.loads((dest/'source.json').read_text(encoding='utf-8'));targetmeta['actual_mixed_folder_counterparts']=[dict(item,content=(folder/filename).with_suffix('.txt').read_text(encoding='utf-8'),identifying_affidavit=(source/'affidavit.txt').read_text(encoding='utf-8'))];(dest/'source.json').write_text(json.dumps(targetmeta,indent=2),encoding='utf-8')
    print('Materialized four source-backed counterpart distractors')

if __name__=='__main__':main()
