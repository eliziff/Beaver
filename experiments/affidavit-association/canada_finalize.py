"""Consolidate independently accepted Canada gold, retaining every source receipt."""
import pathlib,json,shutil,hashlib,datetime,collections,sqlite3,os,sys
BASE=pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada').resolve()
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'benchmarks/court-record-exhibits'))
import verify
def read(p):return json.loads(p.read_text(encoding='utf-8'))
def write(p,v):p.write_text(json.dumps(v,indent=2,ensure_ascii=False),encoding='utf-8')
def main():
    summaries=list(BASE.rglob('summary.json'));accepted={};rejected=[]
    for p in summaries:
        m=read(p)
        for rid in m.get('accepted',[]):accepted[rid]=p.parent/'records'/rid if (p.parent/'records'/rid).exists() else BASE/'records'/rid
        for x in m.get('rejected',[]):
            entry=dict(x);entry.setdefault('adjudication_summary',str(p.relative_to(BASE)))
            if not any((e.get('record_id'),e.get('reason'))==(entry.get('record_id'),entry.get('reason')) for e in rejected):rejected.append(entry)
    receipts=list(BASE.glob('**/calls/**/receipt.json'));attempts=sum(len(read(p)['attempts']) for p in receipts)
    db=sqlite3.connect(str(pathlib.Path(os.path.expandvars('%LOCALAPPDATA%/OpenLegalData/corpus/corpus.sqlite'))))
    sources={};errors={};families=collections.Counter();subjects=collections.Counter()
    for rid,old in accepted.items():
        dest=BASE/'records'/rid
        if old!=dest:
            assert not dest.exists(),dest;assert old.resolve().is_relative_to(BASE);shutil.move(old,dest)
        gold=read(dest/'gold.json');source=read(dest/'source.json')
        # All aliases identify the actual proceeding, never the affidavit's evidence-registration number.
        family='liverpool-bay-aquaculture' if rid.startswith('nsarb-2023-') else 'rattling-beach-boundary' if rid.startswith('nsarb-2021-') else 'town-point-aquaculture-2022' if rid.startswith('nsarb-2022-') else 'manitoba-gateway-publichealth-2021' if rid.startswith('nsarb-mb-gateway') else 'hillier-ontario-publichealth-2022' if rid.startswith('on-hillier') else gold['family']
        gold['family']=source['family']=family;families[family]+=1;subjects[gold.get('subject','unknown')]+=1
        reviews=[]
        for p in receipts:
            if rid not in p.parts or not any('review' in part for part in p.relative_to(BASE).parts):continue
            for attempt in read(p)['attempts']:
                if attempt.get('status')=='complete':reviews.append((attempt['started_at']+attempt.get('seconds',0),str(p.relative_to(BASE))))
        assert reviews,(rid,'missing independent review')
        when,receipt=max(reviews);prov=gold['gold_provenance'];prov.pop('recorded',None);prov['recorded_at']=datetime.datetime.fromtimestamp(when,datetime.timezone.utc).isoformat();prov['independent_review_receipt']=receipt
        fetched=db.execute('select * from files where sha256=?',(source['source_sha256'],)).fetchone()
        columns=[x[1] for x in db.execute('pragma table_info(files)')]
        row=dict(zip(columns,fetched));fetch=db.execute('select fetched_at,final_url from fetches where sha256=? and http_status=200 order by fetched_at limit 1',(source['source_sha256'],)).fetchone()
        if fetch:
            source['canonical_source_metadata']={'fetched_at':fetch[0],'final_url':fetch[1],'indexed_at':row['indexed_at']};source['retrieved']=fetch[0]
        else:
            doc=db.execute('select fetched_at,final_url from documents where sha256=? order by fetched_at limit 1',(source['source_sha256'],)).fetchone()
            source['canonical_source_metadata']={'fetched_at':doc[0] if doc else None,'final_url':doc[1] if doc else None,'indexed_at':row['indexed_at']};source['retrieved']=doc[0] if doc else 'unknown'
        path=pathlib.Path(os.path.expandvars('%LOCALAPPDATA%/OpenLegalData'))/source['canonical_source_path'];assert hashlib.sha256(path.read_bytes()).hexdigest()==source['source_sha256']
        derivative=ROOT/source['ocr_derivative'];assert hashlib.sha256(derivative.read_bytes()).hexdigest()==source['ocr_derivative_sha256']
        if (dest/'distractors.json').exists():
            for e in read(dest/'distractors.json'):
                assert type(e.get('same_proceeding')) is bool
                f=dest/e['file'];assert f.exists() and f.with_suffix('.txt').exists();assert hashlib.sha256(f.read_bytes()).hexdigest()==e['sha256']
        write(dest/'gold.json',gold);write(dest/'source.json',source);errs=verify.check(str(dest))
        if errs:errors[rid]=errs
        sources[rid]={'source_sha256':source['source_sha256'],'url':source['url'],'ocr_derivative':source['ocr_derivative'],'ocr_derivative_sha256':source['ocr_derivative_sha256'],'affidavit_source_pages':read(dest/'split.json')['affidavit_pages'],'independent_review_receipt':receipt}
    db.close()
    assert not errors,errors;assert max(families.values())<=8
    original=BASE/'prior-root-summary.json'
    if not original.exists():shutil.copyfile(BASE/'summary.json',original)
    summary=dict(origin='machine_test',run_id='affidavit-association-canada-20261022',accepted=sorted(accepted),rejected=rejected,model_call_attempts=attempts,attempt_cap=60,families=dict(families),subjects=dict(subjects),validation={'records':len(accepted),'valid':len(accepted)-len(errors),'errors':errors},source_manifest='accepted-sources.json',nested_adjudication_summaries=[str(p.relative_to(BASE)) for p in summaries if p.parent!=BASE])
    write(BASE/'accepted-sources.json',sources);write(BASE/'summary.json',summary);print(json.dumps({k:summary[k] for k in ['accepted','model_call_attempts','families','validation']},indent=2))
if __name__=='__main__':main()
