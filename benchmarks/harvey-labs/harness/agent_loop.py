"""The agent loop — model calls tools until it finishes or hits max turns.

This is the core of the harness. It's deliberately simple: the model does
the thinking, the loop just shuttles messages back and forth.

The agent finishes when it stops making tool calls (no explicit `finish`
tool). The agent loop ends on:
  1. No tool calls returned — the model has nothing more to do
  2. Max turns reached
"""

import time
import json
import hashlib
from pathlib import Path

from harness.adapters.base import ModelAdapter, ModelResponse
from harness.tools import ToolExecutor, get_all_tool_definitions


def run_agent(
    adapter: ModelAdapter,
    system_prompt: str,
    user_prompt: str,
    tool_executor: ToolExecutor,
    tools: list[dict] | None = None,
    max_turns: int = 200,
    transcript_path: str | None = None,
) -> dict:
    """Run the agent loop to completion.

    Args:
        adapter: The model adapter (Anthropic, OpenAI, Google, xAI).
        system_prompt: Capabilities and conventions (preamble + skill manuals).
        user_prompt: The first user message — the task assignment.
        tool_executor: Configured tool executor with documents and output dirs.
        tools: Tool definitions to use. Defaults to standard 6 tools if not provided.
        max_turns: Maximum number of loop iterations.
        transcript_path: Optional path to write transcript JSONL.

    Returns:
        Dict with run results: messages, metrics, timing.
    """
    messages = [
        adapter.make_system_message(system_prompt),
        adapter.make_user_message(user_prompt),
    ]
    if tools is None:
        tools = get_all_tool_definitions()

    total_input_tokens = 0
    total_output_tokens = 0
    total_cached_input_tokens = 0
    total_cache_write_input_tokens = 0
    total_reasoning_tokens = 0
    turn_count = 0
    start_time = time.time()
    context_rounds = []
    tool_call_count = 0
    tool_result_characters = 0
    tool_result_bytes = 0
    tool_error_count = 0
    tool_batches = []
    response = None

    transcript_file = None
    if transcript_path:
        Path(transcript_path).parent.mkdir(parents=True, exist_ok=True)
        transcript_file = open(transcript_path, "w")

    context_overflow = False
    try:
        for turn in range(max_turns):
            turn_count = turn + 1

            # Call the model
            try:
                request_started = time.time()
                response = adapter.chat(messages, tools)
                request_latency_ms = round((time.time() - request_started) * 1000, 2)
            except Exception as e:
                err_msg = str(e)
                if "prompt is too long" in err_msg or "context_length_exceeded" in err_msg:
                    context_overflow = True
                    print(f"Context window exceeded on turn {turn_count}: {err_msg}")
                    break
                raise

            messages.append(response.message)
            total_input_tokens += response.input_tokens
            total_output_tokens += response.output_tokens
            total_cached_input_tokens += response.cached_input_tokens
            total_cache_write_input_tokens += response.cache_write_input_tokens
            total_reasoning_tokens += response.reasoning_tokens
            context_rounds.append(
                {
                    "turn": turn_count,
                    "response_id": response.response_id,
                    "service_tier": response.service_tier,
                    "input_tokens": response.input_tokens,
                    "cached_input_tokens": response.cached_input_tokens,
                    "cache_write_input_tokens": response.cache_write_input_tokens,
                    "output_tokens": response.output_tokens,
                    "reasoning_tokens": response.reasoning_tokens,
                    "tool_call_count": len(response.tool_calls),
                    "latency_ms": request_latency_ms,
                }
            )

            # Log to transcript
            if transcript_file:
                _log_turn(transcript_file, turn_count, "assistant", response)

            # If no tool calls, the agent is done
            if not response.tool_calls:
                break

            # Execute each tool call and feed results back
            tool_results = []
            for tc in response.tool_calls:
                result = tool_executor.execute(tc.name, tc.arguments)
                tool_call_count += 1
                tool_result_characters += len(result)
                tool_result_bytes += len(result.encode("utf-8"))
                if result.startswith(("Error:", "SecurityError:")):
                    tool_error_count += 1

                if transcript_file:
                    _log_tool(transcript_file, turn_count, tc.name, tc.arguments, result)

                tool_results.append((tc, result))
            tool_batches.append(
                {
                    "turn": turn_count,
                    "calls": len(tool_results),
                    "names": [tc.name for tc, _ in tool_results],
                }
            )

            # Add tool results to message history via the adapter
            result_messages = adapter.make_tool_result_messages(
                [(tc.id, result) for tc, result in tool_results]
            )
            messages.extend(result_messages)

    finally:
        if transcript_file:
            transcript_file.close()

    elapsed = time.time() - start_time

    return {
        "messages": messages,
        "turn_count": turn_count,
        "input_tokens": total_input_tokens,
        "output_tokens": total_output_tokens,
        "cached_input_tokens": total_cached_input_tokens,
        "cache_write_input_tokens": total_cache_write_input_tokens,
        "reasoning_tokens": total_reasoning_tokens,
        "context_rounds": context_rounds,
        "tool_call_count": tool_call_count,
        "tool_result_characters": tool_result_characters,
        "tool_result_bytes": tool_result_bytes,
        "tool_error_count": tool_error_count,
        "tool_batches": tool_batches,
        "wall_clock_seconds": round(elapsed, 2),
        "finished_cleanly": (not context_overflow and
                             (not response.tool_calls if response is not None else False)),
        "context_overflow": context_overflow,
        "tool_metrics": tool_executor.get_metrics(),
        "finish_summary": None,
    }


def _log_turn(f, turn: int, role: str, response: ModelResponse):
    """Log a turn to the transcript JSONL."""
    entry = {
        "turn": turn,
        "role": role,
        "text": response.text or None,
        "message": response.message,
        "tool_calls": [
            {"name": tc.name, "arguments": tc.arguments}
            for tc in response.tool_calls
        ] if response.tool_calls else None,
        "input_tokens": response.input_tokens,
        "cached_input_tokens": response.cached_input_tokens,
        "cache_write_input_tokens": response.cache_write_input_tokens,
        "output_tokens": response.output_tokens,
        "reasoning_tokens": response.reasoning_tokens,
        "response_id": response.response_id,
        "service_tier": response.service_tier,
    }
    f.write(json.dumps(entry) + "\n")
    f.flush()


def _log_tool(f, turn: int, name: str, arguments: str, result: str):
    """Log a tool execution to the transcript JSONL."""
    entry = {
        "turn": turn,
        "role": "tool",
        "tool_name": name,
        "arguments": arguments if isinstance(arguments, str) else str(arguments),
        "result": result,
        "result_characters": len(result),
        "result_bytes": len(result.encode("utf-8")),
        "result_sha256": hashlib.sha256(result.encode("utf-8")).hexdigest(),
    }
    f.write(json.dumps(entry) + "\n")
    f.flush()
