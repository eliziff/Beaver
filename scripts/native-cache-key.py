"""Hash committed build inputs, so documentation/workflow pin updates reuse the addon."""
import hashlib
from pathlib import Path
import subprocess


INPUTS = {
    '.': ['.cargo', 'native/legal-structure-node'],
    'legal-structure': ['Cargo.toml', 'build.rs', 'src',
                        'grammar/Cargo.toml', 'python/Cargo.toml'],
    'legal-pdf-parser': ['Cargo.toml', 'build.rs', 'data', 'rust',
                         'legal-pdf-core', 'legal-pdf-extraction', 'legal-pdf-extraction-processor',
                         'legal-pdf-language', 'legal-pdf-ocr', 'legal-pdf-pairing',
                         'legal-pdf-structure', 'legal-pdf-support'],
}


def cache_key(root, toolchain):
    digest = hashlib.sha256(toolchain)
    for repository, inputs in INPUTS.items():
        digest.update(repository.encode() + b'\0')
        digest.update(subprocess.check_output([
            'git', '-C', str(Path(root) / repository), 'ls-tree', '-r', '-z', 'HEAD', '--', *inputs]))
    return digest.hexdigest()


if __name__ == '__main__':
    print('key=' + cache_key(Path(__file__).resolve().parents[1],
                             subprocess.check_output(['rustc', '-vV'])))
