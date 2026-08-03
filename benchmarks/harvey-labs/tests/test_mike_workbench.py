import json
import shlex
from dataclasses import dataclass
from pathlib import Path

from harness.adapters.base import ModelResponse, ToolCall
from harness.adapters.openai import OpenAIAdapter
from harness.agent_loop import run_agent
from harness.mike_workbench import (
    FINAL_CHECK_INSTRUCTION,
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


def _linked_grounding() -> list[dict]:
    return [
        {
            "id": "G1",
            "source": "alpha.txt",
            "quote": "Debt is $2 million.",
            "supports": "The reported debt is $2 million.",
        },
        {
            "id": "G2",
            "source": "alpha.txt",
            "quote": "Closing date is March 15, 2027.",
            "supports": "The closing date is March 15, 2027.",
        },
        {
            "id": "G3",
            "source": "beta.txt",
            "quote": "Fixed charge coverage ratio is 1.20x.",
            "supports": "The fixed charge coverage ratio is 1.20x.",
        },
        {
            "id": "G4",
            "source": "alpha.txt",
            "quote": "Debt is $2 million. Closing date is March 15, 2027.",
            "supports": "The debt and closing date are both source-reported.",
        },
    ]


def test_surface_is_frozen_mike_or_a_compact_native_delta():
    inventory = [("alpha.docx", "docx")]
    control_prompt, control, frozen = get_mike_surface("mike_control_v1", inventory)
    native_prompt, native, _ = get_mike_surface(
        "mike_one_shot_native_xhigh_v1", inventory
    )
    linked_prompt, linked, _ = get_mike_surface(
        "mike_one_shot_linked_grounding_xhigh_v1", inventory
    )
    final_check_prompt, final_check, _ = get_mike_surface(
        "mike_one_shot_final_check_xhigh_v1", inventory
    )

    assert [tool["name"] for tool in control] == [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "generate_docx",
    ]
    assert [tool["name"] for tool in native] == ["fetch_documents", "generate_docx"]
    assert [tool["name"] for tool in linked] == ["fetch_documents", "generate_docx"]
    assert [tool["name"] for tool in final_check] == [
        "fetch_documents",
        "generate_docx",
    ]
    assert final_check == native
    grounding = linked[1]["parameters"]["properties"]["grounding"]
    assert grounding["minItems"] == 4
    assert grounding["maxItems"] == 12
    assert linked[1]["parameters"]["required"][0] == "grounding"
    assert "Successful generation" in native_prompt
    assert "Successful generation" not in final_check_prompt
    assert FINAL_CHECK_INSTRUCTION not in final_check_prompt
    assert "GROUNDING:" in native_prompt
    assert "GROUNDING:" not in control_prompt
    assert "PRIVATE LINKED GROUNDING" in linked_prompt
    assert "[[G1]]" in linked_prompt
    assert frozen["commit"] == "2266446b0d26f735865b8cd3bb153b28e7d11b17"


def test_native_work_product_keeps_evidence_without_forcing_citations(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_native_xhigh_v1")

    fetched = executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})

    assert "$2 million" in fetched
    assert "1.20x" in fetched
    assert "Citation requirement" not in fetched
    assert "<task_reminder source=\"original-user-request\">" in fetched


def test_linked_grounding_verifies_links_and_strips_private_markers(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_linked_grounding_xhigh_v1"
    )
    markdown = """# Findings

Debt is $2 million. [[G1]]
Closing is March 15, 2027. [[G2]]
The fixed charge coverage ratio is 1.20x. [[G3]]
Both debt and closing require attention. [[G4]]"""

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "grounding": _linked_grounding(), "markdown": markdown},
        )
    )

    assert receipt["terminal"] is True
    persisted = (tmp_path / "workspace" / ".mike" / "draft-1.md").read_text(
        encoding="utf-8"
    )
    assert "[[G" not in persisted
    metrics = executor.get_metrics()
    assert metrics["grounding_attempts"] == 1
    assert metrics["grounding_claims"] == 4
    assert metrics["grounding_verified"] == 4
    assert metrics["grounding_linked"] == 4
    assert metrics["grounding_private_characters"] > 0


def test_linked_grounding_fails_closed_on_elision_or_broken_links(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_linked_grounding_xhigh_v1"
    )
    grounding = _linked_grounding()
    grounding[0]["quote"] = "Debt ... $2 million."
    grounding[3]["quote"] = "This wording is not in the source."

    result = executor.execute(
        "generate_docx",
        {
            "title": "Memo",
            "grounding": grounding,
            "markdown": "G1 [[G1]] G2 [[G2]] G3 [[G3]] unknown [[G9]]",
        },
    )

    assert result.startswith("Error: linked grounding invalid:")
    assert "quote_has_ellipsis" in result
    assert "quote_not_verbatim" in result
    assert "marker_count" in result
    assert not (tmp_path / "output" / "memo.docx").exists()
    metrics = executor.get_metrics()
    assert metrics["grounding_attempts"] == 1
    assert metrics["grounding_unverified"] == 2
    assert metrics["grounding_unlinked"] == 1


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


def test_final_check_is_a_fresh_turn_and_can_preserve_the_initial_work(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_final_check_xhigh_v1"
    )

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": "# Conclusion\n\nComplete."},
        )
    )

    assert receipt["terminal"] is False
    assert receipt["final_check_follows"] is True
    assert 'Current title(s): "Memo".' in receipt["revision_protocol"]
    assert executor.terminal is False
    assert executor.pop_followup_message() is None

    executor.after_tool_batch()
    followup = executor.pop_followup_message()
    assert followup == FINAL_CHECK_INSTRUCTION

    metrics = executor.get_metrics()
    assert metrics["final_check_enabled"] is True
    assert metrics["final_check_pending_without_revision"] is True
    assert metrics["final_check_revisions"] == 0
    assert len(metrics["initial_draft_receipts"]) == 1
    assert (tmp_path / "output" / "memo.docx").read_bytes() == b"PK\x03\x04test-docx"
    assert (
        tmp_path / "workspace" / ".mike" / "initial-output" / "memo.docx"
    ).read_bytes() == b"PK\x03\x04test-docx"


def test_final_check_replaces_only_the_named_original_title(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_final_check_xhigh_v1"
    )
    executor.execute(
        "generate_docx",
        {"title": "Memo", "markdown": "# Conclusion\n\nInitial."},
    )
    executor.after_tool_batch()
    executor.pop_followup_message()

    wrong = executor.execute(
        "generate_docx",
        {"title": "Different title", "markdown": "# Conclusion\n\nChanged."},
    )
    assert wrong == "Error: final-check revision must use exactly the original title"

    revised = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": "# Conclusion\n\nCorrected."},
        )
    )
    assert revised["filename"] == "memo.docx"
    assert revised["changed"] is True
    executor.after_tool_batch()

    assert executor.terminal is True
    persisted = (tmp_path / "workspace" / ".mike" / "final-check-1.md").read_text(
        encoding="utf-8"
    )
    assert "Corrected." in persisted
    metrics = executor.get_metrics()
    assert metrics["final_check_revision_attempts"] == 2
    assert metrics["final_check_revisions"] == 1
    assert metrics["final_check_changed"] == 1


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


class _FinalCheckAdapter(_OneCallAdapter):
    def __init__(self):
        self.calls = 0
        self.review_messages = None

    def chat(self, messages, tools):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(
                message={"role": "assistant"},
                tool_calls=[
                    ToolCall(
                        id="draft",
                        name="generate_docx",
                        arguments=json.dumps(
                            {"title": "Memo", "markdown": "# Conclusion\n\nComplete."}
                        ),
                    )
                ],
            )
        self.review_messages = list(messages)
        return ModelResponse(
            message={"role": "assistant", "content": "No correction needed."},
            text="No correction needed.",
        )


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


def test_agent_loop_injects_final_check_as_a_fresh_user_turn(tmp_path):
    adapter = _FinalCheckAdapter()
    executor = _executor(
        tmp_path, surface="mike_one_shot_final_check_xhigh_v1"
    )

    result = run_agent(
        adapter=adapter,
        system_prompt="system",
        user_prompt="request",
        tool_executor=executor,
        tools=[],
        max_turns=3,
    )

    assert result["turn_count"] == 2
    assert result["finished_cleanly"] is True
    assert result["finish_summary"] is None
    assert adapter.review_messages[-1]["role"] == "user"
    assert adapter.review_messages[-1]["content"] == FINAL_CHECK_INSTRUCTION


def test_openai_followup_user_turn_reaches_stateful_responses_context():
    adapter = OpenAIAdapter.__new__(OpenAIAdapter)
    adapter._context = []

    message = adapter.make_followup_user_message(FINAL_CHECK_INSTRUCTION)

    assert message == {"role": "user", "content": FINAL_CHECK_INSTRUCTION}
    assert adapter._context == [
        {
            "type": "message",
            "role": "user",
            "content": FINAL_CHECK_INSTRUCTION,
        }
    ]
