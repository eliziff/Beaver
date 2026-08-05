"""Single choke point for spawning the headless Claude Code CLI.

Every `claude -p` call in this repo goes through here, because two things
must be true of every such call and the CLI guarantees neither:

1. **The child must not inherit third-party Anthropic routing.** `deepclaude`
   (the DeepSeek launch function in the user's PowerShell profile) exports
   ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN into the shell. A `claude -p`
   child that inherits them silently leaves the flat-rate claude.ai
   subscription and bills the DeepSeek key per token instead. On 2026-08-03/04
   that sent ~3,000 judge calls and ~110M input tokens to `deepseek-v4-pro`,
   because DeepSeek maps the unknown model id `claude-opus-5` onto its own
   flagship. The `ANTHROPIC_DEFAULT_*_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
   flash pins do NOT protect against this — they remap the opus/sonnet/haiku
   *aliases*, and every call here passes an explicit full model id.

2. **The result must be checked against whoever actually served it.** Env
   isolation closes the known hole; `verify_served_model` catches the next
   one — whatever its mechanism — by failing loudly the first time a
   non-Anthropic model answers, before a whole judging round is billed.

Mirrors `authIsolatedEnv()` in backend/src/lib/llm/claudeP.ts.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

# Deleted, never blanked: an empty ANTHROPIC_API_KEY still counts as "set"
# and the CLI refuses to start ("another auth source is set").
ISOLATED_ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
)


class ForeignModelError(RuntimeError):
    """A non-Anthropic model served a `claude -p` call — a billing leak.

    Deliberately NOT a ValueError: the retry loops in evaluation/judge.py
    catch ValueError, and retrying a misrouted call only spends more money.
    This must abort the run.
    """


def auth_isolated_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """Child env with every competing auth/routing source removed."""
    env = dict(os.environ if base is None else base)
    for key in ISOLATED_ENV_VARS:
        env.pop(key, None)
    return env


def resolve_cli() -> str:
    """Absolute path to the CLI, preferring the real exe over the npm shim.

    PATH resolves to the .CMD shim, which puts cmd.exe between the caller and
    the CLI — a watchdog kill() then hits the shim and orphans the live
    process (observed leaking `-p` calls mid-run).
    """
    appdata = os.environ.get("APPDATA", "")
    exe = os.path.join(
        appdata, "npm", "node_modules", "@anthropic-ai",
        "claude-code", "bin", "claude.exe",
    )
    cli = exe if appdata and os.path.isfile(exe) else shutil.which("claude")
    if not cli:
        raise RuntimeError("claude CLI not found on PATH")
    return cli


def verify_served_model(envelope: dict, requested: str) -> None:
    """Raise unless every model that billed the call was first-party Anthropic.

    The CLI reports who actually served the request in the result envelope's
    `modelUsage` map, keyed by served model id and carrying a `provider`
    field. A rerouted call shows the proxy's own model there
    (`deepseek-v4-pro`) rather than the requested one.

    Checked by vendor rather than by exact id, so that alias resolution and
    the CLI's own internal helper models don't trip it while an off-vendor
    model still does.
    """
    foreign = [
        f"{model} (provider={(stats or {}).get('provider') or 'unknown'})"
        for model, stats in (envelope.get("modelUsage") or {}).items()
        if not model.startswith("claude")
        or ((stats or {}).get("provider") or "firstParty") != "firstParty"
    ]
    if foreign:
        raise ForeignModelError(
            f"`claude -p --model {requested}` was served by {', '.join(foreign)}"
            " — this call left the claude.ai subscription and is being billed"
            " per token. Almost certainly ANTHROPIC_BASE_URL /"
            " ANTHROPIC_AUTH_TOKEN leaking in from the launching shell"
            " (deepclaude). See utils/claude_cli.py."
        )


def run(
    args: list[str],
    *,
    input: str | None = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess:
    """`subprocess.run` for the CLI with the isolated env always applied.

    `args` excludes the executable — it is resolved here so no caller holds a
    raw CLI path. Callers keep their own retry/error accounting; pass the
    parsed result envelope to `verify_served_model` once they have it.
    """
    return subprocess.run(
        [resolve_cli(), *args],
        input=input,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=auth_isolated_env(),
    )


def run_json(
    *,
    model: str,
    prompt: str,
    system_prompt: str,
    timeout: int = 600,
) -> dict:
    """One `claude -p` call returning the verified JSON result envelope.

    The prompt goes over stdin: these prompts carry whole deliverables and
    blow past Windows argv limits.
    """
    completed = run(
        [
            "-p",
            "--model", model,
            "--output-format", "json",
            "--system-prompt", system_prompt,
        ],
        input=prompt,
        timeout=timeout,
    )
    if completed.returncode != 0:
        raise ValueError(
            f"claude CLI exit {completed.returncode}: "
            f"{completed.stderr.strip()[:300]}"
        )
    envelope = json.loads(completed.stdout)
    verify_served_model(envelope, model)
    if envelope.get("is_error"):
        raise ValueError(f"claude CLI error result: {str(envelope)[:300]}")
    return envelope
