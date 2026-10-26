"""Register private split gold in the existing corpus SQLite, without copying it.

The private catalogue is portable. Machine-local registrations resolve its gold
references to actual files; exporters discover them through SQLite, not scans.
"""
import argparse
from contextlib import closing
import gzip
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'legal_pdf_corpus'))
import corpus_store
from index_structure_split_gold import semantic_hash,split_hash


PREFIX='page-stream-segmentation/'


def read(path):
    raw=path.read_bytes()
    return json.loads(gzip.decompress(raw) if path.suffix=='.gz' else raw)


def digest(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream,'sha256').hexdigest()


def registered_sources(origin):
    """The only gold discovery path used by the expanded exporter."""
    dataset=PREFIX+origin
    with closing(corpus_store.connect()) as db:
        sources=[r[0] for r in db.execute('select sha256 from gold_records where dataset=? and status=? order by sha256',
            (dataset,'complete'))]
    result=[]
    for sha in sources:
        job=corpus_store.completed_gold(dataset,sha)
        receipt=read(job/'receipt.json')
        result.append(dict(sha256=sha,path=job/receipt['artifact_paths']['gold'],receipt=receipt))
    if not result: raise ValueError('No registered split gold for '+dataset)
    return result


def register(store,desktop_fable=None,export=False):
    index=read(store/'page-stream-gold/index.json')
    b7_path=(desktop_fable/'b7/split/authoring-splits.json') if desktop_fable else store/index['existing_gold']
    assert digest(b7_path)==index['existing_gold_sha256']
    selections=[]
    for source in read(b7_path)['sources']:
        selections.append(('b7',source['sha256'],b7_path,index['existing_gold'],None,'full-source'))
    for record in index['additional_sources']:
        path=store/record['path']; assert digest(path)==record['record_sha256']
        selections.append(('references',record['sha256'],path,record['path'],None,'explicit-decisions-only'))
    for record in index['structure_gold_sources']:
        path=store/record['path']
        if not path.exists() and desktop_fable: path=desktop_fable/record['batch']/'a/v4'/record['sha256']/'gold.json.gz'
        gold=read(path)
        if semantic_hash(gold)!=record['semantic_sha256']:
            assert split_hash(gold)==record['split_supervision_sha256'], 'Structure split supervision differs from saved private record'
        selections.append(('structure',record['sha256'],path,record['path'],record['physical_pages'],'full-source-unit-starts'))
    versions={}
    if (store/'page-stream-gold/structure-versions.json').exists():
        for record in read(store/'page-stream-gold/structure-versions.json')['records']:
            versions.setdefault(record['semantic_sha256'],{**record,'revision_status':'existing-private-gold'})
        for record in read(store/'page-stream-gold/desktop-versions.json')['observations']:
            versions.setdefault(record['semantic_sha256'],record)
        for semantic,record in versions.items():
            path=store/record['path']; gold=read(path)
            assert semantic_hash(gold)==semantic
            selections.append(('structure-versions',record['sha256'],path,record['path'],gold['page_count'],'archived-structure-revision'))
    imported=0
    if desktop_fable:
        # Import provenance metadata, not PDF bytes. Missing local PDFs remain
        # explicitly catalogued-only in each gold receipt.
        with closing(sqlite3.connect(store/'page-stream-gold/catalogue.sqlite')) as portable_db, closing(corpus_store.connect()) as db, db:
            portable_db.row_factory=sqlite3.Row
            for row in portable_db.execute('select * from files'):
                if db.execute('select 1 from files where sha256=?',(row[0],)).fetchone(): continue
                candidate=corpus_store.HOME/row[1]
                if candidate.exists(): assert digest(candidate)==row[0], 'Local source PDF hash mismatch'
                db.execute('insert into files values ('+','.join('?' for _ in row)+')',row)
                imported+=1
            for original in portable_db.execute('select * from documents'):
                row=dict(original); row.pop('id')
                if db.execute('select 1 from documents where sha256=? and collection is ? and url is ?',
                    (row['sha256'],row['collection'],row['url'])).fetchone(): continue
                db.execute('insert into documents ('+','.join(row)+') values ('+','.join('?' for _ in row)+')',list(row.values()))
    with closing(corpus_store.connect()) as db:
        missing=[sha for _,sha,*_ in selections if db.execute('select 1 from files where sha256=?',(sha,)).fetchone() is None]
    if missing: raise ValueError(f'{len(set(missing))} gold sources are missing from the canonical corpus index')
    for origin in sorted({s[0] for s in selections}):
        corpus_store.register_gold_sources(PREFIX+origin,[dict(sha256=s[1],mode='visual-split') for s in selections if s[0]==origin])
    for origin,sha,path,private_path,pages,scope in selections:
        job=store/'page-stream-gold/catalogue'/origin/sha
        semantic=None
        if origin=='structure-versions':
            semantic=semantic_hash(read(path)); job=job/semantic
        job.mkdir(parents=True,exist_ok=True)
        receipt_path=job/'receipt.json'; gold_sha=digest(path)
        configuration=dict(mode='visual-split',format=origin,scope=scope,
            private_repository='eliziff/benchmarks-private',private_path=private_path,source_sha256=sha)
        if origin=='structure':
            configuration['private_supervision_sha256']=next(r['split_supervision_sha256'] for r in index['structure_gold_sources'] if r['sha256']==sha)
        if semantic:
            configuration.update(semantic_sha256=semantic,revision_status=versions[semantic]['revision_status'],
                origin_batch=versions[semantic]['batch'],origin_run=versions[semantic]['run'],
                provenance_indices=['page-stream-gold/structure-versions.json','page-stream-gold/desktop-versions.json'])
            source_receipt=versions[semantic].get('source_receipt') or str(Path(private_path).with_name('receipt.json')).replace('\\','/')
            if (store/source_receipt).exists():
                configuration['source_authoring_receipt']=source_receipt
                configuration['source_authoring_receipt_sha256']=digest(store/source_receipt)
        with closing(corpus_store.connect()) as db:
            source_path=corpus_store.HOME/db.execute('select path from files where sha256=?',(sha,)).fetchone()[0]
        configuration['source_pdf_available']=source_path.exists()
        relative=Path(os.path.relpath(path,job)).as_posix()
        if receipt_path.exists():
            receipt=read(receipt_path)
        else: receipt={}
        if receipt.get('gold_sha256')!=gold_sha or receipt.get('configuration')!=configuration or receipt.get('artifact_paths')!={'gold':relative}:
            stamp=time.time()
            receipt=dict(schema_version='gold-run-receipt.v1',source_sha256=sha,
                run_id='split-registry:'+origin+':'+sha+(':'+semantic if semantic else ''),status='complete',origin='machine_test',
                historical_authoring_origin='unknown',started_at=stamp,finished_at=stamp,
                configuration=configuration,pages=pages,gold_sha256=gold_sha,artifact_paths={'gold':relative})
            receipt_path.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
        corpus_store.register_gold_run(job,PREFIX+origin,select=origin!='structure-versions')
    if export:
        portable(store)
    counts={origin:len(registered_sources(origin)) for origin in ('b7','references','structure')}
    print(json.dumps(dict(registered_origins=counts,unique_sources=len({s[1] for s in selections}),
        archived_gold_versions=len(versions),source_metadata_imported=imported,sqlite_registry_verified=True,portable_catalogue_exported=export)))


def portable(store):
    """Bounded SQLite snapshot: only this task's gold and owning file rows."""
    target=store/'page-stream-gold/catalogue.sqlite'
    next_path=target.with_suffix('.sqlite.next'); next_path.unlink(missing_ok=True)
    try:
        with closing(corpus_store.connect()) as source, closing(sqlite3.connect(next_path)) as out, out:
            source.row_factory=sqlite3.Row
            selected=source.execute('select * from gold_records where dataset like ? order by dataset,sha256',(PREFIX+'%',)).fetchall()
            shas={r['sha256'] for r in selected}
            runs={r[0] for r in source.execute('select run_id from gold_runs where dataset like ?',(PREFIX+'%',))}
            for table in ('files','documents','gold_records','gold_runs','gold_artifacts','gold_memberships'):
                sql=source.execute('select sql from sqlite_master where name=?',(table,)).fetchone()[0]
                out.execute(sql)
                for original in source.execute('select * from '+table):
                    row=dict(original)
                    eligible=(row['sha256'] in shas if table in ('files','documents') else row.get('run_id') in runs if table in ('gold_runs','gold_artifacts') else row['dataset'].startswith(PREFIX))
                    if not eligible: continue
                    if table=='gold_runs': row['receipt_path']=Path(row['receipt_path']).relative_to(store.resolve()).as_posix()
                    if table=='gold_artifacts': row['path']=Path(row['path']).relative_to(store.resolve()).as_posix()
                    out.execute('insert into '+table+' values ('+','.join('?' for _ in row)+')',list(row.values()))
            assert out.execute('pragma integrity_check').fetchone()[0]=='ok'
        next_path.replace(target)
    finally:
        next_path.unlink(missing_ok=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--private-store',required=True,type=Path)
    parser.add_argument('--desktop-fable',type=Path)
    parser.add_argument('--export',action='store_true')
    args=parser.parse_args(); register(args.private_store,args.desktop_fable,args.export)
