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
        selected = ci.scope(["frontend/src/widget.tsx"])
        self.assertFalse(selected["backend"])
        self.assertTrue(selected["frontend"])
        self.assertTrue(selected["guards"])
        self.assertEqual(selected["audit"], [])

    def test_shared_backend_native_and_unknown_inputs_keep_consumers(self):
        for path in ("shared/wire.mjs", "backend/src/handler.ts", "legal-structure",
                     "native/legal-structure-node/Cargo.lock", "new-build-input.json"):
            with self.subTest(path=path):
                selected = ci.scope([path])
                self.assertTrue(selected["backend"])
                self.assertTrue(selected["frontend"])

    def test_audits_follow_manifests_and_gate_changes(self):
        self.assertEqual(ci.scope(["frontend/package-lock.json"])["audit"], ["frontend"])
        self.assertEqual(ci.scope(["backend/package.json"])["audit"], ["backend"])
        self.assertEqual(ci.scope(["scripts/audit-allowlist.json"])["audit"], [".", "backend", "frontend"])
        self.assertEqual(ci.scope([".github/workflows/ci.yml"])["audit"], [".", "backend", "frontend"])

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
                    self.assertEqual(json.loads(selected["audit"]), [".", "backend", "frontend"])
                    self.assertEqual(json.loads(selected["backend"]), name != "schedule")
                    self.assertEqual(json.loads(selected["frontend"]), name != "schedule")

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
