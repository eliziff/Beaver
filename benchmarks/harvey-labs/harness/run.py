"""Main entry point — runs one agent against one benchmark task.

Usage:
    uv run python -m harness.run \
        --model anthropic/claude-sonnet-4-6 \
        --task corporate-ma/review-data-room-red-flag-review
"""

import argparse
import hashlib
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path

from evaluation.run_eval import validate_task_config
from harness.adapters.anthropic import AnthropicAdapter
from harness.adapters.baseten import BasetenAdapter
from harness.adapters.claude_code import ClaudeCodeAdapter
from harness.adapters.codex import CodexAdapter
from harness.adapters.ollama import OllamaAdapter
from harness.adapters.fireworks import FireworksAdapter
from harness.adapters.google import GoogleAdapter
from harness.adapters.mistral import MistralAdapter
from harness.adapters.openai import OpenAIAdapter, prompt_cache_key_for
from harness.agent_loop import run_agent
from harness.ablation_tools import AblationToolExecutor, get_ablation_tool_definitions
from harness.mike_workbench import (
    MIKE_SURFACES,
    MikeWorkbenchExecutor,
    get_mike_surface,
)
from harness.tools import ToolExecutor, get_all_tool_definitions
from sandbox.sandbox import DEFAULT_IMAGE, ENGINE, Sandbox
from utils.stdio import force_utf8_stdio


# ── Task Discovery ─────────────────────────────────────────────────────

BENCH_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BENCH_ROOT.parents[1]

_MIKE_HARNESS_SOURCES = (
    Path(__file__),
    Path(__file__).with_name("agent_loop.py"),
    Path(__file__).with_name("mike_workbench.py"),
    Path(__file__).with_name("tools.py"),
    Path(__file__).with_name("adapters") / "codex.py",
    Path(__file__).with_name("adapters") / "openai.py",
    BENCH_ROOT / "sandbox" / "sandbox.py",
    REPO_ROOT / "backend" / "scripts" / "lab-upstream-surface-json.ts",
    REPO_ROOT / "backend" / "scripts" / "lab-upstream-parse-stdin.ts",
    REPO_ROOT / "backend" / "src" / "lib" / "chat" / "tools" / "documentOps.ts",
    REPO_ROOT / "backend" / "src" / "lib" / "chat" / "upstreamMikeBenchmarkSurface.ts",
)


def mike_harness_source_receipts(surface: str) -> list[dict]:
    paths = list(_MIKE_HARNESS_SOURCES)
    if surface in {
        "mike_workbench_anchor_v1",
        "mike_one_shot_fact_index_xhigh_v1",
    }:
        paths.extend(
            [
                REPO_ROOT / "backend" / "scripts" / "anchor-coverage-stdin.ts",
                REPO_ROOT / "backend" / "src" / "lib" / "legalTextAnchors.ts",
            ]
        )
    return [
        {
            "relative_path": path.relative_to(REPO_ROOT).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in paths
    ]

def load_task(task_name: str) -> dict:
    """Load a benchmark task.

    Task names use slash-separated paths under tasks/, e.g.:
        load_task("corporate-ma/analyze-qoe-reconciliation")
        load_task("funds-asset-management/draft-lpa/scenario-01")
    """
    parts = task_name.split("/")
    if len(parts) < 2:
        raise ValueError(
            f"Task name must have at least 2 parts (e.g., 'practice-area/task-slug'), got: {task_name}"
        )
    task_dir = BENCH_ROOT / "tasks" / Path(*parts)

    config_path = task_dir / "task.json"
    if not config_path.exists():
        raise FileNotFoundError(f"task.json not found: {config_path}")
    config = json.loads(config_path.read_text(encoding="utf-8"))

    validate_task_config(config=config, task_path=config_path)

    # Documents directory
    docs_dir = task_dir / "documents"
    if not docs_dir.exists():
        raise FileNotFoundError(f"Documents directory not found: {docs_dir}")

    # Instructions — inline in task.json, otherwise from instructions.md.
    if not (instructions := config.get("instructions")):
        instructions_path = task_dir / "instructions.md"
        if not instructions_path.exists():
            raise ValueError(f"No instructions found in task.json or {instructions_path}")
        instructions = instructions_path.read_text(encoding="utf-8")

    return {
        "name": task_name,
        "task_dir": str(task_dir),
        "docs_dir": str(docs_dir),
        "instructions": instructions,
        "config": config,
    }


# ── Adapter Factory ────────────────────────────────────────────────────

def create_adapter(
    model: str,
    temperature: float = 0.0,
    reasoning_effort: str | None = None,
):
    """Create the right adapter based on the model string.

    Accepts either 'provider/model' format or just the model name:
        claude-opus-4-8, gpt-5.6-sol, gemini-3.5-flash

    Args:
        reasoning_effort: Controls thinking depth; supported values vary by model.
    """
    provider, model_id = model.split("/", 1) if "/" in model else (None, model)

    if provider in {"anthropic"}:
        return AnthropicAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif provider in {"baseten"}:
        return BasetenAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif provider in {"openai", "openai-compatible", "vllm"}:
        return OpenAIAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    # ChatGPT-subscription Codex backend (chatgpt.com/backend-api/codex).
    elif provider in {"codex"}:
        return CodexAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    # Headless Claude Code transport (subscription flat rate, judge's surface).
    elif provider in {"claude-code"}:
        return ClaudeCodeAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    # Local models over ollama (OLLAMA_BASE_URL, default the desktop PC).
    elif provider in {"ollama"}:
        return OllamaAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif provider in {"google"}:
        return GoogleAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif provider in {"mistral"}:
        return MistralAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    # Explicit Fireworks serverless resource path (bare names route below).
    elif model.startswith("accounts/fireworks/"):
        return FireworksAdapter(
            model=model, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif provider is not None:
        raise ValueError(
            f"Unknown provider prefix: {provider!r}. "
            "Supported: anthropic, claude-code, codex, ollama, openai, baseten, "
            "openai-compatible, vllm, google, mistral, and accounts/fireworks/ "
            "(Fireworks serverless)."
        )

    if model_id.startswith("claude"):
        return AnthropicAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif model_id.startswith("gpt") or model_id.startswith("o1") or model_id.startswith("o3") or model_id.startswith("o4"):
        return OpenAIAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif model_id.startswith("gemini"):
        return GoogleAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    elif model_id.startswith("mistral"):
        return MistralAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    # Fireworks-served open models, addressed by bare name; the adapter
    # expands the name to accounts/fireworks/models/<name>.
    elif model_id.startswith(("kimi", "glm", "nemotron")):
        return FireworksAdapter(
            model=model_id, temperature=temperature,
            reasoning_effort=reasoning_effort,
        )

    else:
        raise ValueError(
            f"Can't determine provider for model: {model}. "
            "Model name should start with claude, gpt, o1/o3/o4, gemini, "
            "mistral, or a Fireworks model (kimi*, glm*, nemotron*); or be a "
            "full resource path (accounts/fireworks/models/<name>)."
        )


# ── System prompt preamble ───────────────────────────────────────────
#
# Prepended to the task's `instructions` field. Lives in a markdown file so
# it can be edited and reviewed independently of the harness code. Tells
# the agent about the workspace layout and how to use each tool, so it
# doesn't fall back to `bash find /` when the directional task prompt is
# brief.

SYSTEM_PROMPT_PATH = BENCH_ROOT / "harness" / "system_prompt.md"
SYSTEM_PROMPT_PREAMBLE = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


# ── Skill Loading ─────────────────────────────────────────────────────

SKILLS_DIR = BENCH_ROOT / "harness" / "skills"

# All skills with a SKILL.md file
DEFAULT_SKILLS = sorted(
    p.parent.name for p in SKILLS_DIR.glob("*/SKILL.md")
)


def load_skills(skill_names: list[str]) -> str:
    """Load skill SKILL.md files and return as a system prompt appendage."""
    sections = []
    for name in skill_names:
        skill_path = SKILLS_DIR / name / "SKILL.md"
        if skill_path.exists():
            sections.append(f"\n\n## Skill: {name}\n\n{skill_path.read_text(encoding='utf-8')}")
        else:
            print(f"Warning: skill '{name}' not found at {skill_path}")
    return "\n".join(sections)


def setup_skill_scripts(skill_names: list[str], workspace_dir: Path):
    """Copy skill scripts into the workspace so the agent can invoke them via bash."""
    for name in skill_names:
        scripts_dir = SKILLS_DIR / name / "scripts"
        if scripts_dir.exists():
            dest = workspace_dir / "skills" / name / "scripts"
            shutil.copytree(scripts_dir, dest, dirs_exist_ok=True)


# ── CLI ────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Run an agent evaluation")
parser.add_argument("--model", required=True, help="Model identifier (e.g., claude-sonnet-5)")
parser.add_argument("--task", required=True, help="Task ID (e.g., corporate-ma/review-data-room-red-flag-review)")
parser.add_argument("--run-id", default=None, help="Unique run identifier (auto-generated if omitted)")
parser.add_argument("--max-turns", type=int, default=200, help="Max agent loop turns")
parser.add_argument("--temperature", type=float, default=0.0, help="Model temperature")
parser.add_argument("--shell-timeout", type=int, default=60, help="Shell command timeout (seconds)")
parser.add_argument(
    "--preflight-only",
    action="store_true",
    help="Print deterministic task/source/prompt/tool fingerprints without starting a sandbox or model call.",
)
parser.add_argument("--reasoning-effort", default=None,
                    help="Reasoning effort level (e.g., low/medium/high/max/xhigh — varies by provider)")
parser.add_argument("--skills", nargs="*", default=None,
                    help="Skills to load into system prompt (default: all available). Use --skills with no args to disable.")
parser.add_argument("--sandbox-image", default=DEFAULT_IMAGE,
                    help="Container image tag for the sandbox (default: %(default)s); "
                         "pulled from ghcr.io and built locally as fallback.")
parser.add_argument(
    "--surface",
    choices=(
        "standard",
        "coding_plain_v1",
        "coding_legal_v1",
        "mike_control_v1",
        "mike_workbench_v1",
        "mike_workbench_anchor_v1",
        "mike_one_shot_v1",
        "mike_one_shot_xhigh_v1",
        "mike_one_shot_fact_index_xhigh_v1",
        "mike_one_shot_conflict_first_xhigh_v1",
        "mike_one_shot_native_xhigh_v1",
        "mike_one_shot_quote_first_xhigh_v1",
        "mike_one_shot_monotonic_review_xhigh_v1",
    ),
    default="standard",
    help="Tool surface for a preregistered harness ablation.",
)


# ── Main ───────────────────────────────────────────────────────────────

def _load_env():
    """Auto-load .env if it exists and keys aren't already set."""
    env_path = BENCH_ROOT / ".env"
    if not env_path.exists():
        return
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                key, value = key.strip(), value.strip().strip('"').strip("'")
                if key and value:
                    os.environ.setdefault(key, value)


def main(args):
    force_utf8_stdio()
    _load_env()

    # Auto-generate run-id: task/model[-effort]/timestamp
    if args.run_id is None:
        model_short = args.model.split("/")[-1].replace(".", "-")
        effort_suffix = f"-{args.reasoning_effort}" if args.reasoning_effort else ""
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        model_dir = f"{model_short}{effort_suffix}"
        args.run_id = f"{args.task}/{model_dir}/{ts}"

    # Load task
    print(f"Loading task: {args.task}")
    task = load_task(task_name=args.task)
    mike_surface = args.surface in MIKE_SURFACES
    effective_max_turns = min(args.max_turns, 10) if mike_surface else args.max_turns

    configured_deliverables = task["config"].get("deliverables") or {}
    if isinstance(configured_deliverables, dict):
        deliverables = list(configured_deliverables)
    else:
        deliverables = []
    if not deliverables:
        deliverables = list(
            dict.fromkeys(
                name
                for criterion in task["config"].get("criteria", [])
                for name in criterion.get("deliverables", [])
            )
        )
    document_paths = sorted(
        path for path in Path(task["docs_dir"]).rglob("*") if path.is_file()
    )
    document_inventory = [
        (path.name, path.suffix.lstrip(".").lower()) for path in document_paths
    ]
    task_config_bytes = (Path(task["task_dir"]) / "task.json").read_bytes()
    source_receipts = [
        {
            "relative_path": path.relative_to(Path(task["docs_dir"])).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in document_paths
    ]
    source_bundle_bytes = json.dumps(
        source_receipts, sort_keys=True, separators=(",", ":")
    ).encode()
    task_fingerprints = {
        "task_config_sha256": hashlib.sha256(task_config_bytes).hexdigest(),
        "instructions_sha256": hashlib.sha256(task["instructions"].encode()).hexdigest(),
        "source_bundle_sha256": hashlib.sha256(source_bundle_bytes).hexdigest(),
        "source_receipts": source_receipts,
    }
    harness_fingerprints = {}
    if mike_surface:
        harness_source_receipts = mike_harness_source_receipts(args.surface)
        harness_source_bytes = json.dumps(
            harness_source_receipts, sort_keys=True, separators=(",", ":")
        ).encode()
        harness_fingerprints = {
            "harness_source_bundle_sha256": hashlib.sha256(
                harness_source_bytes
            ).hexdigest(),
            "harness_source_receipts": harness_source_receipts,
        }

    if args.preflight_only:
        if not mike_surface:
            raise ValueError("--preflight-only currently supports the Mike workbench surfaces")
        system_prompt, tools, frozen = get_mike_surface(
            args.surface,
            document_inventory,
        )
        schema_bytes = json.dumps(
            tools, sort_keys=True, separators=(",", ":")
        ).encode()
        responses_tools = [{"type": "function", **tool} for tool in tools]
        prompt_cache_key = prompt_cache_key_for(
            args.model.split("/", 1)[-1],
            system_prompt,
            task["instructions"],
            responses_tools,
        )
        fingerprint_input = {
            "model": args.model,
            "reasoning_effort": args.reasoning_effort,
            "task": args.task,
            "surface": args.surface,
            "max_turns": effective_max_turns,
            "temperature": args.temperature,
            "provider_service_tier": "default",
            "sandbox_engine": ENGINE,
            "sandbox_image": args.sandbox_image,
            "deliverables": deliverables,
            **task_fingerprints,
            **harness_fingerprints,
            "system_prompt_sha256": hashlib.sha256(system_prompt.encode()).hexdigest(),
            "tool_schema_sha256": hashlib.sha256(schema_bytes).hexdigest(),
            "prompt_cache_key": prompt_cache_key,
            "upstream_mike_commit": frozen["commit"],
            "upstream_mike_schema_sha256": frozen["schema_sha256"],
            "upstream_mike_source_blobs": frozen["source_blobs"],
        }
        result = {
            **fingerprint_input,
            "system_prompt_bytes": len(system_prompt.encode()),
            "tool_schema_bytes": len(schema_bytes),
        }
        result["run_fingerprint_sha256"] = hashlib.sha256(
            json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        print(json.dumps(result, indent=2))
        return

    # Create output directory
    results_dir = BENCH_ROOT / "results" / args.run_id
    output_dir = results_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Workspace directory (scratch space for intermediate files)
    workspace_dir = results_dir / "workspace"
    workspace_dir.mkdir(parents=True, exist_ok=True)

    # Resolve skills (default: all available)
    skill_names = (
        [] if mike_surface else DEFAULT_SKILLS if args.skills is None else args.skills
    )

    # Open the sandbox first — it owns the per-run filesystem boundary.
    sandbox = Sandbox(
        documents_dir=Path(task["docs_dir"]),
        output_dir=output_dir,
        workspace_dir=workspace_dir,
        image=args.sandbox_image,
        default_timeout=args.shell_timeout,
    )
    sandbox.start()
    print(f"Sandbox: {ENGINE} (documents={sandbox.documents_dir})")

    # Save config
    config = {
        "model": args.model,
        "task": args.task,
        "run_id": args.run_id,
        "max_turns": effective_max_turns,
        "temperature": args.temperature,
        "shell_timeout": args.shell_timeout,
        "reasoning_effort": args.reasoning_effort,
        "skills": skill_names,
        "sandbox_image": args.sandbox_image,
        "sandbox_engine": ENGINE,
        "provider_service_tier": "default",
        "surface": args.surface,
        "started_at": datetime.now(timezone.utc).isoformat(),
        **task_fingerprints,
        **harness_fingerprints,
    }
    (results_dir / "config.json").write_text(json.dumps(config, indent=2))

    # Create adapter and tool executor
    print(f"Creating adapter for: {args.model}")
    adapter = create_adapter(
        model=args.model,
        temperature=args.temperature,
        reasoning_effort=args.reasoning_effort,
    )

    frozen_mike_surface = None
    mike_system_prompt = None
    if args.surface == "standard":
        tool_executor = ToolExecutor(
            sandbox=sandbox,
            shell_timeout=args.shell_timeout,
        )
        tools = get_all_tool_definitions()
    elif mike_surface:
        mike_system_prompt, tools, frozen_mike_surface = get_mike_surface(
            args.surface,
            document_inventory,
        )
        tool_executor = MikeWorkbenchExecutor(
            sandbox=sandbox,
            shell_timeout=args.shell_timeout,
            deliverables=deliverables,
            anchor_enabled=args.surface == "mike_workbench_anchor_v1",
            surface_name=args.surface,
            task_instructions=task["instructions"],
        )
    else:
        tool_executor = AblationToolExecutor(
            sandbox=sandbox,
            shell_timeout=args.shell_timeout,
            legal_scopes=args.surface == "coding_legal_v1",
        )
        tools = get_ablation_tool_definitions(
            legal_scopes=args.surface == "coding_legal_v1"
        )

    # Build the system prompt: preamble (workspace + tools + conventions)
    # + skill manuals. Capabilities only — no task content. The per-task
    # instructions go in the first user message so the model treats them as
    # an assignment, not as additional ambient context.
    system_prompt = mike_system_prompt or SYSTEM_PROMPT_PREAMBLE
    if args.surface != "standard" and not mike_surface:
        system_prompt += (
            "\n\n## Source projections\n\n"
            "`/workspace/sources/manifest.json` maps every read-only original "
            "document to a deterministic UTF-8 projection with exact hashes "
            "and sizes. `glob` and `grep` default to those projections. Read a "
            "small/few-document matter whole when useful; for a large matter, "
            "use grep and bounded read calls to curate context. The original "
            "documents remain under `/workspace/documents`; write every final "
            "deliverable under `/workspace/output`.\n"
        )
    if skill_names:
        skills_text = load_skills(skill_names)
        system_prompt += skills_text
        setup_skill_scripts(skill_names, workspace_dir)
    user_prompt = task["instructions"]
    schema_bytes = json.dumps(tools, sort_keys=True, separators=(",", ":")).encode()
    responses_tools = [{"type": "function", **tool} for tool in tools]
    prompt_cache_key = prompt_cache_key_for(
        args.model.split("/", 1)[-1],
        system_prompt,
        user_prompt,
        responses_tools,
    )
    if hasattr(adapter, "prompt_cache_key"):
        adapter.prompt_cache_key = prompt_cache_key
    config.update(
        {
            "instructions_sha256": hashlib.sha256(user_prompt.encode()).hexdigest(),
            "system_prompt_sha256": hashlib.sha256(system_prompt.encode()).hexdigest(),
            "system_prompt_bytes": len(system_prompt.encode()),
            "tool_schema_sha256": hashlib.sha256(schema_bytes).hexdigest(),
            "tool_schema_bytes": len(schema_bytes),
            "deliverables": deliverables,
            "prompt_cache_key": prompt_cache_key,
            "upstream_mike_commit": (
                frozen_mike_surface.get("commit") if frozen_mike_surface else None
            ),
            "upstream_mike_schema_sha256": (
                frozen_mike_surface.get("schema_sha256") if frozen_mike_surface else None
            ),
            "upstream_mike_source_blobs": (
                frozen_mike_surface.get("source_blobs") if frozen_mike_surface else None
            ),
        }
    )
    run_fingerprint_input = {
        "model": args.model,
        "reasoning_effort": args.reasoning_effort,
        "task": args.task,
        "surface": args.surface,
        "max_turns": effective_max_turns,
        "temperature": args.temperature,
        "provider_service_tier": config["provider_service_tier"],
        "sandbox_engine": config["sandbox_engine"],
        "sandbox_image": config["sandbox_image"],
        "deliverables": deliverables,
        **task_fingerprints,
        **harness_fingerprints,
        "system_prompt_sha256": config["system_prompt_sha256"],
        "tool_schema_sha256": config["tool_schema_sha256"],
        "prompt_cache_key": config["prompt_cache_key"],
        "upstream_mike_commit": config["upstream_mike_commit"],
        "upstream_mike_schema_sha256": config["upstream_mike_schema_sha256"],
        "upstream_mike_source_blobs": config["upstream_mike_source_blobs"],
    }
    config["run_fingerprint_sha256"] = hashlib.sha256(
        json.dumps(run_fingerprint_input, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    (results_dir / "config.json").write_text(json.dumps(config, indent=2))

    # Run the agent
    print(f"Starting agent loop (max {args.max_turns} turns)...")
    print(f"Tools: {len(tools)} ({', '.join(t['name'] for t in tools)})")
    if skill_names:
        print(f"Skills: {', '.join(skill_names)}")
    print(f"Documents: {task['docs_dir']}")
    print(f"Output: {output_dir}")
    print()

    try:
        result = run_agent(
            adapter=adapter,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            tool_executor=tool_executor,
            tools=tools,
            max_turns=effective_max_turns,
            transcript_path=str(results_dir / "transcript.jsonl"),
        )
    finally:
        sandbox.stop()

    # Save metrics
    transport_retry_count = int(
        getattr(
            getattr(getattr(adapter, "client", None), "responses", None),
            "transport_retry_count",
            0,
        )
    )
    metrics = {
        "model": args.model,
        "task": args.task,
        "run_id": args.run_id,
        "turn_count": result["turn_count"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "reasoning_tokens": result["reasoning_tokens"],
        "total_tokens": result["input_tokens"] + result["output_tokens"],
        "cached_input_tokens": result["cached_input_tokens"],
        "cache_write_input_tokens": result["cache_write_input_tokens"],
        "cache_read_ratio": (
            result["cached_input_tokens"] / result["input_tokens"]
            if result["input_tokens"]
            else 0
        ),
        "uncached_input_tokens": max(
            0,
            result["input_tokens"]
            - result["cached_input_tokens"]
            - result["cache_write_input_tokens"],
        ),
        "context_rounds": result["context_rounds"],
        "provider_request_count": len(result["context_rounds"]),
        "transport_retry_count": transport_retry_count,
        "service_tiers_reported": sorted(
            {
                round_["service_tier"]
                for round_ in result["context_rounds"]
                if round_["service_tier"]
            }
        ),
        "tool_call_count": result["tool_call_count"],
        "tool_result_characters": result["tool_result_characters"],
        "tool_result_bytes": result["tool_result_bytes"],
        "tool_error_count": result["tool_error_count"],
        "tool_batches": result["tool_batches"],
        "surface": args.surface,
        "prompt_cache_key": config["prompt_cache_key"],
        "instructions_sha256": config["instructions_sha256"],
        "system_prompt_sha256": config["system_prompt_sha256"],
        "system_prompt_bytes": config["system_prompt_bytes"],
        "tool_schema_sha256": config["tool_schema_sha256"],
        "tool_schema_bytes": config["tool_schema_bytes"],
        "task_config_sha256": config["task_config_sha256"],
        "source_bundle_sha256": config["source_bundle_sha256"],
        "run_fingerprint_sha256": config["run_fingerprint_sha256"],
        "wall_clock_seconds": result["wall_clock_seconds"],
        "finished_cleanly": result["finished_cleanly"],
        "completed_at": datetime.now(timezone.utc).isoformat(),
        **result["tool_metrics"],
    }
    (results_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))

    # Print summary
    print()
    print("=" * 60)
    print(f"Run complete: {args.run_id}")
    print(f"  Model:          {args.model}")
    print(f"  Turns:          {result['turn_count']}")
    print(f"  Input tokens:   {result['input_tokens']:,}")
    print(f"  Output tokens:  {result['output_tokens']:,}")
    print(f"  Wall clock:     {result['wall_clock_seconds']:.1f}s")
    print(f"  Docs read:      {metrics['documents_read']}/{metrics['total_documents']}")
    print(f"  Finished:       {result['finished_cleanly']}")
    print(f"\nResults saved to: {results_dir}")


if __name__ == "__main__":
    main(parser.parse_args())
