"""Provider translation contracts; only the network clients are doubled."""

from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from harness.adapters.anthropic import AnthropicAdapter
from harness.adapters.baseten import BasetenAdapter
from harness.adapters.fireworks import FireworksAdapter
from harness.adapters.google import GoogleAdapter, types
from harness.adapters.openai import OpenAIAdapter
from harness.tools import get_all_tool_definitions


@pytest.fixture
def adapters(monkeypatch):
    monkeypatch.setattr("harness.adapters.anthropic.anthropic.Anthropic", Mock())
    monkeypatch.setattr("harness.adapters.openai.openai.OpenAI", Mock())
    monkeypatch.setattr("harness.adapters.google.genai.Client", Mock())
    monkeypatch.setenv("FIREWORKS_API_KEY", "test-key")
    return {
        "anthropic": lambda: AnthropicAdapter("claude-sonnet-4-6"),
        "openai": lambda: OpenAIAdapter("gpt-5.4"),
        "google": lambda: GoogleAdapter("gemini-3.1-pro"),
        "baseten": lambda: BasetenAdapter(
            "test-model", base_url="https://example/sync/v1", api_key="k"
        ),
        "fireworks": lambda: FireworksAdapter("accounts/fireworks/models/kimi-k2p6"),
    }


@pytest.fixture
def tool():
    return {
        "name": "test",
        "description": "Test",
        "parameters": {"type": "object", "properties": {}},
    }


@pytest.fixture
def openai_adapter(adapters):
    adapter = adapters["openai"]()
    adapter.client.responses.create.return_value = SimpleNamespace(output=[], usage=None)
    return adapter


@pytest.mark.parametrize("provider", ["anthropic", "google", "baseten", "fireworks"])
def test_make_system_message(adapters, provider):
    assert adapters[provider]().make_system_message("System prompt") == {
        "role": "system",
        "content": "System prompt",
    }


def test_make_system_message_stores_instructions(openai_adapter):
    assert openai_adapter.make_system_message("System instructions here") == {
        "role": "system",
        "content": "System instructions here",
    }
    # Exercise the stored instruction through the provider boundary, not a private field.
    openai_adapter.chat([openai_adapter.make_user_message("Hello")], [])
    assert (
        openai_adapter.client.responses.create.call_args.kwargs["instructions"]
        == "System instructions here"
    )


@pytest.mark.parametrize(
    "provider,expected",
    [
        pytest.param("anthropic", {"role": "user", "content": "Hello"}, id="anthropic"),
        pytest.param("openai", {"role": "user", "content": "Hello"}, id="openai"),
        pytest.param("google", {"role": "user", "parts": [{"text": "Hello"}]}, id="google"),
        pytest.param("baseten", {"role": "user", "content": "Hello"}, id="baseten"),
        pytest.param("fireworks", {"role": "user", "content": "Hello"}, id="fireworks"),
    ],
)
def test_make_user_message(adapters, provider, expected):
    assert adapters[provider]().make_user_message("Hello") == expected


@pytest.mark.parametrize(
    "provider,results,expected",
    [
        pytest.param(
            "anthropic",
            [("tc1", "file list")],
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tc1", "content": "file list"},
                    ],
                }
            ],
            id="test_make_tool_result_single",
        ),
        pytest.param(
            "anthropic",
            [("tc1", "result 1"), ("tc2", "result 2"), ("tc3", "result 3")],
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "tc1", "content": "result 1"},
                        {"type": "tool_result", "tool_use_id": "tc2", "content": "result 2"},
                        {"type": "tool_result", "tool_use_id": "tc3", "content": "result 3"},
                    ],
                }
            ],
            id="test_make_tool_result_batches_in_single_message",
        ),
        pytest.param(
            "openai",
            [("call_1", "result 1"), ("call_2", "result 2")],
            [
                {"type": "function_call_output", "call_id": "call_1", "output": "result 1"},
                {"type": "function_call_output", "call_id": "call_2", "output": "result 2"},
            ],
            id="test_make_tool_result_returns_separate_items",
        ),
        pytest.param(
            "google",
            [("list_files", "file listing here")],
            [
                {
                    "role": "user",
                    "parts": [
                        {
                            "function_response": {
                                "name": "list_files",
                                "response": {"result": "file listing here"},
                            }
                        },
                    ],
                }
            ],
            id="test_make_tool_result_wraps_in_function_response",
        ),
        pytest.param(
            "google",
            [("func_a", "result a"), ("func_b", "result b")],
            [
                {
                    "role": "user",
                    "parts": [
                        {
                            "function_response": {
                                "name": "func_a",
                                "response": {"result": "result a"},
                            }
                        },
                        {
                            "function_response": {
                                "name": "func_b",
                                "response": {"result": "result b"},
                            }
                        },
                    ],
                }
            ],
            id="test_make_tool_result_multiple_in_one_message",
        ),
        pytest.param(
            "baseten",
            [("tc1", "r1"), ("tc2", "r2")],
            [
                {"role": "tool", "tool_call_id": "tc1", "content": "r1"},
                {"role": "tool", "tool_call_id": "tc2", "content": "r2"},
            ],
            id="test_make_tool_result_one_message_per_result",
        ),
        pytest.param(
            "fireworks",
            [("call_1", "result 1"), ("call_2", "result 2")],
            [
                {"role": "tool", "tool_call_id": "call_1", "content": "result 1"},
                {"role": "tool", "tool_call_id": "call_2", "content": "result 2"},
            ],
            id="test_make_tool_result_returns_separate_messages",
        ),
    ],
)
def test_tool_result_messages(adapters, provider, results, expected):
    assert adapters[provider]().make_tool_result_messages(results) == expected


def test_make_tool_result_appends_to_context(openai_adapter):
    openai_adapter.chat([openai_adapter.make_user_message("Request")], [])
    openai_adapter.make_tool_result_messages([("c1", "r1"), ("c2", "r2")])
    openai_adapter.chat([], [])
    assert openai_adapter.client.responses.create.call_args.kwargs["input"] == [
        {"type": "message", "role": "user", "content": "Request"},
        {"type": "function_call_output", "call_id": "c1", "output": "r1"},
        {"type": "function_call_output", "call_id": "c2", "output": "r2"},
    ]


@pytest.mark.parametrize(
    "provider,expected",
    [
        pytest.param(
            "anthropic",
            {
                "name": "test",
                "description": "Test",
                "input_schema": {"type": "object", "properties": {}},
            },
            id="test_translate_tool_uses_input_schema",
        ),
        pytest.param(
            "openai",
            {
                "type": "function",
                "name": "test",
                "description": "Test",
                "parameters": {"type": "object", "properties": {}},
            },
            id="test_translate_tool_adds_type_function",
        ),
        pytest.param(
            "baseten",
            {
                "type": "function",
                "function": {
                    "name": "test",
                    "description": "Test",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            id="test_translate_tool_uses_function_envelope",
        ),
        pytest.param(
            "fireworks",
            {
                "type": "function",
                "function": {
                    "name": "test",
                    "description": "Test",
                    "parameters": {"type": "object", "properties": {}},
                },
            },
            id="test_translate_tool_wraps_in_function",
        ),
    ],
)
def test_tool_translation(adapters, provider, tool, expected):
    assert adapters[provider]()._translate_tool(tool) == expected


def test_translate_tools_creates_function_declarations(adapters):
    tools = get_all_tool_definitions()
    translated = adapters["google"]()._translate_tools(tools)
    assert len(translated) == 1
    # Use real SDK types: counting mocked constructors accepted dropped schema data.
    assert [
        (declaration.name, declaration.description, declaration.parameters)
        for declaration in translated[0].function_declarations
    ] == [
        (tool["name"], tool["description"], types.Schema.model_validate(tool["parameters"]))
        for tool in tools
    ]


def test_current_sonnet_defaults(adapters):
    adapter = AnthropicAdapter("claude-sonnet-5", reasoning_effort="xhigh")
    assert (adapter.model, adapter.max_tokens, adapter.reasoning_effort) == (
        "claude-sonnet-5",
        128000,
        "xhigh",
    )


def test_requires_api_key(adapters, monkeypatch):
    monkeypatch.delenv("BASETEN_API_KEY", raising=False)
    with pytest.raises(ValueError, match="requires BASETEN_API_KEY"):
        BasetenAdapter("test-model", base_url="https://example/sync/v1", api_key=None)


def test_bare_name_expands_to_resource_path(adapters):
    assert (
        FireworksAdapter("kimi-k2p6").model,
        FireworksAdapter("accounts/fireworks/models/glm-5p2").model,
    ) == (
        "accounts/fireworks/models/kimi-k2p6",
        "accounts/fireworks/models/glm-5p2",
    )


def test_cache_identity_and_cache_telemetry(adapters):
    adapter = OpenAIAdapter("gpt-5.6-luna", reasoning_effort="xhigh")
    adapter.client.responses.create.return_value = SimpleNamespace(
        output=[],
        id="resp-test",
        service_tier="default",
        usage=SimpleNamespace(
            input_tokens=10,
            output_tokens=3,
            input_tokens_details=SimpleNamespace(cached_tokens=4, cache_write_tokens=5),
            output_tokens_details=SimpleNamespace(reasoning_tokens=2),
        ),
    )
    tools = [
        {
            "name": "fetch_documents",
            "description": "Fetch documents",
            "parameters": {"type": "object", "properties": {}},
        }
    ]
    response = adapter.chat(
        [adapter.make_system_message("system"), adapter.make_user_message("request")], tools
    )
    kwargs = adapter.client.responses.create.call_args.kwargs
    # Fixed fixture digest, not the production key helper used as its own oracle.
    assert (
        kwargs["prompt_cache_key"]
        == "lab-7f425d07834d9cc7115e857152352d52f1f546e2e2298a374aeb51875f78cd31"
    )
    assert kwargs["reasoning"] == {"summary": "auto", "effort": "xhigh"}
    assert (
        response.input_tokens,
        response.output_tokens,
        response.cached_input_tokens,
        response.cache_write_input_tokens,
        response.reasoning_tokens,
        response.response_id,
        response.service_tier,
    ) == (10, 3, 4, 5, 2, "resp-test", "default")
