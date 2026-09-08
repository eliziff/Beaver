"""Offline pipeline contracts and the unchanged, explicitly opted-in Podman tests."""

import json
import os
from pathlib import Path
from unittest.mock import Mock

import pytest

from evaluation.judge import Judge, PROMPTS_DIR
from harness.adapters.anthropic import AnthropicAdapter
from harness.adapters.google import GoogleAdapter
from harness.adapters.openai import OpenAIAdapter
from harness.run import _load_env, create_adapter, load_task
from harness.tools import get_all_tool_definitions


@pytest.fixture
def tmp_env_file(tmp_path, monkeypatch):
    monkeypatch.setattr("harness.run.BENCH_ROOT", tmp_path)
    env = tmp_path / ".env"
    env.write_text(
        "ANTHROPIC_API_KEY=sk-test-123\nOPENAI_API_KEY=sk-test-456\n"
        "GOOGLE_API_KEY=test-google-789\n# This is a comment\n\n",
        encoding="utf-8",
    )
    return env


class TestEnvLoading:
    def test_load_env_sets_keys(self, tmp_env_file, monkeypatch):
        monkeypatch.setattr(os, "environ", {})
        _load_env()
        assert os.environ == {
            "ANTHROPIC_API_KEY": "sk-test-123",
            "OPENAI_API_KEY": "sk-test-456",
            "GOOGLE_API_KEY": "test-google-789",
        }

    def test_load_env_does_not_override_existing(self, tmp_env_file, monkeypatch):
        monkeypatch.setattr(os, "environ", {})
        os.environ["ANTHROPIC_API_KEY"] = "already-set"
        _load_env()
        assert os.environ == {
            "ANTHROPIC_API_KEY": "already-set",
            "OPENAI_API_KEY": "sk-test-456",
            "GOOGLE_API_KEY": "test-google-789",
        }

    def test_load_env_missing_file(self, tmp_env_file, monkeypatch):
        monkeypatch.setattr(os, "environ", {})
        tmp_env_file.unlink()
        os.environ["EXISTING"] = "untouched"
        _load_env()
        assert os.environ == {"EXISTING": "untouched"}


class TestTaskLoading:
    def test_load_task_returns_expected_keys(self, rubric_run):
        assert set(load_task(rubric_run.task)) == {
            "name",
            "task_dir",
            "docs_dir",
            "instructions",
            "config",
        }

    def test_load_task_docs_dir_exists(self, rubric_run):
        task = load_task(rubric_run.task)
        assert task["docs_dir"] == str(rubric_run.task_dir / "documents")
        assert (Path(task["docs_dir"]) / "sample.txt").read_text(
            encoding="utf-8"
        ) == "Sample document — café."

    def test_load_task_reads_task_json_as_utf8(self, rubric_run, monkeypatch):
        read_text = Path.read_text

        def strict_read_text(path, encoding=None, **kwargs):
            if encoding is None:
                raise UnicodeDecodeError("charmap", b"\x90", 0, 1, "no explicit encoding")
            return read_text(path, encoding=encoding, **kwargs)

        monkeypatch.setattr(Path, "read_text", strict_read_text)
        assert load_task(rubric_run.task)["config"] == rubric_run.config

    def test_load_task_two_part_name_required(self, rubric_run):
        with pytest.raises(ValueError, match="at least 2 parts") as error:
            load_task("only-one-part")
        assert "only-one-part" in str(error.value)

    def test_load_task_instructions_loaded(self, rubric_run):
        assert load_task(rubric_run.task)["instructions"] == (
            "Analyze the sample documents and produce a detailed memo."
        )


@pytest.fixture
def clients(monkeypatch):
    clients = [Mock(), Mock(), Mock()]
    for path, client in zip(
        [
            "harness.adapters.anthropic.anthropic.Anthropic",
            "harness.adapters.openai.openai.OpenAI",
            "harness.adapters.google.genai.Client",
        ],
        clients,
        strict=True,
    ):
        monkeypatch.setattr(path, client)
    return clients


@pytest.mark.parametrize(
    "model,adapter_type,model_id",
    [
        pytest.param(
            "claude-sonnet-4-6",
            AnthropicAdapter,
            "claude-sonnet-4-6",
            id="test_create_anthropic_adapter",
        ),
        pytest.param("gpt-5.4", OpenAIAdapter, "gpt-5.4", id="test_create_openai_adapter"),
        pytest.param(
            "gemini-3.1-pro-preview",
            GoogleAdapter,
            "gemini-3.1-pro-preview",
            id="test_create_google_adapter",
        ),
        pytest.param(
            "anthropic/claude-sonnet-4-6",
            AnthropicAdapter,
            "claude-sonnet-4-6",
            id="test_create_with_provider_prefix",
        ),
    ],
)
def test_adapter_creation(clients, model, adapter_type, model_id):
    adapter = create_adapter(model, temperature=0.25, reasoning_effort="high")
    assert (type(adapter), adapter.model, adapter.temperature, adapter.reasoning_effort) == (
        adapter_type,
        model_id,
        0.25,
        "high",
    )


def test_create_unknown_raises(clients):
    with pytest.raises(ValueError, match="Can't determine provider"):
        create_adapter("unknown-model-xyz")
    for client in clients:
        client.assert_not_called()


class TestToolDefinitions:
    def test_all_tools_have_required_fields(self):
        for tool in get_all_tool_definitions():
            assert set(tool) == {"name", "description", "parameters"}, tool["name"]
            assert tool["description"].strip(), tool["name"]
            assert tool["parameters"]["type"] == "object", tool["name"]
            assert isinstance(tool["parameters"]["properties"], dict), tool["name"]

    def test_expected_tools_present(self):
        assert [tool["name"] for tool in get_all_tool_definitions()] == [
            "bash",
            "read",
            "write",
            "edit",
            "glob",
            "grep",
        ]


@pytest.mark.parametrize(
    "text,expected",
    [
        pytest.param(
            'Here is my analysis:\n```json\n{"verdict": "pass"}\n```',
            {"verdict": "pass"},
            id="test_parse_json_from_fences",
        ),
        pytest.param(
            '{"verdict": "fail", "reasoning": "Not supported"}',
            {"verdict": "fail", "reasoning": "Not supported"},
            id="test_parse_json_bare",
        ),
    ],
)
def test_judge_parse_json(text, expected):
    assert Judge._parse_json(text) == expected


def test_parse_json_no_json_raises():
    with pytest.raises(ValueError, match="No JSON found"):
        Judge._parse_json("This has no JSON at all")


def test_evaluate_calls_client(clients):
    from types import SimpleNamespace

    judge = Judge(model="claude-sonnet-4-6")
    judge.client.messages.create.return_value = SimpleNamespace(
        stop_reason="end_turn",
        content=[SimpleNamespace(text='{"verdict": "pass"}')],
    )
    assert judge.evaluate("Is {thing} good?", {"thing": "pizza"}) == {"verdict": "pass"}
    judge.client.messages.create.assert_called_once()
    kwargs = judge.client.messages.create.call_args.kwargs
    assert kwargs["model"] == "claude-sonnet-4-6"
    assert kwargs["messages"] == [{"role": "user", "content": "Is pizza good?"}]


def test_only_expected_prompts():
    assert sorted(path.name for path in PROMPTS_DIR.glob("*.txt")) == ["rubric_criterion.txt"]


@pytest.mark.podman
class TestToolExecution:
    def test_glob(self, tool_executor):
        result = tool_executor.execute("glob", '{"pattern": "**/*.txt"}')
        assert "test_doc.txt" in result
        assert "agreement.txt" in result

    def test_glob_subdir(self, tool_executor):
        result = tool_executor.execute("glob", '{"pattern": "*.txt", "path": "01-corporate"}')
        assert "test_doc.txt" in result

    def test_glob_no_matches(self, tool_executor):
        result = tool_executor.execute("glob", '{"pattern": "*.xyz"}')
        assert "No files matching" in result

    def test_read(self, tool_executor):
        result = tool_executor.execute("read", '{"file_path": "01-corporate/test_doc.txt"}')
        assert "merger" in result

    def test_read_tracks_reads(self, tool_executor):
        tool_executor.execute("read", '{"file_path": "01-corporate/test_doc.txt"}')
        assert len(tool_executor.files_read) == 1

    def test_read_missing(self, tool_executor):
        result = tool_executor.execute("read", '{"file_path": "nonexistent.txt"}')
        assert "Error" in result

    def test_bash_basic(self, tool_executor):
        result = tool_executor.execute("bash", '{"command": "echo hello"}')
        assert "hello" in result

    def test_bash_env_vars(self, tool_executor):
        result = tool_executor.execute("bash", '{"command": "echo $OUTPUT_DIR"}')
        # Inside the sandbox, $OUTPUT_DIR is the canonical sandbox path,
        # not the host bind-mount source.
        assert "/workspace/output" in result

    def test_bash_documents_env(self, tool_executor):
        result = tool_executor.execute("bash", '{"command": "echo $DOCUMENTS_DIR"}')
        assert "/workspace/documents" in result

    def test_bash_tracks_count(self, tool_executor):
        tool_executor.execute("bash", '{"command": "true"}')
        assert tool_executor.bash_command_count == 1

    def test_bash_timeout(self, documents_dir, output_dir):
        from tests.conftest import _PODMAN_REACHABLE
        if not _PODMAN_REACHABLE:
            import pytest
            pytest.skip("podman not reachable")
        from harness.tools import ToolExecutor
        te = ToolExecutor(documents_dir=str(documents_dir), output_dir=str(output_dir), shell_timeout=1)
        try:
            result = te.execute("bash", '{"command": "sleep 10"}')
            assert "timed out" in result
        finally:
            te.close()

    def test_write(self, tool_executor, output_dir):
        result = tool_executor.execute("write", '{"file_path": "out.json", "content": "[1,2,3]"}')
        assert "Wrote" in result
        assert (output_dir / "out.json").read_text() == "[1,2,3]"

    def test_edit(self, tool_executor, output_dir):
        (output_dir / "edit_test.txt").write_text("hello world")
        result = tool_executor.execute("edit", '{"file_path": "edit_test.txt", "old_string": "hello", "new_string": "goodbye"}')
        assert "Replaced" in result
        assert (output_dir / "edit_test.txt").read_text() == "goodbye world"

    def test_grep(self, tool_executor):
        result = tool_executor.execute("grep", '{"pattern": "merger", "output_mode": "content"}')
        assert "merger" in result

    def test_unknown_tool(self, tool_executor):
        result = tool_executor.execute("nonexistent_tool", '{}')
        assert "Error: unknown tool" in result

    def test_invalid_json_arguments(self, tool_executor):
        result = tool_executor.execute("bash", "not json at all")
        assert "Error" in result

    def test_get_metrics(self, tool_executor):
        tool_executor.execute("read", '{"file_path": "01-corporate/test_doc.txt"}')
        metrics = tool_executor.get_metrics()
        assert metrics["documents_read"] == 1
        assert metrics["total_documents"] == 3  # test_doc.txt, another.txt, agreement.txt

    def test_get_metrics_no_reads(self, tool_executor):
        metrics = tool_executor.get_metrics()
        assert metrics["documents_read"] == 0
        assert metrics["documents_skipped"] == 3


@pytest.mark.podman
class TestAgentLoop:
    def test_single_turn_no_tools(self, mock_adapter, tool_executor):
        """Agent returns text only — loop should exit after 1 turn."""
        from harness.agent_loop import run_agent
        result = run_agent(mock_adapter, "system prompt", "begin task", tool_executor, max_turns=10)
        assert result["turn_count"] == 1
        assert result["finished_cleanly"] is True  # No tool calls = done
        assert result["input_tokens"] == 100
        assert result["output_tokens"] == 50

    def test_tool_call_then_done(self, mock_adapter, tool_executor):
        """Agent calls a tool, then returns no tool calls (done)."""
        from harness.agent_loop import run_agent
        from harness.adapters.base import ModelResponse, ToolCall

        call_count = [0]

        def mock_chat(messages, tools):
            call_count[0] += 1
            if call_count[0] == 1:
                return ModelResponse(
                    message={"role": "assistant", "content": [
                        {"type": "tool_use", "id": "tc1", "name": "glob",
                         "input": {"pattern": "**/*"}},
                    ]},
                    tool_calls=[ToolCall(id="tc1", name="glob",
                                        arguments='{"pattern": "**/*"}')],
                    text="",
                    input_tokens=100, output_tokens=20,
                )
            else:
                return ModelResponse(
                    message={"role": "assistant", "content": [{"type": "text", "text": "Done."}]},
                    tool_calls=[], text="Done.",
                    input_tokens=200, output_tokens=30,
                )

        mock_adapter.chat.side_effect = mock_chat
        mock_adapter.make_tool_result_messages.return_value = [
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tc1", "content": "result"}]}
        ]

        result = run_agent(mock_adapter, "system", "begin task", tool_executor, max_turns=10)
        assert result["turn_count"] == 2
        assert result["finished_cleanly"] is True
        assert result["input_tokens"] == 300

    def test_max_turns_limit(self, mock_adapter, tool_executor):
        """Agent that always calls tools should be stopped at max_turns."""
        from harness.agent_loop import run_agent
        from harness.adapters.base import ModelResponse, ToolCall

        mock_adapter.chat.return_value = ModelResponse(
            message={"role": "assistant", "content": [
                {"type": "tool_use", "id": "tc1", "name": "glob",
                 "input": {"pattern": "**/*"}},
            ]},
            tool_calls=[ToolCall(id="tc1", name="glob",
                                 arguments='{"pattern": "**/*"}')],
            text="", input_tokens=10, output_tokens=5,
        )
        mock_adapter.make_tool_result_messages.return_value = [
            {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tc1", "content": "ok"}]}
        ]

        result = run_agent(mock_adapter, "system", "begin task", tool_executor, max_turns=3)
        assert result["turn_count"] == 3
        assert result["finished_cleanly"] is False

    def test_transcript_written(self, mock_adapter, tool_executor, tmp_path):
        """Transcript JSONL should be written when path is provided."""
        from harness.agent_loop import run_agent

        transcript = tmp_path / "transcript.jsonl"
        run_agent(mock_adapter, "system", "begin task", tool_executor,
                  max_turns=1, transcript_path=str(transcript))
        assert transcript.exists()
        lines = transcript.read_text().strip().split("\n")
        assert len(lines) >= 1
        entry = json.loads(lines[0])
        assert entry["role"] == "assistant"
