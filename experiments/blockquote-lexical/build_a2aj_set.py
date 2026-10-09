"""Paragraph units from A2AJ judgments, labelled block quotation or running text by the
judgment's own paragraph numbering: `python build_a2aj_set.py <out.jsonl> [--every N]`.

A judgment that numbers its paragraphs ("[12] ...") sets what it quotes as unnumbered
paragraphs between two numbered ones. Such a paragraph of eight words or more that opens no
list item is read as quotation; a numbered paragraph, its number dropped, as running text.
Lists, headings and the lines after the last numbered paragraph are left out.
"""
import argparse, json, re, sqlite3

DB = r'C:/Users/elias/AppData/Local/OpenLegalData/providers/a2aj/a2aj.sqlite'
NUMBERED = re.compile(r'^\s*\[(\d{1,4})\]\s+(\S.*)$')
ITEM = re.compile(r'^\s*(?:\(?[a-z0-9ivx]{1,4}[.)]|[\u2022\u25cf\-\u2013*])\s')
# Not quotation though unnumbered: a heading run into its paragraph's number ("ANALYSIS [12]"),
# a transcript's questions and answers, a signature or counsel block.
NOT_QUOTE = re.compile(r'\[\d{1,4}\]|^\s*(?:Q|A|THE COURT|THE WITNESS|MR|MS|MRS)[.:]?\s|^\s*\u00b7|^\s*(?:solicitors?|counsel|signed|dated|delivered)\b', re.I)
# A quoted paragraph ends a sentence or a quotation; a heading ends neither.
FINISHED = re.compile(r'[.;:!?"\u201d\u2019)\]]\s*$')


def units(text):
    paragraphs = [p.strip() for p in text.split('\n') if p.strip()]
    numbered = [i for i, p in enumerate(paragraphs) if NUMBERED.match(p)]
    if len(numbered) < 10:
        return
    for first, last in zip(numbered, numbered[1:]):
        for index in range(first, last + 1):
            paragraph = paragraphs[index]
            match = NUMBERED.match(paragraph)
            if match:
                yield index, False, match.group(2), paragraphs
            elif (len(paragraph.split()) >= 8 and not ITEM.match(paragraph)
                  and not NOT_QUOTE.search(paragraph) and FINISHED.search(paragraph)):
                yield index, True, paragraph, paragraphs


def plain(paragraph):
    match = NUMBERED.match(paragraph)
    return match.group(2) if match else paragraph


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('out')
    parser.add_argument('--every', type=int, default=8, help='Take every Nth case')
    args = parser.parse_args()
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    rows = db.execute("select id, dataset, unofficial_text_en from document where doc_type='cases' and id % ? = 0 and unofficial_text_en is not null", (args.every,))
    count = docs = 0
    with open(args.out, 'w', encoding='utf-8') as handle:
        for doc_id, dataset, text in rows:
            used = False
            for index, quote, body, paragraphs in units(text):
                before = plain(paragraphs[index - 1]) if index else ''
                after = plain(paragraphs[index + 1]) if index + 1 < len(paragraphs) else ''
                handle.write(json.dumps({'article': f'a2aj/{dataset}/{doc_id}', 'quote': quote, 'text': body,
                                         'before': before[-300:], 'after': after[:300]}, ensure_ascii=False) + '\n')
                count += 1
                used = True
            docs += used
    print(count, 'units from', docs, 'judgments')


if __name__ == '__main__':
    main()
