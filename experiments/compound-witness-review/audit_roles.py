"""Compare retained structure lanes on identical source lines; no model calls."""
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SMOKE = ROOT / 'legal-pdf-parser/experiments/ppdoc-lite/product-smoke'

def load(name):
    path = SMOKE / name / 'pages.jsonl'
    data = path.read_bytes()
    pages = [json.loads(line) for line in data.decode('utf-8').splitlines()]
    lines = {(p['number'], l['id']): l for p in pages for l in p['lines']}
    assert len(lines) == sum(len(p['lines']) for p in pages), 'duplicate line IDs'
    return hashlib.sha256(data).hexdigest(), lines

def main():
    baseline_hash, baseline = load('native-sec-complaint-release')
    reports = []
    for name in ('teacher-fp32-sec-complaint-release-dpi96', 'teacher-fp32-sec-complaint-release-dpi72'):
        candidate_hash, candidate = load(name)
        missing = baseline.keys() - candidate.keys()
        added = candidate.keys() - baseline.keys()
        changed_text = [key for key in baseline.keys() & candidate.keys()
                        if baseline[key]['text'] != candidate[key]['text']]
        changed_boxes = [key for key in baseline.keys() & candidate.keys()
                         if baseline[key]['bbox'] != candidate[key]['bbox']]
        # Alignment differences invalidate a clean role-only comparison.
        assert not (missing or added or changed_text or changed_boxes), (name, len(missing), len(added), len(changed_text), len(changed_boxes))
        differences = []
        for key in sorted(baseline):
            before, after = baseline[key], candidate[key]
            if before['region_type'] != after['region_type']:
                differences.append({'page': key[0], 'line_id': key[1],
                    'text': before['text'], 'bbox': before['bbox'],
                    'before': before['region_type'], 'after': after['region_type']})
        reports.append({'lane': name, 'baseline_sha256': baseline_hash,
            'candidate_sha256': candidate_hash, 'aligned_lines': len(baseline),
            'transitions': dict(Counter(f'{d["before"]}->{d["after"]}' for d in differences)),
            'differences': differences})
    print(json.dumps(reports, indent=2))

if __name__ == '__main__':
    main()
