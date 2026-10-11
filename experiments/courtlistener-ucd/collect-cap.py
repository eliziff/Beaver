"""Retain exact CAP metadata and CourtListener stylesheet bytes from source URLs."""
from __future__ import annotations
import argparse
import importlib.util
import json
from pathlib import Path
import sys

WORKSPACE = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('legal_corpus_store', WORKSPACE/'experiments/legal_pdf_corpus/corpus_store.py')
store = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(store)
sys.path.insert(0, str(WORKSPACE/'experiments/courtlistener-renditions'))
from budget import remaining


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('candidates', type=Path)
    parser.add_argument('--out', type=Path, default=WORKSPACE/'benchmarks/local-data/courtlistener-ucd/cap-captures.jsonl')
    args = parser.parse_args()
    candidates = json.loads(args.candidates.read_text(encoding='utf-8'))
    with store.connect() as db, args.out.open('a', encoding='utf-8', newline='\n') as output:
        for candidate in candidates:
            url = candidate['url']
            stylesheet = candidate.get('kind') == 'stylesheet'
            if stylesheet:
                valid = url.startswith('https://storage.courtlistener.com/static/') and url.endswith('.css')
            else:
                valid = url.startswith('https://archive.org/download/') and url.endswith('.json')
            if not valid:
                raise ValueError('Expected official cluster CAP archive JSON URL')
            if remaining() < store.MAX_BYTES + 1_500_000_000:
                break
            record = {**candidate, 'fetched_at':store.now()}
            known = db.execute('select f.sha256,f.path from documents d join files f on f.sha256=d.sha256 where d.url=? order by d.last_seen_at desc limit 1', (url,)).fetchone()
            try:
                if known:
                    sha, relative = known
                    body = (store.HOME/relative).read_bytes()
                    data = {} if stylesheet else json.loads(body)
                    record.update(sha256=sha, corpus_path=relative, bytes=len(body), status='already-stored')
                else:
                    status, final, ctype, body, headers = store.get(url)
                    if status != 200:
                        raise ValueError(f'HTTP {status}')
                    data = {} if stylesheet else json.loads(body)
                    if stylesheet and 'text/css' not in ctype:
                        raise ValueError('Expected stylesheet response')
                    meta = {'collection':'courtlistener-http' if stylesheet else 'courtlistener-cap',
                        'kind':'stylesheet' if stylesheet else 'opinion', 'jurisdiction':'us',
                        'label':'CourtListener stylesheet' if stylesheet else 'CAP metadata',
                        'provenance':'Captured CourtListener stylesheet href' if stylesheet else 'Official CourtListener cluster filepath_json_harvard'}
                    # Text equality cannot replace byte equality: preserve every
                    # original metadata value, annotation and structural witness.
                    sha = store.add_file(db, body, ctype, store.place(meta), text=False)
                    store.note(db, sha, meta, url, final, headers)
                    db.commit()
                    relative = db.execute('select path from files where sha256=?', (sha,)).fetchone()[0]
                    record.update(sha256=sha, corpus_path=relative, bytes=len(body), status='stored', final_url=final)
                if not stylesheet:
                    record.update(citations=data.get('citations'), casebody_format=data.get('casebody',{}).get('format'))
            except (OSError, ValueError) as error:
                record.update(status='failed', error=str(error))
            output.write(json.dumps(record, ensure_ascii=False)+'\n')
            output.flush()
            print(json.dumps(record, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
