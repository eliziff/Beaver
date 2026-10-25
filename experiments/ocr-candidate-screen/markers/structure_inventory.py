"""Candidate inventories (grader --candidates format) per arm and split, plus timing jobs.

  structure_inventory.py inventories     -> structure-ab/<arm>-<split>.inventory.json
  structure_inventory.py timing          -> structure-ab/jobs-<arm>T.json (fresh output dirs)
  structure_inventory.py times LOG...    -> per-arm parse ms per page from batch logs
"""
import glob, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
root = HERE / 'structure-ab'
selection = json.loads((root / 'selection.json').read_text())
pages = {r['sha']: r['pages'] for r in selection}
action = sys.argv[1]
if action == 'inventories':
    for arm in ('shipped', 'packA'):
        for split in ('development', 'train', 'test', 'all'):
            rows = []
            for r in selection:
                if split != 'all' and r['split'] != split:
                    continue
                found = glob.glob(str(root / arm / 'parsed' / r['sha'] / '*' / '*' / 'ocr.json.gz'))
                assert len(found) == 1, (arm, r['sha'], found)
                rows.append({'source_sha256': r['sha'], 'candidate': found[0]})
            (root / f'{arm}-{split}.inventory.json').write_text(json.dumps({'inputs': rows}, indent=1))
            print(arm, split, len(rows))
elif action == 'timing':
    for arm in ('shipped', 'packA'):
        jobs = json.loads((root / f'jobs-{arm}.json').read_text())
        for job in jobs:
            job['output'] = str(root / f'{arm}T' / 'parsed')
        (root / f'jobs-{arm}T.json').write_text(json.dumps(jobs, indent=1))
else:
    for log in sys.argv[2:]:
        total_ms = total_pages = 0
        for line in Path(log).read_text(encoding='utf-8').splitlines():
            row = json.loads(line)
            sha = Path(row['file']).parts[-4]
            total_ms += row['parseMs']
            total_pages += pages[sha]
        print(log, 'documents', len(Path(log).read_text().splitlines()), 'pages', total_pages,
              'parse s', round(total_ms / 1000, 1), 'ms/page', round(total_ms / total_pages))
