"""Register exact embedded PDF portfolio streams once in the shared corpus."""
import sys,json,hashlib,sqlite3
from pathlib import Path
import fitz
from third_atlantic_sources import s,O,provenance

def extract(prefix):
    parent=s.source(prefix); rows=[]; db=s.cs.connect(); db.row_factory=sqlite3.Row
    try:
        with fitz.open(parent['original_path']) as pdf:
            for i in range(pdf.embfile_count()):
                info=pdf.embfile_info(i); body=pdf.embfile_get(i)
                assert len(body)==info['size'],info
                meta=dict(collection='affidavit-association-expansion-3',jurisdiction=parent['jurisdiction'],kind='embedded-court-record',label=parent['label']+' / '+info['filename'],provenance=json.dumps(dict(container_sha256=parent['sha256'],container_url=parent['url'],embedded_file=info,method='PyMuPDF embfile_get; exact stored decompressed attachment bytes; no PDF rewrite')))
                digest=s.cs.add_file(db,body,'application/pdf' if body.startswith(b'%PDF-') else 'application/octet-stream',s.cs.place(meta));s.cs.note(db,digest,meta);db.commit()
                file=dict(db.execute('select * from files where sha256=?',(digest,)).fetchone())
                row=dict(provenance(),sha256=digest,url=parent['url'],landing_url=parent.get('landing_url'),label=meta['label'],jurisdiction=parent['jurisdiction'],canonical_path=file['path'],original_path=str(s.cs.HOME/file['path']),pages=file['pages'],content_type=file['content_type'],source_views_root='atlantic-north/source-views',status='exact_embedded_source_stream',container_sha256=parent['sha256'],embedded_file=info,extraction_method=meta['provenance'],acquisition_checked_at_utc=parent['acquisition_checked_at_utc'])
                assert s.sha(Path(row['original_path']))==hashlib.sha256(body).hexdigest()==digest
                s.dump(O/'acquisitions'/('embedded-'+digest+'.json'),row);rows.append(row)
        s.dump(O/'embedded-inventories'/(parent['sha256']+'.json'),dict(container=parent,attachments=rows,complete_embedded_inventory=True))
        print(json.dumps([dict(label=r['label'],sha256=r['sha256'],pages=r['pages'])for r in rows],ensure_ascii=False,indent=2))
    finally:db.close()

if __name__=='__main__':extract(sys.argv[1])
