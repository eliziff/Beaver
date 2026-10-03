"""Clone missing owner repositories; existing working trees are never changed."""
import json
import os
from pathlib import Path
import subprocess
import sys


def git(*arguments):
    return subprocess.check_output(['git', *map(str, arguments)], text=True).strip()


def bootstrap(root, names=None, refs=None, resolve=False):
    repositories = json.loads((root / 'repositories.json').read_text())
    selected = names or list(repositories)
    result = {}
    for name in selected:
        repository = repositories[name]
        branch = repository['branch']
        source = repository.get('remote') or str(root / repository['bundle'])
        if resolve:
            if repository.get('remote'):
                value = git('ls-remote', source, f'refs/heads/{branch}').split()
                if len(value) != 2:
                    raise ValueError(f'Missing {name}/{branch}')
                result[name] = value[0]
            continue
        destination = root / name
        if destination.exists():
            if refs and name in refs and git('-C', destination, 'rev-parse', 'HEAD') != refs[name]:
                raise ValueError(f'Existing {name} differs from this CI run; refusing to replace it')
            continue
        arguments = ['clone', '--branch', branch]
        if repository.get('remote'):
            arguments += ['--depth', '1']
        git(*arguments, source, destination)
        if refs and name in refs:
            git('-C', destination, 'fetch', '--depth', '1', 'origin', refs[name])
            git('-C', destination, 'checkout', '-B', branch, refs[name])
    return result


if __name__ == '__main__':
    arguments = sys.argv[1:]
    resolve = '--resolve' in arguments
    arguments = [argument for argument in arguments if argument != '--resolve']
    result = bootstrap(Path(__file__).resolve().parents[1], arguments,
                       json.loads(os.environ.get('BEAVER_REPOSITORY_REFS') or '{}'), resolve)
    if resolve:
        print(json.dumps(result, separators=(',', ':')))
