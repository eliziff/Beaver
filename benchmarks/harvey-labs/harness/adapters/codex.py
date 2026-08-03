"""Codex subscription-backend adapter.

Routes Responses-API calls to chatgpt.com/backend-api/codex using ChatGPT
OAuth credentials borrowed from the Codex CLI (~/.codex/auth.json) — the
same flow the open-source CLI and simonw/llm-openai-via-codex use.

Backend dialect quirks vs api.openai.com:
  - `store` must be false
  - `max_output_tokens` is rejected ("Unsupported parameter")
  - responses are streamed and accumulated to a final Response object
"""

import base64
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

import httpx
import openai

from harness.adapters.openai import OpenAIAdapter

CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
REFRESH_URL = "https://auth.openai.com/oauth/token"
# OAuth client id of the Codex CLI itself (public, from openai/codex).
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
REFRESH_SKEW_S = 30

_auth_lock = threading.Lock()


def _auth_path() -> Path:
    home = os.environ.get("CODEX_HOME", "").strip() or str(Path.home() / ".codex")
    return Path(home) / "auth.json"


def _jwt_expiry_s(token: str) -> float | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload)).get("exp")
        return float(exp) if isinstance(exp, (int, float)) else None
    except Exception:
        return None


def borrow_codex_key() -> tuple[str, str | None]:
    """Return (access_token, account_id), refreshing via OAuth when expired."""
    with _auth_lock:
        file = _auth_path()
        try:
            auth = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            raise RuntimeError(
                f"Codex auth file not readable at {file}. Run codex login."
            ) from e
        tokens = auth.get("tokens") or {}
        if auth.get("auth_mode") != "chatgpt" or not tokens.get("access_token"):
            raise RuntimeError("Codex auth.json has no ChatGPT tokens. Run codex login.")

        expiry = _jwt_expiry_s(tokens["access_token"])
        if expiry is not None and time.time() < expiry - REFRESH_SKEW_S:
            return tokens["access_token"], tokens.get("account_id")
        if not tokens.get("refresh_token"):
            raise RuntimeError("Codex access token expired and no refresh token present.")

        req = urllib.request.Request(
            REFRESH_URL,
            data=json.dumps(
                {
                    "client_id": CODEX_CLIENT_ID,
                    "grant_type": "refresh_token",
                    "refresh_token": tokens["refresh_token"],
                }
            ).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                fresh = json.loads(resp.read())
        except Exception as e:
            raise RuntimeError(f"Codex token refresh failed: {e}. Run codex login.") from e
        if not fresh.get("access_token"):
            raise RuntimeError("Codex token refresh returned no access token.")

        tokens["access_token"] = fresh["access_token"]
        if fresh.get("refresh_token"):
            tokens["refresh_token"] = fresh["refresh_token"]
        if fresh.get("id_token"):
            tokens["id_token"] = fresh["id_token"]
        auth["tokens"] = tokens
        auth["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # Atomic write-back so a concurrent Codex CLI never sees a torn file.
        tmp = file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(auth, indent=2), encoding="utf-8")
        tmp.replace(file)
        return tokens["access_token"], tokens.get("account_id")


class _CodexResponses:
    """`client.responses` stand-in that speaks the codex backend dialect.

    Accepts the same kwargs callers pass for api.openai.com, sanitizes them
    for the backend, and always streams (the backend expects it), collecting
    events into the final Response so non-streaming callers work unchanged.
    """

    def create(self, **kwargs):
        kwargs.pop("max_output_tokens", None)
        kwargs.pop("temperature", None)
        kwargs.pop("stream", None)
        kwargs["store"] = False
        # The backend requires `input` to be a list (api.openai.com also
        # accepts a bare string, which the judge uses).
        if isinstance(kwargs.get("input"), str):
            kwargs["input"] = [
                {"type": "message", "role": "user", "content": kwargs["input"]}
            ]
        access_token, account_id = borrow_codex_key()
        client = openai.OpenAI(
            base_url=CODEX_BASE_URL,
            api_key=access_token,
            default_headers={"ChatGPT-Account-ID": account_id} if account_id else None,
        )
        for attempt in range(2):
            try:
                stream = client.responses.create(stream=True, **kwargs)
                # The backend's response.completed carries an empty `output`;
                # the real items arrive via response.output_item.done.
                items = []
                for event in stream:
                    if event.type == "response.output_item.done":
                        items.append(event.item)
                    elif event.type == "response.completed":
                        response = event.response
                        if not response.output:
                            response = response.model_copy(update={"output": items})
                        return response
                    elif event.type in ("response.failed", "error"):
                        raise RuntimeError(f"codex backend stream error: {event}")
                raise RuntimeError(
                    "codex backend stream ended without response.completed"
                )
            except (httpx.TransportError, openai.APIConnectionError):
                if attempt:
                    raise
                time.sleep(1)
        raise AssertionError("unreachable")


class CodexClient:
    """Minimal client exposing the one surface the harness and judge use."""

    responses = _CodexResponses()


class CodexAdapter(OpenAIAdapter):
    """OpenAI Responses adapter pointed at the Codex subscription backend."""

    def __init__(
        self,
        model: str,
        temperature: float = 0.0,
        reasoning_effort: str | None = None,
    ):
        super().__init__(
            model=model,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )
        self.client = CodexClient()
