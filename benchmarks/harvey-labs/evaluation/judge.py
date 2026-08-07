"""Generic LLM judge — wraps any ModelAdapter to evaluate outputs.

The judge formats a prompt template with variables, sends it to the model,
and parses the structured response. Used by all scoring functions.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import anthropic
import openai
from google import genai
from google.genai import types
from mistralai.client import Mistral

from utils import claude_cli

PROMPTS_DIR = Path(__file__).parent / "prompts"

_VERDICT_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "reasoning": {"type": "string"},
    },
    "required": ["verdict", "reasoning"],
    "additionalProperties": False,
}

def _detect_provider(model: str) -> str:
    """Return 'anthropic', 'google', 'openai', 'mistral', or 'codex' from the model name."""
    name = model.lower()
    if name.startswith("codex-cli"):
        return "codex-cli"
    if name.startswith("codex"):
        return "codex"
    if name.startswith("claude-code"):
        return "claude-code"
    if name.startswith("claude"):
        return "anthropic"
    if name.startswith("gemini"):
        return "google"
    if name.startswith(("gpt", "o1", "o3", "o4", "o5")):
        return "openai"
    if name.startswith("mistral"):
        return "mistral"
    if name.startswith("deepseek"):
        return "deepseek"
    raise ValueError(f"Unknown judge provider for model: {model!r}")

class Judge:
    """LLM-as-judge that evaluates agent outputs against rubric criteria."""

    def __init__(self, model: str = "claude-sonnet-4-6"):
        """Initialize with a model ID. Picks the SDK client based on the model prefix.

        Args:
            model: Model ID (e.g. 'claude-sonnet-4-6', 'gemini-3-flash-preview',
                'gpt-5.4', 'mistral-medium-3.5').
        """
        self.model = model
        self.provider = _detect_provider(model)
        if self.provider == "codex-cli":
            self.client = None
            self.model = model.split("/", 1)[1] if "/" in model else model
            self._codex_cli = shutil.which("codex.cmd" if os.name == "nt" else "codex")
            if not self._codex_cli:
                raise RuntimeError("codex CLI not found on PATH for codex-cli judge")
        elif self.provider == "codex":
            # `codex/<slug>` routes through the ChatGPT-subscription backend;
            # it shares the OpenAI Responses call shape, so _evaluate_openai
            # works unchanged against the sanitizing CodexClient.
            from harness.adapters.codex import CodexClient

            self.client = CodexClient()
            self.model = model.split("/", 1)[1] if "/" in model else model
        elif self.provider == "claude-code":
            # `claude-code/<model-id>` shells out to headless Claude Code on
            # the user's subscription (official surface, flat rate). No SDK
            # client; the CLI does not expose temperature or schema-enforced
            # output — the shared _parse_json handles the verdict extraction.
            self.client = None
            self.model = model.split("/", 1)[1] if "/" in model else model
            # Resolved once here so a missing CLI fails at construction rather
            # than mid-round; the spawn itself re-resolves inside claude_cli.
            claude_cli.resolve_cli()
        elif self.provider == "anthropic":
            self.client = anthropic.Anthropic(max_retries=1)
        elif self.provider == "google":
            self.client = genai.Client()
        elif self.provider == "openai":
            self.client = openai.OpenAI()
        elif self.provider == "deepseek":
            # deepseek-* judges ride the OpenAI-compatible chat-completions
            # endpoint (no Responses API upstream); flash is the flat-cheap
            # judging lane (Eli, 2026-08-06). Key resolution mirrors the
            # backend runner lane (deepseek.ts): DEEPSEEK_API_KEY with
            # DEEPSEEK_OCR_KEY as the fallback actually present in the env.
            self.client = openai.OpenAI(
                api_key=os.environ.get("DEEPSEEK_API_KEY")
                or os.environ["DEEPSEEK_OCR_KEY"],
                base_url=os.environ.get(
                    "DEEPSEEK_BASE_URL", "https://api.deepseek.com"
                ),
            )
        else:  # mistral
            self.client = Mistral(
                api_key=os.environ["MISTRAL_API_KEY"],
                timeout_ms=600_000,
            )

    def evaluate(
        self, prompt_template: str, variables: dict, temperature: float = 0.0, _retries: int = 2,
    ) -> dict:
        """Send a formatted prompt to the judge and parse the JSON response.

        Args:
            prompt_template: A prompt string with {variable} placeholders.
            variables: Dict of values to format into the template.
            temperature: Sampling temperature (default 0.0).

        Returns:
            Parsed JSON dict from the judge's response.
        """
        prompt = prompt_template.format(**variables)
        if self.provider == "anthropic":
            return self._evaluate_anthropic(prompt, temperature, _retries)
        if self.provider == "google":
            return self._evaluate_google(prompt, temperature, _retries)
        if self.provider in ("openai", "codex"):
            return self._evaluate_openai(prompt, temperature, _retries)
        if self.provider == "deepseek":
            return self._evaluate_deepseek(prompt, temperature, _retries)
        if self.provider == "codex-cli":
            return self._evaluate_codex_cli(prompt, _retries)
        if self.provider == "claude-code":
            return self._evaluate_claude_code(prompt, _retries)
        return self._evaluate_mistral(prompt, temperature, _retries)

    def _evaluate_anthropic(self, prompt: str, temperature: float, _retries: int) -> dict:
        last_err: Exception | None = None
        for attempt in range(_retries):
            kwargs = {
                "model": self.model,
                "max_tokens": 16384,
                "temperature": temperature,
                "messages": [{"role": "user", "content": prompt}],
            }
            # Use output_config on every attempt except the last.
            if attempt < _retries - 1:
                kwargs["output_config"] = {
                    "format": {
                        "type": "json_schema",
                        "schema": _VERDICT_SCHEMA,
                    }
                }
            try:
                response = self.client.messages.create(**kwargs)
            except anthropic.InternalServerError as e:
                # 500s on the structured-output path have been observed to
                # succeed when retried without output_config.
                last_err = e
                continue

            if response.stop_reason == "max_tokens":
                input_tokens = response.usage.input_tokens if response.usage else "unknown"
                raise ValueError(
                    f"Judge response truncated (stop_reason=max_tokens, "
                    f"input_tokens={input_tokens}, max_tokens={16384}). "
                    f"The agent output is likely too large for the judge context window. "
                    f"Ensure criteria have deliverables lists to scope output."
                )

            text = response.content[0].text
            try:
                return self._parse_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )
    
    def _evaluate_google(self, prompt: str, temperature: float, _retries: int) -> dict:
        last_err: Exception | None = None
        for attempt in range(_retries):
            config_kwargs = dict(
                temperature=temperature,
                max_output_tokens=16384,
                response_mime_type="application/json",
            )
            # Constrain to the verdict schema on early attempts; drop it on the last.
            if attempt < _retries - 1:
                config_kwargs["response_schema"] = _VERDICT_SCHEMA
            try:
                response = self.client.models.generate_content(
                    model=self.model,
                    contents=prompt,
                    config=types.GenerateContentConfig(**config_kwargs),
                )
            except Exception as e:
                last_err = e
                continue
            text = response.text or ""
            try:
                return self._parse_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def _evaluate_openai(self, prompt: str, temperature: float, _retries: int) -> dict:
        last_err: Exception | None = None
        for attempt in range(_retries):
            kwargs = {
                "model": self.model,
                "input": prompt,
                "max_output_tokens": 16384,
                "temperature": temperature,
            }
            if attempt < _retries - 1:
                kwargs["text"] = {
                    "format": {
                        "type": "json_schema",
                        "name": "verdict",
                        "schema": _VERDICT_SCHEMA,
                        "strict": True,
                    }
                }
            while True:
                try:
                    response = self.client.responses.create(**kwargs)
                    break
                except Exception as e:
                    # Reasoning models reject temperature. Retrying the same
                    # invalid request only wastes a judge attempt; remove just
                    # the provider-identified unsupported parameter.
                    if (
                        "temperature" in kwargs
                        and "Unsupported parameter: 'temperature'" in str(e)
                    ):
                        kwargs.pop("temperature")
                        continue
                    last_err = e
                    response = None
                    break
            if response is None:
                continue
            text = response.output_text or ""
            try:
                return self._parse_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def _evaluate_deepseek(self, prompt: str, temperature: float, _retries: int) -> dict:
        # Chat-completions shape (deepseek has no Responses API); JSON mode on
        # every attempt but the last so a schema-refusing reply still yields a
        # parseable free-form verdict for _parse_json.
        last_err: Exception | None = None
        for attempt in range(_retries):
            kwargs = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": 16384,
            }
            if attempt < _retries - 1:
                kwargs["response_format"] = {"type": "json_object"}
            try:
                response = self.client.chat.completions.create(**kwargs)
            except Exception as e:
                last_err = e
                continue
            text = response.choices[0].message.content or ""
            try:
                return self._parse_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def _evaluate_mistral(self, prompt: str, temperature: float, _retries: int) -> dict:
        last_err: Exception | None = None
        for attempt in range(_retries):
            kwargs = {
                "model": self.model,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": temperature,
                "max_tokens": 16384,
            }
            if attempt < _retries - 1:
                kwargs["response_format"] = {"type": "json_object"}
            try:
                response = self.client.chat.complete(**kwargs)
            except Exception as e:
                last_err = e
                continue
            text = response.choices[0].message.content or ""
            try:
                return self._parse_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def _evaluate_claude_code(self, prompt: str, _retries: int) -> dict:
        # CLI spawns fail transiently under parallel judging (observed:
        # exit 1 with empty stderr at --parallel 4). Spawn-level failures
        # get more attempts with backoff; unparseable-but-successful runs
        # keep the original tight retry budget.
        last_err: Exception | None = None
        spawn_failures = 0
        _retries = max(_retries, 2)
        for attempt in range(_retries + 3):
            if attempt and spawn_failures == attempt:
                time.sleep(5 * attempt)
            if attempt >= _retries and spawn_failures < attempt:
                break
            # Prompt via stdin (judge prompts with deliverable text exceed
            # Windows argv limits); neutral system prompt replaces the
            # Claude Code default so the judge sees only the rubric task.
            run = claude_cli.run(
                [
                    "-p",
                    "--model", self.model,
                    "--output-format", "json",
                    "--system-prompt",
                    "You are an evaluation judge. Respond with only the requested"
                    " JSON. Keep the reasoning field under 60 words.",
                ],
                input=prompt,
                timeout=600,
            )
            try:
                if run.returncode != 0:
                    spawn_failures += 1
                    raise ValueError(f"claude CLI exit {run.returncode}: {run.stderr.strip()[:300]}")
                envelope = json.loads(run.stdout)
                # Before anything else: a misrouted call bills per token, and
                # ForeignModelError is not caught below, so it aborts the whole
                # judging round instead of retrying at the proxy's expense.
                claude_cli.verify_served_model(envelope, self.model)
                if envelope.get("is_error"):
                    raise ValueError(f"claude CLI error result: {str(envelope)[:300]}")
                text = str(envelope.get("result", ""))
                try:
                    return self._parse_json(text)
                except (ValueError, json.JSONDecodeError):
                    # Truncated responses (output cap mid-reasoning) leave the
                    # JSON unterminated; the verdict comes first, so salvage it.
                    verdict = re.search(r'"verdict"\s*:\s*"(pass|fail)"', text)
                    if not verdict:
                        raise
                    reasoning = re.search(r'"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)', text)
                    return {
                        "verdict": verdict.group(1),
                        "reasoning": (reasoning.group(1) if reasoning else "")
                        + " [truncated]",
                    }
            except (ValueError, json.JSONDecodeError) as e:
                last_err = e
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def _evaluate_codex_cli(self, prompt: str, _retries: int) -> dict:
        last_err: Exception | None = None
        instruction = (
            "You are an evaluation judge. Respond only with the requested JSON. "
            "Keep the reasoning field under 60 words.\n\n"
        )
        for attempt in range(max(_retries, 2)):
            with tempfile.TemporaryDirectory(prefix="lab-codex-judge-") as workdir:
                run = subprocess.run(
                    [
                        self._codex_cli,
                        "exec",
                        "--ephemeral",
                        "--ignore-user-config",
                        "--ignore-rules",
                        "--strict-config",
                        "--sandbox",
                        "read-only",
                        "--json",
                        "--color",
                        "never",
                        "--skip-git-repo-check",
                        "--cd",
                        workdir,
                        "--model",
                        self.model,
                        "--config",
                        'approval_policy="never"',
                        "--config",
                        'web_search="disabled"',
                        "-",
                    ],
                    input=instruction + prompt,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=600,
                    creationflags=(
                        subprocess.CREATE_NO_WINDOW
                        | subprocess.BELOW_NORMAL_PRIORITY_CLASS
                        if os.name == "nt"
                        else 0
                    ),
                )
            try:
                if run.returncode != 0:
                    raise ValueError(
                        f"codex CLI exit {run.returncode}: {run.stderr.strip()[:300]}"
                    )
                messages = []
                for line in run.stdout.splitlines():
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    item = event.get("item") if isinstance(event, dict) else None
                    if (
                        isinstance(item, dict)
                        and item.get("type") == "agent_message"
                        and isinstance(item.get("text"), str)
                    ):
                        messages.append(item["text"])
                if not messages:
                    raise ValueError("codex CLI returned no agent message")
                return self._parse_json(messages[-1])
            except (ValueError, json.JSONDecodeError) as error:
                last_err = error
                if attempt + 1 < max(_retries, 2):
                    time.sleep(2)
        raise ValueError(
            f"Judge returned unparseable response after {_retries} attempts: {last_err}"
        )

    def evaluate_from_file(self, prompt_name: str, variables: dict) -> dict:
        """Load a prompt template from prompts/ dir and evaluate.

        Args:
            prompt_name: Filename (without .md) in the prompts directory.
            variables: Dict of values to format into the template.

        Returns:
            Parsed JSON dict from the judge's response.
        """
        path = PROMPTS_DIR / f"{prompt_name}.txt"
        template = path.read_text(encoding="utf-8")
        return self.evaluate(prompt_template=template, variables=variables)

    @staticmethod
    def _parse_json(text: str) -> dict:
        """Extract JSON from model response, handling markdown fences."""
        # Try to find JSON in code fences first
        match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1).strip())
            except json.JSONDecodeError:
                pass  # Fall through to brace matching

        # Try to find a JSON object by matching balanced braces
        for i, ch in enumerate(text):
            if ch == '{':
                depth = 0
                for j in range(i, len(text)):
                    if text[j] == '{':
                        depth += 1
                    elif text[j] == '}':
                        depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(text[i:j + 1])
                        except json.JSONDecodeError:
                            break  # Try next opening brace
                        break

        raise ValueError(f"No JSON found in judge response: {text[:200]}")
