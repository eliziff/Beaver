"""Read only the existing development transcript column for the fixed tensor sample."""

import argparse
import hashlib
import json
import re
import unicodedata
import uuid
from pathlib import Path

import pyarrow as pa
import pyarrow.ipc as ipc


def normalized(text):
    text = re.sub(r'[\u00ad\u00ac]\r?\n', '', text)
    text = unicodedata.normalize('NFKC', text).replace('\u00ad', '').replace('\u00ac', '')
    return re.sub(r'\s+', ' ', text).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('arrow', type=Path)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    with args.arrow.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    assert digest == manifest['dev_arrow_sha256']
    texts = []
    with pa.memory_map(str(args.arrow), 'r') as source:
        reader = ipc.open_file(source)
        for index in range(reader.num_record_batches):
            texts.extend(reader.get_batch(index).column('lines').field('text').to_pylist())
    count = manifest['lines']
    indices = [int(index * ((len(texts) - 1) / (count - 1))) for index in range(count)]
    indices[-1] = len(texts) - 1
    result = {'origin': 'machine_test', 'run_id': str(uuid.uuid4()), 'split': 'development',
              'reference': 'existing human gold transcripts; historical acquisition origin unknown',
              'arrow_sha256': digest, 'manifest_sha256': hashlib.sha256(args.manifest.read_bytes()).hexdigest(),
              'development_lines': len(texts), 'ordinal_source_indices': indices, 'gold': [normalized(texts[index]) for index in indices]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'development_lines': len(texts), 'sample_lines': count, 'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest()}))


if __name__ == '__main__':
    main()
