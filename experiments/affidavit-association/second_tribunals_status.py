"""Report author packets without implying independent acceptance."""
import json
from datetime import datetime, timezone
from second_tribunals_sources import OUT, dump, sha


def main():
    target = OUT / 'author-status.json'
    status = json.loads(target.read_text(encoding='utf8')) if target.exists() else {}
    rows = []
    for path in sorted((OUT / 'records').glob('*/source-gold.json')):
        gold = json.loads(path.read_text(encoding='utf8'))
        rows.append({'record_id': gold['record_id'],
                     'source_gold_path': path.relative_to(OUT).as_posix(),
                     'source_gold_sha256': sha(path),
                     'exhibits': len(gold['exhibits']), 'events': len(gold['events']),
                     'family': gold['family'], 'jurisdiction': gold['jurisdiction'],
                     'review_status': 'pending'})
    status.update(country='CA', target=33,
                  status='authoring_ongoing_pending_independent_review',
                  updated_utc=datetime.now(timezone.utc).isoformat(),
                  author_ready=rows, records=len(rows),
                  exhibits=sum(r['exhibits'] for r in rows),
                  events=sum(r['events'] for r in rows),
                  proceedings=len({r['family'] for r in rows}))
    dump(target, status)
    print(status['records'], status['exhibits'], status['events'], status['proceedings'])


if __name__ == '__main__':
    main()
