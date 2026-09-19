"""Re-judge framing rows with the FULL decision in state instead of the
deterministic extractor's ~6k window centered on the quote.

Answers: is the statement-form judge limited by how much source text it sees?
Input: the rows we want to re-check (misses and/or false-adverse) taken from
existing framing receipts; sources fetched by citation from the public A2AJ
API and cached in receipts/framing-sources.json.
"""
import io
import json
import sys
import time
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
from run_tasks import FRAMING, RECEIPTS, call, framing_questions  # noqa: E402
from fetch_cslb_sources import fetch  # noqa: E402

SOURCES = RECEIPTS / 'framing-sources.json'
MAX_CHARS = 100_000


def source_for(citation):
    sources = json.loads(io.open(SOURCES, encoding='utf-8').read()) if SOURCES.exists() else {}
    if citation not in sources:
        match = None
        import re
        m = re.search(r'\b(19|20)\d{2}\s+[A-Za-z.]{2,7}\s+\d+\s*$', citation.split(', para')[0].strip())
        if m:
            match = m.group(0).strip()
        text = None
        if match:
            try:
                text = fetch(match)
            except Exception as error:  # noqa: BLE001
                print('fetch error', citation, error)
        sources[citation] = text
        SOURCES.write_text(json.dumps(sources), encoding='utf-8')
        time.sleep(0.3)
    return sources[citation]


def main(tag, source_receipt, result_receipt, want):
    claims = [json.loads(line) for line in
              (FRAMING / source_receipt).read_text(encoding='utf-8').splitlines()]
    results = {r['row_id']: r for r in json.loads(io.open(
        RECEIPTS / ('framing-%s.json' % result_receipt), encoding='utf-8').read())}
    rows = []
    for claim in claims:
        row_id = claim.get('id') or claim.get('claim_id')
        prior = results.get(row_id)
        if not prior or not want(prior):
            continue
        full = source_for(claim['citation'])
        if not full:
            rows.append({'row_id': row_id, 'status': 'no_source'})
            continue
        text = full[:MAX_CHARS]
        state = {
            'cited_decision': claim['citation'],
            'source_text': text,
            'exact_quotation': claim.get('exact_quote'),
            'framing_claim': claim.get('claim_text') or claim.get('claim'),
            'note': 'source_text is the complete decision text' if len(full) <= MAX_CHARS
                    else 'source_text is truncated at %d characters' % MAX_CHARS,
        }
        record = call(state, framing_questions(), 'fwide:%s:%s' % (tag, row_id), tag)
        if not record['ok']:
            rows.append({'row_id': row_id, 'status': 'error', 'error': record.get('error')})
            print(json.dumps(rows[-1]))
            continue
        answers = record['response']['answers']
        got = answers['verdict']['choice']
        rows.append({'row_id': row_id, 'proxy_label': prior['proxy_label'], 'prior_got': prior['got'],
                     'full_got': got, 'full_supported_p': answers['supported']['noul'],
                     'chars': len(text), 'usage': record['response']['usage']})
        print(json.dumps({k: rows[-1][k] for k in ('row_id', 'proxy_label', 'prior_got', 'full_got',
                                                   'full_supported_p', 'chars')}))
    (RECEIPTS / ('framing-wide-%s.json' % tag)).write_text(json.dumps(rows, indent=2), encoding='utf-8')
    scored = [r for r in rows if r.get('full_got')]
    adverse = [r for r in scored if r['proxy_label'] in ('insufficient', 'contradicted')]
    false_ad = [r for r in scored if r['proxy_label'] == 'supported']
    flipped = sum(1 for r in adverse if r['full_got'] != 'supported' and r['prior_got'] == 'supported')
    regressed = sum(1 for r in false_ad if r['full_got'] != 'supported' and r['prior_got'] == 'supported')
    print('WIDE %s: adverse %d rows, %d now adverse (was %d) | false-adverse %d rows, %d now adverse (was %d)' % (
        tag, len(adverse), sum(1 for r in adverse if r['full_got'] != 'supported'),
        sum(1 for r in adverse if r['prior_got'] != 'supported'),
        len(false_ad), regressed, sum(1 for r in false_ad if r['prior_got'] != 'supported')))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'misses'
    if which == 'misses':
        want = lambda r: r['proxy_label'] in ('insufficient', 'contradicted') and r['got'] == 'supported'
    elif which == 'falsead':
        want = lambda r: r['proxy_label'] == 'supported' and r['got'] != 'supported'
    else:
        want = lambda r: True
    main('wide-' + which, sys.argv[2], sys.argv[3], want)
