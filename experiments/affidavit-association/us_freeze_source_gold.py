"""Freeze source annotations independently of mutable benchmark PDF projections."""
import json
import hashlib
import re
from pathlib import Path
from datetime import datetime,timezone
import us_author as u
from us_supplemental import OUT


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def pages_for(quote,text,allowed):
    parts=re.split(r'\[(?:source )?page (\d+)\]\s*',text)
    pages={int(parts[i]):parts[i+1] for i in range(1,len(parts),2)}
    for size in range(1,len(allowed)+1):
        for start in range(len(allowed)-size+1):
            selected=allowed[start:start+size]
            if u.verify.fold(quote) in u.verify.fold('\n'.join(pages.get(n,'')for n in selected)):
                return selected
    raise ValueError('Source anchor does not occur in the referring instrument: '+quote[:100])


def freeze_supplemental():
    rows=[]
    for record in sorted((OUT/'records').iterdir()):
        candidate=record/'candidate-gold.json'
        if not candidate.exists():continue
        g=json.loads(candidate.read_text(encoding='utf8'))
        original=json.loads((OUT/'work'/record.name/'sources.json').read_text(encoding='utf8'))[0]
        text=(OUT/original['text_path']).read_text(encoding='utf8')
        referring=g['source_referring_document']
        allowed=referring['pages']
        for event in g['events']:
            event['source']={'sha256':referring['sha256'],'pages':pages_for(event['quote'],text,allowed)}
        for exhibit in g['source_exhibits']:
            exhibit.pop('review_status',None)
            for reference in exhibit['references']:
                reference['source']={'sha256':referring['sha256'],'pages':pages_for(reference['quote'],text,allowed)}
        frozen={k:v for k,v in g.items()if k not in {'exhibits','source_exhibits','source_attachments','source_referring_document','view_status','view_unavailable_reason','review_notes'}}
        frozen.update(exhibits=g['source_exhibits'],source_documents=g['source_attachments'],referring_document=referring,
            schema='court-record-source-gold-v1',review_status='pending_independent_source_review')
        path=record/'source-gold.json'
        u.dump(path,frozen)
        digest=sha(path)
        receipt_path=record/'author_receipt.json'
        receipt=json.loads(receipt_path.read_text(encoding='utf8'))
        receipt.update(source_gold_path=str(path.relative_to(OUT)),source_gold_sha256=digest,
            finished=datetime.now(timezone.utc).isoformat(),source_gold_status='frozen_for_independent_review')
        u.dump(receipt_path,receipt)
        rows.append({'id':record.name,'path':str(path.relative_to(OUT)),'sha256':digest,'exhibits':len(frozen['exhibits']),'events':len(frozen['events'])})
    u.dump(OUT/'frozen-source-gold.json',{'origin':'machine_test','method':'codex_collaboration',
        'agent':'/root/gold_us','job_id':'7856f4ae-3a74-447d-a085-48ff905f85e1','frozen':datetime.now(timezone.utc).isoformat(),
        'records':rows})
    print(json.dumps(rows,indent=1))


if __name__=='__main__':freeze_supplemental()
