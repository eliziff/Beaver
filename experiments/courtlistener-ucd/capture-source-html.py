"""Independently inventory literal saved source nesting on selected real pages.

BeautifulSoup's existing html.parser dependency retains nested source anchors;
HTML5 browser reparsing can instead repair them. This is not rendering evidence.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from bs4 import BeautifulSoup


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('gaps', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    selected = {json.loads(line)['html_sha256'] for line in args.gaps.read_text(encoding='utf-8').splitlines()}
    bodies, elements_count = 0, 0
    with args.output.open('w', encoding='utf-8', newline='\n') as output:
        for line in args.manifest.read_text(encoding='utf-8').splitlines():
            capture = json.loads(line)
            if capture['sha256'] not in selected:
                continue
            raw = Path(capture['path']).read_bytes()
            if hashlib.sha256(raw).hexdigest() != capture['sha256']:
                raise RuntimeError('Retained source digest changed')
            soup = BeautifulSoup(raw.decode('utf-8'), 'html.parser', multi_valued_attributes=None)
            for body_index, body in enumerate(soup.select('.subopinion-content')):
                tags = [body, *body.find_all(True)]
                indexes = {id(tag):index for index, tag in enumerate(tags)}
                elements = [{'source_index':index, 'parent_index':indexes.get(id(tag.parent)),
                    'tag':tag.name, 'anchor':tag.get('id'), 'attributes':dict(tag.attrs),
                    'text_content':tag.get_text(), 'inner_text':None, 'row_span':1, 'column_span':1}
                    for index, tag in enumerate(tags)]
                output.write(json.dumps({'html_sha256':capture['sha256'], 'body_index':body_index,
                    'ancestors':[], 'elements':elements}, ensure_ascii=False)+'\n')
                bodies += 1
                elements_count += len(elements)
    summary = {'schema':'courtlistener.literal-source-gold.v1', 'pages':len(selected),
        'bodies':bodies, 'elements':elements_count, 'all_elements':True, 'visible_text':False,
        'scope':'Independent existing html.parser source nesting and decoded attributes; no browser rendering or navigation claim'}
    args.output.with_name(args.output.stem+'-summary.json').write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(summary))


if __name__ == '__main__':
    main()
