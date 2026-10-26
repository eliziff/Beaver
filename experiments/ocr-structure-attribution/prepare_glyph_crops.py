"""Join inventoried gold to source pixels; render selected pages, never re-run OCR.

All eligible source families are considered. The bounded pilot samples annotated
references, leading markers and explicit corrections, deduplicating crop targets
and quarantining conflicting targets. Test sources are not read.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import zipfile

import cv2
import numpy as np
import pyarrow as pa
import pyarrow.ipc as ipc
import pypdfium2 as pdfium

from gold_inventory import cache_lines, corrected_lines, digest, geometry, normalized, read


def annotations(gold):
    result = defaultdict(lambda: {'markers': [], 'refs': []})
    for item in gold.get('typed', []):
        for group in item.get('markers', []):
            for span in group:
                result[span['line_id']]['markers'].append([span['start'], span['end']])
        for reference in item.get('references', []):
            for span in reference['spans']:
                result[span['line_id']]['refs'].append([span['start'], span['end']])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--new-gold', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--per-source', type=int, default=24)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    config = read(args.config)
    locators = defaultdict(set)
    for path in config['manifests']:
        for row in read(path)['documents']:
            locators[row['sha256']].add(row['path'])
    for row in read(config['catalogue'])['runs']:
        if row.get('source'):
            path = Path(row['source']['path'])
            locators[row['sha256']].add(str(path if path.is_absolute() else Path(config['corpus_home'])/path))
    for parent, dirs, files in os.walk(args.corpus):
        for name in files:
            if name.endswith('.pdf') and len(Path(name).stem) == 64:
                locators[Path(name).stem].add(str(Path(parent)/name))
    by_source = defaultdict(list)
    with gzip.open(args.inventory, 'rt', encoding='utf-8') as stream:
        for line in stream:
            row = json.loads(line)
            if row['kind'] == 'line_transcript' and row['partition'] in {'train','development'}:
                by_source[row['source_sha256']].append(row)
    totals = Counter()
    records = {'train': [], 'development': []}
    cache_root = Path(config['owners'][0]['root'])
    with zipfile.ZipFile(args.new_gold) as new_gold:
        available = set(new_gold.namelist())
        for index, (source, artifacts) in enumerate(sorted(by_source.items())):
            if index % 50 == 0:
                print(json.dumps({'sources': index, 'total': len(by_source), 'crops': {k:len(v) for k,v in records.items()}}), flush=True)
            split = {row['partition'] for row in artifacts}
            if len(split) != 1:
                totals['split_conflict'] += 1
                continue
            split = next(iter(split))
            pdf = next((Path(p) for p in sorted(locators[source]) if Path(p).is_file()), None)
            if pdf is None:
                totals['source_locator_unresolved'] += 1
                continue
            candidates = {}
            cache = cache_lines(cache_root, source)
            for artifact in sorted(artifacts, key=lambda a: (not a['collection'].startswith('recent-'), 'alternate' in a['collection'])):
                name = artifact['artifact_sha256']+'.json.gz'
                path = artifact['notes'].get('origin_path')
                if name in available:
                    data = new_gold.read(name)
                elif path and Path(path).is_file():
                    data = Path(path).read_bytes()
                else:
                    totals['gold_locator_unresolved'] += 1
                    continue
                if digest(data) != artifact['artifact_sha256']:
                    totals['gold_changed_after_snapshot'] += 1
                    continue
                gold = json.loads(gzip.decompress(data))
                marks = annotations(gold)
                for line, text, explicit, error in corrected_lines(gold):
                    if error or not text.strip() or len(text) > 350:
                        continue
                    annotation = marks[line['id']]
                    if not (annotation['refs'] or any(a==0 for a,b in annotation['markers']) or explicit):
                        continue
                    box, _ = geometry(line, gold, cache)
                    if box is None:
                        totals['no_matched_geometry'] += 1
                        continue
                    key = (line['page'], box)
                    value = {'text':text, 'ocr':gold.get('source_text',{}).get(line['id'],line['text']),
                             'id':line['id'], 'page':line['page'], 'bbox':box, 'explicit':explicit,
                             'gold_artifact_sha256':artifact['artifact_sha256'], **annotation}
                    old = candidates.get(key)
                    if old and normalized(old['text']) != normalized(text):
                        if explicit and not old['explicit']:
                            candidates[key] = value
                        elif explicit == old['explicit']:
                            old['conflict'] = True
                    elif old is None:
                        candidates[key] = value
            selected = [r for r in candidates.values() if not r.get('conflict')]
            totals['conflicting_crops_quarantined'] += sum(bool(r.get('conflict')) for r in candidates.values())
            selected.sort(key=lambda r:(not bool(r['refs']),not any(a==0 for a,b in r['markers']),
                                        hashlib.sha256((source+r['id']).encode()).hexdigest()))
            selected = selected[:args.per_source]
            if not selected:
                continue
            by_page = defaultdict(list)
            for row in selected:
                by_page[row['page']].append(row)
            document = pdfium.PdfDocument(str(pdf))
            try:
                for number, lines in by_page.items():
                    page = document[number-1]
                    bitmap = page.render(scale=2, grayscale=True)
                    try:
                        gray = bitmap.to_numpy()
                        if gray.ndim == 3:
                            gray = gray[:,:,0]
                        height,width = gray.shape
                        for row in lines:
                            x0,y0,x1,y1 = row['bbox']
                            left,top=max(0,math.floor(2*x0)),max(0,math.floor(2*y0))
                            right,bottom=min(width,math.ceil(2*x1)),min(height,math.ceil(2*y1))
                            if right-left < 2 or bottom-top < 2:
                                totals['invalid_crop'] += 1
                                continue
                            image = gray[top:bottom,left:right]
                            if not np.any(image<220):
                                totals['blank_crop'] += 1
                                continue
                            ok,png=cv2.imencode('.png',image)
                            if not ok:
                                raise ValueError('PNG encoding failed')
                            h=bottom-top
                            context=gray[max(0,top-h):min(height,bottom+h),left:right]
                            ok,padded=cv2.imencode('.png',context)
                            if not ok:
                                raise ValueError('Context PNG encoding failed')
                            records[split].append({'im':png.tobytes(),'im_pad':padded.tobytes(),
                                'text':row['text'],'ocr':row['ocr'],'stock':'','sha':source,
                                'page':number,'id':row['id'],'markers':json.dumps(row['markers']),
                                'refs':json.dumps(row['refs']),'gold_artifact_sha256':row['gold_artifact_sha256'],
                                'explicit_correction':row['explicit'],'bbox':list(row['bbox'])})
                    finally:
                        bitmap.close()
                        page.close()
            finally:
                document.close()
            totals['sources_'+split] += 1
    for split, rows in records.items():
        table=pa.table({'lines':pa.array(rows)})
        with (args.out/(split+'.arrow')).open('wb') as stream:
            with ipc.new_file(stream,table.schema) as writer:
                writer.write_table(table)
    receipt={'schema':'expanded-ocr-glyph-crops.v1','dpi':144,'per_source':args.per_source,
             'counts':dict(totals),'splits':{k:{'lines':len(v),'sources':len({r['sha'] for r in v}),
                 'reference_lines':sum(bool(json.loads(r['refs'])) for r in v),
                 'marker_lines':sum(bool(json.loads(r['markers'])) for r in v)} for k,v in records.items()},
             'test_read':False,'ocr_replayed':False,'geometry':'inherited proposals; pixel review and source-family gates still apply'}
    (args.out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(receipt),flush=True)


if __name__=='__main__':
    main()
