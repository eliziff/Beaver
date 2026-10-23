"""Join already accepted complete annotations to their original source-page maps.

This mechanical export adds no facts, quotations or inferred source pages. The
canonical source Gold is independent of anonymous, stripped model-input PDFs.
"""
import argparse
from copy import deepcopy
import json

from data import PRIVATE, accepted_gold, read, digest, source_mapping


def from_complete_projection(directory):
    gold = read(directory / 'gold.json')
    if gold.get('available_not_selected') or gold.get('source_exhibit_exclusions'):
        raise ValueError('Incomplete source inventory needs source authoring: ' + gold['record_id'])
    source, split = read(directory / 'source.json'), read(directory / 'split.json')
    def original(part):
        return source_mapping(source, part)
    mappings = {e['label']: e for e in split['exhibits']}
    result = {key: deepcopy(value) for key, value in gold.items() if key not in {'exhibits', 'events', 'gold_provenance'}}
    result['schema'] = 'affidavit-source-gold.v1'
    result['origin'] = 'machine_test'
    result['gold_provenance'] = deepcopy(gold['gold_provenance'])
    result['source_referring_document'] = {'source_files': [original({'pages': split['affidavit_pages']})]}
    result['exhibits'] = []
    for annotation in gold['exhibits']:
        exhibit = {key: deepcopy(value) for key, value in annotation.items() if key != 'file'}
        mapping = mappings[annotation['label']]
        parts = mapping.get('source_files') or [{'pages': mapping['source_pages'], 'cover_page': mapping.get('cover_page')}]
        exhibit['source_files'] = [original(part) for part in parts]
        exhibit['availability'] = 'attached_public'
        result['exhibits'].append(exhibit)
    result['events'] = deepcopy(gold['events'])
    result['source_gold_scope'] = 'Complete existing attached-label inventory; model projections are separate derived artifacts.'
    result['mechanical_derivation'] = {'evaluated_gold_sha256': digest(directory / 'gold.json'),
                                       'source_metadata_sha256': digest(directory / 'source.json'),
                                       'split_sha256': digest(directory / 'split.json'),
                                       'method': 'Existing accepted facts and quotations joined to existing original SHA/page maps; no inferred pages or new annotation.'}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lanes', nargs='+', default=['canada', 'regulatory'])
    options = parser.parse_args()
    count = 0
    for path in accepted_gold(PRIVATE / 'expansion', lanes=options.lanes).values():
        output = path.with_name('source-gold.json')
        if output.exists(): continue
        result = from_complete_projection(path.parent)
        output.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
        count += 1
    print(json.dumps({'canonical_source_records_written': count}))


if __name__ == '__main__':
    main()
