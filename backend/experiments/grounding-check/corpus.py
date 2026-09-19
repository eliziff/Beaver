"""Pinned upstream corpora -> separate inference packets and scoring labels."""
import hashlib
import json
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

UPSTREAM = {
    'contract-nli.zip': ('stanfordnlp/contract-nli', 'eced6528dd3c1d14d73f9a87df8f7bdbc03126f9',
                         'resources/contract-nli.zip', '757fd1dafd29a997fba00c60c6d40b2930a36159'),
    'source_info.jsonl': ('ParticleMedia/RAGTruth', 'c103204b9ce28d6bbad859304bf30de72b8ed8fe',
                          'dataset/source_info.jsonl', '119277774009f110aa58596b93f9512f62594a89'),
    'response.jsonl': ('ParticleMedia/RAGTruth', 'c103204b9ce28d6bbad859304bf30de72b8ed8fe',
                       'dataset/response.jsonl', 'f9ae5913fb9976684f3e13be3cd3465062db54cc'),
}


def digest(value):
    data = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(data.encode('utf-8')).hexdigest()


def records(path):
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def utf16_len(text):
    return len(text.encode('utf-16-le')) // 2


def packet(identifier, group, split, slice_name, text, answer, question=''):
    version = UPSTREAM['contract-nli.zip' if group.startswith('contractnli:') else 'response.jsonl'][1]
    source = {'id': group, 'version': version, 'text': text, 'sha256': digest(text)}
    return {'id': identifier, 'group': group, 'split': split, 'slice': slice_name, 'question': question, 'privacy': 'public',
            'sources': [source], 'evidence': [{'id': 'e0', 'source_id': group, 'version': version,
              'start': 0, 'end': utf16_len(text), 'text': text}],
            'answer': [{'text': answer, 'evidence_ids': ['e0']}]}


def fetch(directory, filename):
    path = directory / filename
    repo, revision, remote, expected = UPSTREAM[filename]
    if not path.exists():
        temporary = path.with_suffix('.download')
        try:
            url = f'https://raw.githubusercontent.com/{repo}/{revision}/{remote}'
            with urllib.request.urlopen(url, timeout=90) as response, temporary.open('wb') as out:
                count = 0
                while block := response.read(1024 * 1024):
                    count += len(block)
                    if count > 80 * 1024 * 1024:
                        raise ValueError('upstream_file_too_large')
                    out.write(block)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    data = path.read_bytes()
    actual = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
    if actual != expected:
        raise ValueError(f'upstream_hash_mismatch: {filename}')
    return path


def contract_cases(path):
    with zipfile.ZipFile(path) as archive:
        for split in ('train', 'dev', 'test'):
            names = [name for name in archive.namelist() if Path(name).name == f'{split}.json']
            if len(names) != 1 or archive.getinfo(names[0]).file_size > 64 * 1024 * 1024:
                raise ValueError(f'bad_contract_split: {split}')
            data = json.loads(archive.read(names[0]))
            for doc in data['documents']:
                group = f'contractnli:{doc["id"]}'
                for key, annotation in doc['annotation_sets'][0]['annotations'].items():
                    choice = annotation['choice']
                    if choice not in ('Entailment', 'Contradiction', 'NotMentioned'):
                        raise ValueError('unknown_contract_label')
                    row = packet(f'{group}:{key}', group,
                                 {'train': 'development', 'dev': 'calibration', 'test': 'test'}[split],
                                 'contractnli', doc['text'], data['labels'][key]['hypothesis'])
                    spans = []
                    for index in annotation['spans']:
                        start, end = doc['spans'][index]
                        if not (0 <= start < end <= len(doc['text'])):
                            raise ValueError('bad_contract_span')
                        spans.append({'start': utf16_len(doc['text'][:start]),
                                      'end': utf16_len(doc['text'][:end]), 'text': doc['text'][start:end]})
                    yield row, {'supported': choice == 'Entailment', 'label': choice, 'spans': spans}


def ragtruth_cases(sources_path, responses_path):
    sources = {}
    for row in records(sources_path):
        if row['source_id'] in sources:
            raise ValueError('duplicate_ragtruth_source')
        sources[row['source_id']] = row
    for response in records(responses_path):
        if response['quality'] != 'good':
            continue
        source = sources[response['source_id']]
        info = source['source_info']
        if source['task_type'] == 'QA':
            text, question = info['passages'], info['question']
        else:
            text = info if isinstance(info, str) else json.dumps(info, ensure_ascii=False, sort_keys=True)
            question = 'Summarize the supplied source.'
        if not isinstance(text, str) or not text.strip() or not response['response'].strip():
            raise ValueError('empty_ragtruth_text')
        group = f'ragtruth:{response["source_id"]}'
        split = response['split']
        if split not in ('train', 'test'):
            raise ValueError('unknown_ragtruth_split')
        split = 'test' if split == 'test' else ('calibration' if int(digest(group)[:8], 16) % 5 == 0 else 'development')
        for label in response['labels']:
            if not (0 <= label['start'] < label['end'] <= len(response['response'])):
                raise ValueError('bad_ragtruth_span')
        row = packet(f'ragtruth:{response["id"]}', group, split, f'ragtruth:{source["task_type"]}',
                     text, response['response'], question)
        yield row, {'supported': not response['labels'], 'label': 'Supported' if not response['labels'] else 'Hallucination',
                    'spans': [{'start': utf16_len(response['response'][:label['start']]),
                               'end': utf16_len(response['response'][:label['end']]),
                               'text': response['response'][label['start']:label['end']],
                               'label': label['label_type']} for label in response['labels']]}


def prepare(destination, names=('contractnli', 'ragtruth')):
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    raw = destination / 'upstream'
    raw.mkdir(exist_ok=True)
    counts, seen, boundaries = Counter(), set(), {}
    for name in names:
        paths = {split: (destination / f'{name}-{split}.input.jsonl', destination / f'{name}-{split}.gold.jsonl')
                 for split in ('development', 'calibration', 'test')}
        if any(path.exists() for pair in paths.values() for path in pair):
            raise ValueError('prepared_output_exists; choose a fresh directory')
        iterator = contract_cases(fetch(raw, 'contract-nli.zip')) if name == 'contractnli' else ragtruth_cases(
            fetch(raw, 'source_info.jsonl'), fetch(raw, 'response.jsonl'))
        handles = {split: (pair[0].open('x', encoding='utf-8'), pair[1].open('x', encoding='utf-8'))
                   for split, pair in paths.items()}
        try:
            for row, gold in iterator:
                if row['id'] in seen:
                    raise ValueError('duplicate_id')
                seen.add(row['id'])
                for key in (row['group'], f'hash:{row["sources"][0]["sha256"]}'):
                    if key in boundaries and boundaries[key] != row['split']:
                        raise ValueError(f'cross_split_source: {key}')
                    boundaries[key] = row['split']
                gold.update(id=row['id'], input_sha256=digest(row))
                inputs, labels = handles[row['split']]
                inputs.write(json.dumps(row, ensure_ascii=False) + '\n')
                labels.write(json.dumps(gold, ensure_ascii=False) + '\n')
                counts[f'{name}:{row["split"]}:{gold["label"]}'] += 1
        finally:
            for pair in handles.values():
                for handle in pair:
                    handle.close()
    (destination / 'manifest.json').write_text(json.dumps({'upstream': UPSTREAM, 'counts': counts}, indent=2) + '\n')
    return counts
