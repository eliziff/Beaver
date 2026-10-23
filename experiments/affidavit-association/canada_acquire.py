"""Acquire public hearing affidavits in the canonical shared corpus."""
import json, sys, pathlib, collections
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'legal_pdf_corpus'))
import corpus_store as store

BASE = pathlib.Path('benchmarks/local-data/affidavit-association/expansion/canada')

def main():
    rows = json.loads((BASE/'all-nsarb-links.json').read_text())
    db = store.connect()
    results = []
    for row in rows:
        if row['family'] == '2025':
            continue
        try:
            meta = dict(collection='affidavit-association-expansion', jurisdiction='ns', kind='affidavit',
                        label=row['label'], provenance=json.dumps(dict(origin='machine_test', run_id='affidavit-association-100-20261022', landing_url=row['landing_url'])))
            sha, status = store.fetch(db,row['url'],meta)
            if sha:
                f = db.execute('select path,pages from files where sha256=?',(sha,)).fetchone()
                results.append(dict(row,sha256=sha,path=str(store.HOME/f[0]),pages=f[1]))
            print(status,row['family'],row['label'],flush=True)
        except Exception as e:
            print(type(e).__name__,str(e)[:150],flush=True)
        (BASE/'acquired.json').write_text(json.dumps(results,indent=2),encoding='utf-8')

if __name__ == '__main__': main()
