"""Fetch full sources for the CSLB A2AJ adversarial benchmark via the public API.

The benchmark ships prompts and gold responses but not the underlying passages;
the local a2aj.sqlite only covers a small slice. The public API
(https://api.a2aj.ca/fetch) resolves by neutral citation (e.g. '2024 CHRT 17').

Writes receipts/cslb-sources.json: {citation: full_text} for benchmark
source_citations, plus a resolution report. Respects upstream licenses:
texts are used locally for evaluation only and are not redistributed.
"""
import io
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH = ROOT / 'benchmarks' / 'legal-generalization-corpus' / 'cslb' / 'repo' / 'data' / 'a2aj_benchmark.jsonl'
RECEIPTS = Path(__file__).resolve().parent / 'receipts'

CACHE = RECEIPTS / 'cslb-sources.json'


def neutral_citation(source_citation):
    match = re.search(r'\b(19|20)\d{2}\s+[A-Z]{2,7}\s+\d+\s*$', source_citation.split(', para')[0].strip())
    return match.group(0).strip() if match else source_citation.strip()


def statutory_citation_key(source_citation):
    """Reduce 'Motor Vehicle Act, RSBC 1996, c 318, s. 117' to 'RSBC 1996, c 318'."""
    match = re.search(r'\((?:R\.?S\.?|S\.?)[A-Z]{0,4}.*?\)$', source_citation.strip(), re.IGNORECASE)
    tail = re.search(r'((?:R\.?S\.?|S\.?|RS\.?|R\.?S\.?C\.?)[A-Za-z ]*\d{4},\s*c\.?\s*[A-Z]?-?\d+(?:\.\d+)?)', source_citation)
    if tail:
        return re.sub(r'\s+', ' ', tail.group(1).replace('c.', 'c').replace(' ,', ',')).strip()
    return None


def fetch(citation, doc_type='cases'):
    key = urllib.parse.quote(citation)
    url = f'https://api.a2aj.ca/fetch?citation={key}&doc_type={doc_type}'
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.loads(response.read())
    results = payload.get('results') or []
    if len(results) == 1:
        return results[0]['unofficial_text_en']
    return None


def is_statute(source_citation):
    """Statutory citations name an Act or cite a consolidated statute code."""
    return (re.search(r'\bAct\b|, c [A-Z]-?\d+', source_citation) is not None
            and not re.search(r'\bv\.|v\b\.', source_citation))


def source_key(source_citation):
    """The cache key for a benchmark source_citation (matches fetch_cslb_sources)."""
    if is_statute(source_citation):
        key = statutory_citation_key(source_citation)
        return re.sub(r'\s+', ' ', key.replace('c.', 'c').replace(' ,', ',')).strip() if key else None
    return neutral_citation(source_citation)


def main():
    rows = [json.loads(line) for line in io.open(BENCH, encoding='utf-8')]
    sources = json.loads(io.open(CACHE, encoding='utf-8').read()) if CACHE.exists() else {}
    resolved, missed = 0, []
    for row in rows:
        citation = neutral_citation(row['source_citation'])
        if citation in sources:
            continue
        try:
            if is_statute(row['source_citation']):
                key = statutory_citation_key(row['source_citation'])
                text = fetch(key, 'laws') if key else None
            else:
                text = fetch(neutral_citation(row['source_citation']), 'cases')
        except Exception as error:  # noqa: BLE001 - log and continue
            print('ERROR', citation, error)
            text = None
        if text:
            sources[citation] = text
            resolved += 1
        else:
            missed.append(citation)
        time.sleep(0.3)
    CACHE.write_text(json.dumps(sources), encoding='utf-8')
    unique = sorted({neutral_citation(r['source_citation']) for r in rows})
    print(f'unique citations {len(unique)} | resolved {len(sources)} | missing {len(set(unique) - set(sources))}')
    for citation in sorted(set(unique) - set(sources))[:15]:
        print('  missing:', citation)


if __name__ == '__main__':
    main()
