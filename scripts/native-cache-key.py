"""Hash committed build inputs, so documentation/workflow pin updates reuse the addon."""
import hashlib
from pathlib import Path
import subprocess


INPUTS = {
    '.': ['.cargo', 'native/legal-structure-node/Cargo.toml',
          'native/legal-structure-node/Cargo.lock', 'native/legal-structure-node/build.rs',
          'native/legal-structure-node/src'],
    'legal-structure': ['Cargo.toml', 'build.rs', 'src'],
    'common-law-cite': ['Cargo.toml', 'crates/legal-citations/Cargo.toml',
                        'crates/legal-citations/build.rs', 'crates/legal-citations/src',
                        'crates/legal-citations/registry', 'crates/legal-citations/vendor', 'crates/legal-grammar/Cargo.toml',
                        'crates/legal-grammar/src', 'crates/legal-grammar/data'],
    'legal-pdf-parser': ['Cargo.toml', 'build.rs', 'vendor/pdf-inspector/Cargo.toml',
                         'vendor/pdf-inspector/src',
                         'vendor/pdf-inspector/external/bcmaps', 'rust/native/tesseract_layout.c',
                         *[f'rust/src/{module}.rs' for module in
                           ('lib', 'contract', 'engine', 'structure_engine', 'supplied_ocr')],
                         *[f'legal-pdf-{crate}/{path}' for crate in
                           ('core', 'extraction', 'extraction-processor', 'language',
                            'ocr', 'pairing', 'structure', 'support')
                           for path in ('Cargo.toml', 'build.rs', 'src')]],
}


def cache_key(root, toolchain):
    digest = hashlib.sha256(toolchain)
    for repository, inputs in INPUTS.items():
        digest.update(repository.encode() + b'\0')
        tree = subprocess.check_output([
            'git', '-C', str(Path(root) / repository), 'ls-tree', '-r', '-z', 'HEAD', '--', *inputs])
        digest.update(b'\0'.join(entry for entry in tree.split(b'\0')
                                 if b'\tvendor/pdf-inspector/src/bin/' not in entry))
    return digest.hexdigest()


if __name__ == '__main__':
    print('key=' + cache_key(Path(__file__).resolve().parents[1],
                             subprocess.check_output(['rustc', '-vV'])))
