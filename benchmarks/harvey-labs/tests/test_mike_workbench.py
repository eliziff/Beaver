import json
import shlex
from dataclasses import dataclass
from pathlib import Path

from harness.adapters.base import ModelResponse, ToolCall
from harness.agent_loop import run_agent
from harness.mike_workbench import (
    ANCHOR_STDIN,
    MikeWorkbenchExecutor,
    _run_typescript,
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
    anchor: bool = False,
    surface: str | None = None,
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
        deliverables=["memo.docx"],
        anchor_enabled=anchor,
        surface_name=surface or ("mike_workbench_anchor_v1" if anchor else "mike_workbench_v1"),
        task_instructions="Extract every loan balance, ratio, and maturity date.",
    )


def test_surface_is_frozen_mike_plus_only_registered_deltas():
    inventory = [("alpha.docx", "docx")]
    control_prompt, control, frozen = get_mike_surface("mike_control_v1", inventory)
    workbench_prompt, workbench, _ = get_mike_surface("mike_workbench_v1", inventory)
    anchor_prompt, anchor, _ = get_mike_surface("mike_workbench_anchor_v1", inventory)

    assert [tool["name"] for tool in control] == [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "generate_docx",
    ]
    assert [tool["name"] for tool in workbench] == [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "bash",
        "generate_docx",
    ]
    assert [tool["name"] for tool in anchor] == [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "bash",
        "generate_docx",
    ]
    assert "ANALYST WORKBENCH" not in control_prompt
    assert "ANALYST WORKBENCH" in workbench_prompt
    assert "BOUNDED DETERMINISTIC REVIEW" in anchor_prompt
    assert frozen["commit"] == "2266446b0d26f735865b8cd3bb153b28e7d11b17"


def test_one_shot_surfaces_share_exact_two_tool_prompt_and_schema():
    inventory = [("alpha.docx", "docx"), ("beta.xlsx", "xlsx")]
    plain_prompt, plain_tools, _ = get_mike_surface("mike_one_shot_v1", inventory)
    xhigh_prompt, xhigh_tools, _ = get_mike_surface(
        "mike_one_shot_xhigh_v1", inventory
    )
    index_prompt, index_tools, _ = get_mike_surface(
        "mike_one_shot_fact_index_xhigh_v1", inventory
    )

    assert plain_prompt == xhigh_prompt == index_prompt
    assert plain_tools == xhigh_tools == index_tools
    assert [tool["name"] for tool in plain_tools] == [
        "fetch_documents",
        "generate_docx",
    ]
    assert "markdown" in plain_tools[1]["parameters"]["required"]
    assert "sections" not in plain_tools[1]["parameters"]["properties"]
    assert "AVAILABLE DOCUMENTS" in plain_prompt
    assert "ANALYST WORKBENCH" not in plain_prompt


def test_conflict_first_changes_only_the_prompt():
    inventory = [("alpha.docx", "docx")]
    base_prompt, base_tools, _ = get_mike_surface("mike_one_shot_xhigh_v1", inventory)
    conflict_prompt, conflict_tools, _ = get_mike_surface(
        "mike_one_shot_conflict_first_xhigh_v1", inventory
    )

    assert conflict_tools == base_tools
    assert "ATTENTION BUDGET" not in base_prompt
    assert "ATTENTION BUDGET" in conflict_prompt
    assert conflict_prompt.endswith(base_prompt[base_prompt.index("\n\nAVAILABLE DOCUMENTS:"):])


def test_native_work_product_keeps_evidence_without_forcing_citations(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_native_xhigh_v1")

    fetched = executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})

    assert "$2 million" in fetched
    assert "1.20x" in fetched
    assert "Citation requirement" not in fetched
    assert "<task_reminder source=\"original-user-request\">" in fetched


def test_quote_first_schema_puts_private_grounding_before_markdown():
    prompt, tools, _ = get_mike_surface(
        "mike_one_shot_quote_first_xhigh_v1", [("alpha.docx", "docx")]
    )

    assert [tool["name"] for tool in tools] == ["fetch_documents", "generate_docx"]
    properties = tools[1]["parameters"]["properties"]
    assert list(properties)[0] == "grounding"
    assert "grounding" in tools[1]["parameters"]["required"]
    assert "PRIVATE QUOTE-FIRST GROUNDING" in prompt


def test_quote_first_verifies_private_quotes_without_inserting_them(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_quote_first_xhigh_v1")
    executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})

    receipt = json.loads(
        executor.execute(
            "generate_docx",
            {
                "grounding": [
                    {
                        "source": "alpha.txt",
                        "quote": "Closing date is March 15, 2027.",
                        "supports": "The closing date is March 15, 2027.",
                    },
                    {
                        "source": "beta.txt",
                        "quote": "This text is absent.",
                        "supports": "An intentionally unverified claim.",
                    },
                ],
                "title": "Memo",
                "markdown": "# Conclusion\n\nComplete.",
            },
        )
    )

    assert receipt["terminal"] is True
    draft = (tmp_path / "workspace" / ".mike" / "draft-1.md").read_text()
    assert "March 15, 2027" not in draft
    metrics = executor.get_metrics()
    assert metrics["grounding_claims"] == 2
    assert metrics["grounding_verified"] == 1
    assert metrics["grounding_unverified"] == 1
    assert metrics["grounding_receipts"][0]["locator"]
    assert metrics["grounding_receipts"][1]["locator"] is None


def test_quote_first_rejects_an_empty_private_ledger(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_quote_first_xhigh_v1")

    result = executor.execute(
        "generate_docx",
        {"grounding": [], "title": "Memo", "markdown": "# Conclusion\n\nComplete."},
    )

    assert result.startswith("Error: grounding")
    assert not (tmp_path / "output" / "memo.docx").exists()


def test_monotonic_review_schema_and_prompt_are_append_only():
    prompt, tools, _ = get_mike_surface(
        "mike_one_shot_monotonic_review_xhigh_v1", [("alpha.docx", "docx")]
    )

    assert [tool["name"] for tool in tools] == [
        "fetch_documents",
        "generate_docx",
        "append_docx",
    ]
    assert tools[2]["parameters"]["required"] == ["filename", "markdown"]
    assert "ONE OMISSIONS-ONLY REVIEW" in prompt
    assert "cannot lose content" in prompt


def test_monotonic_review_freezes_initial_and_only_appends_after_next_round(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_monotonic_review_xhigh_v1"
    )
    initial_markdown = "# Findings\n\nDebt is $2 million."
    generated = json.loads(
        executor.execute(
            "generate_docx",
            {"title": "Memo", "markdown": initial_markdown},
        )
    )

    assert generated["terminal"] is False
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
    final_source = (tmp_path / "workspace" / ".mike" / "final" / "memo.docx.md").read_text()
    initial_source = (tmp_path / "workspace" / ".mike" / "initial" / "memo.docx.md").read_text()
    assert final_source.startswith(initial_source.rstrip())
    assert "Ratio is 1.20x" in final_source
    metrics = executor.get_metrics()
    assert metrics["initial_draft_receipts"][0]["source_sha256"] == generated["initial_source_sha256"]
    assert metrics["append_receipts"][0]["initial_prefix_preserved"] is True
    assert metrics["finalized_deliverables"] == ["memo.docx"]


def test_monotonic_review_empty_append_preserves_exact_initial_source(tmp_path):
    executor = _executor(
        tmp_path, surface="mike_one_shot_monotonic_review_xhigh_v1"
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
    initial_source = (tmp_path / "workspace" / ".mike" / "initial" / "memo.docx.md").read_text()
    final_source = (tmp_path / "workspace" / ".mike" / "final" / "memo.docx.md").read_text()
    assert final_source == initial_source


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
    executor = _executor(tmp_path, surface="mike_one_shot_v1")

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


def test_fact_index_is_bounded_source_only_and_in_band(tmp_path):
    executor = _executor(tmp_path, surface="mike_one_shot_fact_index_xhigh_v1")
    fetched = executor.execute("fetch_documents", {"doc_ids": ["doc-0", "doc-1"]})

    assert "<deterministic_source_index" in fetched
    assert "</deterministic_source_index>" in fetched
    assert fetched.index("<deterministic_source_index") < fetched.index("<task_reminder")
    metrics = executor.get_metrics()
    assert metrics["source_fact_index_calls"] == 1
    assert metrics["source_fact_index_characters"] <= 6000
    assert metrics["source_fact_index_sha256"]


def test_fact_index_bound_keeps_packet_closed(tmp_path, monkeypatch):
    executor = _executor(tmp_path, surface="mike_one_shot_fact_index_xhigh_v1")
    for path in executor._documents:
        executor._texts[path] = "source text"

    rows = [
        {
            "cls": "money",
            "display": f"${index} million",
            "documents": ["alpha.txt"],
            "excerpt": "material context " * 500,
        }
        for index in range(8)
    ]
    monkeypatch.setattr(
        "harness.mike_workbench._run_typescript",
        lambda *args, **kwargs: json.dumps(
            {"relevant_or_repeated_source_anchors_missing_from_draft": rows}
        ),
    )

    packet = executor._source_fact_index()

    assert len(packet) <= 6000
    assert packet.endswith("</deterministic_source_index>")
    assert executor.get_metrics()["source_fact_index_rows"] == 0


def test_bash_materializes_exact_mike_normalized_sources_once(tmp_path):
    executor = _executor(tmp_path)

    executor.execute("bash", {"command": "true"})
    manifest_path = tmp_path / "workspace" / ".mike" / "sources" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert [entry["doc_id"] for entry in manifest] == ["doc-0", "doc-1"]
    assert manifest[0]["parser"] == "plain-text"
    assert (tmp_path / "workspace" / ".mike" / "sources" / "alpha.txt.txt").read_text(
        encoding="utf-8"
    ).startswith("Debt is $2 million")

    executor.execute("bash", {"command": "true"})
    assert executor.get_metrics()["analysis_sources_materialized"] is True
    assert len(executor.get_metrics()["parse_receipts"]) == 2


def test_compiler_review_reuses_normalized_text_and_allows_second_submission(tmp_path, monkeypatch):
    executor = _executor(tmp_path, anchor=True)
    observed = {}

    def fake_run(script, payload=None, timeout=90):
        if script.name == "lab-upstream-parse-stdin.ts":
            text = Path(payload["path"]).read_text(encoding="utf-8")
            return json.dumps(
                {
                    "text": text,
                    "parser": "plain-text",
                    "parser_version": 1,
                    "text_chars": len(text),
                    "text_sha256": "fixture",
                }
            )
        observed.update(payload)
        return '{"status":"review_required","relevant_or_repeated_source_anchors_missing_from_draft":[{"display":"$2 million"}]}'

    monkeypatch.setattr("harness.mike_workbench._run_typescript", fake_run)
    arguments = {
        "title": "Memo",
        "sections": [{"heading": "Conclusion", "level": 1, "content": "Done."}],
    }
    output = executor.execute("generate_docx", arguments)

    assert "$2 million" in output
    assert observed["compiler_review"] is True
    assert observed["attention_text"].startswith("Extract every loan balance")
    assert observed["drafts"][0]["text"] == "# Conclusion\n\nDone."
    assert {source["name"] for source in observed["sources"]} == {
        "alpha.txt",
        "beta.txt",
    }
    assert not (tmp_path / "output" / "memo.docx").exists()

    same_batch = executor.execute("generate_docx", arguments)
    assert same_batch == output
    assert not (tmp_path / "output" / "memo.docx").exists()

    executor.after_tool_batch()
    receipt = json.loads(executor.execute("generate_docx", arguments))
    assert receipt["terminal"] is True
    assert (tmp_path / "output" / "memo.docx").exists()
    metrics = executor.get_metrics()
    assert metrics["compiler_review_calls"] == 1
    assert metrics["compiler_review_result_characters"] == len(output)


def test_compiler_flags_same_anchor_under_uncovered_source_context():
    review = json.loads(
        _run_typescript(
            ANCHOR_STDIN,
            {
                "sources": [
                    {
                        "name": "agreement.txt",
                        "text": (
                            "Interest payment defaults have a grace period of five Business Days. "
                            "A pro forma compliance certificate is due five Business Days before an acquisition."
                        ),
                    }
                ],
                "drafts": [
                    {
                        "name": "draft.txt",
                        "text": "Deliver the compliance certificate five Business Days before an acquisition.",
                    }
                ],
                "compiler_review": True,
                "attention_text": "Report payment defaults and acquisition conditions.",
            },
        )
    )

    candidates = review["repeated_anchor_contexts_not_evidenced_in_draft"]
    five_days = next(row for row in candidates if "five Business Days" in row["display"])
    assert five_days["source_occurrences"] == 2
    assert five_days["draft_occurrences"] == 1
    assert five_days["uncovered_source_contexts"] == 1
    assert "Interest payment defaults" in five_days["contexts"][0]["excerpt"]


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
