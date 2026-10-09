"""Paragraph units from the Open Access Journals Database's final journal packages, labelled
block quotation or running text by the package's own regions, with the text around each:
`python build_journal_set.py <out.jsonl> [--limit N]`.

A unit is one text or block_quote region; a region the page break cuts carries on the
previous page's when the two share a type and the first ends no sentence. Footnotes, running
heads, folios, tables and titles are left out, as are units of fewer than four words.
"""
import argparse, json, random, re
from pathlib import Path

PACKAGES = Path(r'C:/Users/elias/Desktop/Open Access Journals Database/data/final_contracts')
KEEP = {'text', 'block_quote'}
ENDS = re.compile(r'[.:;!?]["\u201d\u2019)\]]*\s*$')


def units(path):
    regions = []
    for line in open(path, encoding='utf-8'):
        page = json.loads(line)
        for region in page.get('regions') or []:
            kind = region.get('type')
            text = ' '.join((region.get('text') or '').split())
            if kind in KEEP and text:
                regions.append([kind, text, page.get('pdf_page')])
            elif kind in ('paragraph_title', 'doc_title', 'table'):
                regions.append(['break', text, page.get('pdf_page')])
    merged = []
    for kind, text, page in regions:
        if merged and merged[-1][0] == kind != 'break' and merged[-1][2] != page and not ENDS.search(merged[-1][1]):
            merged[-1][1] += ' ' + text
            merged[-1][2] = page
        else:
            merged.append([kind, text, page])
    return merged


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('out', type=Path)
    parser.add_argument('--limit', type=int, default=0)
    args = parser.parse_args()
    files = sorted(PACKAGES.rglob('pages.jsonl'))
    if args.limit:
        random.Random(0).shuffle(files)
        files = files[:args.limit]
    count = 0
    with args.out.open('w', encoding='utf-8') as handle:
        for path in files:
            try:
                items = units(path)
            except (OSError, json.JSONDecodeError):
                continue
            article = '/'.join(path.parts[-5:-1])
            for index, (kind, text, page) in enumerate(items):
                if kind == 'break' or len(text.split()) < 4:
                    continue
                before = items[index - 1][1] if index else ''
                after = items[index + 1][1] if index + 1 < len(items) else ''
                handle.write(json.dumps({'article': article, 'page': page, 'quote': kind == 'block_quote',
                                         'text': text, 'before': before[-300:], 'after': after[:300],
                                         'before_kind': items[index - 1][0] if index else '',
                                         'after_kind': items[index + 1][0] if index + 1 < len(items) else ''},
                                        ensure_ascii=False) + '\n')
                count += 1
    print(count, 'units from', len(files), 'packages')


if __name__ == '__main__':
    main()
