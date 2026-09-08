from types import SimpleNamespace
from unittest.mock import Mock

from evaluation.judge import Judge, _detect_provider


def test_codex_cli_provider_is_distinct_from_direct_codex():
    assert (_detect_provider("CODEX-CLI/gpt-5.6-sol"), _detect_provider("CODEX/gpt-5.6-sol")) == (
        "codex-cli",
        "codex",
    )


def test_openai_judge_retries_without_unsupported_temperature(monkeypatch):
    create = Mock(
        side_effect=[
            RuntimeError("Unsupported parameter: 'temperature'"),
            SimpleNamespace(output_text='{"verdict":"pass","reasoning":"supported"}'),
        ]
    )
    client = SimpleNamespace(responses=SimpleNamespace(create=create))
    monkeypatch.setattr("evaluation.judge.openai.OpenAI", Mock(return_value=client))
    judge = Judge("gpt-test", reasoning_effort="high")
    assert judge.evaluate("{task}", {"task": "prompt"}) == {
        "verdict": "pass",
        "reasoning": "supported",
    }
    first, retried = [call.kwargs for call in create.call_args_list]
    assert "temperature" not in retried
    assert first == {**retried, "temperature": 0.0}
    assert (
        retried["model"],
        retried["input"],
        retried["reasoning"],
        retried["max_output_tokens"],
    ) == (
        "gpt-test",
        "prompt",
        {"effort": "high"},
        16384,
    )
