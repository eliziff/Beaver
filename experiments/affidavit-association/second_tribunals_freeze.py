"""Freeze private author packets and source acquisition history for peer review."""
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlsplit

from second_tribunals_sources import OUT, cs, dump, sha
from second_tribunals_audit import main as audit


def main():
    target = OUT / 'frozen-source-gold.json'
    if target.exists():
        raise RuntimeError('Author freeze already exists; never overwrite frozen Gold.')
    audit()
    report = json.loads((OUT / 'author-audit.json').read_text(encoding='utf8'))
    assert not report['errors'] and not report['exact_body_duplicates']
    used = defaultdict(set)
    records = []
    for row in report['records']:
        path = OUT / row['source_gold_path']
        gold = json.loads(path.read_text(encoding='utf8'))
        directory = path.parent
        used[gold['original_referring_instrument']['source_sha256']].add(gold['record_id'])
        for item in gold['exhibits'] + gold.get('same_proceeding_distractors', []):
            digest = item.get('source_sha256')
            if digest:
                used[digest].add(gold['record_id'])
        records.append(dict(row, model_views_path=(directory / 'model-views.json').relative_to(OUT).as_posix(),
                            model_views_sha256=sha(directory / 'model-views.json'),
                            author_receipt_path=(directory / 'author_receipt.json').relative_to(OUT).as_posix(),
                            author_receipt_sha256=sha(directory / 'author_receipt.json')))
    db = sqlite3.connect((cs.HOME / 'corpus/corpus.sqlite').as_uri() + '?mode=ro&immutable=1', uri=True)
    db.row_factory = sqlite3.Row
    listings = []
    for path in (OUT / 'source-pages').glob('*.json'):
        item = json.loads(path.read_text(encoding='utf8'))
        if isinstance(item, dict) and item.get('source_url'):
            listings.append(dict(item, receipt_path=path.relative_to(OUT).as_posix()))
    inventory = []
    for path in sorted((OUT / 'sources').glob('*.json')):
        item = json.loads(path.read_text(encoding='utf8'))
        digest = item['sha256']
        original = cs.HOME / item['canonical_path']
        assert sha(original) == digest
        acquisitions = [dict(row) for row in db.execute(
            'select url,final_url,fetched_at,last_seen_at from documents where sha256=?', (digest,))]
        listed_by = [dict(listing_url=p['source_url'], listing_receipt=p['receipt_path'],
                          listing_html_sha256=p.get('html_sha256'), listing_accessed_at=p.get('retrieved_at'))
                     for p in listings if any(link.get('url') == item['url'] for link in p.get('public_links', []))]
        inventory.append(dict(item, website=urlsplit(item['url']).netloc,
                              direct_url=item['url'], accessed_at=item.get('retrieved_at'),
                              acquisition_records=acquisitions, listings=listed_by,
                              used_by_records=sorted(used[digest]),
                              selection_status='source_for_author_packet' if used[digest] else 'gathered_not_selected',
                              provenance_note='Cached-source access time is distinct from canonical corpus acquisition timestamps. Unselected sources are retained; no independent acceptance is implied.'))
    db.close()
    dump(OUT / 'source-inventory.json', {'origin': 'machine_test', 'run_id': report['run_id'],
         'sources': inventory, 'listing_receipts': listings,
         'discovery_history': 'The excluded initial US discovery receipt remains at ../us/local-source-inventory.json; no US proceeding is counted.'})
    frozen = {'origin': 'machine_test', 'run_id': report['run_id'],
              'method': 'codex_collaboration', 'agent': '/root/gold_us',
              'job_id': 'd8da3bbf-725b-47f9-9d81-3a4f0062c0e4', 'runner_call': False,
              'frozen_at': datetime.now(timezone.utc).isoformat(),
              'status': 'author_ready_pending_independent_review',
              'records': records, 'record_count': len(records),
              'exhibits': sum(r['exhibits'] for r in records),
              'events': sum(r['events'] for r in records),
              'source_inventory_sha256': sha(OUT / 'source-inventory.json'),
              'author_audit_sha256': sha(OUT / 'author-audit.json')}
    dump(target, frozen)
    print(target, sha(target))


if __name__ == '__main__':
    main()
