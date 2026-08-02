"""Focused correctness checks for the preregistered coding surfaces."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess

import pytest

from harness.ablation_tools import (
    AblationToolExecutor,
    _structure,
    get_ablation_tool_definitions,
)


def test_six_honest_tool_names_and_scope_only_schema_delta():
    plain = get_ablation_tool_definitions(legal_scopes=False)
    legal = get_ablation_tool_definitions(legal_scopes=True)
    assert [tool["name"] for tool in plain] == ["bash", "read", "write", "edit", "glob", "grep"]
    assert [tool["name"] for tool in legal] == [tool["name"] for tool in plain]
    plain_by_name = {tool["name"]: tool for tool in plain}
    legal_by_name = {tool["name"]: tool for tool in legal}
    for name in ("bash", "write", "edit", "glob"):
        assert legal_by_name[name] == plain_by_name[name]
    for name in ("read", "grep"):
        plain_properties = plain_by_name[name]["parameters"]["properties"]
        legal_properties = legal_by_name[name]["parameters"]["properties"]
        assert {
            key: value
            for key, value in legal_properties.items()
            if key not in {"section", "pages", "references", "table"}
        } == plain_properties


def test_structure_sidecar_uses_exact_projection_offsets():
    text = (
        "[page 1]\nARTICLE I\nSection 1.01 Reports.\nSee Section 2.01.\n"
        "[page 2]\nSection 2.01 Notices.\n| Name | Amount |\n| A | 10 |\n"
    )
    sidecar = _structure(text)
    assert text[sidecar["pages"][0]["start"] : sidecar["pages"][0]["end"]].startswith("[page 1]")
    reports = next(item for item in sidecar["sections"] if "1.01" in item["label"])
    assert text[reports["start"] : reports["end"]].startswith("Section 1.01")
    assert sidecar["references"][0]["target"] == "Section 2.01."
    assert text[sidecar["tables"][0]["start"] : sidecar["tables"][0]["end"]].startswith("|")


def _engine_reachable() -> bool:
    engine = os.environ.get("LAB_SANDBOX_ENGINE", "podman")
    try:
        return subprocess.run(
            [engine, "info"], capture_output=True, timeout=10
        ).returncode == 0
    except OSError:
        return False


requires_engine = pytest.mark.skipif(
    not _engine_reachable(), reason="LAB sandbox engine unavailable"
)


@pytest.fixture
def dirs(tmp_path):
    documents = tmp_path / "documents"
    output = tmp_path / "output"
    workspace = tmp_path / "workspace"
    documents.mkdir()
    output.mkdir()
    workspace.mkdir()
    (documents / "agreement.txt").write_text(
        "ARTICLE I\nSection 1.01 Reports.\nThe Borrower shall report monthly.\n"
        "Section 1.02 Notices.\nNotice must be written.\n",
        encoding="utf-8",
    )
    return {
        "documents_dir": str(documents),
        "output_dir": str(output),
        "workspace_dir": str(workspace),
    }


@requires_engine
def test_plain_and_legal_unscoped_calls_are_byte_identical(dirs):
    calls = [
        ("glob", {"pattern": "*.txt"}),
        ("grep", {"pattern": "Borrower", "output_mode": "content"}),
        ("read", {"file_path": "agreement.txt.txt", "offset": 0, "limit": 3}),
    ]
    with AblationToolExecutor(legal_scopes=False, **dirs) as plain:
        plain_results = [plain.execute(name, arguments) for name, arguments in calls]
        direct = plain.sandbox.exec(
            "rg --no-config --color never --line-number --with-filename -- Borrower /workspace/sources"
        )
        assert direct.returncode == 0
        assert plain_results[1] == direct.stdout.rstrip("\r\n")
    with AblationToolExecutor(legal_scopes=True, **dirs) as legal:
        legal_results = [legal.execute(name, arguments) for name, arguments in calls]
    assert legal_results == plain_results


@requires_engine
def test_projection_receipts_scoped_read_and_write_boundary(dirs):
    with AblationToolExecutor(legal_scopes=True, **dirs) as executor:
        manifest = json.loads(executor.execute("read", {"file_path": "manifest.json"}))
        receipt = manifest["documents"][0]
        projection = executor.sandbox.read_file(receipt["projection"])
        assert hashlib.sha256(projection).hexdigest() == receipt["projection_sha256"]
        scoped = json.loads(
            executor.execute(
                "read",
                {"file_path": "agreement.txt.txt", "section": "Section 1.01"},
            )
        )
        assert scoped["ok"] is True
        assert "Borrower shall report" in scoped["text"]
        assert "Section 1.02" not in scoped["text"]
        denied = executor.execute(
            "write",
            {"file_path": "/workspace/documents/no.txt", "content": "no"},
        )
        assert denied.startswith("SecurityError:")
        outside = executor.execute("grep", {"pattern": "root", "path": "/etc/passwd"})
        assert outside.startswith("Error:") or outside.startswith("SecurityError:")
