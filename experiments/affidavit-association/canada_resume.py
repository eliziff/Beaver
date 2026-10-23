"""Reopen specified corrected records while retaining all earlier adjudications."""
import pathlib,sys
import canada_expand as lane
w=lane.workflow

def main():
    name=sys.argv[1];assert name.isidentifier();w.OUT=w.OUT/name;ids=set(sys.argv[2].split(','))
    assert not any(a['status']=='running' for p in (w.OUT/'calls').glob('**/receipt.json') for a in w.read_json(p)['attempts'])
    prepared=w.OUT/'prepared.json';original=w.read_json;rows=original(prepared);assert ids<={r['record_id'] for r in rows}
    w.read_json=lambda path: [r for r in rows if r['record_id'] in ids] if pathlib.Path(path)==prepared else original(path)
    for row in rows:
        if row['record_id'] in ids:
            p=w.OUT/'records'/row['record_id']/'source.json';meta=original(p);lane.canada_masks.apply(p.parent,w.ROOT/meta['ocr_derivative'])
    w.atomic_json(w.OUT/'reopen.json',sorted(ids));w.annotate()

if __name__=='__main__':main()
