"""Process a disjoint source batch with its own summary and shared call cap."""
import pathlib,sys,shutil
import canada_expand as lane
w=lane.workflow

def main():
    root=w.OUT;name=sys.argv[1];ids=set(sys.argv[2].split(','));target=root/name
    assert name.isidentifier() and target.resolve().is_relative_to(root)
    (target/'records').mkdir(parents=True,exist_ok=True)
    rows=[r for r in w.read_json(root/'prepared.json') if r['record_id'] in ids]
    assert {r['record_id'] for r in rows}==ids
    for row in rows:
        rid=row['record_id'];source=root/'records'/rid;destination=target/'records'/rid
        assert source.resolve().is_relative_to(root) and destination.resolve().is_relative_to(root)
        assert not any(a['status']=='running' for p in (root/'calls'/rid).glob('**/receipt.json') for a in w.read_json(p)['attempts'])
        if source.exists():
            assert not destination.exists();shutil.move(source,destination)
        meta=w.read_json(destination/'source.json');lane.canada_masks.apply(destination,w.ROOT/meta['ocr_derivative'])
    w.atomic_json(target/'prepared.json',rows)
    w.atomic_json(target/'prior-adjudications.json',{'origin':'machine_test','run_id':w.RUN,'record_ids':sorted(ids),'prior_summary':'../summary.json','method':'Disjoint source batch; prior rejection entries and exact model receipts remain unchanged. Source masks are explicit in current split metadata.'})
    w.OUT=target;w.annotate()

if __name__=='__main__':main()
