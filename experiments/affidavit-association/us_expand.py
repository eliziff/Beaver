"""Private RECAP hard-gold expansion; use existing cached originals first."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

import fitz

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/local-data/affidavit-association/expansion/us'
STORE = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData/corpus'
OUT.mkdir(parents=True, exist_ok=True)


def dump(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')


def inventory():
    roots = [ROOT / 'benchmarks/court-record-exhibits/records',
             STORE.parent / 'benchmarks/court-record-exhibits/records']
    known = []
    for root in roots:
        for path in root.glob('*/source.json'):
            value = json.loads(path.read_text(encoding='utf-8'))
            known.append({'id': path.parent.name, 'source': value})
    dump(OUT / 'existing.json', known)
    connection = sqlite3.connect(STORE / 'corpus.sqlite')
    connection.row_factory = sqlite3.Row
    print(connection.execute("select sql from sqlite_master where type='table'").fetchall()[0][0])
    rows = [dict(r) for r in connection.execute("select distinct f.* from files f join pages p on p.sha256=f.sha256 where f.path like '%court-record-sources/us/%' and p.page<=3 and (p.text like '%DECLARATION OF%' or p.text like '%AFFIDAVIT OF%')")]
    print('FILES', len(rows), rows[0])
    candidates = []
    for row in rows:
        path = STORE.parent / row['path']
        if '/us/' not in path.as_posix() and 'gov.uscourts' not in str(row):
            continue
        try:
            with fitz.open(path) as doc:
                if len(doc) > 250:
                    continue
                texts = connection.execute('select page,text from pages where sha256=? order by page', (row['sha256'],)).fetchall()
                text = '\n'.join(f'[source page {r[0]}]\n{r[1]}' for r in texts)
                if re.search(r'(?:declar(?:e|ation)|affidavit)', text, re.I) and len(re.findall(r'\bexhibits?\b', text, re.I)) >= 3:
                    candidates.append({'sha256': row['sha256'], 'path': str(path), 'pages': len(doc), 'text': text})
        except Exception:
            pass
    dump(OUT / 'inventory.json', candidates)
    print('US CANDIDATES', len(candidates))


def acquire():
    sys.path.insert(0, str(ROOT / 'experiments/legal_pdf_corpus'))
    import corpus_store as cs
    connection = cs.connect()
    listings = json.loads((ROOT / 'benchmarks/court-record-exhibits/expansion-50/us-listings-all.json').read_text(encoding='utf-8'))
    allowed = {'us-akd-gilbert-natchiq', 'us-cod-connor-servicequik', 'us-mad-larson-amadei',
               'us-mied-dobronski-fractel', 'us-nysd-kouyate-bai', 'us-pawd-biros-snyder',
               'us-txsd-wilmington-myers', 'us-vid-friedberg-daybreak'}
    cached = {r[0]: r[1] for r in connection.execute('select url,sha256 from documents')}
    candidates = []
    for listing in listings:
        if listing['case']['record'] not in allowed:
            continue
        grouped = {}
        for obj in listing['objects']:
            m = re.search(r'\.(\d+)\.(\d+)\.pdf$', obj['key'])
            if m:
                grouped.setdefault(int(m[1]), {})[int(m[2])] = obj
        for entry, group in grouped.items():
            if 0 not in group or len(group) < 2 or group[0]['bytes'] > 500000:
                continue
            if '--parts' in sys.argv:
                items = [(n, obj) for n, obj in group.items() if n and obj['bytes'] < 450000]
            else:
                items = [(0, group[0])]
            for attachment, obj in items:
                screen_object(connection, cached, listing, entry, group, attachment, obj, candidates, cs)
    dump(OUT / ('acquired-parts.json' if '--parts' in sys.argv else 'acquired.json'), candidates)


def screen_object(connection, cached, listing, entry, group, attachment, obj, candidates, cs):
            url = 'https://com-courtlistener-storage.s3.us-west-2.amazonaws.com/' + obj['key']
            sha = cached.get(url)
            if not sha:
                sha, status = cs.fetch(connection, url, {'collection': 'court-record-sources', 'jurisdiction': 'us',
                    'kind': 'court-record', 'label': listing['case']['title'] + f' entry {entry}',
                    'provenance': 'RECAP public S3 listing snapshot 2026-10-07'}, refresh=False)
            if not sha:
                return
            row = connection.execute('select path from files where sha256=?', (sha,)).fetchone()
            path = cs.HOME / row[0]
            try:
                with fitz.open(path) as doc:
                    text = '\n'.join(f'[source page {i+1}]\n{p.get_text()}' for i,p in enumerate(doc))
                    if len(re.findall(r'\bexhibits?\b', text, re.I)) >= 2:
                        value = {'case': listing['case'], 'entry': entry, 'attachment': attachment, 'objects': group,
                                 'url': url, 'sha256': sha, 'path': str(path), 'pages': len(doc), 'text': text}
                        candidates.append(value)
                        dump(OUT / ('acquired-parts.json' if '--parts' in sys.argv else 'acquired.json'), candidates)
                        print('CANDIDATE', listing['case']['record'], entry, attachment, len(doc), flush=True)
            except Exception as exc:
                print('SKIP', url, str(exc), flush=True)



if __name__ == '__main__':
    acquire() if '--acquire' in sys.argv else inventory()
