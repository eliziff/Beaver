"""Print public benchmark sources for independent passage review; no gold/model imports."""
import argparse
import json
import os
from pathlib import Path
import sqlite3

ROOT = Path(__file__).resolve().parents[2]


def database_path():
    if os.environ.get('MIKE_A2AJ_BULK_DB'):
        return Path(os.environ['MIKE_A2AJ_BULK_DB'])
    home = Path(os.environ.get('OPEN_LEGAL_DATA_HOME') or Path(os.environ['LOCALAPPDATA']) / 'OpenLegalProducts' / 'LegalData')
    return home / 'providers' / 'a2aj' / 'a2aj.sqlite'


def source(document_id):
    with sqlite3.connect(database_path().resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT id, citation_en, name_en, url_en, unofficial_text_en FROM document WHERE id=? AND doc_type=?', (document_id, 'cases')).fetchone()
    if row is None or not row['unofficial_text_en']:
        raise ValueError(f'Missing English source: {document_id}')
    return dict(row)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('ids', type=int, nargs='+')
    parser.add_argument('--contains')
    parser.add_argument('--radius', type=int, default=1600)
    args = parser.parse_args()
    for document_id in args.ids:
        row = source(document_id)
        print(f"\nDOCUMENT {document_id}: {row['citation_en']} {row['name_en']}")
        text = row['unofficial_text_en']
        if args.contains:
            start = 0
            while (index := text.lower().find(args.contains.lower(), start)) >= 0:
                print(f'\nOFFSET {index}\n{text[max(0,index-args.radius):index+len(args.contains)+args.radius]}')
                start = index + len(args.contains)
        else:
            print(text)
