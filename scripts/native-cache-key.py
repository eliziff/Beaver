"""Hash committed build inputs, so documentation/workflow pin updates reuse the addon."""
import hashlib
from fnmatch import fnmatchcase
from pathlib import Path
import subprocess


INPUTS = {
    '.': ['Cargo.toml', 'Cargo.lock', '.cargo',
          'native/legal-structure-node/Cargo.toml', 'native/legal-structure-node/build.rs',
          'native/legal-structure-node/src', 'native/vendor/calamine/Cargo.toml',
          'native/vendor/calamine/src'],
    'legal-structure': ['Cargo.toml', 'build.rs', 'src',
                        *[f'{crate}/{path}' for crate in
                          ('features', 'layout', 'locator', 'model', 'query')
                          for path in ('Cargo.toml', 'build.rs', 'src')]],
    'common-law-cite': ['Cargo.toml', 'crates/*/Cargo.toml',
                        'crates/*/build*.rs', 'crates/*/src/*',
                        'crates/legal-citations/registry', 'crates/legal-citations/vendor',
                        'crates/legal-grammar/data'],
    'legal-pdf-parser': ['Cargo.toml', 'build.rs', 'vendor/pdf-inspector/Cargo.toml',
                         'vendor/pdf-inspector/src',
                         'vendor/pdf-inspector/external/bcmaps',
                         'rust/src', 'legal-pdf-*/Cargo.toml',
                         'legal-pdf-*/build.rs', 'legal-pdf-*/src/*'],
}


def cache_key(root, toolchain):
    digest = hashlib.sha256(toolchain)
    for repository, inputs in INPUTS.items():
        digest.update(repository.encode() + b'\0')
        tree = subprocess.check_output([
            'git', '-C', str(Path(root) / repository), 'ls-tree', '-r', '-z', 'HEAD'])
        for entry in tree.split(b'\0'):
            if not entry:
                continue
            name = entry.split(b'\t', 1)[1].decode('utf-8')
            if name.startswith('vendor/pdf-inspector/src/bin/'):
                continue
            if any(name == path or name.startswith(path + '/') or fnmatchcase(name, path)
                   for path in inputs):
                digest.update(entry + b'\0')
    return digest.hexdigest()


if __name__ == '__main__':
    print('key=' + cache_key(Path(__file__).resolve().parents[1],
                             subprocess.check_output(['rustc', '-vV'])))
