#!/usr/bin/env python3
"""Offline original/shared citation comparison. Private inputs and receipts stay local."""
from __future__ import annotations

import argparse
import collections
import dataclasses
import hashlib
import gzip
import importlib.metadata
from itertools import zip_longest
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time
import traceback
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def iter_rows(path):
    with Path(path).open(encoding='utf-8-sig') as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def rows(path):
    return list(iter_rows(path))


def below_normal():
    if os.name == 'nt':
        import ctypes
        kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.SetPriorityClass.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), 0x4000):
            raise ctypes.WinError(ctypes.get_last_error())


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def emit(stream, value):
    stream.write(json.dumps(value, ensure_ascii=False) + '\n')
    stream.flush()


def git(repo, *args):
    return subprocess.check_output(['git', '-c', f'safe.directory={Path(repo).as_posix()}',
                                    '-C', str(repo), *args])


def snapshot(repo, ref, dest, working=False):
    revision = git(repo, 'rev-parse', ref).decode().strip()
    archive = dest.with_suffix('.zip')
    with archive.open('wb') as stream:
        subprocess.run(['git', '-c', f'safe.directory={Path(repo).as_posix()}', '-C', str(repo),
                        'archive', '--format=zip', revision], stdout=stream, check=True)
    with zipfile.ZipFile(archive) as stream:
        stream.extractall(dest)
    if working:
        for name in git(repo, 'ls-files', '-z').decode().split('\0'):
            if not name:
                continue
            source, target = Path(repo) / name, dest / name
            if source.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            elif target.is_file():
                target.unlink()
        (dest.parent / (dest.name + '.patch')).write_bytes(git(repo, 'diff', 'HEAD', '--binary'))
    return {'repository': str(repo), 'revision': revision, 'working_tree': working,
            'archive_sha256': sha(archive), 'path': str(dest),
            'files': {str(p.relative_to(dest)): sha(p) for p in dest.rglob('*') if p.is_file()}}


def freeze(args):
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    sources = out / 'sources'
    sources.mkdir()
    manifest = {'schema': 1, 'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'platform': platform.platform(), 'python': sys.version, 'sources': {},
                'documents': [], 'gold': {}, 'coverage_gaps': []}
    for arm, working in [('baseline', False), ('candidate', True)]:
        print('Freezing ALR', arm, flush=True)
        manifest['sources'][arm] = snapshot(args.alr.resolve(), 'HEAD', sources / arm, working)
    import legal_citations
    package = Path(legal_citations.__file__).parent
    shutil.copytree(package, sources / 'python' / 'legal_citations', ignore=shutil.ignore_patterns('__pycache__'))
    manifest['binding'] = {'version': legal_citations.version(), 'files': {
        str(p.relative_to(sources)): sha(p) for p in (sources / 'python').rglob('*') if p.is_file()}}
    manifest['dependencies'] = sorted(f'{d.metadata["Name"]}=={d.version}' for d in importlib.metadata.distributions())
    manifest['engine'] = {'revision': git(args.engine, 'rev-parse', 'HEAD').decode().strip(),
                          'diff_sha256': hashlib.sha256(git(args.engine, 'diff', 'HEAD', '--binary')).hexdigest()}
    docs = {}
    def add(path, collection, expected=None):
        path = path.resolve()
        if not path.is_file():
            manifest['coverage_gaps'].append({'collection': collection, 'path': str(path), 'reason': 'missing_input'})
            return
        digest = sha(path)
        if expected and expected != digest:
            raise ValueError(f'Input hash differs from frozen manifest: {path}')
        entry = docs.setdefault(digest, {'sha256': digest, 'path': str(path), 'kind': path.suffix[1:].lower(),
                                        'collections': [], 'paths': []})
        if collection not in entry['collections']:
            entry['collections'].append(collection)
        entry['paths'].append(str(path))
    for folder, label in [(args.alr / 'data', 'alr-working'),
                          (sources / 'baseline' / 'data', 'alr-committed'),
                          (ROOT / 'benchmarks/docx_corpus/private_sources', 'staged-24'),
                          (args.wordwright / 'wordwright/reference/submissions/documents', 'wordwright-submissions'),
                          (args.wordwright / 'typesetting-macro-upload/corpus/inputs', 'wordwright-inputs'),
                          (args.wordwright / 'benchmarks/alr-components/c', 'wordwright-components')]:
        for path in sorted(folder.rglob('*.docx')):
            add(path, label)
    for item in read(args.pdf_manifest)['documents']:
        add(ROOT / item['path'], 'pdf-original-750', item['sha256'])
    manifest['pdf_manifest'] = {'path': str(args.pdf_manifest.resolve()), 'sha256': sha(args.pdf_manifest),
                                'expected_documents': len(read(args.pdf_manifest)['documents'])}
    manifest['documents'] = sorted(docs.values(), key=lambda d: d['sha256'])
    gold = out / 'gold'
    gold.mkdir()
    for path in sorted((args.alr / 'dev/benchmarks').glob('*')):
        if path.suffix in ('.json', '.jsonl'):
            shutil.copy2(path, gold / path.name)
            manifest['gold'][path.name] = sha(gold / path.name)
    manifest['coverage_gaps'].extend([
        {'capability': 'live-model/provider equivalence', 'reason': 'offline; requires matching authentic recordings'},
        {'capability': 'source adjudication', 'reason': 'output agreement alone does not establish correctness against the source'}])
    write(out / 'manifest.json', manifest)
    print('Frozen', dict(collections.Counter(d['kind'] for d in docs.values())), flush=True)


def offline(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.bind'):
        raise RuntimeError('Network disabled for citation comparison')


def plain(value):
    if dataclasses.is_dataclass(value):
        value = dataclasses.asdict(value)
    return json.loads(json.dumps(value, default=str, ensure_ascii=False))


def worker(args):
    manifest = read(args.manifest)
    source = Path(manifest['sources'][args.arm]['path'])
    sys.addaudithook(offline)
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(args.manifest.parent / 'sources/python'))
    import alr_quote_verifier as app
    from verifier_core import deterministic_splitter as splitter
    from dev import supra_bench, link_truth
    if args.arm == 'baseline' and 'legal_citations' in sys.modules:
        raise RuntimeError('Original baseline imports the shared engine')
    # Independent reviewed data is identical in both arms, never candidate-derived.
    link_truth._LIVE_MAP_PATH = args.manifest.parent / 'gold/gold_link_verification.json'
    link_truth._REPAIRS_PATH = args.manifest.parent / 'gold/link_repairs.json'
    app.FREE_NO_LLM = True
    app.RUN_MODE = 'free'
    app.LOCAL_ONLY = True
    app.PURE_REF_PREFILTER = True
    app.DETERMINISTIC_SOURCE_SPLITTER = True
    app.DETERMINISTIC_REF_LINKS = True
    app.REF_DISAMBIG_FALLBACK = False
    app.USE_DB_SEARCH = False
    app.USE_A2AJ = False
    app.SEARCH_ALT_PINPOINTS = False
    app.LINK_RESOLVER = app.NoopHtmlResolver()
    app.LLM_CACHE_ENABLED = False
    app.SUPRA_LINKING_AGGRESSIVENESS = args.mode
    def forbidden(*a, **kw):
        raise RuntimeError('Live model call unavailable in offline comparison')
    app._llm_call = forbidden
    app._ensure_llm_client = forbidden
    cases = rows(args.cases)
    with args.output.open('x', encoding='utf-8') as stream:
        for index, case in enumerate(cases):
            result = {'id': case['id'], 'kind': case['kind'], 'mode': args.mode, 'status': 'ok'}
            start = time.perf_counter()
            try:
                text = case.get('text', '')
                if case['kind'] == 'split':
                    fn = splitter.split_footnote_recall_first if args.mode == 'aggressive' else splitter.split_footnote
                    split = fn(text)
                    result['output'] = {'split': plain(split), 'fields': [plain(splitter.extract_fields(p)) for p in split.parts]}
                    from dev.benchtools.benchmark_fast_splitter import score_parts, score_character_neutrality
                    result['splitter_mode'] = 'recall_first' if args.mode == 'aggressive' else 'conservative'
                    result['gold'] = []
                    for gold in case['gold']:
                        if gold.get('status') == 'accepted':
                            values = [p.text for p in split.parts]
                            result['gold'].append({'id': gold['id'], 'file': gold['file'],
                                **score_parts(gold['expected_verbatim_parts'], values, gold.get('acceptable_partitions')),
                                **score_character_neutrality(text, values)})
                elif case['kind'] == 'supra':
                    registry = supra_bench.parse_history_entries(case['previous_citations'])
                    # Legacy frozen histories omit note IDs and kinds; do not invent them from gold targets.
                    result['limitations'] = ['frozen history lacks note IDs and source kinds; inferred-name/note-tier coverage incomplete']
                    parts = [app.FootnotePart(verbatim=text, corrected=text, kind='other', link='', pinpoint_fragments=[])]
                    methods = app._resolve_footnote_reference_links(0, text, parts, registry, allow_fallback=False)
                    result['output'] = {'link': parts[0].link, 'methods': methods}
                    accepted = case.get('gold_status') in ('auto', 'agent')
                    valid, reason = link_truth.gate_gold_link(case['expected_link'], case.get('origin_text', ''))
                    result['gold'] = {'eligible': accepted and valid, 'provenance': case.get('gold_status'), 'verification': reason,
                                      'exact': parts[0].link == case['expected_link'],
                                      'identity': link_truth.canonical_link_identity(parts[0].link) == link_truth.canonical_link_identity(case['expected_link'])}
                elif case['kind'] == 'docx':
                    path = Path(case['path'])
                    if sha(path) != case['sha256']:
                        raise ValueError('Document changed after freeze')
                    notes, order, display = supra_bench.parse_docx_footnotes(path)
                    output, counts = app.build_footnote_parts(notes, order)
                    _, display_to_internal, _ = app._compute_footnote_display_ids(order, notes)
                    app.resolve_reference_chains(output, notes, counts,
                        display_num_to_internal=display_to_internal, internal_to_display_id=display)
                    result['output'] = {'notes': notes, 'order': order, 'display': display, 'parts': plain(output), 'counts': counts}
                    result['limitations'] = ['offline deterministic citation pipeline; external journal/provider enrichment not replayed']
                    result['configuration'] = {'run_mode': 'free', 'supra_linking': args.mode,
                                               'supra_mode': app.SUPRA_MODE}
                else:
                    raise ValueError(f'Unsupported case {case["kind"]}')
            except BaseException as exc:
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                result.update(status='error', error=traceback.format_exc())
            result['elapsed_s'] = time.perf_counter() - start
            emit(stream, result)
            if (index + 1) % 25 == 0 or index + 1 == len(cases):
                print(args.arm, args.mode, index + 1, '/', len(cases), flush=True)


def prepare_cases(manifest_path):
    manifest = read(manifest_path)
    gold = manifest_path.parent / 'gold'
    cases, split_by_text = [], {}
    for filename in ('fast_split_manual_gold.jsonl', 'fast_split_gold_all.jsonl'):
        for row in rows(gold / filename):
            text = row.get('verbatim_footnote_text') or row['footnote_text']
            key = hashlib.sha256(text.encode()).hexdigest()
            case = split_by_text.setdefault(key, {'id': 'split:' + key, 'kind': 'split', 'text': text, 'gold': []})
            case['gold'].append({'file': filename, **row})
    cases.extend(split_by_text.values())
    for row in rows(gold / 'supra_gold_candidates.jsonl'):
        cases.append({'id': row['id'], 'kind': 'supra', 'text': row['part_text'],
                      'previous_citations': row['previous_citations'], 'expected_link': row['expected_link'],
                      'origin_text': (row.get('expected_origin') or {}).get('verbatim', ''),
                      'gold_status': row['status'], 'source_doc': row['source_doc'], 'note': row['footnote_number']})
    cases.extend({'id': 'docx:' + d['sha256'], **d} for d in manifest['documents'] if d['kind'] == 'docx')
    return cases


def compare(args):
    manifest = read(args.manifest)
    for source in manifest['sources'].values():
        for name, digest in source['files'].items():
            if sha(Path(source['path']) / name) != digest:
                raise ValueError(f'Frozen source changed: {name}')
    for name, digest in manifest['binding']['files'].items():
        if sha(args.manifest.parent / 'sources' / name) != digest:
            raise ValueError(f'Frozen binding changed: {name}')
    for name, digest in manifest['gold'].items():
        if sha(args.manifest.parent / 'gold' / name) != digest:
            raise ValueError(f'Frozen gold changed: {name}')
    args.output.mkdir(parents=True, exist_ok=False)
    frozen_runner = args.output / 'runner.py'
    shutil.copy2(__file__, frozen_runner)
    cases = prepare_cases(args.manifest)
    if args.kinds:
        cases = [c for c in cases if c['kind'] in args.kinds]
    if args.ids:
        cases = [c for c in cases if c['id'] in args.ids]
        if {c['id'] for c in cases} != set(args.ids):
            raise ValueError('Requested case IDs are not all present')
    with (args.output / 'cases.jsonl').open('w', encoding='utf-8') as stream:
        for case in cases:
            emit(stream, case)
    write(args.output / 'receipt.json', {'manifest_sha256': sha(args.manifest), 'harness_sha256': sha(__file__),
                                       'command': sys.argv, 'python': sys.executable, 'platform': platform.platform()})
    commands = []
    for mode in ('safe', 'aggressive'):
        for arm in ('baseline', 'candidate'):
            command = [sys.executable, '-u', '-X', 'utf8', str(frozen_runner.resolve()), 'worker',
                       '--manifest', str(args.manifest.resolve()), '--cases', str((args.output / 'cases.jsonl').resolve()),
                       '--arm', arm, '--mode', mode, '--output', str((args.output / f'{arm}-{mode}.jsonl').resolve())]
            commands.append(command)
            log = args.output / f'{arm}-{mode}.log'
            print('Running', arm, mode, 'log:', log, flush=True)
            with log.open('w', encoding='utf-8') as stream:
                subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, check=True,
                               creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == 'nt' else 0)
    write(args.output / 'commands.json', commands)
    report(args.output)


def report(out):
    counts = collections.Counter()
    with (out / 'differences.jsonl').open('w', encoding='utf-8') as stream:
        for mode in ('safe', 'aggressive'):
            baseline = iter_rows(out / f'baseline-{mode}.jsonl')
            candidate = iter_rows(out / f'candidate-{mode}.jsonl')
            for a, b in zip_longest(baseline, candidate):
                if a and b and a['id'] != b['id']:
                    raise ValueError('Receipt order differs; refusing to guess occurrence alignment')
                key = (a or b)['id']
                kind = (a or b)['kind']
                outcome = 'equal' if a and b and a['status'] == b['status'] == 'ok' and a['output'] == b['output'] else 'different'
                if not a or not b or a['status'] != 'ok' or b['status'] != 'ok':
                    outcome = 'error_or_missing'
                counts[f'{mode}:{kind}:{outcome}'] += 1
                if outcome != 'equal':
                    emit(stream, {'id': key, 'mode': mode, 'outcome': outcome, 'baseline': a, 'candidate': b})
    write(out / 'summary.json', {'counts': dict(counts), 'preservation_established': False,
                                 'note': 'Raw differences require scoring and adjudication; equality is not independent correctness.'})
    print(json.dumps(dict(counts), indent=2), flush=True)


def score_saved(args):
    """Re-score immutable component outputs with ALR's original truth/scoring helpers."""
    manifest = read(args.manifest)
    source = Path(manifest['sources']['baseline']['path'])
    sys.addaudithook(offline)
    sys.path.insert(0, str(source))
    from dev import link_truth
    from dev.benchtools import benchmark_correctness as correctness
    # This component emits parser fields, not provider-resolved final links.
    correctness.FIELD_NAMES = tuple(name for name in correctness.FIELD_NAMES if name != 'link')
    gold = args.manifest.parent / 'gold'
    link_truth._LIVE_MAP_PATH = gold / 'gold_link_verification.json'
    link_truth._REPAIRS_PATH = gold / 'link_repairs.json'
    link_truth._CANLII_DB_PATH = args.link_db
    cases = {r['id']: r for r in iter_rows(args.run / 'cases.jsonl')}
    adjudications = read(args.adjudications) if args.adjudications else {}
    results = {}
    args.output.mkdir(parents=True, exist_ok=False)
    for path in sorted(args.run.glob('*-*.jsonl')):
        if not path.name.startswith(('baseline-', 'candidate-')):
            continue
        counts = collections.Counter()
        field_inputs = []
        with (args.output / path.name).open('x', encoding='utf-8') as stream:
            for row in iter_rows(path):
                case = cases[row['id']]
                if row['status'] != 'ok':
                    counts['errors'] += 1
                    continue
                if row['kind'] == 'supra':
                    accepted = case['gold_status'] in ('auto', 'agent')
                    valid, reason = link_truth.gate_gold_link(case['expected_link'], case.get('origin_text', ''))
                    actual = row['output']['link']
                    correct = link_truth.canonical_link_identity(actual) == link_truth.canonical_link_identity(case['expected_link'])
                    verdict = 'excluded' if not accepted or not valid else 'correct' if correct else 'incorrect'
                    counts['supra:' + verdict] += 1
                    if accepted and valid:
                        counts[f'supra:{case["gold_status"]}:{verdict}'] += 1
                    emit(stream, {'id': row['id'], 'outcome': verdict, 'verification': reason,
                                  'expected': case['expected_link'], 'actual': actual})
                elif row['kind'] == 'split':
                    # Manual gold owns overlaps. Historical-only inputs remain separate.
                    manual = [g for g in case['gold'] if g['file'] == 'fast_split_manual_gold.jsonl']
                    accepted = [g for g in manual or case['gold'] if g.get('status') == 'accepted']
                    if not accepted:
                        counts['split:excluded'] += 1
                        continue
                    alternatives = {json.dumps([g['expected_verbatim_parts'], g.get('acceptable_partitions') or []], sort_keys=True) for g in accepted}
                    judgment = adjudications.get(row['id'])
                    if len(alternatives) > 1 and not judgment:
                        counts['split:conflicting_gold'] += 1
                        emit(stream, {'id': row['id'], 'outcome': 'conflicting_gold', 'gold_ids': [g['id'] for g in accepted]})
                        continue
                    chosen = next((g for g in accepted if judgment and g['id'] == judgment['preferred_gold_id']), None) if judgment else accepted[0]
                    if chosen is None:
                        raise ValueError(f'Adjudication selects absent or unaccepted gold: {row["id"]}')
                    scores = next(g for g in row['gold'] if g['file'] == chosen['file'] and g['id'] == chosen['id'])
                    counts['split:eligible'] += 1
                    counts['split:strict_correct'] += bool(scores['strict_exact_match'])
                    emit(stream, {'id': row['id'], 'gold_id': chosen['id'], 'gold_file': chosen['file'], 'scores': scores, 'adjudication': judgment})
                    # Field comparison is diagnostic; link_candidate is not a final provider URL.
                    fields = [{**f, 'verbatim': p['text']} for p, f in zip(row['output']['split']['parts'], row['output']['fields'])]
                    field_inputs.append({'id': chosen['id'], 'expected_verbatim_parts': chosen['expected_verbatim_parts'],
                                         'actual_parts_full': fields})
        field_summary, field_details = correctness.score_field_correctness(field_inputs, gold / 'field_gold_provisional.jsonl')
        results[path.stem] = {'counts': dict(counts), 'field_diagnostics': field_summary,
                             'field_limit': 'Parser fields only; final source-link correctness is not established by this lane.'}
        write(args.output / (path.stem + '-fields.json'), field_details)
    write(args.output / 'summary.json', {'results': results, 'manifest_sha256': sha(args.manifest),
        'link_db_sha256': sha(args.link_db), 'input_hashes': {p.name: sha(p) for p in args.run.glob('*.jsonl')},
        'adjudications_sha256': sha(args.adjudications) if args.adjudications else None,
        'preservation_established': False})
    print(json.dumps({k: v['counts'] for k, v in results.items()}, indent=2))


def prepare_texts(args):
    """Reuse original DOCX extraction and saved PDF structure text for component inputs."""
    manifest = read(args.manifest)
    args.output.mkdir(parents=True, exist_ok=False)
    sys.addaudithook(offline)
    sys.path.insert(0, manifest['sources']['baseline']['path'])
    import alr_quote_verifier as app
    receipts, covered = [], set()
    documents = {d['sha256']: d for d in manifest['documents']}
    with (args.output / 'texts.jsonl').open('x', encoding='utf-8') as stream:
        for record in iter_rows(args.saved_documents):
            digest = record['id'].removeprefix('docx:')
            if record['status'] != 'ok':
                receipts.append({'sha256': digest, 'status': record['status']})
                continue
            document = documents[digest]
            if sha(document['path']) != digest:
                raise ValueError('Frozen document hash changed')
            with zipfile.ZipFile(document['path']) as archive:
                body = app._get_zip_xml(archive, 'word/document.xml')
                styles = app._get_zip_xml(archive, 'word/styles.xml')
            paragraphs = app.extract_doc_stream_with_styles(body, styles)
            for index, paragraph in enumerate(paragraphs):
                emit(stream, {'id': f'{digest}:body:{index}', 'text': paragraph['text'],
                              'source_sha256': digest, 'scope': 'original_ALR_body_paragraph', 'style': paragraph['style_name']})
            output = record['output']
            for fid in output['order']:
                emit(stream, {'id': f'{digest}:note:{fid}', 'text': output['notes'][str(fid)],
                              'source_sha256': digest, 'scope': 'original_ALR_note', 'display_note': output['display'][str(fid)]})
            receipts.append({'sha256': digest, 'status': 'ok', 'body_paragraphs': len(paragraphs), 'notes': len(output['order'])})
            covered.add(digest)
        # A cached structure is evidence for shared-input citation comparison, not extractor parity.
        for folder in args.pdf_cache:
            for path in sorted(folder.glob('*.json.gz')):
                with gzip.open(path, 'rt', encoding='utf-8') as source:
                    cached = json.load(source)
                structure = cached.get('structure', {})
                digest = structure.get('source_sha256') or cached.get('summary', {}).get('sha256')
                if digest not in documents or digest in covered or documents[digest]['kind'] != 'pdf':
                    continue
                text = structure.get('text')
                if not isinstance(text, str):
                    continue
                emit(stream, {'id': f'{digest}:cached_pdf_text', 'text': text,
                              'source_sha256': digest, 'scope': 'cached_PDF_component_input'})
                covered.add(digest)
                receipts.append({'sha256': digest, 'status': 'cached_component_only',
                                 'cache': str(path), 'cache_sha256': sha(path),
                                 'text_sha256': hashlib.sha256(text.encode()).hexdigest()})
    write(args.output / 'receipt.json', {'manifest_sha256': sha(args.manifest),
        'saved_documents_sha256': sha(args.saved_documents), 'inputs_sha256': sha(args.output / 'texts.jsonl'),
        'documents': receipts, 'missing_document_hashes': sorted(documents.keys() - covered),
        'limits': ['Original ALR body extractor does not traverse table paragraphs.',
                   'Cached PDF text does not establish before/after extraction or reading-order parity.']})
    print('Prepared shared text inputs; covered documents:', len(covered), 'missing:', len(documents.keys() - covered))


def structure_run(args):
    args.output.mkdir(parents=True, exist_ok=False)
    receipt = {'inputs_sha256': sha(args.inputs), 'bridge_sha256': sha(Path(__file__).with_name('structure_compare.rs')),
               'binaries': {}, 'offset_unit': 'utf16', 'scope': 'LSP public citation/classification interfaces on identical text'}
    for arm, executable in [('baseline', args.baseline_exe), ('candidate', args.candidate_exe)]:
        receipt['binaries'][arm] = {'path': str(executable), 'sha256': sha(executable)}
        print('Running LSP', arm, 'log:', args.output / f'{arm}.log', flush=True)
        started = time.perf_counter()
        with args.inputs.open('rb') as inputs, (args.output / f'{arm}.jsonl').open('xb') as output, (args.output / f'{arm}.log').open('wb') as log:
            completed = subprocess.run([str(executable)], stdin=inputs, stdout=output, stderr=log,
                creationflags=subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == 'nt' else 0)
        receipt['binaries'][arm].update(exit_code=completed.returncode, elapsed_s=time.perf_counter() - started)
    write(args.output / 'receipt.json', receipt)
    structure_score(args)


def core_documents(args):
    """Compare both supra-linking modes using original note numbers and source parts."""
    manifest = read(args.manifest)
    for name, digest in manifest['binding']['files'].items():
        if sha(args.manifest.parent / 'sources' / name) != digest:
            raise ValueError('Frozen binding changed')
    sys.addaudithook(offline)
    import legal_citations
    package = Path(legal_citations.__file__).parent
    binding = {'path': str(package), 'version': legal_citations.version(), 'files': {
        str(path.relative_to(package)): sha(path) for path in sorted(package.rglob('*'))
        if path.is_file() and '__pycache__' not in path.parts}}
    args.output.mkdir(parents=True, exist_ok=False)
    shutil.copy2(__file__, args.output / 'runner.py')
    receipt = {
        'manifest_sha256': sha(args.manifest), 'saved_documents_sha256': sha(args.saved_documents),
        'harness_sha256': sha(__file__), 'frozen_binding': manifest['binding'], 'binding': binding,
        'offset_unit': 'char', 'supra_hint_mode': 'aggressive',
        'outputs': {'safe': 'candidate.jsonl', 'aggressive': 'candidate-aggressive.jsonl'},
        'scope': 'Shared extraction and separate safe/aggressive resolution; original note order and display numbers',
        'limits': ['Note-only input excludes body anchors and body-defined authorities.']}
    with (args.output / 'candidate.jsonl').open('x', encoding='utf-8') as safe, \
         (args.output / 'candidate-aggressive.jsonl').open('x', encoding='utf-8') as aggressive:
        for original in iter_rows(args.saved_documents):
            records = {mode: {'id': original['id'], 'mode': mode, 'status': 'ok'}
                       for mode in ('safe', 'aggressive')}
            started = time.perf_counter()
            try:
                if original['status'] != 'ok':
                    raise ValueError('Original document extraction failed')
                document = original['output']
                texts, notes, cursor = [], [], 0
                for fid in document['order']:
                    text = document['notes'][str(fid)]
                    number = str(document['display'][str(fid)])
                    if number.isdecimal():
                        notes.append({'number': int(number), 'start': cursor, 'end': cursor + len(text)})
                    texts.append(text)
                    cursor += len(text) + 2
                text = '\n\n'.join(texts)
                extracted = legal_citations.call('extract', {'text': text, 'offsetUnit': 'char',
                    'options': {'resolve': False, 'notes': notes}})
                extract_elapsed = time.perf_counter() - started
                text_digest = hashlib.sha256(text.encode()).hexdigest()
                for mode, record in records.items():
                    record.update(notes=notes, text_sha256=text_digest,
                                  extracted=extracted['citations'], sourceParts=extracted['sourceParts'])
                    resolved_at = time.perf_counter()
                    try:
                        record['resolved'] = legal_citations.resolve(record['extracted'], notes=notes,
                            source_parts=record['sourceParts'], supra_hint_mode='aggressive',
                            supra_linking_mode=mode)
                    except Exception:
                        record.update(status='error', error=traceback.format_exc())
                    record['elapsed_s'] = extract_elapsed + time.perf_counter() - resolved_at
            except BaseException as exc:
                if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                    raise
                for record in records.values():
                    record.update(status='error', error=traceback.format_exc(),
                                  elapsed_s=time.perf_counter() - started)
            emit(safe, records['safe'])
            emit(aggressive, records['aggressive'])
            print(original['id'], records['safe']['status'], records['aggressive']['status'], flush=True)
    receipt['outputs_sha256'] = {mode: sha(args.output / filename)
                                 for mode, filename in receipt['outputs'].items()}
    write(args.output / 'receipt.json', receipt)


def structure_score(args):
    """Score saved native outputs without rerunning either implementation."""
    saved = getattr(args, 'run', args.output)
    if saved != args.output:
        args.output.mkdir(parents=True, exist_ok=False)
    receipt = read(saved / 'receipt.json')
    if sha(args.inputs) != receipt['inputs_sha256']:
        raise ValueError('Text inputs differ from the executed corpus')
    counts = collections.Counter()
    with (args.output / 'differences.jsonl').open('x', encoding='utf-8') as differences:
        for index, (source, baseline, candidate) in enumerate(zip_longest(iter_rows(args.inputs),
                iter_rows(saved / 'baseline.jsonl'), iter_rows(saved / 'candidate.jsonl'))):
            if source is None:
                raise ValueError('Native adapter returned extra records')
            if any(row and row['id'] != source['id'] for row in [baseline, candidate]):
                raise ValueError('Native adapter receipt order changed')
            counts['inputs'] += 1
            changed = []
            for arm, row in [('baseline', baseline), ('candidate', candidate)]:
                if not row or row['status'] != 'ok':
                    counts[arm + ':error_or_missing'] += 1
                    changed.append(arm + ':error_or_missing')
                    continue
                encoded = source['text'].encode('utf-16-le')
                for operation in ('occurrences', 'references', 'providers'):
                    spans = []
                    for item in row['output'][operation]:
                        spans.append(item)
                        spans.extend(item.get('pinpoints', []))
                        spans.extend(item[k] for k in ('coreCitation', 'styledCitation', 'token') if k in item)
                    for span in spans:
                        try:
                            valid = (0 <= span['start'] <= span['end'] <= len(encoded) // 2 and
                                     encoded[2*span['start']:2*span['end']].decode('utf-16-le') == span['text'])
                        except UnicodeError:
                            valid = False
                        if not valid:
                            counts[arm + ':' + operation + ':invalid_span'] += 1
                            changed.append(arm + ':' + operation + ':invalid_span')
            if baseline and candidate and baseline['status'] == candidate['status'] == 'ok':
                for operation in baseline['output']:
                    if baseline['output'][operation] != candidate['output'][operation]:
                        changed.append(operation)
                        counts[operation + ':different'] += 1
                # These are observable losses/additions, not automatic correctness judgments.
                for operation, field in [('occurrences', 'coreCitation'), ('references', 'token')]:
                    def identities(row):
                        return collections.Counter((item[field]['start'], item[field]['end'], item[field]['text'],
                                                    item['kind'], item.get('noteNumber'))
                                                   for item in row['output'][operation])
                    old, new = identities(baseline), identities(candidate)
                    counts[operation + ':removed'] += sum((old - new).values())
                    counts[operation + ':added'] += sum((new - old).values())
                if baseline['output']['classification']['kind'] != candidate['output']['classification']['kind']:
                    counts['classification:kind_changed'] += 1
            if changed:
                emit(differences, {'id': source['id'], 'changes': changed, 'source': source,
                                   'baseline': baseline, 'candidate': candidate})
            else:
                counts['equal'] += 1
            if (index + 1) % 1000 == 0:
                print('Compared', index + 1, 'text inputs', flush=True)
    write(args.output / 'summary.json', {'counts': dict(counts), 'preservation_established': False,
        'scorer_sha256': sha(__file__), 'outputs_sha256': {
            arm: sha(saved / f'{arm}.jsonl') for arm in ('baseline', 'candidate')}})
    print(json.dumps(dict(counts), indent=2), flush=True)


def main():
    below_normal()
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('freeze')
    p.add_argument('--alr', type=Path, required=True)
    p.add_argument('--wordwright', type=Path, required=True)
    p.add_argument('--engine', type=Path, required=True)
    p.add_argument('--pdf-manifest', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('run')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--kinds', nargs='+', choices=['split', 'supra', 'docx'])
    p.add_argument('--ids', nargs='+')
    p = sub.add_parser('worker')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--cases', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--arm', choices=['baseline', 'candidate'], required=True)
    p.add_argument('--mode', choices=['safe', 'aggressive'], required=True)
    p = sub.add_parser('score-saved')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--link-db', type=Path, required=True)
    p.add_argument('--adjudications', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('prepare-texts')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--saved-documents', type=Path, required=True)
    p.add_argument('--pdf-cache', type=Path, nargs='*', default=[])
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('structure-run')
    p.add_argument('--inputs', type=Path, required=True)
    p.add_argument('--baseline-exe', type=Path, required=True)
    p.add_argument('--candidate-exe', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('structure-score')
    p.add_argument('--inputs', type=Path, required=True)
    p.add_argument('--run', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('core-documents')
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--saved-documents', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    for name, value in vars(args).items():
        if isinstance(value, Path):
            setattr(args, name, value.resolve())
    if hasattr(args, 'pdf_cache'):
        args.pdf_cache = [p.resolve() for p in args.pdf_cache]
    {'freeze': freeze, 'run': compare, 'worker': worker, 'score-saved': score_saved,
     'prepare-texts': prepare_texts, 'structure-run': structure_run,
     'structure-score': structure_score, 'core-documents': core_documents}[args.command](args)


if __name__ == '__main__':
    main()
