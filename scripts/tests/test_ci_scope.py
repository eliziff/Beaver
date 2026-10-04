import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest

spec = importlib.util.spec_from_file_location("ci_scope", Path(__file__).parents[1] / "ci-scope.py")
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


class ScopeTests(unittest.TestCase):
    def test_docs_and_frontend_do_not_build_native_backend(self):
        self.assertFalse(ci.scope(["docs/guide.md", "README.md"])["backend"])
        self.assertFalse(ci.scope(["docs/guide.md", "README.md"])["native"])
        selected = ci.scope(["frontend/src/widget.tsx"])
        self.assertFalse(selected["backend"])
        self.assertFalse(selected["native"])
        self.assertTrue(selected["frontend"])
        self.assertTrue(selected["application"])
        self.assertEqual(selected["audit"], [])
        self.assertFalse(ci.scope(["backend/src/routes/example.ts"])["native"])
        for path in ("native/legal-structure-node/src/lib.rs",
                     "native/legal-structure-node/Cargo.lock", ".cargo/config.toml",
                     "legal-structure", "common-law-cite/crates/legal-citations/vendor/diff-match-patch-rs/src/lib.rs"):
            self.assertTrue(ci.scope([path])["native"])

    def test_shared_backend_native_and_unknown_inputs_keep_consumers(self):
        for path in ("shared/wire.mjs", "backend/src/lib/authoritiesDomain.ts", "legal-structure",
                     "native/legal-structure-node/Cargo.lock", "new-build-input.json"):
            with self.subTest(path=path):
                selected = ci.scope([path])
                self.assertTrue(selected["backend"])
                self.assertTrue(selected["frontend"])

    def test_backend_implementation_does_not_retest_the_frontend(self):
        selected = ci.scope(["backend/src/routes/example.ts"])
        self.assertTrue(selected["backend"])
        self.assertFalse(selected["frontend"])
        self.assertTrue(selected["application"])
        self.assertFalse(selected["authorities"])
        for path in ("shared/contracts/pdfAssembly.mts", "AuthoritiesHelper", "legal-pdf-parser"):
            self.assertTrue(ci.scope([path])["authorities"])
        self.assertFalse(ci.scope(["shared/contracts/assistantWire.mts"])["authorities"])
        self.assertTrue(ci.scope(["shared/pdf/viewer.ts"])["authorities"])

    def test_source_test_edits_do_not_start_application_jobs(self):
        paths = ["backend/src/lib/__tests__/emailText.test.ts",
                 "frontend/src/app/hooks/useAssistantChat.test.ts"]
        selected = ci.scope(paths)
        for gate in ("backend", "frontend", "native", "application", "cloud", "authorities"):
            self.assertFalse(selected[gate], gate)
        mixed = ci.scope([*paths, "backend/src/lib/emailText.ts"])
        self.assertTrue(mixed["backend"])
        self.assertFalse(mixed["native"])
        deleted = ci.scope(["frontend/src/app/removed.test.ts"])
        self.assertFalse(deleted["application"])
        self.assertFalse(ci.scope(["backend/src/lib/__tests__/structureNativeAuthorityTextUnits.test.ts"])["application"])
        self.assertTrue(ci.scope(["e2e/assistant-interface.spec.ts"])["application"])

    def test_audits_follow_manifests_and_gate_changes(self):
        self.assertEqual(ci.scope(["frontend/package.json"])["audit"], ["."])
        self.assertEqual(ci.scope(["backend/package.json"])["audit"], ["."])
        self.assertEqual(ci.scope(["shared/package.json"])["audit"], ["."])
        self.assertEqual(ci.scope([".github/workflows/ci.yml"])["audit"], ["."])

    def test_browser_mode_keeps_cloud_boundaries_and_skips_cloud_for_ui(self):
        for path in ('frontend/src/app/components/ui/button.tsx',
                     'frontend/src/app/authorities/AuthoritySources.tsx',
                     'backend/src/lib/authoritiesBuild.ts', 'backend/src/lib/pagination.ts',
                     'backend/src/lib/chat/chatToolRunner.ts',
                     'frontend/src/app/lib/api/chat.ts',
                     'shared/contracts/assistantWire.mts',
                     'shared/contracts/authoritiesBook.mts', 'docs/guide.md'):
            with self.subTest(path=path):
                self.assertFalse(ci.scope([path])['cloud'])
        for path in ('backend/schema.sql', 'backend/src/lib/relationalProjectRepository.ts',
                     'backend/src/routes/auth.ts', 'frontend/src/app/contexts/AuthContext.tsx',
                     'frontend/src/app/login/page.tsx', 'frontend/src/app/lib/runtimeConfig.ts',
                     'frontend/src/app/lib/api/client.ts', 'backend/package-lock.json',
                     '.github/workflows/e2e.yml', 'new-deployment-input.json'):
            with self.subTest(path=path):
                self.assertTrue(ci.scope([path])['cloud'])
        self.assertTrue(ci.scope(['frontend/src/app/components/ui/button.tsx',
                                  'backend/schema.sql'])['cloud'])

    def test_word_platforms_follow_runtime_inputs(self):
        for path in ('shared/contracts/assistantWire.mts',
                     'backend/src/lib/wordEditApplication.ts', 'backend/package-lock.json',
                     '.github/workflows/ci.yml', 'package.json',
                     'backend/word-python.Dockerfile',
                     'backend/src/lib/__tests__/wordPython.test.ts'):
            self.assertEqual(ci.scope([path])['word_os'], ['ubuntu-24.04'])
        for path in ('backend/scripts/word_python/runner.py', 'backend/src/lib/convert.ts',
                     'backend/src/lib/subprocessEnv.ts',
                     '.github/workflows/word-python.yml'):
            with self.subTest(path=path):
                self.assertEqual(len(ci.scope([path])['word_os']), 2)

    def test_manual_weekly_and_unavailable_history_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            event_path = Path(directory) / "event.json"
            output_path = Path(directory) / "output.txt"
            for name, event in (("workflow_dispatch", {}), ("schedule", {}),
                                ("push", {"before": "1" * 40, "after": "2" * 40}),
                                ("push", {"before": "0" * 40, "after": "2" * 40})):
                with self.subTest(name=name, event=event):
                    event_path.write_text(json.dumps(event))
                    output_path.write_text("")
                    subprocess.run([sys.executable, str(Path(ci.__file__).resolve())], check=True,
                                   capture_output=True, cwd=directory,
                                   env={**os.environ, "GITHUB_EVENT_PATH": str(event_path),
                                        "GITHUB_EVENT_NAME": name, "GITHUB_OUTPUT": str(output_path)})
                    selected = dict(line.split("=", 1) for line in output_path.read_text().splitlines())
                    self.assertEqual(json.loads(selected["audit"]), ["."])
                    self.assertEqual(json.loads(selected["backend"]), name != "schedule")
                    self.assertEqual(json.loads(selected["frontend"]), name != "schedule")
                    self.assertEqual(json.loads(selected["cloud"]), name != "schedule")
                    self.assertEqual(json.loads(selected["word_os"]), ["ubuntu-24.04"])

    def test_diff_preserves_deleted_and_moved_owners_and_full_pr_range(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args]).decode().strip()
            git("init", "-q")
            git("config", "user.email", "ci-test@users.noreply.github.com")
            git("config", "user.name", "CI test")
            root = Path(directory)
            (root / "backend").mkdir()
            (root / "backend/item.txt").write_text("independent test input")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (root / "frontend").mkdir()
            git("mv", "backend/item.txt", "frontend/item.txt")
            git("commit", "-qm", "move")
            (root / "README.md").write_text("invented documentation")
            git("add", ".")
            git("commit", "-qm", "docs followup")
            head = git("rev-parse", "HEAD")
            from unittest.mock import patch
            original = subprocess.run
            with patch.object(ci.subprocess, "run", side_effect=lambda *a, **kw: original(*a, cwd=directory, **kw)):
                paths = ci.changed_paths({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}, "pull_request")
            self.assertEqual(set(paths), {"backend/item.txt", "frontend/item.txt", "README.md"})
            self.assertTrue(ci.scope(paths)["backend"])


if __name__ == "__main__":
    unittest.main()
