"""Use ALR's existing fixed-response replay runner; never synthesize model answers."""
import argparse
from pathlib import Path
import sys
import time
import traceback

from compare_versions import below_normal, emit, offline, plain, read, sha, write


def main():
    below_normal()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--responses', type=Path, required=True)
    parser.add_argument('--arm', choices=['baseline', 'candidate'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.manifest, args.responses, args.output = (p.resolve() for p in (args.manifest, args.responses, args.output))
    manifest, responses = read(args.manifest), read(args.responses)
    source = manifest['sources'][args.arm]
    for name, digest in source['files'].items():
        if sha(Path(source['path']) / name) != digest:
            raise ValueError('Frozen source changed: ' + name)
    for name, digest in manifest['binding']['files'].items():
        if sha(args.manifest.parent / 'sources' / name) != digest:
            raise ValueError('Frozen binding changed: ' + name)
    for item in responses['cache_files']:
        if sha(args.responses.parent / item['file']) != item['sha256']:
            raise ValueError('Recorded response changed')
    sys.addaudithook(offline)
    sys.path.insert(0, str(args.manifest.parent / 'sources' / 'python'))
    sys.path.insert(0, source['path'])
    from dev.benchtools import benchmark_high_accuracy_hybrid as replay
    if args.arm == 'baseline' and 'legal_citations' in sys.modules:
        raise RuntimeError('Original replay imported the shared engine')
    records = responses['records']
    notes = {int(r['internal_id']): r['text'] for r in records}
    order = [int(r['internal_id']) for r in records]
    display = {int(r['internal_id']): str(r['display_id']) for r in records}
    _, display_to_internal, _ = replay.aqv._compute_footnote_display_ids(order, notes)
    args.output.mkdir(parents=True, exist_ok=True)
    write(args.output / f'{args.arm}-receipt.json', {
        'manifest_sha256': sha(args.manifest), 'responses_sha256': sha(args.responses),
        'harness_sha256': sha(__file__), 'source_revision': source['revision'],
        'scope': 'Fixed postprocessed model-response replay through original ALR runner and chain resolver',
        'limits': ['History drift is reported, not treated as a matching model request.',
                   'Provider retrieval and model disambiguation are disabled by the original runner.']})
    for mode in replay.MODES:
        for supra in ('safe', 'aggressive'):
            record = {'id': 'docx:' + responses['document_sha256'], 'status': 'ok'}
            started = time.perf_counter()
            try:
                result = replay.run_arm(records, mode, supra)
                replay.aqv.resolve_reference_chains(result['rows'], notes, result['counts'],
                    display_num_to_internal=display_to_internal, internal_to_display_id=display)
                record['output'] = {'notes': notes, 'order': order, 'display': display,
                    'parts': plain(result.pop('rows')), 'counts': result['counts']}
                record['replay'] = plain(result)
            except BaseException as error:
                if isinstance(error, (KeyboardInterrupt, SystemExit)):
                    raise
                record.update(status='error', error=traceback.format_exc())
            record['elapsed_s'] = time.perf_counter() - started
            with (args.output / f'{args.arm}-{mode}-{supra}.jsonl').open('x', encoding='utf-8') as stream:
                emit(stream, record)
            print(args.arm, mode, supra, record['status'], flush=True)


if __name__ == '__main__':
    main()
