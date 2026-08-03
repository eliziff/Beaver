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

    with patch("harness.adapters.codex.borrow_codex_key", return_value=("token", None)), patch(
        "harness.adapters.codex.openai.OpenAI", return_value=client
    ), patch("harness.adapters.codex.time.sleep"):
        responses = _CodexResponses()
        response = responses.create(model="gpt-5.6-luna", input="test")

    assert response is final_response
    assert response.output == ["final"]
    assert client.responses.create.call_count == 2
    assert responses.transport_retry_count == 1
