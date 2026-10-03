#!/usr/bin/env python3
"""Sequential fresh-process paired measurement; no overlapping timed workers."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from score import score
from freeze import verify

ROOT = Path(__file__).resolve().parent
WORKLOADS = ['fc-60', 'fc-180', 'abca-60', 'abca-180']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--a', required=True, type=Path)
    parser.add_argument('--b', required=True, type=Path)
    parser.add_argument('--label', required=True)
    parser.add_argument('--pairs', type=int, default=12)
    parser.add_argument('--split', choices=['dev', 'holdout'], default='dev')
    parser.add_argument('--mode', choices=['check', 'measure'], default='measure')
    parser.add_argument('--cpu', default='2')
    parser.add_argument('--start-pair', type=int, default=0)
    parser.add_argument('--final-selection', type=Path)
    args = parser.parse_args()
    if args.split == 'holdout':
        if not args.final_selection:
            raise ValueError('Holdout requires a written final-selection receipt before opening')
        selected = json.loads(args.final_selection.read_text())
        if Path(selected['incumbent_snapshot']).resolve() != args.b.resolve():
            raise ValueError('Holdout candidate must be the already selected final incumbent')
    frozen_sha256 = verify(args.split == 'holdout')
    output = ROOT / 'runs' / args.label
    output.mkdir(parents=True, exist_ok=False)
    worker = ROOT / 'worker.mjs'
    metadata = {
        'schema_version': 'beaver.court-cloud-comparison.v1',
        'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'command': sys.argv, 'cwd': str(Path.cwd()),
        'a_snapshot': str(args.a.resolve()), 'b_snapshot': str(args.b.resolve()),
        'frozen_evaluator_sha256': frozen_sha256,
        'evaluator_sha256': {name: sha(ROOT / name) for name in ['compare.py', 'score.py', 'worker.mjs', 'no-network']},
        'cpu_affinity': args.cpu,
        'worker_order': '4-pair block: AB BA BA AB; workloads rotate then reverse on alternate pairs',
    }
    (output / 'command.json').write_text(json.dumps(metadata, indent=2) + '\n')
    records = []
    count = 1 if args.mode == 'check' else args.pairs
    for pair in range(args.start_pair, args.start_pair + count):
        shift = pair % len(WORKLOADS)
        workloads = WORKLOADS[shift:] + WORKLOADS[:shift]
        if pair % 2:
            workloads = list(reversed(workloads))
        sides = ['a', 'b'] if pair % 4 in (0, 3) else ['b', 'a']
        for workload in workloads:
            for side in sides:
                path = args.a if side == 'a' else args.b
                command = [str(ROOT / 'no-network'), 'taskset', '-c', args.cpu, 'node', '--expose-gc', str(worker),
                           '--snapshot', str(path.resolve()), '--split', args.split,
                           '--workload', workload, '--mode', args.mode]
                if args.split == 'holdout':
                    command += ['--unseal', 'final-incumbent']
                start = time.monotonic()
                child = subprocess.run(command, capture_output=True, text=True, timeout=300,
                                       env={**os.environ, 'UV_THREADPOOL_SIZE': '1'})
                tag = f'{pair:04d}-{workload}-{side}'
                (output / f'{tag}.stdout').write_text(child.stdout)
                (output / f'{tag}.stderr').write_text(child.stderr)
                if child.returncode:
                    (output / 'FAILED.json').write_text(json.dumps({'command': command,
                        'returncode': child.returncode, 'tag': tag}, indent=2) + '\n')
                    print(f'FAILED {tag}: {child.stderr[-3000:]}', flush=True)
                    return child.returncode
                receipt = json.loads(child.stdout)
                receipt.update(workload=workload, pair=pair, side=side, command=command,
                               subprocess_wall_s=time.monotonic() - start)
                if not receipt.get('correctness'):
                    raise ValueError(f'Incorrect worker {tag}')
                with (output / 'raw.jsonl').open('a') as stream:
                    stream.write(json.dumps(receipt) + '\n')
                records.append(receipt)
        print(json.dumps({'label': args.label, 'completed_pairs': pair - args.start_pair + 1,
                          'total_pairs': count}), flush=True)
    result = score(records) if args.mode == 'measure' else {'all_correct': True, 'workers': len(records)}
    if verify(args.split == 'holdout') != frozen_sha256:
        raise ValueError('Frozen evaluator changed during comparison')
    (output / 'score.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
