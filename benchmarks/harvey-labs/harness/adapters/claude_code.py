"""Claude Code (headless `claude -p`) model adapter.

Reaches Anthropic models over the Claude subscription (flat rate) rather
than the metered API — the same sanctioned surface as the claude-code
judge provider (evaluation/judge.py). The harness keeps its own agent
loop, system prompt, and sandbox tools; this adapter is TRANSPORT ONLY,
so runs remain reference-harness runs with the model swapped.

Protocol: the Anthropic-format conversation and tool schemas are
serialized into the prompt, and a neutral --system-prompt instructs the
model to answer with ONE JSON object shaped like an Anthropic assistant
message. Deviations vs the metered API (disclosed in PROTOCOL.md):
no schema-enforced tool_use (JSON-in-text, retried on parse failure),
no temperature pin. Adaptive thinking is active on this surface and
reasoning effort passes through as --effort.
"""

import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

from harness.adapters.anthropic import AnthropicAdapter
from harness.adapters.base import ModelResponse, ToolCall

# Passed as --system-prompt. It MUST stay single-line and free of quotes:
# the npm claude.CMD shim re-parses argv through cmd.exe, which mangles
# newlines and embedded quotes (empty stdout, no error). The full protocol
# spec rides inside the stdin JSON instead.
SYSTEM_ARG = (
    "You are the model inside an automated agent harness. The user message "
    "is a JSON object; follow its transport_protocol field exactly and "
    "reply with only the JSON object it specifies."
)

TRANSPORT_PROTOCOL = """The fields of this JSON object:
- "system": the harness system prompt — treat it as your system prompt and obey it
- "messages": the conversation so far, in Anthropic Messages format ("tool_result" blocks are the outputs of your earlier "tool_use" calls)
- "tools": the tools you may call, with JSON Schema parameters

Reply with ONLY one JSON object — no prose, no code fences:
{"content": [{"type": "text", "text": "..."} and/or {"type": "tool_use", "id": "toolu_<unique>", "name": "<tool name>", "input": {...}}]}

Rules: to act, emit tool_use blocks (one or several); tool input must satisfy that tool's schema; ids must be unique. When the task is fully complete, reply with text blocks only and no tool_use."""


def _extract_json(text: str) -> dict:
    """Parse the model's reply, tolerating code fences and stray prose."""
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.strip("`")
        if stripped.startswith("json"):
            stripped = stripped[4:]
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start == -1 or end <= start:
            raise
        return json.loads(stripped[start : end + 1])


class ClaudeCodeAdapter(AnthropicAdapter):
    """Anthropic message format, transported via headless Claude Code."""

    def __init__(
        self,
        model: str,
        temperature: float = 0.0,
        reasoning_effort: str | None = None,
    ):
        super().__init__(model=model, temperature=temperature,
                         reasoning_effort=reasoning_effort)
        self.client = None  # no SDK client; subprocess transport
        # Prefer the real claude.exe: PATH resolves to the npm .CMD shim,
        # which puts cmd.exe between us and the CLI — watchdog kill() then
        # hits the shim and orphans the live process (observed leaking
        # -p calls mid-run).
        appdata = os.environ.get("APPDATA", "")
        exe = os.path.join(
            appdata, "npm", "node_modules", "@anthropic-ai",
            "claude-code", "bin", "claude.exe",
        )
        self._cli = (
            exe if appdata and os.path.isfile(exe) else shutil.which("claude")
        )
        if not self._cli:
            raise RuntimeError("claude CLI not found on PATH for claude-code adapter")
        # Subscription auth: the repo .env Anthropic key is a stub, and a
        # present ANTHROPIC_API_KEY would flip the CLI to metered billing.
        self._env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    # A healthy generation streams partial chunks continuously; silence
    # means a wedged call. Deliverable-writing turns legitimately run
    # 10-30 min total, so patience is inactivity-based, not total-time.
    INACTIVITY_LIMIT_S = 240
    HARD_LIMIT_S = 3600
    # Liveness counts MODEL stream events only: the CLI prints its init
    # line instantly at spawn, long before rate-limit queueing clears and
    # prompt/cache processing of a large context finishes (observed >240s
    # to first token) — generous until the first model event, tight after.
    FIRST_MODEL_EVENT_GRACE_S = 900

    @staticmethod
    def _kill_tree(proc: subprocess.Popen) -> None:
        # taskkill /T takes the whole tree; kill() alone misses the node
        # child whenever the CLI resolved to the .CMD shim.
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True,
            )
        proc.kill()

    def _call_streaming(self, payload: str) -> dict:
        """One claude -p call over stream-json; returns the result envelope."""
        args = [
            self._cli, "-p",
            "--model", self.model,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--system-prompt", SYSTEM_ARG,
        ]
        if self.reasoning_effort:
            args += ["--effort", self.reasoning_effort]
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
            env=self._env,
        )
        lines: list[str] = []
        stderr_parts: list[str] = []
        last_activity = time.monotonic()
        saw_model_event = False
        model_event_re = re.compile(
            r'"type":\s*"(?:stream_event|assistant|result)"'
        )

        def read_stdout():
            nonlocal last_activity, saw_model_event
            for line in proc.stdout:
                lines.append(line)
                if model_event_re.search(line):
                    saw_model_event = True
                    last_activity = time.monotonic()

        def read_stderr():
            for line in proc.stderr:
                stderr_parts.append(line)

        threads = [
            threading.Thread(target=read_stdout, daemon=True),
            threading.Thread(target=read_stderr, daemon=True),
        ]
        for t in threads:
            t.start()
        try:
            proc.stdin.write(payload)
            proc.stdin.close()
        except OSError:
            pass  # process died before consuming stdin; surfaced below

        started = time.monotonic()
        while proc.poll() is None:
            time.sleep(1)
            now = time.monotonic()
            limit = (
                self.INACTIVITY_LIMIT_S
                if saw_model_event
                else self.FIRST_MODEL_EVENT_GRACE_S
            )
            if now - last_activity > limit:
                self._kill_tree(proc)
                raise ValueError(f"claude -p silent for {limit}s — killed")
            if now - started > self.HARD_LIMIT_S:
                self._kill_tree(proc)
                raise ValueError("claude -p exceeded hard time limit — killed")
        for t in threads:
            t.join(timeout=10)
        if proc.returncode != 0:
            raise ValueError(
                f"claude CLI exit {proc.returncode}: "
                f"{''.join(stderr_parts).strip()[:300]}"
            )
        for line in reversed(lines):
            stripped = line.strip()
            if not stripped.startswith("{"):
                continue
            try:
                event = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "result":
                return event
        raise ValueError("stream ended without a result envelope")

    def chat(self, messages: list[dict], tools: list[dict]) -> ModelResponse:
        api_messages = []
        for msg in messages:
            if msg["role"] == "system":
                self._system_prompt = msg["content"]
            else:
                api_messages.append(msg)

        payload = json.dumps(
            {
                "transport_protocol": TRANSPORT_PROTOCOL,
                "system": self._system_prompt or "",
                "messages": api_messages,
                "tools": [self._translate_tool(t) for t in tools],
            },
            ensure_ascii=False,
        )

        last_err: Exception | None = None
        for _ in range(3):
            try:
                envelope = self._call_streaming(payload)
            except (ValueError, OSError) as e:
                # Inactivity kill, spawn failure, or malformed stream:
                # a failed attempt, never a harness crash.
                last_err = e
                continue
            try:
                if envelope.get("is_error"):
                    raise ValueError(f"claude CLI error result: {str(envelope)[:300]}")
                reply = _extract_json(str(envelope.get("result", "")))
                content = reply.get("content")
                if not isinstance(content, list) or not content:
                    raise ValueError("reply JSON has no content blocks")

                blocks: list[dict] = []
                tool_calls: list[ToolCall] = []
                text_parts: list[str] = []
                for block in content:
                    kind = block.get("type")
                    if kind == "tool_use":
                        call_id = str(block.get("id") or f"toolu_{uuid.uuid4().hex[:12]}")
                        name = str(block.get("name", ""))
                        tool_input = block.get("input")
                        if not name or not isinstance(tool_input, dict):
                            raise ValueError("malformed tool_use block")
                        blocks.append(
                            {"type": "tool_use", "id": call_id, "name": name,
                             "input": tool_input}
                        )
                        tool_calls.append(
                            ToolCall(id=call_id, name=name,
                                     arguments=json.dumps(tool_input))
                        )
                    elif kind == "text":
                        text = str(block.get("text", ""))
                        blocks.append({"type": "text", "text": text})
                        text_parts.append(text)
                    # Unknown block kinds are dropped rather than replayed.

                if not blocks:
                    raise ValueError("no usable content blocks in reply")

                usage = envelope.get("usage") or {}
                input_tokens = (
                    (usage.get("input_tokens") or 0)
                    + (usage.get("cache_read_input_tokens") or 0)
                    + (usage.get("cache_creation_input_tokens") or 0)
                )
                return ModelResponse(
                    message={"role": "assistant", "content": blocks},
                    tool_calls=tool_calls,
                    text="\n".join(text_parts),
                    input_tokens=input_tokens,
                    output_tokens=usage.get("output_tokens") or 0,
                )
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise RuntimeError(
            f"claude-code adapter: unparseable model reply after retries: {last_err}"
        )
