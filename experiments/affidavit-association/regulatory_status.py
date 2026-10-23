"""Aggregate lane receipts and only independently accepted, structurally valid gold."""
from collections import Counter
from datetime import datetime, timezone
import json
import regulatory_expand as w

def main():
    out=w.OUT;accepted=set();rejected=[];reopened=[]
    for path in out.glob('summary*.json'):
        value=w.read_json(path);accepted.update(value.get('accepted',[]));rejected.extend(value.get('rejected',[]));reopened.extend(value.get('reopened_history',[]))
    receipts=[];usage=Counter()
    for path in (out/'calls').glob('*/*/*/receipt.json'):
        value=w.read_json(path)
        for attempt in value['attempts']:
            receipts.append({'record_id':path.relative_to(out/'calls').parts[0],'receipt':path.relative_to(out).as_posix(),**attempt})
            usage.update(attempt.get('usage',{}))
    valid=[];pending=[];families=Counter();subjects=Counter();exhibits=events=0
    for rid in sorted(accepted):
        dest=out/'records'/rid;path=dest/'gold.json'
        if not path.exists():pending.append({'record_id':rid,'reason':'No current gold'});continue
        gold=w.read_json(path)
        if not gold.get('gold_provenance'):pending.append({'record_id':rid,'reason':'Draft awaiting final independent review'});continue
        errors=w.verify.check(str(dest))
        if errors:pending.append({'record_id':rid,'reason':errors});continue
        reviews=[r for r in receipts if (r['record_id']==rid or r['receipt']==gold['gold_provenance'].get('review_receipt')) and ('/review/' in r['receipt'] or '/visual-review/' in r['receipt'])]
        reviews=[r for r in reviews if r['status']=='complete']
        def approved(receipt):
            response=out/receipt['receipt'];response=response.with_name('response.json')
            if not response.exists():return False
            value=w.read_json(response)
            if 'records' in value:return any(item.get('record_id')==rid and item.get('accept') for item in value['records'])
            return bool(value.get('accept'))
        reviews=[r for r in reviews if approved(r)]
        if not reviews:pending.append({'record_id':rid,'reason':'No completed independent-review receipt'});continue
        latest=max(reviews,key=lambda r:r['started_at']+r['seconds']);stamp=datetime.fromtimestamp(latest['started_at']+latest['seconds'],timezone.utc).isoformat()
        provenance=gold['gold_provenance'];provenance.setdefault('accepted_at_utc',stamp);provenance.update(review_completed_at_utc=stamp,recorded=provenance['accepted_at_utc'][:10],review_receipt=latest['receipt'])
        if '/visual-review/' in latest['receipt']:
            provenance['method']='Original author evidence is bound by its retained call receipt; the separate final reviewer read every original source-page image and every anonymous exhibit content-page image with extracted/OCR text; quotations, labels and dates verified.'
        if gold.get('paragraphs_by_eye'):
            gold['paragraph_location_note']='Printed paragraph numbers absent from the extraction index are retained from the completed independent source-image-reviewed gold; exact views and approving review receipt are recorded beside the gold.'
        w.atomic_json(path,gold);valid.append(rid);exhibits+=len(gold['exhibits']);events+=len(gold['events']);families[gold.get('family') or gold.get('court_file') or gold['proceeding']]+=1;subjects[gold['subject']]+=1
    unique={json.dumps(x,sort_keys=True):x for x in rejected}
    history={json.dumps(x,sort_keys=True):x for x in reopened}
    result={'origin':'machine_test','run_id':w.RUN,'target':33,'accepted':valid,'pending_review':pending,'rejected':list(unique.values()),'reopened_history':list(history.values()),'model_call_attempts':len(receipts),'call_statuses':dict(Counter(r['status'] for r in receipts)),'usage':dict(usage),'usage_unreported_attempts':sum(not r.get('usage_reported') for r in receipts),'exhibits':exhibits,'events':events,'families':dict(families),'subjects':dict(subjects)}
    w.atomic_json(out/'summary.json',result)
    print(json.dumps({k:result[k] for k in ['target','model_call_attempts','call_statuses','exhibits','events']},ensure_ascii=False));print('Accepted:',len(valid),'Pending:',len(pending))

if __name__=='__main__':main()
