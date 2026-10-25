"""Jobs and request files for the parser-level A/B (shipped Quality pack vs pack A), CPU backend.

Selects yardstick=main OCR-mode documents whose shipped export has >= 90% of its lines from our
recognizer, per split. Writes structure-ab/<arm>/request.json and structure-ab/jobs-<arm>.json.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = r'C:\Users\elias\Desktop\oajd_compute\lsg-v4\legal-pdf-parser\dist\legal-ocr-runtime-windows-x64\runtime'
PACKS = {'shipped': DIST + r'\indra', 'packA': str(HERE / 'export' / 'A-targets' / 'pack')}
rows = json.loads((HERE / 'qualify.json').read_text(encoding='utf-8'))
chosen = [r for r in rows if r['yardstick'] == 'main' and r['mode'] == 'ocr' and r['lines']
          and r['ocr_lines'] / r['lines'] >= 0.9 and r['split'] in ('development', 'train', 'test')]
root = HERE / 'structure-ab'
for arm, pack in PACKS.items():
    folder = root / arm
    folder.mkdir(parents=True, exist_ok=True)
    request = {'kind': 'pdf', 'ocr': {'provider': 'indra', 'settings': {
        'model_pack': pack, 'runtime': DIST + r'\onnx\onnxruntime.dll', 'tier': 'quality', 'backend': 'cpu'}}}
    (folder / 'request.json').write_text(json.dumps(request), encoding='utf-8')
    jobs = [{'pdf': r['pdf'], 'output': str(folder / 'parsed'), 'mode': 'ocr', 'requestFile': str(folder / 'request.json')}
            for r in chosen]
    (root / f'jobs-{arm}.json').write_text(json.dumps(jobs, indent=1), encoding='utf-8')
(root / 'selection.json').write_text(json.dumps([{k: r[k] for k in ('sha', 'split', 'pages', 'ocr_lines', 'lines')} for r in chosen], indent=1))
for split in ('development', 'train', 'test'):
    sel = [r for r in chosen if r['split'] == split]
    print(split, len(sel), 'documents', sum(r['pages'] for r in sel), 'pages')
