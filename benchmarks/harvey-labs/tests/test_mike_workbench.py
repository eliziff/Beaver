import hashlib
import json
import shlex
from dataclasses import dataclass
from pathlib import Path

from harness.adapters.base import ModelResponse, ToolCall
from harness.agent_loop import run_agent
from harness.mike_workbench import (
    ADAPTIVE_REVIEW_BUDGET_CHARACTERS,
    MikeWorkbenchExecutor,
    get_mike_surface,
)
from sandbox.sandbox import DOCUMENTS_PATH, OUTPUT_PATH, WORKSPACE_PATH


@dataclass
class _ExecResult:
    stdout: str = ""
    stderr: str = ""
    returncode: int | None = 0
    timed_out: bool = False


class _FakeSandbox:
    def __init__(self, root: Path):
        self.documents_dir = root / "documents"
        self.output_dir = root / "output"
        self.workspace_dir = root / "workspace"
        for directory in (self.documents_dir, self.output_dir, self.workspace_dir):
            directory.mkdir(parents=True)

    def _host(self, path: str) -> Path:
        for prefix, root in (
            (DOCUMENTS_PATH, self.documents_dir),
            (OUTPUT_PATH, self.output_dir),
            (WORKSPACE_PATH, self.workspace_dir),
        ):
            if path == prefix or path.startswith(prefix + "/"):
                return root / path[len(prefix) :].lstrip("/")
        raise ValueError(path)

    def list_files(self, path: str, recursive: bool = True) -> list[str]:
        root = self._host(path)
        iterator = root.rglob("*") if recursive else root.iterdir()
        return sorted(
            f"{path}/{item.relative_to(root).as_posix()}"
            for item in iterator
            if item.is_file()
        )

    def read_file(self, path: str) -> bytes:
        return self._host(path).read_bytes()

    def write_file(self, path: str, content: str | bytes) -> None:
        target = self._host(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            target.write_bytes(content)
        else:
            target.write_text(content, encoding="utf-8")

    def exists(self, path: str) -> bool:
        return self._host(path).exists()

    def exec(self, command: str, timeout: int = 60) -> _ExecResult:
        argv = shlex.split(command)
        if argv and argv[0] == "pandoc" and "-o" in argv:
            output = argv[argv.index("-o") + 1]
            self.write_file(output, b"PK\x03\x04test-docx")
        return _ExecResult()


def _executor(
    tmp_path: Path,
    *,
    surface: str | None = None,
    deliverables: list[str] | None = None,
) -> MikeWorkbenchExecutor:
    sandbox = _FakeSandbox(tmp_path)
    (sandbox.documents_dir / "alpha.txt").write_text(
        "Debt is $2 million. Closing date is March 15, 2027.", encoding="utf-8"
    )
    (sandbox.documents_dir / "beta.txt").write_text(
        "Fixed charge coverage ratio is 1.20x.", encoding="utf-8"
    )
    return MikeWorkbenchExecutor(
        sandbox=sandbox,
        shell_timeout=5,
        deliverables=deliverables or ["memo.docx"],
        surface_name=surface or "mike_control_v1",
        task_instructions="Extract every loan balance, ratio, and maturity date.",
    )


def test_surface_is_frozen_mike_or_a_compact_native_delta():
    inventory = [("alpha.docx", "docx")]
    control_prompt, control, frozen = get_mike_surface("mike_control_v1", inventory)
    native_prompt, native, _ = get_mike_surface(
        "mike_one_shot_native_xhigh_v1", inventory
    )
    adaptive_prompt, adaptive, _ = get_mike_surface(
        "mike_one_shot_adaptive_review_xhigh_v1", inventory
    )

    assert [tool["name"] for tool in control] == [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "generate_docx",
    ]
    assert [tool["name"] for tool in native] == ["fetch_documents", "generate_docx"]
    assert [tool["name"] for tool in adaptive] == [
        "fetch_documents",
        "generate_docx",
        "append_docx",
    ]
    assert "Successful generation" in native_prompt
    assert "CONTEXT-BUDGETED FINALIZATION" in adaptive_prompt
    assert "Never defer content" in adaptive_prompt
    assert "Successful generation" not in adaptive_prompt
    assert frozen["commit"] == "2266446b0d26f735865b8cd3bb153b28e7d11b17"


def test_native_work_product_keeps_evidence_without_forcing_citations(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_native_xhigh_v1")

    fetched = executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})

    assert "$2 million" in fetched
    assert "1.20x" in fetched
    assert "Citation requirement" not in fetched
    assert "<task_reminder source=\"original-user-request\">" in fetched


def test_adaptive_review_schema_and_prompt_are_bounded_and_append_only():
    prompt, tools, _ = get_mike_surface(
        "mike_one_shot_adaptive_review_xhigh_v1", [("alpha.docx", "docx")]
    )

    assert [tool["name"] for tool in tools] == [
        "fetch_documents",
        "generate_docx",
        "append_docx",
    ]
    assert tools[2]["parameters"]["required"] == ["filename", "markdown"]
    assert f"{ADAPTIVE_REVIEW_BUDGET_CHARACTERS:,} characters" in prompt
    assert "Never defer content" in prompt
    assert "cannot lose content" in prompt


def test_adaptive_small_context_freezes_initial_and_appends_after_next_round(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_adaptive_review_xhigh_v1"
    )
    initial_markdown = "# Findings\n\nDebt is $2 million."
    generated = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": initial_markdown},
        )
    )

    assert generated["terminal"] is False
    assert executor.get_metrics()["review_eligible"] is True
    assert executor.terminal is False
    assert not (tmp_path / "output" / "memo.docx").exists()
    same_batch = executor.execute(
        "append_docx",
        {"filename": "memo.docx", "markdown": "## Correction\n\nRatio is 1.20x."},
    )
    assert same_batch.startswith("Error:")

    executor.after_tool_batch()
    finalized = json.loads(
        executor.execute(
            "append_docx",
            {"filename": "memo.docx", "markdown": "## Correction\n\nRatio is 1.20x."},
        )
    )

    assert finalized["terminal"] is True
    final_source = (tmp_path / "workspace" / ".mike" / "final" / "memo.docx.md").read_bytes()
    initial_source = (tmp_path / "workspace" / ".mike" / "initial" / "memo.docx.md").read_bytes()
    assert final_source.startswith(initial_source)
    assert b"Ratio is 1.20x" in final_source
    metrics = executor.get_metrics()
    assert metrics["initial_draft_receipts"][0]["source_sha256"] == generated["initial_source_sha256"]
    assert metrics["initial_draft_receipts"][0]["source_sha256"] == hashlib.sha256(initial_source).hexdigest()
    assert metrics["append_receipts"][0]["final_source_sha256"] == hashlib.sha256(final_source).hexdigest()
    assert metrics["append_receipts"][0]["initial_prefix_preserved"] is True
    assert metrics["finalized_deliverables"] == ["memo.docx"]


def test_adaptive_empty_append_preserves_exact_initial_source(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_adaptive_review_xhigh_v1"
    )
    executor.execute(
        "generate_docx",
        {"title": "Memo", "markdown": "# Complete\n\nNothing omitted."},
    )
    executor.after_tool_batch()
    receipt = json.loads(
        executor.execute(
            "append_docx", {"filename": "memo.docx", "markdown": ""}
        )
    )

    assert receipt["appended_characters"] == 0
    initial_source = (tmp_path / "workspace" / ".mike" / "initial" / "memo.docx.md").read_bytes()
    final_source = (tmp_path / "workspace" / ".mike" / "final" / "memo.docx.md").read_bytes()
    assert final_source == initial_source


def test_adaptive_large_context_skips_review_and_finalizes_exact_initial(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_adaptive_review_xhigh_v1"
    )
    for path in executor._documents:
        executor._texts[path] = "x" * (ADAPTIVE_REVIEW_BUDGET_CHARACTERS // 2 + 1)

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": "# Complete\n\nNothing omitted."},
        )
    )

    assert receipt["terminal"] is True
    assert executor.terminal is True
    metrics = executor.get_metrics()
    assert metrics["review_eligible"] is False
    assert metrics["review_budget_total_characters"] > ADAPTIVE_REVIEW_BUDGET_CHARACTERS
    assert metrics["append_receipts"][0]["review_skipped"] is True
    initial = (tmp_path / "workspace" / ".mike" / "initial" / "memo.docx.md").read_bytes()
    final = (tmp_path / "workspace" / ".mike" / "final" / "memo.docx.md").read_bytes()
    assert final == initial
    assert (tmp_path / "output" / "memo.docx").exists()


def test_adaptive_large_multi_deliverable_batch_finalizes_together(tmp_path):
    executor = _executor(
        tmp_path,
        surface="mike_one_shot_adaptive_review_xhigh_v1",
        deliverables=["draft.docx", "issues.docx"],
    )
    for path in executor._documents:
        executor._texts[path] = "x" * (ADAPTIVE_REVIEW_BUDGET_CHARACTERS // 2 + 1)

    first = json.loads(
        executor.execute(
            "generate_docx", {"title": "Draft", "markdown": "# Draft\n\nComplete."}
        )
    )
    second = json.loads(
        executor.execute(
            "generate_docx", {"title": "Issues", "markdown": "# Issues\n\nComplete."}
        )
    )

    assert first["terminal"] is False
    assert second["terminal"] is True
    assert executor.terminal is True
    assert (tmp_path / "output" / "draft.docx").exists()
    assert (tmp_path / "output" / "issues.docx").exists()
    assert executor.get_metrics()["finalized_deliverables"] == [
        "draft.docx",
        "issues.docx",
    ]


def test_mike_batch_read_duplicate_guard_search_and_terminal_generation(tmp_path):
    executor = _executor(tmp_path)
    inventory = json.loads(executor.execute("list_documents", {}))
    assert [item["filename"] for item in inventory] == ["alpha.txt", "beta.txt"]

    fetched = executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})
    assert "$2 million" in fetched
    assert "1.20x" in fetched
    duplicate = json.loads(executor.execute("read_document", {"doc_id": "doc-0"}))
    assert duplicate["already_read"] is True
    found = json.loads(
        executor.execute(
            "find_in_document",
            {"doc_id": "doc-0", "query": "March 15, 2027"},
        )
    )
    assert found["total_matches"] == 1

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {
                "title": "Memo",
                "sections": [{"heading": "Conclusion", "level": 1, "content": "Done."}],
            },
        )
    )
    assert receipt == {
        "filename": "memo.docx",
        "message": "Document 'memo.docx' has been generated successfully.",
        "terminal": True,
    }
    assert executor.terminal is True
    assert (tmp_path / "output" / "memo.docx").exists()


def test_one_shot_fetch_repeats_exact_request_after_complete_evidence(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_native_xhigh_v1")

    partial = executor.execute("fetch_documents", {"doc_ids": ["doc-0"]})
    assert "<task_reminder" not in partial
    complete = executor.execute("fetch_documents", {"doc_ids": ["doc-1"]})

    assert "1.20x" in complete
    assert "<task_reminder source=\"original-user-request\">" in complete
    assert "Extract every loan balance, ratio, and maturity date." in complete
    assert complete.rstrip().endswith("Now produce every requested deliverable together.")

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": "# Conclusion\n\nComplete."},
        )
    )
    assert receipt["terminal"] is True


class _OneCallAdapter:
    def make_system_message(self, content):
        return {"role": "system", "content": content}

    def make_user_message(self, content):
        return {"role": "user", "content": content}

    def chat(self, messages, tools):
        return ModelResponse(
            message={"role": "assistant"},
            tool_calls=[ToolCall(id="call-1", name="finish", arguments="{}")],
            input_tokens=10,
            output_tokens=2,
        )

    def make_tool_result_messages(self, results):
        return [{"role": "tool", "content": result} for _, result in results]


class _TerminalExecutor:
    terminal = False

    def execute(self, name, arguments):
        self.terminal = True
        return "ok"

    def get_metrics(self):
        return {}


def test_agent_loop_stops_cleanly_on_terminal_tool():
    result = run_agent(
        adapter=_OneCallAdapter(),
        system_prompt="system",
        user_prompt="user",
        tool_executor=_TerminalExecutor(),
        tools=[],
        max_turns=10,
    )

    assert result["turn_count"] == 1
    assert result["finished_cleanly"] is True
    assert result["finish_summary"] == "terminal_tool"
