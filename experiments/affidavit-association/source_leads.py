"""Find unannotated affidavit starts inside already indexed public PDFs."""
import json
import os
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).resolve().parents[2]
HOME = Path(os.environ['LOCALAPPDATA']) / 'OpenLegalData'
OUT = ROOT / 'benchmarks/local-data/affidavit-association/source-leads.json'


def main():
    annotated = {}
    for root in (HOME / 'benchmarks/court-record-exhibits/records', ROOT / 'benchmarks/court-record-exhibits/records'):
        for source_path in root.glob('*/source.json'):
            split_path = source_path.with_name('split.json')
            if not split_path.exists(): continue
            source, split = (json.loads(p.read_text(encoding='utf-8')) for p in (source_path, split_path))
            key = source.get('source_sha256')
            annotated.setdefault(key, set()).update(split.get('affidavit_pages', []))
    with sqlite3.connect((HOME / 'corpus/corpus.sqlite').as_uri() + '?mode=ro', uri=True) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute('''select p.sha256,p.page,p.text,f.path,f.pages,
            d.jurisdiction,d.collection,d.label,d.url from pages_fts q
            join pages p on p.rowid=q.rowid join files f using(sha256) join documents d using(sha256)
            where pages_fts match '"make oath" OR "solemnly affirm" OR "swear and affirm"'
            and f.path like '%.pdf' and d.url is not null''').fetchall()
    unique = {}
    for row in rows:
        row = dict(row)
        text = re.sub(r'\s+', ' ', row['text'])
        if not re.search(r'\bI,?\s+.{3,220}?(?:MAKE OATH|SWEAR AND AFFIRM|SOLEMNLY AFFIRM)', text, re.I): continue
        if row['page'] in annotated.get(row['sha256'], set()): continue
        row['already_used_parent'] = row['sha256'] in annotated
        row['text'] = row['text'][:16000]
        unique.setdefault((row['sha256'], row['page']), row)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(list(unique.values()), ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'candidate_starts': len(unique), 'parents': len({sha for sha, _ in unique}),
                      'already_used_parents': sum(row['already_used_parent'] for row in unique.values())}))


if __name__ == '__main__':
    main()
