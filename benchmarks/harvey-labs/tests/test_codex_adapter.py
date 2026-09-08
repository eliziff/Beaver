from types import SimpleNamespace
from unittest.mock import Mock, call

import httpx
import pytest
from openai.types.responses import Response

from harness.adapters.codex import _CodexResponses


@pytest.fixture
def transport(monkeypatch):
    client = Mock()
    monkeypatch.setattr("harness.adapters.codex.borrow_codex_key", lambda: ("token", None))
    monkeypatch.setattr("harness.adapters.codex.openai.OpenAI", Mock(return_value=client))
    monkeypatch.setattr("harness.adapters.codex.time.sleep", Mock())
    return _CodexResponses(), client


def test_codex_stream_transport_failure_retries_without_partial_items(transport):
    responses, client = transport
    partial = SimpleNamespace(type="response.output_item.done", item="partial")
    final = SimpleNamespace(type="response.output_item.done", item="final")
    # Empty completion output exercises accumulation; a pre-filled result hid stale items.
    completed = SimpleNamespace(
        type="response.completed", response=Response.model_construct(output=[])
    )

    def broken_stream():
        yield partial
        raise httpx.RemoteProtocolError("incomplete chunked read")

    client.responses.create.side_effect = [broken_stream(), iter([final, completed])]
    seen = []
    response = responses.create_with_event_sink(
        lambda event, attempt: seen.append((event, attempt)),
        model="gpt-5.6-luna",
        input="test",
    )
    assert response.output == ["final"]
    assert responses.transport_retry_count == 1
    assert seen == [(partial, 1), (final, 2), (completed, 2)]
    assert (
        client.responses.create.call_args_list
        == [
            call(
                stream=True,
                store=False,
                model="gpt-5.6-luna",
                input=[{"type": "message", "role": "user", "content": "test"}],
            )
        ]
        * 2
    )


def test_codex_event_sink_preserves_events_and_attempt_numbers(transport):
    responses, client = transport
    item = SimpleNamespace(type="response.output_item.done", item="final")
    final_response = SimpleNamespace(output=["final"])
    completed = SimpleNamespace(type="response.completed", response=final_response)
    client.responses.create.return_value = iter([item, completed])
    seen = []
    response = responses.create_with_event_sink(
        lambda event, attempt: seen.append((event, attempt)),
        model="gpt-5.6-luna",
        input="test",
    )
    assert response is final_response
    assert responses.transport_retry_count == 0
    assert seen == [(item, 1), (completed, 1)]
    client.responses.create.assert_called_once_with(
        stream=True,
        store=False,
        model="gpt-5.6-luna",
        input=[{"type": "message", "role": "user", "content": "test"}],
    )
