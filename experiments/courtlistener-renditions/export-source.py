"""Stream the acquired, independent source rows once into the Rust packer."""
import json
import argparse
from pathlib import Path
import sqlite3
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('--skip', type=int, default=0)
parser.add_argument('--limit', type=int, default=-1)
args, command = parser.parse_known_args()
source = args.source.resolve(strict=True)
process = subprocess.Popen(command, stdin=subprocess.PIPE) if command else None
destination = process.stdin if process else sys.stdout.buffer
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as db:
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    for row in db.execute('SELECT opinion.*, sample_origin.range_index FROM opinion JOIN sample_origin USING(id) ORDER BY CAST(opinion.id AS INTEGER) LIMIT ? OFFSET ?', (args.limit,args.skip)):
        opinion = dict(row)
        position = opinion.pop('range_index')
        destination.write(json.dumps({'opinion': opinion, 'range_index': position}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8') + b'\n')
if process:
    destination.close()
    sys.exit(process.wait())
