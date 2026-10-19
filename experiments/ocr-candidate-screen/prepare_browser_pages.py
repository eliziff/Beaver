"""Freeze held-out pages with human gold transcripts and Kraken-derived boxes."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import unicodedata
import xml.etree.ElementTree as ET


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def normalized(text):
    text = re.sub(r'[\u00ad\u00ac]\r?\n', '', text)
    text = unicodedata.normalize('NFKC', text).replace('\u00ad', '').replace('\u00ac', '')
    return re.sub(r'\s+', ' ', text).strip()


def gold(path):
    lines = []
    for line in ET.parse(path).getroot().iter():
        if line.tag.endswith('TextLine'):
            order = re.search(r'readingOrder\s*\{index:(\d+)', line.get('custom', ''))
            text = next((node.text or '' for node in line.iter() if node.tag.endswith('Unicode')), '')
            if text:
                lines.append((int(order.group(1)) if order else 10**9, text))
    return normalized('\n'.join(text for _, text in sorted(lines, key=lambda item: item[0])))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-bundle', type=Path, required=True)
    parser.add_argument('--audit', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--all-pages', action='store_true', help='Reference all original test pages in place instead of copying the twelve-page sample')
    args = parser.parse_args()
    listing = args.source_bundle / 'test.lst'
    audit = json.loads(args.audit.read_text(encoding='utf-8'))
    assert digest(listing) == audit['test']['manifest_sha256']
    names = [Path(line.replace('\\', '/')).name for line in listing.read_text(encoding='utf-8-sig').splitlines() if line]
    assert len(names) == audit['test']['pages'] == 55
    args.output.mkdir(parents=True, exist_ok=True)
    result = {'source': 'existing frozen CATMuS transfer test partition; original PAGE-XML gold',
              'test_manifest_sha256': digest(listing),
              'selection': 'twelve ordinals floor(i * (55 - 1) / (12 - 1)), fixed before browser predictions',
              'normalization': 'nfkc-collapse-not-soft-hyphen-v1', 'pages': []}
    if args.all_pages:
        result.update(selection='all 55 original test ordinals, in manifest order',
                      source='existing frozen test partition; human transcripts and Kraken line geometry',
                      reading_order='stored PAGE order; not independently audited')
    ordinals = range(len(names)) if args.all_pages else [i * (len(names) - 1) // 11 for i in range(12)]
    for i, ordinal in enumerate(ordinals):
        source = args.source_bundle / 'data' / names[ordinal]
        entry = {'ordinal': ordinal, 'source_page': source.name, 'gold': gold(source)}
        if not args.all_pages:
            assert len(entry['gold']) > 100
        for suffix in ['.xml', '.png']:
            target = source.with_suffix(suffix) if args.all_pages else args.output / f'{i + 1:02d}{suffix}'
            if not args.all_pages:
                shutil.copyfile(source.with_suffix(suffix), target)
            entry[suffix[1:]] = os.path.relpath(target.resolve(), args.output.resolve()).replace('\\', '/')
            entry[suffix[1:] + '_sha256'] = digest(target)
        result['pages'].append(entry)
    (args.output / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'pages': len(result['pages']), 'gold_characters': sum(len(page['gold']) for page in result['pages']), 'manifest_sha256': digest(args.output / 'manifest.json')}), flush=True)


if __name__ == '__main__':
    main()
