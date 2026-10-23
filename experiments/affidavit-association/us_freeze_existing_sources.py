"""Freeze complete source inventories from reviewed US records and pending addenda."""
import json
from datetime import datetime,timezone
from pathlib import Path
import us_author as u
from us_freeze_source_gold import pages_for,sha


def freeze():
    out=u.OUT
    summary=json.loads((out/'summary.json').read_text(encoding='utf8'))
    rows=[]
    for rid in summary['accepted']:
        record=out/'records'/rid
        g=json.loads((record/'gold.json').read_text(encoding='utf8'))
        parts=json.loads((out/'work'/rid/'sources.json').read_text(encoding='utf8'))
        addendum=out/'source-gold-upgrades'/rid/'candidate-source-gold.json'
        if addendum.exists():
            exhibits=json.loads(addendum.read_text(encoding='utf8'))['source_exhibits']
        else:
            byhash={p['sha256']:p for p in parts}
            split=json.loads((record/'split.json').read_text(encoding='utf8'))
            exhibits=[]
            for e in g['exhibits']:
                source_files=[]
                for s in next(s for s in split['exhibits']if s['label']==e['label'])['source_files']:
                    p=byhash[Path(s['file']).stem]
                    pages=sorted(set(s['pages']+([s['cover_page']]if s.get('cover_page')else[])))
                    source_files.append({'sha256':p['sha256'],'url':p['url'],'path':p['path'],'pages':pages})
                exhibits.append({**{k:v for k,v in e.items()if k!='file'},'source_files':source_files})
        primary=parts[0]
        selection=json.loads((out/'work'/rid/'manifest.json').read_text(encoding='utf8')).get('affidavit_pages',list(range(1,primary['pages']+1)))
        for e in g['events']:
            if 'date_end'in e:e['end_date']=e.pop('date_end')
            e['source']={'sha256':primary['sha256'],'pages':pages_for(e['quote'],primary['text'],selection)}
        for e in exhibits:
            for ref in e['references']:
                ref['source']={'sha256':primary['sha256'],'pages':pages_for(ref['quote'],primary['text'],selection)}
        frozen={k:v for k,v in g.items()if k not in {'exhibits','available_not_selected','review_notes','leak_waivers','leak_waiver_details'}}
        frozen.update(schema='court-record-source-gold-v1',exhibits=exhibits,
            referring_document={'sha256':primary['sha256'],'url':primary['url'],'path':primary['path'],'pages':selection},
            source_documents=[{k:v for k,v in p.items()if k in {'attachment','sha256','url','path','pages'}}for p in parts],
            review_status='pending_inventory_extension_review'if addendum.exists()else'existing_independent_source_review',
            source_projection_provenance={'origin':'machine_test','method':'mechanical_source_provenance_projection',
                'agent':'/root/gold_us','job_id':'7856f4ae-3a74-447d-a085-48ff905f85e1',
                'gold_sha256':sha(record/'gold.json'),'recorded':datetime.now(timezone.utc).isoformat()})
        if addendum.exists():
            frozen['source_projection_provenance']['pending_addendum']=str(addendum.relative_to(out))
        path=record/'source-gold.json'
        u.dump(path,frozen)
        rows.append({'id':rid,'path':str(path.relative_to(out)),'sha256':sha(path),'exhibits':len(exhibits),'events':len(g['events']),'review_status':frozen['review_status']})
    u.dump(out/'frozen-source-gold.json',{'origin':'machine_test','method':'mechanical_source_provenance_projection','records':rows})
    print(len(rows),sum(r['exhibits']for r in rows),sum(r['events']for r in rows))


if __name__=='__main__':freeze()
