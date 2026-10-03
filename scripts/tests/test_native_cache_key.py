import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_cache', Path(__file__).parents[1] / 'native-cache-key.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeCacheTests(unittest.TestCase):
    def test_workflow_pin_updates_reuse_cache_but_sources_and_toolchains_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def commit(repository, path, content):
                target = root / repository / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
                subprocess.run(['git', '-C', str(root / repository), 'add', '.'], check=True)
                subprocess.run(['git', '-C', str(root / repository), 'commit', '-qm', 'invented input'], check=True)
            for repository, path in [('.', 'native/legal-structure-node/Cargo.toml'),
                                     ('legal-structure', 'src/lib.rs'), ('legal-pdf-parser', 'rust/src/lib.rs')]:
                (root / repository).mkdir(exist_ok=True)
                subprocess.run(['git', 'init', '-q', str(root / repository)], check=True)
                for setting, value in [('user.name', 'CI test'), ('user.email', 'ci-test@users.noreply.github.com')]:
                    subprocess.run(['git', '-C', str(root / repository), 'config', setting, value], check=True)
                commit(repository, path, 'independently invented build input')
            original = native.cache_key(root, b'compiler one')
            commit('legal-pdf-parser', '.github/workflows/ci.yml', 'changed workflow')
            commit('legal-structure', 'README.md', 'changed documentation')
            # The addon uses its own lockfile and the invocation's root config.
            commit('legal-pdf-parser', '.cargo/config.toml', 'changed standalone job limit')
            commit('legal-structure', 'Cargo.lock', 'changed standalone resolution')
            self.assertEqual(original, native.cache_key(root, b'compiler one'))
            commit('.', '.cargo/config.toml', 'changed actual addon configuration')
            configured = native.cache_key(root, b'compiler one')
            self.assertNotEqual(original, configured)
            commit('legal-pdf-parser', 'rust/src/lib.rs', 'changed source')
            changed = native.cache_key(root, b'compiler one')
            self.assertNotEqual(configured, changed)
            self.assertNotEqual(changed, native.cache_key(root, b'compiler two'))


if __name__ == '__main__':
    unittest.main()
