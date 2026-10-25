"""Direct Responses calls to the Codex subscription backend (chatgpt.com/backend-api/codex) with the
Codex CLI's own ChatGPT sign-in (~/.codex/auth.json), without the 4,264 input tokens `codex exec`
adds to every call (measured on Sol, 2026-10-25). The backend reuses its cache only within one
session (the session_id header) and only for a request that begins with an earlier request's whole
input: an identical repeat reads it, calls that merely share their opening (the same instructions,
the same page images first, even the same schema) do not."""
import base64
import json
import mimetypes
import os
import threading
import time
import uuid
from pathlib import Path

import httpx

URL = "https://chatgpt.com/backend-api/codex/responses"
REFRESH_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"  # the Codex CLI's public OAuth client
TRANSIENT = {408, 409, 429, 500, 502, 503, 504}
_lock = threading.Lock()


def _auth_path():
    return Path(os.environ.get("CODEX_HOME", "").strip() or Path.home() / ".codex") / "auth.json"


def _expiry(token):
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))).get("exp")
    except (IndexError, ValueError):
        return None


def credentials():
    """(access token, account id), refreshed and written back when it is about to expire."""
    with _lock:
        path = _auth_path()
        auth = json.loads(path.read_text(encoding="utf-8"))
        tokens = auth.get("tokens") or {}
        if auth.get("auth_mode") != "chatgpt" or not tokens.get("access_token"):
            raise RuntimeError(f"{path} holds no ChatGPT sign-in: run codex login")
        expiry = _expiry(tokens["access_token"])
        if expiry is None or time.time() < expiry - 60:
            return tokens["access_token"], tokens.get("account_id")
        fresh = httpx.post(REFRESH_URL, json={"client_id": CLIENT_ID, "grant_type": "refresh_token",
                                              "refresh_token": tokens["refresh_token"]}, timeout=30).raise_for_status().json()
        tokens.update({k: fresh[k] for k in ("access_token", "refresh_token", "id_token") if fresh.get(k)})
        auth.update(tokens=tokens, last_refresh=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(auth, indent=2), encoding="utf-8")
        temporary.replace(path)
        return tokens["access_token"], tokens.get("account_id")


def image(path):
    """A page image at detail high, as `codex exec --image` sends it."""
    kind = mimetypes.guess_type(str(path))[0] or "image/png"
    return {"type": "input_image", "detail": "high", "image_url": f"data:{kind};base64," + base64.b64encode(Path(path).read_bytes()).decode()}


def text(value):
    return {"type": "input_text", "text": value}


def usage(response):
    """The call's token counts under the names `codex exec` reports."""
    u = response.get("usage") or {}
    details = u.get("input_tokens_details") or {}
    counts = {"input_tokens": u.get("input_tokens", 0), "cached_input_tokens": details.get("cached_tokens", 0),
              "output_tokens": u.get("output_tokens", 0), "reasoning_output_tokens": (u.get("output_tokens_details") or {}).get("reasoning_tokens", 0)}
    if details.get("cache_write_tokens") is not None:
        counts["cache_write_input_tokens"] = details["cache_write_tokens"]
    counts["total_tokens"] = counts["input_tokens"] + counts["output_tokens"]
    return counts


def respond(*, instructions, content, schema, model, effort, cache_key, timeout_seconds, log):
    """One structured answer. content: the user message's parts in order (text() and image());
    cache_key: the cache's key and the session. Returns the answer's text; its events go to log."""
    body = {"model": model, "instructions": instructions, "store": False, "stream": True,
            "input": [{"type": "message", "role": "user", "content": content}],
            "reasoning": {"effort": effort}, "prompt_cache_key": cache_key,
            "text": {"format": {"type": "json_schema", "name": "answer", "strict": True, "schema": schema}}}
    for attempt in range(5):
        if attempt:
            time.sleep(min(60, 5 * 2 ** attempt))
        token, account = credentials()
        headers = {"Authorization": "Bearer " + token, "OpenAI-Beta": "responses=experimental", "originator": "codex_cli_rs",
                   "Accept": "text/event-stream", "session_id": cache_key, **({"ChatGPT-Account-ID": account} if account else {})}
        try:
            with httpx.stream("POST", URL, headers=headers, json=body, timeout=httpx.Timeout(timeout_seconds, connect=30)) as response:
                if response.status_code in TRANSIENT:
                    log.write(json.dumps({"type": "http.retry", "status": response.status_code}) + "\n")
                    continue
                if response.status_code != 200:
                    raise RuntimeError(f"backend answered {response.status_code}: {response.read().decode(errors='replace')[:2000]}")
                answer = []
                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    event = json.loads(line[6:])
                    kind = event.get("type", "")
                    if kind == "response.output_item.done" and event["item"].get("type") == "message":
                        answer += [part.get("text", "") for part in event["item"].get("content", []) if part.get("type") == "output_text"]
                    elif kind == "response.completed":
                        completed = event["response"]
                        log.write(json.dumps({"type": "turn.completed", "usage": usage(completed), "response_id": completed.get("id")}) + "\n")
                        return "".join(answer)
                    elif kind in ("response.failed", "response.incomplete", "error"):
                        raise RuntimeError(f"backend stream ended with {kind}: {json.dumps(event)[:2000]}")
                log.write(json.dumps({"type": "stream.retry", "reason": "ended without response.completed"}) + "\n")
        except httpx.TransportError as exc:
            log.write(json.dumps({"type": "transport.retry", "error": str(exc)[:500]}) + "\n")
    raise RuntimeError("backend gave no answer after 5 tries")


def invoke(*, prompt, schema_path, image_paths, model, effort, work_dir, timeout_seconds, extra_args=(), instructions="", cache_key=None):
    """The `codex_runner.transport.invoke` contract over the direct backend: the images, then the
    prompt, as `codex exec` sends them; the answer parsed, the last message and the events (with the
    usage `calls.event_usage` reads) in work_dir. extra_args (codex exec's flags) have no meaning here."""
    content = [*(image(p) for p in image_paths), text(prompt)]
    work_dir = Path(work_dir)
    with open(work_dir / "events.jsonl", "w", encoding="utf-8") as log:
        answer = respond(instructions=instructions, content=content, schema=json.loads(Path(schema_path).read_text(encoding="utf-8")),
                         model=model, effort=effort, cache_key=cache_key or str(uuid.uuid4()), timeout_seconds=timeout_seconds, log=log)
    (work_dir / "last-message.json").write_text(answer, encoding="utf-8")
    try:
        return json.loads(answer)
    except json.JSONDecodeError as exc:
        raise ValueError(f"backend response is not valid JSON: {exc}") from exc
