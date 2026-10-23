"""Import known canonical-source metadata into the private second-Canada inventory."""
import sqlite3,sys
from second_canada_author import *

def main():
    c=sqlite3.connect('file:'+str(HOME/'corpus/corpus.sqlite')+'?mode=ro',uri=True);c.row_factory=sqlite3.Row
    rows=json.loads((OUT/'local-source-candidates.json').read_text(encoding='utf-8'))
    seen={r['sha256'] for r in rows};added=[]
    for prefix in sys.argv[1:]:
        found=list(c.execute('select d.sha256,d.label,d.url,d.jurisdiction,f.pages,f.path,d.fetched_at from documents d join files f on f.sha256=d.sha256 where d.sha256 like ?',(prefix+'%',)))
        assert found,prefix
        for row in found:
            r=dict(row)
            if r['sha256'] not in seen:rows.append(r);seen.add(r['sha256']);added.append(r)
    dump(OUT/'local-source-candidates.json',rows);print(json.dumps(added))
if __name__=='__main__':main()
