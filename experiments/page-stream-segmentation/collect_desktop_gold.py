"""Package only gold/receipt versions absent from the existing private store."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import zipfile

from index_structure_split_gold import semantic_hash


def collect(root,fable):
    inventory=json.loads((root/'structure-version-inventory.json').read_bytes())
    existing={r['semantic_sha256']:r for r in inventory}
    originals={(r['batch'],r['run'],r['sha256']):r for r in inventory}
    objects={}; observations=[]; reused=0
    for batch,run in (('b5','a'),('b5','b'),('b6','a'),('b7','a')):
        for path in sorted((fable/batch/run/'v4').glob('*/gold.json.gz')):
            raw=path.read_bytes(); unpacked=gzip.decompress(raw); gold=json.loads(unpacked)
            sha=gold['source_sha256']; semantic=semantic_hash(gold); known=existing.get(semantic)
            if known:
                target=known['path']; reused+=1
            else:
                target='structure-gold/desktop/objects/'+semantic+'.json.gz'
                canonical=json.dumps(gold,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
                objects.setdefault(target,gzip.compress(canonical,mtime=0))
            previous=originals.get((batch,run,sha))
            receipt=path.parent/'receipt.json'; receipt_path=None; recorded_hash=None
            if receipt.exists():
                receipt_raw=receipt.read_bytes(); receipt_sha=hashlib.sha256(receipt_raw).hexdigest()
                recorded_hash=json.loads(receipt_raw).get('gold_sha256')
                if previous and previous.get('receipt_sha256')==receipt_sha:
                    receipt_path=str(Path(previous['path']).with_name('receipt.json')).replace('\\','/')
                else:
                    receipt_path='structure-gold/desktop/receipts/'+receipt_sha+'.json'
                    objects.setdefault(receipt_path,receipt_raw)
            observations.append(dict(batch=batch,run=run,sha256=sha,semantic_sha256=semantic,
                source_locator=path.relative_to(fable).as_posix(),folder_source_sha256=path.parent.name,
                path=target,physical_pages=gold['page_count'],source_artifact_sha256=hashlib.sha256(raw).hexdigest(),
                source_json_sha256=hashlib.sha256(unpacked).hexdigest(),source_receipt=receipt_path,
                receipt_recorded_gold_sha256=recorded_hash,
                reused_existing=known is not None,previous_private_path=previous['path'] if previous else None,
                revision_status='existing-private-gold' if known else 'preserved-desktop-revision-not-promoted'))
    manifest=dict(schema='desktop-gold-versions.v1',origin='machine_test',run_id='desktop-gold-preservation',
        observations=observations,reused_existing=reused,distinct_new_objects=sum(p.endswith('.json.gz') for p in objects))
    objects['page-stream-gold/desktop-versions.json']=(json.dumps(manifest,indent=2)+'\n').encode()
    target=root/'gold-store/page-stream-gold/desktop-versions.json'
    target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(objects['page-stream-gold/desktop-versions.json'])
    with zipfile.ZipFile(root/'gold-version-transfer.zip','w',zipfile.ZIP_STORED) as archive:
        for path,raw in objects.items(): archive.writestr(path,raw)
    print(json.dumps(dict(observations=len(observations),reused_existing=reused,
        new_gold_versions=manifest['distinct_new_objects'],archive_bytes=(root/'gold-version-transfer.zip').stat().st_size)))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--root',required=True,type=Path)
    parser.add_argument('--fable',required=True,type=Path)
    args=parser.parse_args(); collect(args.root,args.fable)
