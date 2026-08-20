from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx

from harness.adapters.codex import _CodexResponses


def test_codex_stream_transport_failure_retries_without_partial_items():
    partial = SimpleNamespace(type="response.output_item.done", item="partial")
    final_response = SimpleNamespace(output=["final"])
    completed = SimpleNamespace(type="response.completed", response=final_response)

    def broken_stream():
        yield partial
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client = MagicMock()
    client.responses.create.side_effect = [broken_stream(), iter([completed])]
    seen = []

    with patch("harness.adapters.codex.borrow_codex_key", return_value=("token", None)), patch(
        "harness.adapters.codex.openai.OpenAI", return_value=client
    ), patch("harness.adapters.codex.time.sleep"):
        responses = _CodexResponses()
        response = responses.create_with_event_sink(
            lambda event, attempt: seen.append((event.type, attempt)),
            model="gpt-5.6-luna",
            input="test",
        )

    assert response is final_response
    assert response.output == ["final"]
    assert client.responses.create.call_count == 2
    assert responses.transport_retry_count == 1
    assert seen == [
        ("response.output_item.done", 1),
        ("response.completed", 2),
    ]


def test_codex_event_sink_preserves_events_and_attempt_numbers():
    item = SimpleNamespace(type="response.output_item.done", item="final")
    final_response = SimpleNamespace(output=["final"])
    completed = SimpleNamespace(type="response.completed", response=final_response)
    client = MagicMock()
    client.responses.create.return_value = iter([item, completed])
    seen = []

    with patch("harness.adapters.codex.borrow_codex_key", return_value=("token", None)), patch(
        "harness.adapters.codex.openai.OpenAI", return_value=client
    ):
        response = _CodexResponses().create_with_event_sink(
            lambda event, attempt: seen.append((event.type, attempt)),
            model="gpt-5.6-luna",
            input="test",
        )

    assert response is final_response
    assert seen == [
        ("response.output_item.done", 1),
        ("response.completed", 1),
    ]
