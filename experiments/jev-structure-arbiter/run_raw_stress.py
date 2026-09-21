"""Exact OAJD text and coordinates; reference judgments never enter payloads."""
import argparse
import hashlib
import json
import os
import statistics
import time
import urllib.request
from pathlib import Path
from run_headings import EXPECTED

ROOT = Path(__file__).parent
CORPUS = Path(r'C:\Users\elias\Desktop\Open Access Journals Database\data\final_contracts')
PROMPT = '''Classify CURRENT using the supplied source text and line rectangles.
heading opens a new article section or subsection.
heading_continuation is another line of an adjacent heading.
body is article prose, including reproduced source passages.
footnote is a supplementary note associated with the article. Notes may contain
ordinary narrative, interview speech, explanations, or citations. A continuation
can lack a leading number and can begin or end mid-sentence across pages.
Compare neighboring numbered notes, line rectangles, and textual flow to decide
which stream a passage belongs to. Grammatical continuity within a note does
not make it main body. Citation language or a leading number alone is insufficient.
furniture is a running journal header or footer.
folio is a printed page number.
uncertain means the observations do not distinguish these roles.
Check grammatical continuity and semantic scope as well as line placement.
Rectangles use the original coordinate system, x0,y0,x1,y1, increasing down and right.
The blocks are extraction candidates; their boundaries may be wrong.'''
CHOICES = {k: v for k, v in [
    ('heading', 'Begins a section or subsection.'),
    ('heading_continuation', 'Continues an adjacent heading.'),
    ('body', 'Main article prose or quotation.'),
    ('footnote', 'Footnote material.'),
    ('furniture', 'Running header or footer.'),
    ('folio', 'Printed page number.'),
    ('uncertain', 'Insufficient evidence.')
]}

def extract():
    cache = {}
    def pages(rel):
        if rel not in cache:
            cache[rel] = [json.loads(s) for s in (CORPUS / rel / 'pages.jsonl').read_text(encoding='utf-8').splitlines()]
        return cache[rel]
    def block(region):
        return {'text': region['text'], 'lines': [
            {'text': line['text'], 'bbox': line.get('bbox')}
            for line in region.get('lines', [])]}
    cases = []
    def add(rel, row, index, expected, ident):
        regions = row['regions']
        state = {'previous': [block(r) for r in regions[max(0, index-2):index]],
                 'current': block(regions[index]),
                 'next': [block(r) for r in regions[index+1:index+3]]}
        cases.append({'id': ident, 'source': rel, 'page': row['pdf_page'],
                      'region_index': index, 'expected': expected, 'state': state})
    rel = 'ALTA-L-REV/63/3/8845'
    expected_pages = [2,5,6,7,9,9,9,14,14,15,18,19,20,20,21,22,23,22,22]
    for (ident, needle, expected), page in zip(EXPECTED, expected_pages):
        matches = [(row, i) for row in pages(rel) if row['pdf_page'] == page
                   for i, region in enumerate(row['regions'])
                   if region['text'].startswith(needle)]
        assert len(matches) == 1, (ident, len(matches))
        row, index = matches[0]
        role = 'heading_continuation' if expected == 'continuation_of_previous_heading' else 'body' if expected == 'not_heading' else 'heading'
        add(rel, row, index, role, ident)
    selections = [
        ('ALTA-L-REV/63/3/8845', 22, {0:'folio',1:'furniture',2:'body',3:'body',7:'body',8:'body',9:'body',10:'footnote'}),
        ('CAN-J-FAM-L/36/2/8204', 21, {0:'folio',1:'furniture',2:'body',3:'body',4:'body',5:'footnote',6:'footnote',7:'footnote',8:'footnote'}),
        ('APPEAL/11/1/9781', 5, {0:'furniture',1:'folio',3:'body',4:'body',5:'footnote'})]
    for rel, page, indices in selections:
        row = next(row for row in pages(rel) if row['pdf_page'] == page)
        for index, expected in indices.items():
            add(rel, row, index, expected, f'{rel.split("/")[0]}-{page}-{index}')
    return cases

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    cases = extract()
    frozen = json.dumps(cases, ensure_ascii=False, sort_keys=True).encode('utf-8')
    digest = hashlib.sha256(frozen).hexdigest()
    out = ROOT / 'receipts' / 'raw-stress-footnote-v2.json'
    out.parent.mkdir(exist_ok=True)
    receipt = {'cases_sha256': digest, 'prompt': PROMPT, 'cases': cases, 'results': []}
    out.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(f'Frozen {len(cases)} cases: {digest}', flush=True)
    if not args.live:
        return
    key = os.environ['TYPESAFE_API_KEY']
    for case in cases:
        payload = {'model':'jev-1.13.0', 'state':json.dumps(case['state'], ensure_ascii=False),
                   'questions':{'decision':{'type':'choice','instructions':PROMPT,'criteria':CHOICES}}}
        request = urllib.request.Request('https://api.typesafe.ai/v1/systemone',
            data=json.dumps(payload).encode(), headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        start = time.perf_counter()
        with urllib.request.urlopen(request, timeout=30) as response:
            answer = json.load(response)
        choice = answer['answers']['decision']['choice']
        result = {'id':case['id'], 'expected':case['expected'], 'choice':choice,
                  'correct':choice == case['expected'], 'seconds':time.perf_counter()-start, 'response':answer}
        receipt['results'].append(result)
        out.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
        print(f'{case["id"]}: {choice}; expected {case["expected"]}', flush=True)
    print('Correct', sum(r['correct'] for r in receipt['results']), '/', len(cases))
    print('Median seconds', statistics.median(r['seconds'] for r in receipt['results']))

if __name__ == '__main__':
    main()
