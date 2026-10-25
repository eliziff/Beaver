"""Pages per split and source (ocr = read by our recognizer) in each arm's exports."""
import collections, gzip, json
from pathlib import Path
root = Path(__file__).resolve().parent / 'structure-ab'
split = {r['sha']: r['split'] for r in json.loads((root / 'selection.json').read_text())}
for arm in ('shipped', 'packA'):
    counts = collections.Counter()
    for row in json.loads((root / f'{arm}-all.inventory.json').read_text())['inputs']:
        export = json.loads(gzip.open(row['candidate']).read())
        for page in export['extraction']['pages']:
            counts[(split[row['source_sha256']], page.get('source'))] += 1
    print(arm, sorted(counts.items()))
