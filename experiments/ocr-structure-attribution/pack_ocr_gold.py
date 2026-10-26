"""Freeze audited OCR gold, geometry proposals and missing source PDFs for private backup.

Reads existing artifacts only. No OCR, PDF rendering, model calls or deletion.
Existing private release members are referenced instead of copying their PDFs.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile

from gold_inventory import corrected_lines, digest, geometry, normalized, page_number, read


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))+'\n').encode()


def file_digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


class Archives:
    def __init__(self, output, prefix):
        self.output, self.prefix = output, prefix
        self.archive = None
        self.names, self.size = [], 0
        self.members = set()

    def _open(self, size):
        if self.archive is None or self.size + size > 450*1024**2:
            if self.archive:
                self.archive.close()
            name = f'{self.prefix}-{len(self.names):03}.tar.gz'
            self.names.append(name)
            self.archive = tarfile.open(self.output/name, 'w:gz', compresslevel=1)
            self.size = 0
        self.size += size
        return self.names[-1]

    def add_bytes(self, member, data):
        if member in self.members:
            raise ValueError('Duplicate archive member: '+member)
        asset = self._open(len(data))
        info = tarfile.TarInfo(member)
        info.size, info.mtime, info.mode = len(data), 0, 0o644
        self.archive.addfile(info, io.BytesIO(data))
        self.members.add(member)
        return {'asset': asset, 'member': member}

    def add_pdf(self, member, path, expected):
        # Check bytes before adding them, so a stale locator cannot publish an unrelated file.
        with path.open('rb') as stream:
            if stream.read(5) != b'%PDF-':
                raise ValueError('Selected source is not a PDF')
        if file_digest(path) != expected:
            raise ValueError('Source PDF differs from its recorded hash: '+expected)
        size = path.stat().st_size
        asset = self._open(size)
        info = tarfile.TarInfo(member)
        info.size, info.mtime, info.mode = size, 0, 0o644
        with path.open('rb') as stream:
            self.archive.addfile(info, stream)
        return {'asset': asset, 'member': member}

    def close(self):
        if self.archive:
            self.archive.close()
            self.archive = None


def authoring_geometry(root, source):
    for folder in ['inputs', 'inputs-r29']:
        path = root/folder/(source+'.json.gz')
        if path.is_file():
            data = path.read_bytes()
            value = json.loads(gzip.decompress(data))
            pages = value.get('extraction', value).get('pages', [])
            witness = {'schema': 'ocr-authoring-geometry.v1', 'source_sha256': source,
                       'authoring_input_sha256': digest(data), 'geometry_status': 'inherited_proposals',
                       'pages': [{'page': p['number'], 'width': p['width'], 'height': p['height'],
                                  'lines': [{k: l[k] for k in ('id', 'text', 'bbox')} for l in p['lines']]}
                                 for p in pages]}
            lines = {l['id']: {**l, 'page': p['page']} for p in witness['pages'] for l in p['lines']}
            return witness, lines
    return None, {}


def pack(config, artifacts, known, output, prefix):
    output.mkdir(parents=True, exist_ok=True)
    owners = {o['name']: o for o in config['owners']}
    source_paths, partitions = defaultdict(set), defaultdict(set)
    for path in config.get('manifests', []):
        for row in read(path)['documents']:
            if row.get('path'):
                source_paths[row['sha256']].add(row['path'])
            if row.get('split'):
                partitions[row['sha256']].add(row['split'])
    catalogue = read(config['catalogue'])
    for row in catalogue['runs']:
        if row.get('source') and row['source'].get('path'):
            path = Path(row['source']['path'])
            if not path.is_absolute():
                path = Path(config['corpus_home'])/path
            source_paths[row['sha256']].add(str(path))
    rows, missing, changed = [], [], []
    pixels, geometries, seen = {}, {}, {}
    archives = Archives(output, prefix)
    recorded = datetime.now(timezone.utc).isoformat()
    evidence = digest(json_bytes(artifacts))
    try:
        for index, item in enumerate(artifacts):
            if index % 100 == 0:
                print(json.dumps({'gold_files': index, 'total': len(artifacts), 'pdfs_added':
                                  sum('missing' not in v and 'availability' not in v for v in pixels.values())}), flush=True)
            path = Path(item['path'])
            data = path.read_bytes()
            signature = digest(data)
            if signature != item['sha256']:
                changed.append({'path': str(path), 'audited_sha256': item['sha256'], 'current_sha256': signature})
                continue
            if signature in seen:
                seen[signature]['notes']['other_origins'].append({'owner': item['owner'], 'path': str(path)})
                continue
            gold = json.loads(gzip.decompress(data) if path.suffix == '.gz' else data)
            source = gold['source_sha256']
            if not re.fullmatch('[a-f0-9]{64}', source):
                raise ValueError('Invalid source identity')
            if source not in pixels:
                if source in known['pdfs']:
                    pixels[source] = {**known['pdfs'][source], 'sha256': source, 'availability': 'existing_private_backup'}
                else:
                    pdf = next((Path(p) for p in sorted(source_paths[source]) if Path(p).is_file()), None)
                    if pdf:
                        pixels[source] = {**archives.add_pdf('pdfs/'+source+'.pdf', pdf, source),
                                          'sha256': source}
                    else:
                        pixels[source] = {'sha256': source, 'missing': True}
                        missing.append(source)
            owner = owners[item['owner']]
            root = Path(owner.get('cache_root', owner['root']))
            witness, cache = authoring_geometry(root, source)
            geometry_locator = None
            if witness:
                raw = gzip.compress(json_bytes(witness), mtime=0)
                geometry_hash = digest(raw)
                if geometry_hash not in geometries:
                    geometries[geometry_hash] = {**archives.add_bytes('geometry/'+geometry_hash+'.json.gz', raw),
                                                 'sha256': geometry_hash}
                geometry_locator = geometries[geometry_hash]
            projection, counts, pages = [], Counter(), set()
            for line, text, explicit, error in corrected_lines(gold):
                if error:
                    counts[error] += 1
                    continue
                if not text.strip():
                    continue
                box, kind = geometry(line, gold, cache)
                pages.add(page_number(line))
                counts['lines'] += 1
                counts['corrected'] += explicit
                counts['geometry'] += box is not None
                counts[kind] += 1
                projection.append([line['id'], page_number(line), box, normalized(text)])
            member = 'transcripts/'+source+'/'+signature+'/gold.json.gz'
            locator = {**archives.add_bytes(member, data), 'sha256': signature}
            receipt = path.with_name('receipt.json')
            receipt_locator = None
            if receipt.is_file():
                receipt_data = receipt.read_bytes()
                receipt_locator = {**archives.add_bytes(member.rsplit('/', 1)[0]+'/receipt.json', receipt_data),
                                   'sha256': digest(receipt_data)}
            split = sorted(partitions[source])
            ocr_hash = digest(json_bytes({'source_sha256': source, 'lines': projection}))
            row = {'artifact_sha256': signature, 'ocr_sha256': ocr_hash, 'source_sha256': source,
                   'collection': item['owner'], 'kind': 'line_transcript', 'authority': 'model_image_annotation',
                   'qualification': 'model_annotated',
                   'text_contract': 'package_v2_corrected_lines' if gold.get('source_text') is not None else 'corrected_else_text',
                   'gold_locator': locator, 'geometry_locator': geometry_locator, 'pixel_locator': pixels[source],
                   'partition': split[0] if len(split) == 1 else 'conflict' if split else 'unassigned',
                   'page_count': len(pages), 'line_count': counts['lines'], 'corrected_line_count': counts['corrected'],
                   'geometry_line_count': counts['geometry'], 'notes': {'schema': gold.get('schema_version'),
                       'origin_path': str(path), 'origin_owner': item['owner'], 'other_origins': [],
                       'receipt_locator': receipt_locator, 'mode': item['mode'], 'validation_counts': dict(counts),
                       'geometry_status': 'inherited_proposals', 'crop_validation': 'pending',
                       'structure_selection': 'historical_structure' if 'historical' in item['owner'] else 'not_reclassified',
                       'split_conflict': len(split) > 1},
                   'evidence_sha256': evidence, 'recorded_at': recorded}
            if counts['geometry'] and geometry_locator is None:
                row['geometry_locator'] = {'embedded_in_gold': True, 'units': 'normalized_1000' if
                                           gold.get('source_text') is not None else 'pdf_points'}
            rows.append(row)
            seen[signature] = row
    finally:
        archives.close()
    manifests = [{'name': name, 'sha256': file_digest(output/name), 'bytes': (output/name).stat().st_size}
                 for name in archives.names]
    assets = {a['name']: a for a in manifests}
    def bind(value):
        if isinstance(value, dict):
            if value.get('asset') in assets:
                value.update({'repo': config['repository'], 'tag': config['tag'],
                              'asset_sha256': assets[value['asset']]['sha256']})
            elif value.get('asset'):
                value.setdefault('repo', config['repository'])
            for child in list(value.values()):
                bind(child)
        elif isinstance(value, list):
            for child in value:
                bind(child)
    bind(rows)
    result = {'schema': 'ocr-gold-private-snapshot.v1', 'recorded_at': recorded,
              'archives': manifests, 'rows': rows, 'missing_pixel_sources': sorted(missing),
              'changed_since_audit': changed,
              'counts': {'artifact_files': len(rows), 'unique_source_pdfs': len(pixels),
                         'unique_ocr_views': len({r['ocr_sha256'] for r in rows}),
                         'missing_pixel_sources': len(missing), 'changed_since_audit': len(changed)}}
    with gzip.open(output/'snapshot.json.gz', 'wt', encoding='utf-8') as stream:
        json.dump(result, stream, ensure_ascii=False)
    print(json.dumps(result['counts']), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--artifacts', type=Path, required=True)
    parser.add_argument('--known-assets', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--prefix', required=True)
    args = parser.parse_args()
    if not re.fullmatch('[a-z0-9-]+', args.prefix):
        parser.error('Archive prefix must contain only lowercase letters, numbers and hyphens')
    with gzip.open(args.artifacts, 'rt', encoding='utf-8') as stream:
        artifacts = [json.loads(line) for line in stream]
    pack(read(args.config), artifacts, read(args.known_assets), args.out, args.prefix)


if __name__ == '__main__':
    main()
