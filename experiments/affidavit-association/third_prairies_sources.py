"""Private original-source discovery and acquisition receipts for Canadian Gold."""
import hashlib
import html
import json
import re
import sqlite3
import sys
import urllib.parse
import urllib.request
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'benchmarks/local-data/affidavit-association/expansion-3/prairies-other'
RUN = 'b29b8749-30fa-4827-96a1-6ee61137c7b6'
JOB = 'fbc4b177-8261-4515-b39d-49d0e4eae84a'
sys.path.insert(0, str(ROOT / 'experiments/legal_pdf_corpus'))
import corpus_store as cs


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def provenance():
    return dict(origin='machine_test', run_id=RUN, method='codex_collaboration', agent='/root/gold_us', job_id=JOB, runner_call=False)


def receipt(path, row):
    previous = json.loads(path.read_text(encoding='utf8')) if path.exists() else None
    observations = previous.get('retrievals', [previous]) if previous else []
    row = dict(row)
    row['retrievals'] = observations + [dict(row)]
    dump(path, row)


def listing(url, accept=None):
    key = hashlib.sha256(url.encode()).hexdigest()
    folder = OUT / 'discovery'; folder.mkdir(parents=True, exist_ok=True)
    row = dict(provenance(), listing_url=url, requested_at_utc=datetime.now(timezone.utc).isoformat())
    try:
        headers = dict(cs.HEADERS)
        if accept: headers['Accept'] = accept
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
            raw = response.read(); row.update(final_url=response.url, status=response.status)
        path = folder / (key + '.html')
        if path.exists():
            previous_bytes = path.read_bytes()
            previous_path = folder / 'responses' / (hashlib.sha256(previous_bytes).hexdigest() + '.bin')
            previous_path.parent.mkdir(parents=True, exist_ok=True)
            if not previous_path.exists(): previous_path.write_bytes(previous_bytes)
        path.write_bytes(raw)
        response_path = folder / 'responses' / (hashlib.sha256(raw).hexdigest() + '.bin')
        response_path.parent.mkdir(parents=True, exist_ok=True)
        if not response_path.exists(): response_path.write_bytes(raw)
        links = [dict(url=urllib.parse.urljoin(url, html.unescape(m[2])), text=re.sub('<[^>]+>', '', html.unescape(m[3])).strip()) for m in cs.LINK.finditer(raw.decode('utf8', errors='replace'))]
        row.update(html_file=path.name, html_sha256=sha(path), response_file=response_path.relative_to(OUT).as_posix(), links=links)
    except Exception as exc:
        row.update(status='retrieval_failed', error=str(exc), links=[])
    receipt(folder / (key + '.json'), row)
    return row


def acquire(url, label, jurisdiction, listing_url):
    row = dict(provenance(), url=url, original_url=url, website=urllib.parse.urlsplit(listing_url or url).netloc,
               listing_url=listing_url or None, label=label, jurisdiction=jurisdiction,
               acquisition_checked_at_utc=datetime.now(timezone.utc).isoformat())
    db = cs.connect()
    try:
        digest, status = cs.fetch(db, url, dict(collection='affidavit-association-expansion-3', kind='court-record', jurisdiction=jurisdiction, label=label, provenance=json.dumps(row)), refresh=False)
        db.commit(); row.update(sha256=digest, status=status)
        if digest:
            db.row_factory = sqlite3.Row
            file = dict(db.execute('select * from files where sha256=?', (digest,)).fetchone())
            row.update(canonical_path=file['path'], pages=file['pages'], bytes=file['bytes'])
            assert sha(cs.HOME / file['path']) == digest
            row['corpus_observations'] = [dict(r) for r in db.execute('select * from documents where sha256=?', (digest,))]
    except Exception as exc:
        row.update(status='retrieval_failed', error=str(exc))
    finally:
        db.close()
        receipt(OUT / 'acquisitions' / (hashlib.sha256(url.encode()).hexdigest() + '.json'), row)
    return row


def extract(prefix, numbers=None):
    import fitz
    import pypdfium2 as pdfium
    item = next(json.loads(p.read_text(encoding='utf8')) for p in (OUT / 'acquisitions').glob('*.json') if json.loads(p.read_text(encoding='utf8')).get('sha256', '').startswith(prefix))
    path = cs.HOME / item['canonical_path']; assert sha(path) == item['sha256']
    folder = OUT / 'source-views' / item['sha256']; folder.mkdir(parents=True, exist_ok=True)
    native_pdf, image_pdf = fitz.open(path), pdfium.PdfDocument(str(path))
    for n in numbers or range(1, len(native_pdf) + 1):
        target = folder / f'page-{n:04}.txt'
        if target.exists(): continue
        text = native_pdf[n - 1].get_text()
        row = dict(source_sha256=item['sha256'], physical_page=n, method='native_full_page', no_clipping=True)
        if len(text.strip()) < 120:
            bitmap = image_pdf[n - 1].render(scale=216 / 72)
            image = bitmap.to_pil(); png = target.with_suffix('.png'); image.save(png)
            text = subprocess.run([r'C:\Program Files\Tesseract-OCR\tesseract.exe', str(png), 'stdout', '-l', 'eng'], capture_output=True, encoding='utf8', check=True, env=dict(os.environ, OMP_THREAD_LIMIT='1')).stdout
            row.update(method='pdfium_216dpi_tesseract_eng', image_sha256=sha(png))
            image.close(); bitmap.close()
        target.write_text(text, encoding='utf8'); row['text_sha256'] = sha(target)
        dump(target.with_suffix('.json'), row)
        print(n, len(text), flush=True)
    native_pdf.close(); image_pdf.close()


if __name__ == '__main__':
    if sys.argv[1] == 'listing':
        result = listing(sys.argv[2])
        print(json.dumps({k: v for k, v in result.items() if k != 'links'}))
        print(json.dumps([x for x in result['links'] if re.search(r'pdf|legal|court|affidavit', x['url'] + x['text'], re.I)], ensure_ascii=False, indent=2))
    elif sys.argv[1] == 'acquire':
        print(json.dumps(acquire(*sys.argv[2:6]), ensure_ascii=False))
    elif sys.argv[1] == 'scc-inventory':
        for case_no in sys.argv[2:]:
            if not re.fullmatch(r'\d{5}', case_no): raise ValueError('Expected a known five-digit SCC case number')
            url = f'https://www.scc-csc.ca/data/case-documents/{case_no}.json'
            result = listing(url, accept='application/json')
            links = []
            if result.get('html_file'):
                data = json.loads((OUT / 'discovery' / result['html_file']).read_text(encoding='utf-8-sig'))
                for kind in ['factums', 'memorandums', 'condensedBooks']:
                    for filename in data.get(kind, []):
                        if '/' in filename or '\\' in filename or not filename.lower().endswith('.pdf'):
                            raise ValueError('Unexpected public inventory filename')
                        links.append(dict(kind=kind, filename=filename,
                            url=f'https://www.scc-csc.ca/pdf/case-documents/{case_no}/' + urllib.parse.quote(filename),
                            listing_url=url, case_listing_url=f'https://www.scc-csc.ca/cases-dossiers/search-recherche/{case_no}/'))
            dump(OUT / 'discovery' / f'scc-{case_no}-inventory.json', dict(provenance(), case_no=case_no,
                inventory_response=result, source_contract='Literal public inventory used by the SCC case-page fetchCaseDocuments JavaScript', links=links))
            print(json.dumps(dict(case_no=case_no, status=result['status'], links=links), ensure_ascii=False), flush=True)
    elif sys.argv[1] == 'documentcloud':
        query = sys.argv[2]
        parameters = dict(q=query, per_page=100, expand='organization')
        if len(sys.argv) > 3: parameters['cursor'] = sys.argv[3]
        url = 'https://api.www.documentcloud.org/api/documents/search/?' + urllib.parse.urlencode(parameters)
        result = listing(url, accept='application/json')
        if result.get('html_file'):
            data = json.loads((OUT / 'discovery' / result['html_file']).read_text(encoding='utf8'))
            print('count', data.get('count'), 'next', data.get('next'))
            for item in data.get('results', []):
                print(json.dumps({k: item.get(k) for k in ['id', 'title', 'slug', 'page_count', 'source', 'asset_url']}, ensure_ascii=False))
        else:
            print(json.dumps(result))
    elif sys.argv[1] == 'acquire-list':
        for item in json.loads(Path(sys.argv[2]).read_text(encoding='utf8')):
            row = acquire(item['url'], item['label'], item['jurisdiction'], item['listing_url'])
            print(json.dumps({k: row.get(k) for k in ['label', 'status', 'sha256', 'pages', 'error']}), flush=True)
    elif sys.argv[1] == 'extract':
        extract(sys.argv[2], [int(x) for x in sys.argv[3:]] or None)
