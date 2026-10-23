"""Finalize provenance and aggregate only independently accepted US records."""
import json
import sqlite3
from collections import Counter
from datetime import datetime, timezone
import us_author as u


def finalize():
    accepted=[]
    with sqlite3.connect(u.STORE/'corpus.sqlite') as db:
        for path in sorted((u.OUT/'records').glob('*/gold.json')):
            if u.verify.check(str(path.parent)):
                continue
            gold=json.loads(path.read_text(encoding='utf8'))
            work=u.OUT/'work'/path.parent.name
            reviews=[]
            batch=gold.get('gold_provenance',{}).get('batch_review_response')
            if batch:
                result=json.loads((u.OUT/batch).read_text(encoding='utf8'))
                raw=json.loads((u.OUT/result['_batch_response']).read_text(encoding='utf8'))
                matching=[r for r in raw['records'] if r['record_id']==path.parent.name and r['accept']]
                if len(matching)!=1:
                    raise ValueError('No unique accepting result in actual shared batch response')
                receipt=json.loads((u.OUT/result['_review_receipt']).read_text(encoding='utf8'))
                reviews.extend(a['started_at']+a.get('seconds',0) for a in receipt['attempts'] if a['status']=='complete')
            for response in (work/'review').glob('*/response.json'):
                if json.loads(response.read_text(encoding='utf8')).get('accept'):
                    receipt=json.loads((response.parent/'receipt.json').read_text(encoding='utf8'))
                    for attempt in receipt['attempts']:
                        if attempt['status']=='complete':
                            reviews.append(attempt['started_at']+attempt.get('seconds',0))
            if not reviews:
                raise ValueError('No completed accepting independent review: '+path.parent.name)
            recorded=datetime.fromtimestamp(max(reviews),timezone.utc)
            gold['gold_provenance']['recorded']=recorded.isoformat()
            gold['gold_provenance']['date']=recorded.date().isoformat()
            u.dump(path,gold)
            source_path=path.parent/'source.json'
            source=json.loads(source_path.read_text(encoding='utf8'))
            parts=json.loads((work/'sources.json').read_text(encoding='utf8'))
            retrievals=[]
            for part in parts:
                row=db.execute('select min(fetched_at) from documents where sha256=? and url=?',(part['sha256'],part['url'])).fetchone()
                retrievals.append({'sha256':part['sha256'],'url':part['url'],'fetched_at':row[0]})
            source['source_retrievals']=retrievals
            primary=next(p for p in parts if p['attachment']==0)
            fetched=next(p['fetched_at'] for p in retrievals if p['sha256']==primary['sha256'])
            source['retrieved']=fetched
            u.dump(source_path,source)
            accepted.append(path.parent.name)
    summary_path=u.OUT/'summary.json'
    summary=json.loads(summary_path.read_text(encoding='utf8')) if summary_path.exists() else {}
    summary['accepted']=accepted
    summary['calls']=sum(len(json.loads(p.read_text(encoding='utf8'))['attempts']) for p in u.OUT.glob('work/*/*/*/receipt.json'))
    summary['record_paths']={rid:'records/'+rid for rid in accepted}
    records=[json.loads((u.OUT/'records'/rid/'gold.json').read_text(encoding='utf8')) for rid in accepted]
    summary['case_distribution']=dict(Counter(rid.rsplit('-entry-',1)[0] for rid in accepted))
    summary['exhibits']=sum(len(g['exhibits']) for g in records)
    summary['events']=sum(len(g['events']) for g in records)
    summary['single_target_records']=sum(len(g['exhibits'])==1 for g in records)
    summary['human_review_status']='not_human_reviewed'
    summary['requested_target']=47
    summary['remaining_records']=max(0,47-len(accepted))
    summary['authorized_attempt_cap']=110
    withheld=u.OUT/'post-review-withheld.json'
    summary['post_review_withheld']=json.loads(withheld.read_text(encoding='utf8')) if withheld.exists() else []
    summary['latest_review_rejections']=[]
    for work in sorted((u.OUT/'work').iterdir()):
        if work.name in accepted or not work.is_dir() or work.name.startswith('_'):
            continue
        responses=list((work/'review').glob('*/response.json'))
        if (work/'batch-review.json').exists():
            responses.append(work/'batch-review.json')
        if responses:
            latest=max(responses,key=lambda p:p.stat().st_mtime)
            result=json.loads(latest.read_text(encoding='utf8'))
            if not result['accept']:
                summary['latest_review_rejections'].append({'id':work.name,'reason':result['reason'],
                    'response':str(latest.relative_to(u.OUT))})
    summary['provenance_finalized_at']=datetime.now(timezone.utc).isoformat()
    u.dump(summary_path,summary)
    print(json.dumps({'accepted':len(accepted),'attempts':summary['calls']}))


if __name__=='__main__':
    finalize()
