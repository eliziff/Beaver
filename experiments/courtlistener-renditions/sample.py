"""Recover a lossless, position-stratified sample from the official bulk snapshot.

Uses the existing bzip2recover locator and range planner. Unlike the historical
sampler, it reads the actual header and preserves SQL NULL versus empty strings.
Raw complete source rows remain in the named, ignored source database for
independent reconstruction and native corpus runs.
"""
from __future__ import annotations

import argparse
import bz2
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend/scripts'))
from sample_courtlistener_opinions import bzip2recover_path, range_plan

BASE = 'https://com-courtlistener-storage.s3-us-west-2.amazonaws.com/bulk-data/'


def get_range(url, start, end, etag):
    request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}', 'If-Match': etag})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(end - start + 2)
        if response.status != 206 or len(data) != end - start + 1 or response.headers.get('ETag') != etag:
            raise ValueError('Snapshot changed or byte range was not honored')
        return data


def complete_rows(raw, columns, initially_quoted):
    quoted, escaped_at, start = initially_quoted, -1, 0
    rows, rejected = [], 0
    cluster_column = columns.index('cluster_id')
    for match in re.finditer(rb'["\\\n]', raw):
        offset, byte = match.start(), match.group()
        if offset == escaped_at:
            continue
        if byte == b'\\':
            if quoted:
                escaped_at = offset + 1
        elif byte == b'"':
            quoted = not quoted
        elif not quoted:
            record, start = raw[start:offset + 1], offset + 1
            try:
                row = next(csv.reader(io.StringIO(record.decode('utf-8')), escapechar='\\',
                    doublequote=False, quoting=csv.QUOTE_NOTNULL, strict=True))
                valid = len(row) == len(columns) and (row[0] or '').isdigit() and (row[cluster_column] or '').isdigit()
            except (csv.Error, UnicodeDecodeError, StopIteration):
                valid = False
            if valid:
                rows.append(row)
            else:
                rejected += 1
    return rows, rejected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', default='2026-09-30')
    parser.add_argument('--ranges', type=int, default=64)
    parser.add_argument('--range-bytes', type=int, default=2 * 1024 * 1024)
    parser.add_argument('--out', default='benchmarks/local-data/courtlistener-renditions/sample')
    args = parser.parse_args()
    csv.field_size_limit(2 ** 31 - 1)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    url = BASE + f'opinions-{args.snapshot}.csv.bz2'
    with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as response:
        size, etag = int(response.headers['Content-Length']), response.headers['ETag']
    header_bytes = get_range(url, 0, args.range_bytes - 1, etag)
    header = bz2.BZ2Decompressor().decompress(header_bytes).split(b'\n', 1)[0].decode('utf-8')
    columns = next(csv.reader([header], escapechar='\\', doublequote=False, quoting=csv.QUOTE_NOTNULL))
    if not columns or columns[0] != 'id' or 'cluster_id' not in columns or len(set(columns)) != len(columns) or any(not re.fullmatch('[a-z][a-z0-9_]*', c) for c in columns):
        raise ValueError('Unrecognized official opinion header')
    db = sqlite3.connect(out / 'original.sqlite')
    db.executescript('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT); '
        'CREATE TABLE IF NOT EXISTS sampled_range(ordinal INTEGER PRIMARY KEY,start INTEGER,end INTEGER,receipt TEXT); '
        'CREATE TABLE IF NOT EXISTS sample_origin(id TEXT PRIMARY KEY,range_index INTEGER);')
    previous = db.execute("SELECT value FROM meta WHERE key='snapshot'").fetchone()
    identity = json.dumps({'url': url, 'bytes': size, 'etag': etag, 'columns': columns,
                           'ranges': args.ranges, 'range_bytes': args.range_bytes}, sort_keys=True)
    if previous and previous[0] != identity:
        raise ValueError('Existing sample belongs to a different snapshot or sampling plan')
    db.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', ('snapshot', identity))
    db.execute('CREATE TABLE IF NOT EXISTS opinion(' + ','.join(f'"{c}" TEXT' + (' PRIMARY KEY' if c == 'id' else '') for c in columns) + ')')
    db.commit()
    recover = bzip2recover_path(None)
    scratch = ROOT / '.tmp'
    scratch.mkdir(exist_ok=True)
    try:
        for ordinal, (start, end) in enumerate(range_plan(size, args.ranges, args.range_bytes)):
            if db.execute('SELECT 1 FROM sampled_range WHERE ordinal=?', (ordinal,)).fetchone():
                print(f'[{ordinal + 1}/{args.ranges}] already retained', flush=True)
                continue
            data = header_bytes if start == 0 else get_range(url, start, end, etag)
            with tempfile.TemporaryDirectory(prefix='courtlistener-range-', dir=scratch) as work_name:
                work = Path(work_name)
                (work / 'range.bin').write_bytes(data)
                with (work / 'recover.log').open('w', encoding='utf-8') as log:
                    subprocess.run([str(recover), 'range.bin'], cwd=work, stdout=log,
                        stderr=subprocess.STDOUT, check=True, creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
                blocks = sorted(work.glob('rec*.bz2'))
                raw = b''.join(bz2.decompress(b.read_bytes()) for b in blocks)
                alternatives = sorted([complete_rows(raw, columns, False), complete_rows(raw, columns, True)], key=lambda pair: len(pair[0]), reverse=True)
                rows, rejected = alternatives[0]
                if not rows or len(rows) == len(alternatives[1][0]) and rows != alternatives[1][0]:
                    raise ValueError(f'No unambiguous complete records in source range {ordinal}')
                receipt = {'start': start, 'end': end, 'compressed_sha256': hashlib.sha256(data).hexdigest(),
                    'recovered_blocks': len(blocks), 'recovered_bytes': len(raw), 'rows': len(rows),
                    'rejected_boundaries': rejected}
                with db:
                    db.executemany('INSERT OR IGNORE INTO opinion VALUES (' + ','.join('?' for _ in columns) + ')', rows)
                    db.executemany('INSERT OR IGNORE INTO sample_origin VALUES (?,?)', ((r[0], ordinal) for r in rows))
                    db.execute('INSERT INTO sampled_range VALUES (?,?,?,?)', (ordinal, start, end, json.dumps(receipt)))
            print(f'[{ordinal + 1}/{args.ranges}] {len(rows):,} source rows retained from bytes {start:,}-{end:,}', flush=True)
        report = {'source': json.loads(identity), 'sampling': 'evenly spaced compressed positions; complete recoverable CSV records only',
            'full_corpus': False, 'opinion_rows': db.execute('SELECT COUNT(*) FROM opinion').fetchone()[0],
            'sampled_compressed_bytes': args.ranges * args.range_bytes,
            'raw_database_bytes': (out / 'original.sqlite').stat().st_size,
            'ranges': [json.loads(r[0]) for r in db.execute('SELECT receipt FROM sampled_range ORDER BY ordinal')]}
        (out / 'source.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print(json.dumps({k: report[k] for k in ('full_corpus', 'opinion_rows', 'raw_database_bytes')}), flush=True)
    finally:
        db.close()


if __name__ == '__main__':
    main()
