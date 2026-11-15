"""Read every candidate PDF through the same existing Legal PDF Parser executable."""
import os
import json
from pathlib import Path
import subprocess

import benchmark as b


READER=Path(os.environ.get('LEGALPDF_READ') or b.ROOT/'native/legal-structure-node/target/release/legalpdf-read.exe')


def extract(unique):
    reader_hash=b.digest(READER)
    folder = b.PRIVATE / 'projection' / reader_hash
    output = folder / 'output'
    folder.mkdir(parents=True,exist_ok=True)
    pending={}
    for key,path in unique.items():
        result=output/(key+'.json')
        try:
            b.read(result)
        except (FileNotFoundError,json.JSONDecodeError):
            pending[key]=path
    if pending:
        listing = folder/'read.list'
        listing.write_text(''.join(f'{key}\t{path}\n' for key,path in pending.items()),encoding='utf-8')
        env = {**os.environ,'LEGALPDF_INDRA_MODEL_PACK':str(b.ROOT/'legal-pdf-parser/runtime/indra'),
               'LEGALPDF_ONNXRUNTIME':str(b.ROOT/'legal-pdf-parser/runtime/onnx/onnxruntime.dll')}
        subprocess.run([str(READER),str(listing),str(output)],env=env,check=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
    return {key:output/(key+'.json') for key in unique}


def project(documents):
    results=extract({row['file_sha256']:b.PRIVATE/row['file'] for row in documents})
    for row in documents:
        result = results[row['file_sha256']]
        parsed = b.read(result)
        row['source_text'] = row['text']
        row['text'] = '\f'.join('\n'.join(line['text'] for line in page['lines']) for page in parsed['pages'])
        row['text_sha256'] = b.hashlib.sha256(row['text'].encode()).hexdigest()
        row['projection'] = {'engine':'legalpdf-read','reader_sha256':result.parent.parent.name,
            'input_sha256':row['file_sha256'],'output_sha256':b.digest(result),
            'output_file':result.relative_to(b.PRIVATE).as_posix()}
