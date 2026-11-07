"""The fair test of reading plain text. From a sample, take records whose markup marks footnotes, pages or paragraph signs and that also
carry a plain text of the same opinion; write the plain text alone as a pack, and what the tags say as the truth.
python -I plaincut.py PACK OUT. Run from C:/courtlistener-structure."""
import json, re, sys, collections
sys.stdout.reconfigure(encoding='utf-8')
pack, out = sys.argv[1:3]
BLOCK = re.compile(r'</?(?:p|div|li|br|tr|td|h\d|blockquote|pre|center|table|opinion)\b[^>]*>', re.I)
TAG = re.compile(r'<[^>]+>')
SIGN = re.compile(r'^[\s\u00a0]*[\[{(]?\s*(?:¶|&#182;)+\s*(\d{1,4})', re.M)
NOTE = [re.compile(r'<footnote[^>]*\blabel="([^"]+)"'), re.compile(r'<div[^>]*class="footnote"[^>]*id="fn([^"_-]+)')]
PAGE = [re.compile(r'<page-number[^>]*\blabel="([^"]+)"'), re.compile(r'class="star-pagination"[^>]*\blabel="([^"]+)"'), re.compile(r'\blabel="([^"]+)"[^>]*class="star-pagination')]
HEAD = re.compile(r'<h[1-6][^>]*>(.*?)</h[1-6]>', re.S)
n = 0; c = collections.Counter()
with open(f'samples/{out}.jsonl', 'w', encoding='utf-8', newline='\n') as w, open(f'samples/{out}-truth.jsonl', 'w', encoding='utf-8', newline='\n') as tr:
    for line in open(f'samples/{pack}.jsonl', encoding='utf-8'):
        if 'plain_text.txt' not in line[:2000000]: continue
        r = json.loads(line); plain = r['files'].get('plain_text.txt', '')
        if len(plain) < 500: continue
        notes, pages, signs, heads = set(), set(), set(), set()
        for k, t in r['files'].items():
            if k in ('fields.json', 'plain_text.txt') or '<pre' in t[:300]: continue
            for p in NOTE: notes |= {x.strip('[]().,: ') for x in p.findall(t) if re.fullmatch(r'\d{1,3}', x.strip('[]().,: '))}
            for p in PAGE: pages |= {x for x in p.findall(t) if x.isdigit()}
            due = 1
            for m in SIGN.finditer(TAG.sub('', BLOCK.sub('\n', t))):
                if int(m.group(1)) == due: signs.add(due); due += 1
            heads |= {re.sub(r'\s+', ' ', TAG.sub('', x)).strip().lower() for x in HEAD.findall(t)}
        if not (notes or pages or len(signs) >= 3): continue
        w.write(json.dumps({'id': r['id'], 'files': {'plain_text.txt': plain, 'fields.json': r['files']['fields.json']}}, ensure_ascii=False) + '\n')
        tr.write(json.dumps({'id': r['id'], 'notes': sorted(notes), 'pages': sorted(pages), 'signs': sorted(signs), 'heads': sorted(heads)}) + '\n')
        n += 1; c['notes'] += bool(notes); c['pages'] += bool(pages); c['signs'] += len(signs) >= 3
print(n, c)
