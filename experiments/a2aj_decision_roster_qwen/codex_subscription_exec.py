#!/usr/bin/env python3
"""One isolated structured-output call over the Codex ChatGPT subscription route."""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.metadata
import json
import sys
import time
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


ROOT = Path(__file__).resolve().parents[2]
HARVEY_HARNESS = ROOT / "benchmarks" / "harvey-labs"
sys.path.insert(0, str(HARVEY_HARNESS))

from harness.adapters import codex as codex_adapter  # noqa: E402


ALLOWED_EFFORTS = {"none", "low", "medium", "high", "xhigh", "max", "ultra"}


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def subscription_preflight() -> dict[str, Any]:
    token, account_id = codex_adapter.borrow_codex_key()
    expiry = codex_adapter._jwt_expiry_s(token)
    adapter_path = Path(codex_adapter.__file__).resolve()
    return {
        "kind": "subscription_preflight",
        "endpoint": codex_adapter.CODEX_BASE_URL,
        "auth_mode": "chatgpt",
        "account_id_present": bool(account_id),
        "access_token_valid_for_seconds": None if expiry is None else int(expiry - time.time()),
        "openai_sdk_version": importlib.metadata.version("openai"),
        "adapter_sha256": sha256_file(adapter_path),
        "helper_sha256": sha256_file(Path(__file__).resolve()),
    }


def event_dict(event: Any) -> dict[str, Any]:
    if hasattr(event, "model_dump"):
        value = event.model_dump(mode="json")
        if isinstance(value, dict):
            return value
    return {"type": str(getattr(event, "type", "unknown"))}


def response_text(response: Any) -> str:
    direct = getattr(response, "output_text", None)
    if isinstance(direct, str) and direct:
        return direct
    parts: list[str] = []
    for item in getattr(response, "output", []) or []:
        if getattr(item, "type", None) != "message":
            continue
        for content in getattr(item, "content", []) or []:
            text = getattr(content, "text", None)
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


def surrogate_paths(value: Any, path: str = "$") -> list[str]:
    if isinstance(value, str):
        return [path] if any(0xD800 <= ord(character) <= 0xDFFF for character in value) else []
    if isinstance(value, list):
        return [found for index, item in enumerate(value) for found in surrogate_paths(item, f"{path}[{index}]")]
    if isinstance(value, dict):
        return [found for key, item in value.items() for found in surrogate_paths(item, f"{path}.{key}")]
    return []


def load_request() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")
    required = {"model", "effort", "prompt_base64", "response_format"}
    if set(value) != required | ({"prompt_cache_key"} if "prompt_cache_key" in value else set()):
        raise ValueError("request has unexpected or missing fields")
    if not isinstance(value["model"], str) or not value["model"]:
        raise ValueError("model must be a non-empty string")
    if value["effort"] not in ALLOWED_EFFORTS:
        raise ValueError("unsupported reasoning effort")
    if not isinstance(value["prompt_base64"], str) or not value["prompt_base64"]:
        raise ValueError("prompt_base64 must be a non-empty string")
    try:
        prompt = base64.b64decode(value["prompt_base64"], validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as error:
        raise ValueError("prompt_base64 must contain canonical UTF-8 bytes") from error
    if not isinstance(value["response_format"], dict):
        raise ValueError("response_format must be an object")
    if "prompt_cache_key" in value and not isinstance(value["prompt_cache_key"], str):
        raise ValueError("prompt_cache_key must be a string")
    value = {**value, "prompt": prompt}
    del value["prompt_base64"]
    invalid = surrogate_paths(value)
    if invalid:
        raise ValueError(f"request contains unpaired Unicode surrogates at {', '.join(invalid[:8])}")
    return value


def run(output: Path) -> None:
    request = load_request()
    preflight = subscription_preflight()
    print(compact_json(preflight), flush=True)
    responses = codex_adapter.CodexClient().responses

    def emit(event: Any, attempt: int) -> None:
        print(
            compact_json(
                {
                    "kind": "subscription_provider_event",
                    "attempt": attempt,
                    "event": event_dict(event),
                }
            ),
            flush=True,
        )

    kwargs: dict[str, Any] = {
        "model": request["model"],
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": request["prompt"],
            }
        ],
        "reasoning": {"effort": request["effort"], "summary": "auto"},
        "text": {"format": request["response_format"]},
    }
    if request.get("prompt_cache_key"):
        kwargs["prompt_cache_key"] = request["prompt_cache_key"]
    response = responses.create_with_event_sink(emit, **kwargs)
    answer = response_text(response)
    if not answer.strip():
        raise RuntimeError("Codex subscription response contained no output text")
    output.write_text(answer, encoding="utf-8")
    usage = getattr(response, "usage", None)
    usage_json = usage.model_dump(mode="json") if hasattr(usage, "model_dump") else None
    print(
        compact_json(
            {
                "kind": "subscription_completed",
                "endpoint": codex_adapter.CODEX_BASE_URL,
                "auth_mode": "chatgpt",
                "response_id": getattr(response, "id", None),
                "service_tier": getattr(response, "service_tier", None),
                "usage": usage_json,
                "transport_retries": responses.transport_retry_count,
                "output_sha256": hashlib.sha256(answer.encode("utf-8")).hexdigest(),
            }
        ),
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--encoding-test", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.encoding_test:
        print(compact_json({"kind": "encoding_test", "text": "non‑breaking «UTF-8»"}))
        return
    if args.preflight:
        print(compact_json(subscription_preflight()))
        return
    if args.output is None:
        parser.error("--output is required unless --preflight is used")
    run(args.output.resolve())


if __name__ == "__main__":
    main()
