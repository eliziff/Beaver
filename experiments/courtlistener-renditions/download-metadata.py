"""Retain the exact compressed official metadata snapshots, with resumable HTTP reads."""
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.request
from sample import BASE
from budget import CAP, occupied

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True,exist_ok=True)
snapshot = sys.argv[2] if len(sys.argv)>2 else '2026-09-30'
manifest_path = out/'source.json'
manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
for kind in ['courts','opinion-clusters','dockets','citations']:
    name = f'{kind}-{snapshot}.csv.bz2'
    url = BASE+name
    with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=60) as r:
        size,etag = int(r.headers['Content-Length']),r.headers['ETag']
    target,partial = out/name,out/(name+'.part')
    if target.exists() and manifest.get(kind,{}).get('etag')==etag and target.stat().st_size==size:
        print(f'{kind}: retained complete {size:,} bytes',flush=True)
        continue
    received = partial.stat().st_size if partial.exists() else 0
    if occupied()+size-received>CAP-512*1024*1024:
        raise RuntimeError('Metadata would exceed the total 30 GB iteration budget')
    if received>size or target.exists():
        raise ValueError('Existing metadata file conflicts with snapshot identity')
    started,last = time.monotonic(),received
    if received<size:
        request = urllib.request.Request(url,headers={'Range':f'bytes={received}-{size-1}','If-Match':etag})
        with urllib.request.urlopen(request,timeout=120) as response,partial.open('ab') as handle:
            if response.status!=206 or response.headers.get('ETag')!=etag:
                raise ValueError('Source identity changed or range not honored')
            while block:=response.read(1024*1024):
                handle.write(block)
                received+=len(block)
                if received-last>=64*1024*1024:
                    print(f'{kind}: {received:,}/{size:,} bytes; {(received-last)/1048576:.0f} MiB interval',flush=True)
                    last=received
    if received!=size:
        raise ValueError('Incomplete metadata snapshot')
    digest = hashlib.sha256()
    with partial.open('rb') as handle:
        while block:=handle.read(1024*1024):
            digest.update(block)
    partial.replace(target)
    manifest[kind] = {'url':url,'etag':etag,'bytes':size,'sha256':digest.hexdigest(),'path':name,
                      'download_seconds':time.monotonic()-started,'representation':'original compressed CSV'}
    manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
    print(f'{kind}: complete, source SHA256 recorded',flush=True)
