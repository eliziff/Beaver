#!/usr/bin/env python3
"""Orchestrate frozen final checks. This does not change the v1 evaluator."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

HOME = Path(__file__).resolve().parent
ROOT = HOME.parents[1]
WORKLOADS = ['fc-60', 'fc-180', 'abca-60', 'abca-180']

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def verify_hashes(hashes, root=HOME):
    for relative, expected in hashes.items():
        assert sha(root / relative) == expected, f'Identity changed: {relative}'

def event(name, **values):
    receipt = dict(event=name, time=now(), **values)
    with (HOME / 'ledger.jsonl').open('a') as stream:
        stream.write(json.dumps(receipt, sort_keys=True) + '\n')
    print(json.dumps(receipt), flush=True)

def run(command, label):
    event('final_validation_command_started', label=label, command=command)
    with (HOME / (label + '.log')).open('x') as stream:
        result = subprocess.run(command, cwd=ROOT, stdout=stream,
            stderr=subprocess.STDOUT, env={**os.environ, 'UV_THREADPOOL_SIZE': '1'})
    event('final_validation_command_completed', label=label, returncode=result.returncode,
          command=command, log=label + '.log', log_sha256=sha(HOME / (label + '.log')))
    if result.returncode:
        raise RuntimeError(f'{label} failed with exit {result.returncode}; see preserved log')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--reason', required=True)
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    baseline = HOME / 'snapshots/baseline'
    selected = json.loads((candidate / 'manifest.json').read_text())
    assert sha(candidate / 'assembly.mjs') == selected['bundle_sha256']
    assert sha(candidate / 'source.patch') == selected['patch_sha256']
    verify_hashes(selected['files'], candidate / 'source')
    verify_hashes(selected['files'], ROOT)
    snapshot_hashes = {str(path.relative_to(HOME)): sha(path)
        for path in sorted(candidate.rglob('*')) if path.is_file()}
    selection_path = HOME / 'final-selection.json'
    assert not selection_path.exists(), 'Final selection is immutable once written'
    common = [sys.executable, str(HOME / 'compare.py'), '--a', str(baseline), '--b', str(candidate)]
    run(common + ['--label', 'final-dev', '--pairs', '12'], 'final-dev')
    dev = json.loads((HOME / 'runs/final-dev/score.json').read_text())
    event('final_development_score', candidate=str(candidate), score=dev)
    if not (dev['all_correct'] and dev['guardrails_pass'] and dev['strict_improvement_supported']):
        raise RuntimeError('Final development validation needs review; holdout remains sealed')
    verify_hashes(snapshot_hashes)
    verify_hashes(selected['files'], ROOT)
    selection = dict(schema='beaver.court-cloud-final-selection.v1', selected_at=now(),
        incumbent_snapshot=str(candidate), baseline_snapshot=str(baseline),
        incumbent_manifest=selected, frozen_evaluator_sha256=sha(HOME / 'freeze-v1.json'),
        snapshot_file_hashes=snapshot_hashes,
        original_baseline_development_score=dev, search_stop_reason=args.reason,
        no_further_tuning=True, holdout_opened_before_selection=False,
        orchestrator_sha256=sha(Path(__file__)), command=sys.argv)
    with selection_path.open('x') as stream:
        json.dump(selection, stream, indent=2)
        stream.write('\n')
    selection_hash = sha(selection_path)
    selection_path.chmod(0o444)
    for relative in snapshot_hashes:
        (HOME / relative).chmod(0o444)
    event('final_incumbent_selected', selection=str(selection_path),
          selection_sha256=sha(selection_path), candidate=str(candidate), reason=args.reason)
    run([sys.executable, str(HOME / 'freeze.py'), 'verify', '--holdout'], 'final-holdout-unseal-integrity')
    event('holdout_opened_after_final_selection', candidate=str(candidate), tuning_prohibited=True)
    prefix = [str(HOME / 'no-network'), 'taskset', '-c', '2', 'node', '--expose-gc']
    for workload in WORKLOADS:
        run(prefix + [str(HOME / 'worker.mjs'), '--snapshot', str(baseline),
            '--split', 'holdout', '--workload', workload, '--mode', 'record',
            '--unseal', 'final-incumbent'], 'final-oracle-' + workload)
        run(prefix + [str(HOME / 'semantic-audit.mjs'), '--split', 'holdout',
            '--workload', workload, '--unseal', 'final-incumbent'], 'final-semantic-' + workload)
    oracle_manifest = {str(path.relative_to(HOME)): sha(path)
        for path in sorted((HOME / 'oracles/holdout').rglob('*')) if path.is_file()}
    (HOME / 'holdout-oracle-hashes.json').write_text(json.dumps(oracle_manifest, indent=2) + '\n')
    for relative in oracle_manifest:
        (HOME / relative).chmod(0o444)
    (HOME / 'holdout-oracle-hashes.json').chmod(0o444)
    event('holdout_baseline_oracles_recorded', hashes=oracle_manifest)
    verify_hashes(snapshot_hashes)
    verify_hashes(oracle_manifest)
    assert sha(selection_path) == selection_hash
    holdout_common = common + ['--split', 'holdout', '--final-selection', str(selection_path)]
    run(holdout_common + ['--label', 'final-holdout-check', '--mode', 'check'], 'final-holdout-check')
    run(holdout_common + ['--label', 'final-holdout', '--pairs', '12'], 'final-holdout')
    heldout = json.loads((HOME / 'runs/final-holdout/score.json').read_text())
    verify_hashes(snapshot_hashes)
    verify_hashes(oracle_manifest)
    verify_hashes(selected['files'], ROOT)
    assert sha(selection_path) == selection_hash
    event('final_holdout_score', candidate=str(candidate), score=heldout, no_tuning_on_holdout=True)
    run([sys.executable, str(HOME / 'freeze.py'), 'verify', '--holdout'], 'final-frozen-integrity')
    summary = dict(completed_at=now(), selection=selection, development=dev, holdout=heldout,
        complete=True, passed=bool(heldout['all_correct'] and heldout['guardrails_pass']
                                  and heldout['strict_improvement_supported']))
    (HOME / 'final-validation.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'final_validation_complete': True, 'passed': summary['passed']}), flush=True)
    return 0 if summary['passed'] else 2

if __name__ == '__main__':
    sys.exit(main())
