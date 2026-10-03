#!/usr/bin/env python3
"""Freeze and verify evaluator identities; holdout data is not opened before final."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(include_holdout=False):
    manifest = json.loads((ROOT / 'freeze-v1.json').read_text())
    for relative, expected in manifest['files'].items():
        path = ROOT / relative
        if digest(path) != expected:
            raise ValueError(f'Frozen evaluator or development fixture changed: {relative}')
    if include_holdout:
        for relative, expected in manifest['holdout_sealed_files'].items():
            if digest(ROOT / relative) != expected:
                raise ValueError(f'Sealed holdout changed: {relative}')
    return digest(ROOT / 'freeze-v1.json')


def freeze():
    target = ROOT / 'freeze-v1.json'
    if target.exists():
        raise ValueError('Freeze exists; never overwrite. Genuine harness corrections require a new version.')
    files = {}
    paths = list(ROOT.glob('*.mjs')) + list(ROOT.glob('*.py'))
    paths += [ROOT / name for name in ['PROTOCOL.md', 'no-network', 'no-network.c',
                                       'fixture-manifest.json', 'machine.json', 'network-denial-selftest.json']]
    paths += [p for p in (ROOT / 'oracles/dev').rglob('*') if p.is_file()]
    paths += [p for p in (ROOT / 'snapshots/baseline').rglob('*') if p.is_file()]
    paths += [REPO / 'frontend/package-lock.json']
    paths += [p for p in (REPO / 'frontend/public/court-fonts').rglob('*') if p.is_file()]
    for path in paths:
        files[str(path.relative_to(ROOT, walk_up=True))] = digest(path)
    fixture_manifest = json.loads((ROOT / 'fixture-manifest.json').read_text())
    for workload, values in fixture_manifest['development'].items():
        for name, expected in values['files'].items():
            relative = f'fixtures/dev/{workload}/{name}'
            if digest(ROOT / relative) != expected:
                raise ValueError(f'Fixture mismatch before freeze: {relative}')
            files[relative] = expected
    sealed = {}
    # Hashes originate in the creation-time seal; do not open held-out documents here.
    for workload, values in fixture_manifest['holdout_sealed'].items():
        for name, expected in values['files'].items():
            sealed[f'fixtures/holdout/{workload}/{name}'] = expected
    manifest = {'schema_version': 'beaver.court-cloud-frozen-evaluator.v1',
                'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'files': dict(sorted(files.items())), 'holdout_sealed_files': sealed,
                'holdout_opened': False, 'production_mutations_before_freeze': 0}
    target.write_text(json.dumps(manifest, indent=2) + '\n')
    for relative in files:
        path = ROOT / relative
        if path.is_relative_to(ROOT):
            path.chmod(0o555 if path.name == 'no-network' else 0o444)
    target.chmod(0o444)
    print(json.dumps({'freeze_sha256': digest(target), 'frozen_files': len(files),
                      'sealed_holdout_files': len(sealed), 'holdout_opened': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['freeze', 'verify'])
    parser.add_argument('--holdout', action='store_true')
    args = parser.parse_args()
    if args.command == 'freeze':
        freeze()
    else:
        print(json.dumps({'verified': True, 'freeze_sha256': verify(args.holdout),
                          'holdout_checked': args.holdout}))
