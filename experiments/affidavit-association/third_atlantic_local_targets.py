"""Retain exact-citation first-page source searches before further acquisition."""
import sqlite3
from third_atlantic_sources import s,O,provenance
queries=['2012 NLCA 61','2011 NSCA 30','2016 NLCA 57','2009 BCCA 111','2016 NBCA 15']
db=s.cs.connect();db.row_factory=sqlite3.Row;out=[]
try:
    for citation in queries:
        query='"'+citation+'"'
        rows=[dict(r) for r in db.execute('select distinct f.sha256,d.label,d.url,d.jurisdiction,f.pages,p.page,substr(p.text,1,700) first_text from pages_fts join pages p on p.rowid=pages_fts.rowid join files f on f.sha256=p.sha256 join documents d on d.sha256=f.sha256 where pages_fts match ? and p.page<=2 and d.jurisdiction in (?,?,?,?,?,?,?,?,?)',(query,'ca','nl','ns','nb','pe','yt','nt','nu','bc'))]
        out.append(dict(citation=citation,query=query,rows=rows))
        print(citation,len(rows),[(r['sha256'][:12],r['label'][:80])for r in rows])
    s.dump(O/'local-criminal-targets.json',dict(provenance(),searches=out,scope='Actual exact citation on first two pages; candidate identity still requires complete original source checking'))
finally:db.close()
