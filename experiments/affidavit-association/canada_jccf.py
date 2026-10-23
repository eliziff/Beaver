"""Provincial hard affidavits reuse the same source-author/reviewer contract."""
import pathlib,json,sys
import canada_expand as lane
w=lane.workflow
w.OUT=w.OUT/'jccf'
w.OUT.mkdir(exist_ok=True)

def prepare():
    rows=w.read_json(w.ROOT/'benchmarks/local-data/affidavit-association/expansion/regulatory/sources.json')
    patterns=('UR-Pride-12.','UR-Pride-11.','UR-Pride-10.','UR-Pride-08.','UR-Pride-09.','UR-Pride-07.','UR-Pride-04.','UR-Pride-05.',
              '2021-04-01-Reply-Affidavit-of-Joel','2021-03-31-Reply-Affidavit-of-Jay','2021-03-30-Reply-Affidavit-of-Thomas','2021-03-05-Affidavit-of-Lanette','2020-12-14-Affidavit-of-Dale',
              '230731-Affidavit-of-Paul','230731-Affidavit-of-Jonah','230727-Affidavit-of-Frances','Affidavit-of-Dr.-T.-Warren-signed','Affidavit-of-Dr.-J.-Kettner-Reply')
    selected=[r for r in rows if any(x in r['label'] for x in patterns)]
    w.atomic_json(w.OUT/'sources.json',selected)
    w.prepare()

if __name__=='__main__':
    if sys.argv[1]=='prepare':prepare()
    else:
        for p in (w.OUT/'records').glob('*/source.json'):
            source=w.read_json(p);lane.canada_masks.apply(p.parent,w.ROOT/source['ocr_derivative'])
        w.annotate()
