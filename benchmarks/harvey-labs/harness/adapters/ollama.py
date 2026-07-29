"""Ollama adapter (local models over the LAN, e.g. desktop Qwen).

Speaks ollama's native /api/chat with tool calling, so the reference
harness can hold ITS loop constant while a local small model supplies
the inference layer. Base URL from OLLAMA_BASE_URL (default the desktop
PC), context window from OLLAMA_NUM_CTX.

Ollama tool_calls carry no ids; the adapter synthesizes them and keeps
an id→name map so tool results can be replayed in ollama's format
({"role": "tool", "tool_name": ..., "content": ...}).
"""

import json
import os
import time
import urllib.request

from harness.adapters.base import ModelAdapter, ModelResponse, ToolCall

DEFAULT_BASE_URL = "http://127.0.0.1:11434"


class OllamaAdapter(ModelAdapter):
    """Adapter for local models served by ollama."""

    def __init__(
        self,
        model: str,
        temperature: float = 0.0,
        reasoning_effort: str | None = None,
    ):
        super().__init__(model, temperature, reasoning_effort)
        self.base_url = (
            os.environ.get("OLLAMA_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        )
        self.num_ctx = int(os.environ.get("OLLAMA_NUM_CTX", "32768"))
        self._call_counter = 0
        self._call_names: dict[str, str] = {}

    def chat(self, messages: list[dict], tools: list[dict]) -> ModelResponse:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "tools": [self._translate_tool(t) for t in tools],
                "stream": False,
                "options": {
                    "temperature": self.temperature,
                    "num_ctx": self.num_ctx,
                },
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        last_error: OSError | None = None
        for attempt in range(3):
            if attempt:
                time.sleep(3 * attempt)
            try:
                # OSError covers urllib.error.URLError plus raw
                # ECONNRESET/route flaps seen on the LAN/tailnet path.
                with urllib.request.urlopen(request, timeout=900) as response:
                    reply = json.loads(response.read())
                break
            except OSError as error:
                last_error = error
        else:
            raise last_error

        message = reply.get("message") or {}
        tool_calls: list[ToolCall] = []
        native_calls = message.get("tool_calls") or []
        for raw in native_calls:
            function = raw.get("function") or {}
            name = str(function.get("name", ""))
            arguments = function.get("arguments")
            if isinstance(arguments, str):
                arguments_json = arguments
            else:
                arguments_json = json.dumps(arguments or {})
            self._call_counter += 1
            call_id = f"call_{self._call_counter}"
            self._call_names[call_id] = name
            tool_calls.append(ToolCall(id=call_id, name=name, arguments=arguments_json))

        return ModelResponse(
            message=message,
            tool_calls=tool_calls,
            text=str(message.get("content") or ""),
            input_tokens=reply.get("prompt_eval_count") or 0,
            output_tokens=reply.get("eval_count") or 0,
        )

    def make_tool_result_messages(self, results: list[tuple[str, str]]) -> list[dict]:
        return [
            {
                "role": "tool",
                "tool_name": self._call_names.get(call_id, call_id),
                "content": result,
            }
            for call_id, result in results
        ]

    def make_system_message(self, content: str) -> dict:
        return {"role": "system", "content": content}

    def make_user_message(self, content: str) -> dict:
        return {"role": "user", "content": content}

    def _translate_tool(self, tool: dict) -> dict:
        return {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
