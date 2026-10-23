"""Concrete same-proceeding counterparts, with reviewed or pending evidence status."""
import pathlib,json,hashlib,shutil,fitz,sys
import canada_supplemental_author as a
O=a.OUT
def add(rid,path,item):
    target=O/'records'/rid;folder=target/'distractors';folder.mkdir(exist_ok=True);sha=hashlib.sha256(path.read_bytes()).hexdigest();name='doc-'+sha[:12]+'.pdf';shutil.copyfile(path,folder/name);shutil.copyfile(path.with_suffix('.txt'),(folder/name).with_suffix('.txt'));entry=dict(item,file='distractors/'+name,sha256=sha,text_file='distractors/'+pathlib.Path(name).with_suffix('.txt').name,same_proceeding=True)
    p=target/'distractors.json';rows=json.loads(p.read_text(encoding='utf-8')) if p.exists() else [];rows=[x for x in rows if x.get('source_record_id')!=entry.get('source_record_id')];a.dump(p,rows+[entry])
def main():
    rid='us-nysd-sec-ripple-entry-187';peer=a.ROOT/'benchmarks/local-data/affidavit-association/expansion/us/records/us-nysd-sec-ripple-entry-568';source=json.loads((peer/'source.json').read_text(encoding='utf-8'));ex=json.loads((peer/'split.json').read_text(encoding='utf-8'))['exhibits'][0];gold=json.loads((peer/'gold.json').read_text(encoding='utf-8'));origin=ex['source_files'][0];metadata=next(x for x in source['sources'] if x['file']==origin['file']);add(rid,peer/'files'/ex['file'],{'review_status':'accepted','source_record_id':peer.name,'source_sha256':metadata['sha256'],'source_url':metadata['url'],'source_pages':origin['pages'],'relationship':'same_proceeding_same_author_different_tweet_compilation','review_provenance':gold['gold_provenance'],'source_accepted_file_sha256':hashlib.sha256((peer/'files'/ex['file']).read_bytes()).hexdigest()})
    # Oracle attachment2 is Hall opening report, not Astrachan second report; rejected proposal is audited privately.
    print('Reviewed Ripple counterpart materialized')
if __name__=='__main__':main()
