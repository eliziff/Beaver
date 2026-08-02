"""Run the stock Codex harness in a task-only Docker workspace."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from utils.stdio import force_utf8_stdio


SURFACE = "codex_native_v1"
DEFAULT_IMAGE = "lab-codex-native:0.146.0"
BENCH_ROOT = Path(__file__).resolve().parent.parent


def _sha256(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _run(
    argv: list[str],
    *,
    stdin: str | None = None,
    timeout: int = 120,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def _load_task(task_name: str) -> tuple[str, Path]:
    task_dir = BENCH_ROOT / "tasks" / Path(*task_name.split("/"))
    config_path = task_dir / "task.json"
    documents = task_dir / "documents"
    if not config_path.is_file() or not documents.is_dir():
        raise FileNotFoundError(f"task or documents missing: {task_dir}")
    config = json.loads(config_path.read_text(encoding="utf-8"))
    instructions = config.get("instructions")
    if not instructions:
        instructions = (task_dir / "instructions.md").read_text(encoding="utf-8")
    return str(instructions), documents.resolve()


def _auth_file() -> Path:
    configured = os.environ.get("CODEX_HOME", "").strip()
    root = Path(configured) if configured else Path.home() / ".codex"
    auth = (root / "auth.json").resolve()
    if not auth.is_file():
        raise FileNotFoundError(f"Codex auth missing: {auth}; run codex login")
    return auth


def _receipts(root: Path) -> list[dict]:
    receipts = []
    for path in sorted(file for file in root.rglob("*") if file.is_file()):
        data = path.read_bytes()
        receipts.append(
            {
                "path": path.relative_to(root).as_posix(),
                "bytes": len(data),
                "sha256": _sha256(data),
            }
        )
    return receipts


def _events(raw: str) -> list[dict]:
    events = []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def _last_usage(events: list[dict]) -> dict:
    usages = [event["usage"] for event in events if isinstance(event.get("usage"), dict)]
    return usages[-1] if usages else {}


def _mount(source: Path, target: str, *, readonly: bool = False) -> str:
    value = f"type=bind,src={source},dst={target}"
    return f"{value},readonly" if readonly else value


def _preflight(image: str, documents: Path, output: Path) -> dict:
    command = (
        "set -eu; find documents -maxdepth 1 -type f -print -quit | grep -q .; "
        "printf ok > output/.codex-native-probe; "
        "if printf bad > documents/.write-probe 2>/dev/null; then exit 31; fi; "
        "test ! -e /host-repository; rm output/.codex-native-probe; codex --version"
    )
    completed = _run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--security-opt",
            "seccomp=unconfined",
            "--mount",
            _mount(documents, "/workspace/documents", readonly=True),
            "--mount",
            _mount(output, "/workspace/output"),
            image,
            "codex",
            "sandbox",
            "-P",
            ":workspace",
            "-C",
            "/workspace",
            "--",
            "bash",
            "-lc",
            command,
        ],
        timeout=60,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"native Codex container preflight failed: {completed.stderr[-1000:]}")
    return {
        "passed": True,
        "documents_read_only": True,
        "output_read_write": True,
        "host_repository_mounted": False,
        "container_network_during_probe": "none",
        "inner_codex_sandbox": "passed",
        "docker_security_opt": "seccomp=unconfined",
        "codex_version": completed.stdout.strip(),
    }


def main(args: argparse.Namespace) -> None:
    force_utf8_stdio()
    instructions, documents = _load_task(args.task)
    auth = _auth_file()
    results = Path(args.results_root).resolve() / Path(*args.run_id.split("/"))
    if results.exists():
        raise FileExistsError(f"run already exists: {results}")
    output = results / "output"
    output.mkdir(parents=True)

    inspect = _run(
        ["docker", "image", "inspect", args.image, "--format", "{{.Id}}"],
        timeout=30,
    )
    if inspect.returncode != 0:
        raise RuntimeError(f"native Codex image unavailable: {args.image}")
    preflight = _preflight(args.image, documents, output)
    prompt = (
        "Complete the original user request in this clean workspace. Source documents are "
        "read-only in documents/. Put every requested final deliverable in output/. Do not "
        "use the web.\n\nORIGINAL USER REQUEST:\n" + instructions
    )
    container_name = f"lab-codex-{_sha256(args.run_id)[:16]}"
    codex_args = [
        "codex",
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--strict-config",
        "--sandbox",
        "workspace-write",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--cd",
        "/workspace",
        "--model",
        args.model,
        "--config",
        f'model_reasoning_effort="{args.effort}"',
        "--config",
        'approval_policy="never"',
        "--config",
        'web_search="disabled"',
        "-",
    ]
    docker_args = [
        "docker",
        "run",
        "--rm",
        "--interactive",
        "--security-opt",
        "seccomp=unconfined",
        "--name",
        container_name,
        "--mount",
        _mount(documents, "/workspace/documents", readonly=True),
        "--mount",
        _mount(output, "/workspace/output"),
        "--mount",
        _mount(auth, "/root/.codex/auth.json", readonly=True),
        args.image,
        *codex_args,
    ]
    config = {
        "surface": SURFACE,
        "task": args.task,
        "run_id": args.run_id,
        "model": args.model,
        "reasoning_effort": args.effort,
        "service_tier_requested": None,
        "image": args.image,
        "image_id": inspect.stdout.strip(),
        "codex_version": preflight["codex_version"],
        "codex_argv": codex_args,
        "prompt_bytes": len(prompt.encode("utf-8")),
        "prompt_sha256": _sha256(prompt),
        "instructions_sha256": _sha256(instructions),
        "source_receipts": _receipts(documents),
        "mounts": {
            "documents": "read_only",
            "output": "read_write",
            "auth": "read_only_not_model_visible",
            "host_repository": "not_mounted",
        },
        "preflight": preflight,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    config["source_bundle_sha256"] = _sha256(
        json.dumps(config["source_receipts"], sort_keys=True, separators=(",", ":"))
    )
    (results / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
    if args.conformance_only:
        print(json.dumps(preflight, indent=2))
        return

    started = time.time()
    try:
        completed = _run(docker_args, stdin=prompt, timeout=args.max_seconds)
    except subprocess.TimeoutExpired as exc:
        (results / "transcript.jsonl").write_text(exc.stdout or "", encoding="utf-8")
        (results / "stderr.txt").write_text(exc.stderr or "", encoding="utf-8")
        raise
    finally:
        if re.fullmatch(r"lab-codex-[0-9a-f]{16}", container_name):
            _run(["docker", "rm", "--force", container_name], timeout=30)
    elapsed = round(time.time() - started, 2)
    (results / "transcript.jsonl").write_text(completed.stdout, encoding="utf-8")
    (results / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        raise RuntimeError(f"codex exec failed ({completed.returncode}): {completed.stderr[-1000:]}")

    events = _events(completed.stdout)
    usage = _last_usage(events)
    items = [event.get("item") for event in events if isinstance(event.get("item"), dict)]
    commands = [item for item in items if item.get("type") == "command_execution"]
    artifacts = _receipts(output)
    input_tokens = int(usage.get("input_tokens", 0) or 0)
    output_tokens = int(usage.get("output_tokens", 0) or 0)
    metrics = {
        "surface": SURFACE,
        "model": args.model,
        "task": args.task,
        "run_id": args.run_id,
        "input_tokens": input_tokens,
        "cached_input_tokens": int(usage.get("cached_input_tokens", 0) or 0),
        "output_tokens": output_tokens,
        "reasoning_tokens": int(usage.get("reasoning_tokens", 0) or 0),
        "total_tokens": input_tokens + output_tokens,
        "provider_request_count": sum(event.get("type") == "turn.completed" for event in events),
        "command_count": len(commands),
        "commands": commands,
        "compaction_count": sum(
            "compact" in str(event.get("type", "")).lower() for event in events
        ),
        "event_count": len(events),
        "wall_clock_seconds": elapsed,
        "service_tier_requested": None,
        "service_tiers_reported": sorted(
            {str(event["service_tier"]) for event in events if event.get("service_tier")}
        ),
        "finished_cleanly": bool(artifacts),
        "deliverable_count": len(artifacts),
        "deliverable_receipts": artifacts,
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }
    (results / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    if not artifacts:
        raise RuntimeError("native Codex run produced no deliverable")
    print(json.dumps({"run_id": args.run_id, "metrics": metrics}, indent=2))


parser = argparse.ArgumentParser(description="Run stock Codex in a task-only LAB container")
parser.add_argument("--task", required=True)
parser.add_argument("--run-id", required=True)
parser.add_argument("--model", default="gpt-5.6-luna")
parser.add_argument("--effort", default="high")
parser.add_argument("--image", default=DEFAULT_IMAGE)
parser.add_argument("--results-root", default=str(BENCH_ROOT / "results"))
parser.add_argument("--max-seconds", type=int, default=7200)
parser.add_argument("--conformance-only", action="store_true")


if __name__ == "__main__":
    main(parser.parse_args())
