"""Materialize nested, messy file sets; originals and truth never enter model folders."""
from __future__ import annotations

import argparse
from functools import lru_cache
import io
import json
import os
from pathlib import Path
import random
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject
import pypdfium2
from PIL import Image, ImageDraw, ImageFilter

import benchmark as b
sys.path.insert(0, str(b.PRIVATE / 'python-packages'))
os.environ['MPLCONFIGDIR'] = str(b.PRIVATE / 'runtime/matplotlib')
import numpy as np
from augraphy import BadPhotoCopy
from projection import extract, project

PIPELINE = 'raster-v4-reviewed-word-masks'
PREPARER_SHA=b.digest(Path(__file__))
PROJECTION_CODE_SHA=b.digest(b.HERE/'projection.py')


class SourceMappingError(ValueError):
    pass


@lru_cache(maxsize=4)
def original(part_path, sha):
    path = b.corpus_store.HOME / part_path
    if b.digest(path) != sha:
        raise ValueError('Original source changed: ' + sha)
    return PdfReader(path)


@lru_cache(maxsize=512)
def physical_pages(part_path,sha):
    return len(original(part_path,sha).pages)


def metadata(key):
    """Fictional export profiles, assigned independently of origin, role and gold."""
    rng = random.Random('metadata:' + key)
    creator, producer = rng.choice([
        ('Microsoft Word', 'Microsoft: Print To PDF'),
        ('Acrobat PDFMaker', 'Adobe PDF Library'),
        ('Office scanner', 'Image conversion'),
        ('', ''),
    ])
    value = {'/Creator': creator, '/Producer': producer}
    if rng.choice([False, True]):
        value['/CreationDate'] = f'D:202{rng.randrange(1, 6)}{rng.randrange(1,13):02}{rng.randrange(1,29):02}103000Z'
        value['/ModDate'] = 'D:20261020120000Z'
    if rng.choice([False, True]):
        value['/Title'] = rng.choice(['Document', 'Correspondence', 'Scan', ''])
        value['/Author'] = rng.choice(['', 'Administration', 'Records'])
    return value


def finish(writer, path, key, masks=None):
    # One image-PDF export for every origin removes writer/font/stream signatures.
    native = io.BytesIO()
    writer.write(native)
    frames = []
    with pypdfium2.PdfDocument(native.getvalue()) as pdf:
        for number, page in enumerate(pdf):
            bitmap = page.render(scale=110 / 72)
            try:
                frame = bitmap.to_pil().convert('RGB')
                # These are the source suite's reviewed folio/stamp rectangles, not new detection.
                for rectangle in (masks or {}).get(number, []):
                    if len(rectangle) != 4:
                        raise ValueError('Invalid reviewed source rectangle')
                    x0,y0,x1,y1 = rectangle
                    width,height = page.get_size()
                    ImageDraw.Draw(frame).rectangle((x0*frame.width/width,y0*frame.height/height,
                        x1*frame.width/width,y1*frame.height/height),fill='white')
                frames.append(frame)
            finally:
                bitmap.close()
    try:
        encoded = io.BytesIO()
        frames[0].save(encoded, 'PDF', save_all=True, append_images=frames[1:], resolution=110, quality=72)
        result = PdfWriter(clone_from=io.BytesIO(encoded.getvalue()))
        result.metadata = metadata(key)
        result._root_object.pop(NameObject('/Metadata'), None)
        path.parent.mkdir(parents=True, exist_ok=True)
        partial=path.with_suffix('.partial.pdf')
        try:
            result.write(partial)
            os.replace(partial,path)
        finally:
            partial.unlink(missing_ok=True)
    finally:
        for frame in frames:
            frame.close()


def source_pdf(row, path):
    writer, masks = PdfWriter(), {}
    if row['pdf']:
        existing = b.corpus_store.HOME / row['pdf']
        if b.digest(existing) != row['pdf_sha256']:
            raise ValueError('Existing projection changed')
        reader = PdfReader(existing)
        for page in reader.pages:
            writer.add_page(page)
    else:
        for part in row['source_files']:
            reader = original(part['corpus_path'], part['sha256'])
            for number in part['pages']:
                if not 1<=number<=len(reader.pages):
                    raise SourceMappingError(f'{row["record"]}: physical page {number} exceeds {len(reader.pages)} source pages')
                masks[len(writer.pages)] = part.get('reviewed_masks',{}).get(str(number),[])
                writer.add_page(reader.pages[number - 1])
    normalization={'reviewed_masks':masks,'method':'Common raster export; existing source masks'}
    if any(masks.values()):
        scratch=b.ROOT/'.tmp'
        scratch.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='document-review-',dir=scratch) as temporary:
            native=Path(temporary)/'source.pdf'
            assert native.resolve().is_relative_to(b.ROOT.resolve())
            writer.write(native)
            key=b.digest(native)
            geometry=extract({key:native})[key]
            masks=b.reviewed_word_masks(b.read(geometry)['pages'],masks)
            normalization.update(method='Reviewed rectangles expanded to intersecting Legal PDF Parser words',
                geometry_sha256=b.digest(geometry),geometry_file=geometry.relative_to(b.PRIVATE).as_posix(),
                applied_masks=masks)
    finish(writer, path, row['text_key'], masks)
    b.dump(path.with_suffix('.normalization.json'),normalization)


def export_info(path):
    reader = PdfReader(path)
    return {'file_extension': '.pdf', 'bytes': path.stat().st_size, 'pages': len(reader.pages),
            'pdf_info': dict(reader.metadata or {}), 'has_xmp': reader.xmp_metadata is not None}


def scan(path, output, quality, key):
    """Rendering only; text extraction/OCR belongs to Legal PDF Parser."""
    frames = []
    state, numpy_state = random.getstate(), np.random.get_state()
    try:
        seed = int(b.hashlib.sha256(key.encode()).hexdigest()[:8],16)
        random.seed(seed)
        np.random.seed(seed)
        with pypdfium2.PdfDocument(path) as pdf:
            for page in pdf:
                bitmap = page.render(scale=130 / 72)
                try:
                    frame = bitmap.to_pil().convert('RGB')
                    if quality == 'poor':
                        pixels = np.asarray(frame)[:,:,::-1].copy()
                        pixels = BadPhotoCopy(noise_type=2,noise_value=(210,240),noise_size=(1,2),
                            noise_sparsity=(.02,.08),blur_noise=0,wave_pattern=0,edge_effect=0,numba_jit=0,p=1)(pixels)
                        frame.close()
                        frame = Image.fromarray(pixels[:,:,::-1] if pixels.ndim==3 else pixels).convert('RGB')
                        reduced=frame.resize((int(frame.width*.7),int(frame.height*.7)))
                        softened=reduced.resize(frame.size).filter(ImageFilter.GaussianBlur(.25))
                        reduced.close()
                        frame.close()
                        frame=softened
                    frames.append(frame)
                finally:
                    bitmap.close()
        data = io.BytesIO()
        frames[0].save(data, 'PDF', save_all=True, append_images=frames[1:], resolution=130)
        writer = PdfWriter(clone_from=io.BytesIO(data.getvalue()))
        finish(writer, output, key)
    finally:
        for frame in frames:
            frame.close()
        random.setstate(state)
        np.random.set_state(numpy_state)


def pages_for_review(path, folder):
    paths = []
    with pypdfium2.PdfDocument(path) as pdf:
        for number, page in enumerate(pdf, 1):
            target = folder / f'{number:03}.jpg'
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                bitmap = page.render(scale=130 / 72)
                try:
                    image = bitmap.to_pil().convert('RGB')
                    image.save(target, 'JPEG', quality=82)
                    image.close()
                finally:
                    bitmap.close()
            paths.append(target.relative_to(b.PRIVATE).as_posix())
    return paths


def review_brief(item):
    world = b.read(b.PRIVATE/'histories'/item['id']/'world.json')
    people = world['people']
    return b.brief(item)+'\n\n'+world['representation']+'\nContact authorized to give instructions: '+people['client']['name']+'.'


def build(item, pool):
    seed=next(row for row in pool if row['record']==item['seed'])
    invalid=[]
    for row in pool:
        if row['group']!=seed['group']:continue
        for part in row['source_files']:
            count=physical_pages(part['corpus_path'],part['sha256'])
            if any(not 1<=page<=count for page in part['pages']):
                invalid.append({'record':row['record'],'text_key':row['text_key'],
                    'reason':'Recorded physical pages exceed the original source', 'source_files':row['source_files']})
                break
    rejected_keys={row['text_key'] for row in invalid}
    pool=[row for row in pool if row['group']!=seed['group'] or row['text_key'] not in rejected_keys]
    primary, siblings = b.choose(item, pool)
    group = primary[0]['group']
    history_path = b.PRIVATE / 'histories' / item['id'] / 'manifest.json'
    generated = b.read(history_path)['documents']
    folder = b.PRIVATE / 'sets' / item['id']
    identity=folder/'identity.json'
    if not identity.exists():
        b.dump(identity,{'origin':'machine_test','run_id':b.RUN,'seed':secrets.token_hex(32)})
    identity_seed=b.read(identity)['seed']
    documents = []
    assets = b.PRIVATE / 'assets/v4'
    assets.mkdir(parents=True, exist_ok=True)

    def add(text, path, *, level, role, origin, family, provenance, inherits=None, components=None, version_group=None, images=None):
        key = b.opaque_id(identity_seed,item['id']+':'+str(len(documents)))
        documents.append({'document_id': key, 'level': level, 'role': role, 'origin': origin,
            'family_id': family, 'text': text, 'text_sha256': b.hashlib.sha256(text.encode()).hexdigest(),
            'file': path.relative_to(b.PRIVATE).as_posix(), 'file_sha256': b.digest(path),
            'metadata': export_info(path), 'provenance': provenance,
            'inherits': inherits, 'components': components or [], 'version_group': version_group,
            'images': images or []})
        return documents[-1]

    def real(row, level, role):
        asset_key = b.hashlib.sha256((PIPELINE+json.dumps(row['source_files'], sort_keys=True)).encode()).hexdigest()
        path = assets / (asset_key + '.pdf')
        if not path.exists() or not path.with_suffix('.normalization.json').exists():
            source_pdf(row, path)
        image_paths = pages_for_review(path, assets / asset_key) if row['kind'] == 'photograph' else []
        return add(row['text'], path, level=level, role=role, origin='real', family=row['text_key'],
            provenance=dict({k: row[k] for k in ('record', 'group', 'source_files', 'source_gold_sha256', 'kind')},
                            normalization_sha256=b.digest(path.with_suffix('.normalization.json'))), images=image_paths)

    first = [real(row, 1, 'same_filing') for row in primary]
    for row in siblings:
        real(row, 2, 'same_litigation')
    synthetic = []
    generated_records = {}
    for row in generated:
        source = b.PRIVATE / row['print_file']
        if b.digest(source) != row['print_sha256'] or b.digest(b.PRIVATE/row['native_file']) != row['native_sha256']:
            raise ValueError('Native history source changed: '+row['doc_id'])
    native_text=extract({row['print_sha256']:b.PRIVATE/row['print_file'] for row in generated})
    for row in generated:
        source=b.PRIVATE/row['print_file']
        if row['origin']=='real':
            existing=next((record for record in documents if record['family_id']==row['family_id'] and record['origin']=='real'),None)
            if existing is None:
                source_row=next(p for p in pool if p['text_key']==row['family_id'] and p['record']==row['record'])
                existing=real(source_row,3,'same_litigation')
            generated_records[row['doc_id']]=existing
            continue
        key = b.hashlib.sha256((PIPELINE+row['print_sha256']).encode()).hexdigest()
        path = assets / (key + '.pdf')
        if not path.exists():
            finish(PdfWriter(clone_from=source), path, key)
        reference='\f'.join('\n'.join(line['text'] for line in page['lines']) for page in b.read(native_text[row['print_sha256']])['pages'])
        record=add(reference, path, level=3, role='fictional_record', origin='synthetic', family=key,
            provenance={'manifest_sha256':b.digest(history_path), 'native_file':row['native_file'],
                        'native_sha256':row['native_sha256'],'print_sha256':row['print_sha256'],
                        'reference_projection_sha256':b.digest(native_text[row['print_sha256']]),
                        'doc_id':row['doc_id'],'kind':row['kind'],'format':row['format']},
            version_group=row['version_group'])
        synthetic.append(record)
        generated_records[row['doc_id']]=record
    for row in generated:
        record=generated_records[row['doc_id']]
        record['embedded_copies'] = [{
            'document_id':generated_records[component['doc_id']]['document_id'],
            'family_id':generated_records[component['doc_id']]['family_id'], 'pages':component['pages']
        } for component in row['attachment_pages']]

    # Deliberate repeats are retained. Accidental repeats in the unrelated pool are excluded.
    for base in (first[0], synthetic[0], synthetic[-1]):
        add(base['text'], b.PRIVATE / base['file'], level=3, role='exact_duplicate', origin=base['origin'],
            family=base['family_id'], provenance={'copy_of': base['document_id']}, inherits=base['document_id'])
    short = [r for r in first if r['metadata']['pages'] <= 3]
    if not short:
        raise ValueError('No short source for full good/poor scan pair')
    for base in (short[0],synthetic[4]):
        for quality in ('good', 'poor'):
            key = b.hashlib.sha256((PIPELINE+':photocopy-v2:'+base['file_sha256'] + ':' + quality).encode()).hexdigest()
            path = assets / (key + '.pdf')
            if not path.exists():
                scan(b.PRIVATE / base['file'], path, quality, key)
            add(base['text'], path, level=3, role='scan_' + quality, origin=base['origin'], family=base['family_id'],
                provenance={'rendered_from': base['document_id'], 'method': 'Augraphy BadPhotoCopy + resolution loss and blur + common raster export',
                            'quality': quality, 'legibility_review': 'pending'}, inherits=base['document_id'],
                images=pages_for_review(path, assets / key))
    for bases in ([first[0], first[-1]], [synthetic[0], synthetic[-1]]):
        key = b.hashlib.sha256(':'.join(r['file_sha256'] for r in bases).encode()).hexdigest()
        path = assets / (key + '.pdf')
        writer, components, offset = PdfWriter(), [], 0
        for base in bases:
            reader = PdfReader(b.PRIVATE / base['file'])
            for page in reader.pages:
                writer.add_page(page)
            components.append({'document_id': base['document_id'], 'pages': list(range(offset + 1, offset + len(reader.pages) + 1)), 'family_id': base['family_id']})
            offset += len(reader.pages)
        if not path.exists():
            finish(writer, path, key)
        add('\n\f\n'.join(r['text'] for r in bases), path, level=3, role='bundle',
            origin='synthetic' if any(r['origin'] == 'synthetic' for r in bases) else 'real', family=key,
            provenance={'assembly': 'Complete component files, unchanged pages'}, components=components)

    used = {p['text_key'] for p in primary + siblings}
    outside=b.read(b.PRIVATE/'sourcing/outside-pool.json')
    outside_keys=set(outside['source_keys'])
    candidates = b.shuffled([r for r in pool if r['text_key'] in outside_keys and r['group'] != group and r['kind'] != 'photograph'], item['id'] + ':other')
    # Make the mixed sets contain actual receipts/invoices and actual photographic exhibits.
    special = [r for r in pool if r['text_key'] in outside_keys and r['group'] != group and r['kind'] in ('invoice', 'receipt', 'photograph') and len(r['source_files'][0]['pages']) <= 3]
    special = b.shuffled(special, item['id'] + ':media')
    picks = []
    for kind in ('photograph', 'invoice'):
        match = next((r for r in special if r['kind'] == kind and r['text_key'] not in used), None)
        if match:
            picks.append(match)
            used.add(match['text_key'])
    rejected=list(invalid)
    for row in picks + candidates:
        if len(documents) >= item['size']:
            break
        if row not in picks and row['text_key'] in used:
            continue
        used.add(row['text_key'])
        try:
            real(row, 3, 'outside_litigation')
        except SourceMappingError as error:
            rejected.append({'record':row['record'],'text_key':row['text_key'],'reason':str(error),'source_files':row['source_files']})
    if len(documents) != item['size']:
        raise ValueError('Could not fill requested set size')
    project(documents)
    b.dump(folder / 'inventory.json', {'origin': 'machine_test', 'run_id': b.RUN,
        'status': 'candidate_requires_source_review_and_artifact_probes', 'set': item['id'], 'group': group,
        'brief': review_brief(item), 'spec_sha256': b.hashlib.sha256(json.dumps(item,sort_keys=True).encode()).hexdigest(),
        'level_2_source_records':sorted({row['record'] for row in siblings}),
        'level_2_has_additional_filing':any(row['record']!=item['seed'] for row in siblings),
        'preparer_sha256':PREPARER_SHA,'projection_code_sha256':PROJECTION_CODE_SHA,
        'identity_seed_sha256':b.digest(identity),
        'outside_pool_sha256':b.digest(b.PRIVATE/'sourcing/outside-pool.json'),
        'rejected_source_mappings':rejected, 'documents': documents})
    for level in (1, 2, 3):
        model = folder / 'inputs' / f'level-{level}'
        model.mkdir(parents=True, exist_ok=True)
        selected=b.shuffled([r for r in documents if r['level']<=level],identity_seed+':order:'+str(level))
        expected={r['document_id']+suffix for r in selected for suffix in ('.pdf','.txt')}
        for previous in model.iterdir():
            if previous.is_file() and re.fullmatch(r'[a-f0-9]{16}\.(?:pdf|txt)',previous.name) and previous.name not in expected:
                previous.unlink()
        (model / 'brief.txt').write_text(review_brief(item), encoding='utf-8')
        for row in selected:
            destination = model / (row['document_id'] + '.pdf')
            destination.unlink(missing_ok=True)
            shutil.copyfile(b.PRIVATE / row['file'], destination)
            # This is observed parser output from the supplied PDF, including scans.
            destination.with_suffix('.txt').write_text(row['text'], encoding='utf-8')
            os.utime(destination, (1792497600, 1792497600))
        b.dump(model / 'documents.json', [{'document_id': r['document_id'], 'file': r['document_id'] + '.pdf'}
            for r in selected])
        if os.name == 'nt':
            subprocess.run(['powershell', '-NoProfile', '-File', str(b.HERE / 'normalize_times.ps1'), str(model)], check=True)
        else:
            for path in model.iterdir():
                os.utime(path, (1792497600, 1792497600))
    return {'set': item['id'], 'documents': len(documents), 'levels': [sum(r['level'] <= n for r in documents) for n in (1, 2, 3)],
            'roles': dict(b.Counter(r['role'] for r in documents))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sets', nargs='+')
    args = parser.parse_args()
    pool = b.read(b.PRIVATE / 'intake.json')['documents']
    summary = []
    for item in b.spec():
        if args.sets and item['id'] not in args.sets:
            continue
        summary.append(build(item, pool))
        print(json.dumps(summary[-1]), flush=True)
    b.dump(b.PRIVATE / 'preparation-latest.json', summary)


if __name__ == '__main__':
    main()
