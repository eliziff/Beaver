"""Stage official GPU runtime artifacts for a separate browser comparison."""

import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path('legal-browser-ocr/assets/ort-web-1.30.0'))
    args=parser.parse_args()
    integrity='sha512-q0y+JrrtukXSzsBWEMccVfqX25LRmosXHF+CaRJmg8pZClzcV7svNc4rKY3jL02Vb7QmRMDs1SigqR4CXAfKYQ=='
    url='https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.30.0.tgz'
    files={'package.json','README.md','LICENSE','ThirdPartyNotices.txt',
           'dist/ort.webgpu.min.mjs','dist/ort.jspi.min.mjs','dist/ort.min.mjs'}
    for kind in ['jsep','asyncify','jspi']:
        for extension in ['mjs','wasm']:
            files.add(f'dist/ort-wasm-simd-threaded.{kind}.{extension}')
    args.output.mkdir(parents=True,exist_ok=True)
    receipt=args.output/'source.json'
    if receipt.exists():
        old=json.loads(receipt.read_text(encoding='utf-8'))
        assert old['integrity']==integrity
        if all((args.output/name).is_file() and hashlib.sha256((args.output/name).read_bytes()).hexdigest()==value for name,value in old['sha256'].items()):
            print('Verified existing ORT Web 1.30.0 GPU artifacts.');return
    package=urllib.request.urlopen(url,timeout=90).read()
    assert 'sha512-'+base64.b64encode(hashlib.sha512(package).digest()).decode()==integrity
    found={}
    with tarfile.open(fileobj=io.BytesIO(package),mode='r:gz') as archive:
        for member in archive:
            name=member.name.removeprefix('package/')
            if name not in files:continue
            assert member.isfile()
            data=archive.extractfile(member).read()
            path=args.output/name
            assert path.resolve().is_relative_to(args.output.resolve())
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            found[name]=hashlib.sha256(data).hexdigest()
    assert all(name in found for name in files if name.startswith('dist/'))
    receipt.write_text(json.dumps({'version':'1.30.0','url':url,'integrity':integrity,
                                  'sha256':found,'scope':'Official artifacts; no dependency installation or CPU-runtime replacement'},indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'version':'1.30.0','files':len(found),'package_bytes':len(package)}))


if __name__=='__main__':
    main()
