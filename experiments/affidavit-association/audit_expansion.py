"""Audit an accepted expansion against its frozen baseline and job budget."""
import argparse
from collections import Counter
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from data import ROOT, PRIVATE, RECORDS, read, digest, visible_text, accepted_gold, association_views, source_mapping, distractor_views


def referring_key(text):
    text = re.sub(r'(?mi)^\s*(?:Filed:?(?:\s+on)?|Entered\s+on\s+FLSD\s+Docket)\s+[\d/-]+\s*$', '', visible_text(text))
    return hashlib.sha256(' '.join(re.findall(r'\w+', text.casefold())).encode()).hexdigest()


def iso(value):
    if not value: return
    if not re.fullmatch(r'\d{4}(?:-\d{2}(?:-\d{2})?)?', value):
        raise ValueError('Invalid date precision: ' + value)
    date.fromisoformat(value + {4: '-01-01', 7: '-01', 10: ''}[len(value)])


def source_parts(item):
    parts = item.get('source_files')
    if parts is not None: return parts
    sha = item.get('source_sha256') or item.get('sha256')
    if not sha: return []
    return [{'sha256': sha, 'url': item.get('url') or item.get('source_url'),
             'pages': item.get('pages') or item.get('source_pages'),
             'cover_pages': item.get('cover_pages') or item.get('source_cover_pages')
                            or ([item.get('source_cover_page') or item['cover_page']]
                                if item.get('source_cover_page') or item.get('cover_page') else [])}]


def referring_parts(gold):
    for key in ('source_referring_document', 'referring_document', 'original_referring_instrument', 'reference_instrument'):
        if gold.get(key): return source_parts(gold[key])
    return []


def original_key(parts):
    if not parts or any(not p.get('sha256') or not p.get('pages') for p in parts):
        return None
    return tuple(sorted((p['sha256'], tuple(sorted(set(p['pages'] + p.get('cover_pages', []))))) for p in parts))


def prior_keys(baseline):
    texts, originals = {}, {}
    for row in baseline['records']:
        if row.get('referring_text_sha256'):
            texts[row['referring_text_sha256']] = row['record_id']
        key = original_key(row.get('referring_parts'))
        if key: originals[key] = row['record_id']
    return texts, originals


def legacy_referring_key(directory):
    source, split = directory / 'source.json', directory / 'split.json'
    if not source.exists() or not split.exists(): return None
    return original_key([source_mapping(read(source), {'pages': read(split).get('affidavit_pages', [])})])


def original_source_errors(parts, files, checked):
    errors = []
    for part in parts:
        sha, pages = part.get('sha256'), part.get('pages')
        if not re.fullmatch(r'[a-f0-9]{64}', sha or '') or not part.get('url', '').startswith('https://'):
            errors.append('Invalid original source hash/URL'); continue
        if sha not in files:
            errors.append('Original source missing from corpus index: ' + sha); continue
        path, page_count = files[sha]
        if not pages or any(not isinstance(n, int) or not 1 <= n <= page_count for n in pages + part.get('cover_pages', [])):
            errors.append('Invalid original source-page inventory: ' + sha)
        if sha not in checked:
            checked[sha] = digest(path)
        if checked[sha] != sha: errors.append('Original source hash changed: ' + sha)
    return errors


def geography_errors(gold, baseline):
    errors = []
    if baseline.get('country') and gold.get('country') != baseline['country']:
        errors.append('Source proceeding country does not match this expansion')
    allowed = baseline.get('allowed_jurisdictions')
    if allowed and gold.get('jurisdiction', '').casefold() not in allowed:
        errors.append('Source proceeding jurisdiction is outside this expansion')
    return errors


def peer_review_errors(gold, baseline, jobs):
    if not baseline.get('require_peer_review'): return []
    author = gold.get('author_provenance', {})
    review = gold.get('independent_source_review', {})
    authored, reviewed = jobs.get(author.get('job_id'), {}), jobs.get(review.get('job_id'), {})
    if (author.get('run_id') != baseline['run_id'] or authored.get('phase') != 'author'
            or authored.get('status') != 'completed' or authored.get('agent') != author.get('agent')):
        return ['Missing completed author-job provenance']
    if (review.get('status') != 'accepted' or reviewed.get('phase') != 'review'
            or reviewed.get('status') != 'completed' or reviewed.get('agent') != review.get('agent')
            or review.get('agent') == author.get('agent')):
        return ['Missing accepted review by a distinct completed peer job']
    return []


def counted_attempts(entries):
    """Runner jobs describe separately receipted attempts; preparation is not inference."""
    return sum(not (entry.get('job_id') and (entry.get('runner_call') is True
                    or entry.get('phase') == 'source_preparation')) for entry in entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected', type=int, default=100)
    parser.add_argument('--expansion', type=Path, default=PRIVATE / 'expansion')
    parser.add_argument('--baseline', type=Path, default=PRIVATE / 'baseline.json')
    parser.add_argument('--out', type=Path, default=PRIVATE / 'expansion-audit.json')
    options = parser.parse_args()
    sys.path.insert(0, str(ROOT / 'benchmarks/court-record-exhibits'))
    baseline = read(options.baseline)
    existing = {r['record_id'] for r in baseline['records']}
    seen_text, seen_originals = prior_keys(baseline)
    for root in (RECORDS, ROOT / 'benchmarks/court-record-exhibits/records'):
        for rid in existing:
            text = root / rid / 'affidavit.txt'
            if text.exists(): seen_text[referring_key(text.read_text(encoding='utf-8'))] = rid
            identity = legacy_referring_key(root / rid)
            if identity: seen_originals[identity] = rid
    accepted = accepted_gold(options.expansion, 'source-gold.json', with_directories=True)
    attempts, metadata, jobs = Counter(), Counter(), {}
    for lane in options.expansion.iterdir():
        if not lane.is_dir(): continue
        for p in lane.rglob('receipt.json'):
            entries = read(p).get('attempts', [])
            counted = counted_attempts(entries)
            attempts[lane.name] += counted
            metadata[lane.name] += len(entries) - counted
            jobs.update({entry['job_id']: entry for entry in entries if entry.get('job_id')})
    errors, subjects, jurisdictions, families = [], Counter(), Counter(), Counter()
    events = exhibits = 0
    unavailable_sources, model_coverage, source_hashes = {}, {}, {}
    home = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData'
    database = home / 'corpus/corpus.sqlite'
    # Read SQLite's consistent snapshot, including committed WAL records. The
    # shared corpus may have another reader/writer; immutable would ignore WAL.
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    files = {sha: (home / path, pages) for sha, path, pages in connection.execute('select sha256,path,pages from files')}
    connection.close()
    for rid, (p, directory) in sorted(accepted.items()):
        g = read(p)
        failures = geography_errors(g, baseline) + peer_review_errors(g, baseline, jobs)
        if baseline.get('require_peer_review'):
            author_path = directory / 'source-gold.json'
            if not author_path.exists() or g.get('independent_source_review', {}).get('author_gold_sha256') != digest(author_path):
                failures.append('Peer review does not bind the immutable author Gold')
        if rid in existing: failures.append('Record already in the baseline')
        if g.get('record_id') != rid: failures.append('Record identity mismatch')
        provenance = g.get('gold_provenance') or g.get('author_provenance', {})
        if isinstance(provenance, str): provenance = read(directory / provenance)
        origin = provenance.get('origin', provenance.get('submission_origin', g.get('origin')))
        if origin != 'machine_test' or not (provenance.get('run_id') or g.get('run_id')):
            failures.append('Missing machine-test provenance/run ID')
        if not (g.get('source_review') or g.get('independent_source_review') or g.get('review_provenance')
                or any(provenance.get(key) for key in ('independent_review_receipt', 'review_receipt', 'review_receipts'))):
            failures.append('Missing independent source-review provenance')
        referring = referring_parts(g)
        if not referring: failures.append('Missing original referring-instrument provenance')
        identity = original_key(referring)
        if identity:
            if identity in seen_originals: failures.append('Duplicate original referring instrument: ' + seen_originals[identity])
            seen_originals[identity] = rid
        failures += original_source_errors(referring + [part for exhibit in g['exhibits'] for part in source_parts(exhibit)], files, source_hashes)
        missing = [e for e in g['exhibits'] if not source_parts(e)]
        if missing:
            unavailable_sources[rid] = [{'label': e['label'], 'availability': e.get('availability') or e.get('status')}
                                         for e in missing]
            if any(not (e.get('availability') or e.get('status') or e.get('source_unavailability')) for e in missing):
                failures.append('Unlocated original attachment lacks an explicit availability explanation')
        raw = (directory / 'affidavit.txt').read_text(encoding='utf-8-sig')
        text_hash = referring_key(raw)
        if text_hash in seen_text: failures.append('Duplicate referring text: ' + seen_text[text_hash])
        seen_text[text_hash] = rid
        try:
            iso(g.get('sworn_date'))
            labels = {e['label'] for e in g['exhibits']}
            if len(labels) != len(g['exhibits']): failures.append('Duplicate canonical exhibit label')
            if not g.get('events'): failures.append('Missing sourced narrative events')
            for item in g['exhibits'] + g['events']:
                iso(item.get('date')); iso(item.get('end_date'))
            for item in g['events']:
                if not item.get('quote', '').strip(): failures.append('Empty event quotation')
                if set(item.get('exhibits', [])) - labels: failures.append('Event links an unknown source exhibit')
            for item in g['exhibits']:
                if any(not ref.get('quote', '').strip() for ref in item['references']): failures.append('Empty exhibit quotation')
        except ValueError as exc:
            failures.append(str(exc))
        try:
            import refs
            views, unavailable, referring_view = association_views(directory, p, g)
            model_coverage[rid] = {'source_labels': len(g['exhibits']), 'eligible_labels': len(views), 'unavailable': unavailable}
            model_body = (directory / (referring_view['text_file'] if referring_view else 'affidavit.txt')).read_text(encoding='utf-8-sig')
            contexts = refs.build({'labels': [view['label'] for view in views]}, model_body)
            model_coverage[rid]['reference_parser_found'] = sum(context['found'] for context in contexts.values())
            model_coverage[rid]['reference_parser_missing'] = [label for label, context in contexts.items() if not context['found']]
        except (ValueError, FileNotFoundError) as exc:
            model_coverage[rid] = {'source_labels': len(g['exhibits']), 'status': 'unavailable', 'reason': str(exc)}
        try:
            counterparts = distractor_views(directory)
            counterpart_errors = original_source_errors([part for item, _, _ in counterparts for part in source_parts(item)], files, source_hashes)
            model_coverage[rid]['distractors'] = {'same_proceeding': sum(item['same_proceeding'] for item, _, _ in counterparts),
                                                'other_proceeding': sum(not item['same_proceeding'] for item, _, _ in counterparts),
                                                'errors': counterpart_errors}
        except (ValueError, FileNotFoundError) as exc:
            model_coverage[rid]['distractors'] = {'status': 'unavailable', 'reason': str(exc)}
        # Export/representation failures affect model coverage, never verified source Gold.
        if failures: errors.append({'record': rid, 'errors': failures})
        subject = g.get('subject') or 'unclassified'
        subjects.update(set(subject) if isinstance(subject, list) else [subject])
        jurisdictions[g['jurisdiction'].casefold()] += 1
        family = re.sub(r'[^a-z0-9]', '', (g.get('court_file') or g.get('family') or rid).casefold())
        families[g['jurisdiction'].casefold() + ':' + family] += 1
        events += len(g['events']); exhibits += len(g['exhibits'])
    attempt_limit = baseline.get('job_attempt_limit', 250)
    if sum(attempts.values()) > attempt_limit:
        errors.append({'errors': [f'User-authorized {attempt_limit}-attempt cap exceeded']})
    if len(accepted) != options.expected: errors.append({'errors': [f'Expected {options.expected} new accepted records; found {len(accepted)}']})
    formats = Counter()
    for sha in source_hashes:
        with files[sha][0].open('rb') as source:
            formats['pdf' if source.read(5) == b'%PDF-' else 'other_original'] += 1
    result = {'origin': 'machine_test', 'run_id': baseline.get('run_id'),
              'baseline_records': len(existing), 'baseline_sha256': digest(options.baseline),
              'job_attempt_limit': attempt_limit,
              'accepted': len(accepted), 'exhibits': exhibits, 'events': events, 'calls': dict(attempts),
              'scheduling_metadata_not_counted_twice': dict(metadata),
              'subjects': dict(subjects), 'subject_counting': 'Source tags per record; multiple tags may overlap',
              'jurisdictions': dict(jurisdictions), 'proceedings': dict(families),
              'unavailable_original_attachments': unavailable_sources, 'model_view_coverage': model_coverage,
              'original_source_hashes_checked': len(source_hashes),
              'original_source_formats': dict(formats),
              'original_pdf_hashes_checked': formats['pdf'],
              'gold_sha256s': {rid: digest(p) for rid, (p, _) in accepted.items()}, 'errors': errors}
    options.out.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps({k: result[k] for k in ('accepted', 'exhibits', 'events', 'calls', 'errors')}))
    if errors: raise SystemExit(1)


if __name__ == '__main__':
    main()
