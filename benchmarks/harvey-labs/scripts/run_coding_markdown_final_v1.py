"""Frozen, resumable runner for a registered coding-markdown-final experiment.

The registration owns the cell order, fingerprints, model lanes, judging,
retry policy, and pass gates. This script only executes that registration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import statistics
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
LAB = ROOT / "benchmarks" / "harvey-labs"
BACKEND = ROOT / "backend"
RESULTS = LAB / "results"
REGISTRATION_RELATIVE = Path(
    "docs/harvey-lab-coding-markdown-final-v1-preregistration-2026-08-08.json"
)
REGISTRATION_PATH = ROOT / REGISTRATION_RELATIVE
RUNNER_RELATIVE = Path(
    "benchmarks/harvey-labs/scripts/run_coding_markdown_final_v1.py"
)
ANALYSIS_DIR = LAB / "run-logs" / "coding-markdown-final-v1" / "analysis"
TRANSPORT_PATTERN = re.compile(
    r"terminated|fetch failed|socket hang up|other side closed|ECONNRESET|"
    r"ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_|"
    r"DeepSeek request failed \((?:429|500|502|503|504)\)",
    re.IGNORECASE,
)
REQUIRED_RUN_FILES = (
    "config.json",
    "metrics.json",
    "transcript.jsonl",
    "beaver-receipts.json",
    "run-state.json",
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_checked(argv: list[str], *, cwd: Path = ROOT) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=True,
    )


def git(*args: str) -> str:
    return run_checked(["git", "-C", str(ROOT), *args]).stdout.strip()


def registration() -> dict[str, Any]:
    value = load_json(REGISTRATION_PATH)
    if not str(value.get("experiment_id") or "").startswith(
        "harvey-lab-coding-markdown-final-"
    ):
        raise RuntimeError("Unexpected experiment registration")
    if value.get("status") != "preregistered_before_inference":
        raise RuntimeError("Registration is not launch-ready")
    return value


def verify_commit_and_sources(spec: dict[str, Any]) -> str:
    head = git("rev-parse", "HEAD")
    registered_commit = git(
        "log", "-1", "--format=%H", "--", REGISTRATION_RELATIVE.as_posix()
    )
    if not registered_commit or head != registered_commit:
        raise RuntimeError(
            f"HEAD {head} is not the commit containing the registration "
            f"({registered_commit or 'missing'})"
        )
    scoped = spec["prelaunch_commit_gate"]["scoped_paths"]
    for relative in scoped:
        git("ls-files", "--error-unmatch", "--", relative)
        dirty = subprocess.run(
            ["git", "-C", str(ROOT), "diff", "--quiet", "HEAD", "--", relative]
        ).returncode
        if dirty:
            raise RuntimeError(f"Experiment-scoped file differs from HEAD: {relative}")
    for relative, expected in spec["source_fingerprints"].items():
        if expected.startswith("__FILL_"):
            raise RuntimeError(f"Unresolved source fingerprint: {relative}")
        actual = sha256(ROOT / relative)
        if actual != expected:
            raise RuntimeError(
                f"Source fingerprint mismatch for {relative}: {actual} != {expected}"
            )
    return head


def parse_probe(stdout: str, stderr: str) -> dict[str, Any]:
    for line in reversed((stdout + "\n" + stderr).splitlines()):
        text = line.strip()
        if text.startswith("{") and text.endswith("}"):
            try:
                value = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and "task" in value:
                return value
    raise RuntimeError("Surface probe returned no JSON receipt")


def verify_surfaces(spec: dict[str, Any], lane: str, phase: str) -> None:
    lane_spec = spec["lanes"][lane]
    node = os.environ.get("NODE", "node")
    tsx = BACKEND / "node_modules" / "tsx" / "dist" / "cli.mjs"
    arm_runner = BACKEND / "scripts" / "lab-beaver-arm.ts"
    task_fields = (
        "split_sha256",
        "task_config_sha256",
        "instructions_sha256",
        "source_bundle_sha256",
        "source_count",
        "source_bytes",
    )
    if phase == "preflight":
        tasks = [spec["preflight"]["task"]]
        arms = [spec["preflight"]["arm"]]
    elif phase in spec["stages"]:
        tasks = list(dict.fromkeys(
            cell["task"] for cell in spec["stages"][phase]["cells"]
        ))
        arms = spec["arms"]
    else:
        tasks = list(spec["task_fingerprints"])
        arms = spec["arms"]
    for task in tasks:
        expected_task = spec["task_fingerprints"][task]
        for arm in arms:
            completed = run_checked(
                [
                    node,
                    str(tsx),
                    str(arm_runner),
                    "--task",
                    task,
                    "--arm",
                    arm,
                    "--model",
                    lane_spec["performer_model"],
                    "--effort",
                    lane_spec["performer_effort"],
                    "--preflight-only",
                ],
                cwd=BACKEND,
            )
            probe = parse_probe(completed.stdout, completed.stderr)
            for field in task_fields:
                if str(probe.get(field)) != str(expected_task[field]):
                    raise RuntimeError(
                        f"Task fingerprint drift: {task} {field} "
                        f"{probe.get(field)} != {expected_task[field]}"
                    )
            expected_surface = spec["surface_fingerprints"][task][arm]
            for field in (
                "system_prompt_sha256",
                "tool_schema_sha256",
                "tool_names",
            ):
                if probe.get(field) != expected_surface[field]:
                    raise RuntimeError(
                        f"Surface drift: {task} {arm} {field} "
                        f"{probe.get(field)} != {expected_surface[field]}"
                    )


def phase_cells(spec: dict[str, Any], phase: str) -> list[dict[str, Any]]:
    if phase == "preflight":
        return [spec["preflight"]]
    return list(spec["stages"][phase]["cells"])


def run_id(spec: dict[str, Any], lane: str, phase: str, cell: dict[str, Any]) -> str:
    lane_spec = spec["lanes"][lane]
    root = (
        f"{cell['task']}/beaver-{cell['arm']}-{lane_spec['result_slug']}/"
        f"{lane_spec['run_stamp']}"
    )
    if phase == "preflight":
        return root + "-preflight-r1"
    return (
        root
        + f"-{phase}-o{int(cell['order']):02d}-r{int(cell['replicate'])}"
    )


def retry_run_id(base_run_id: str) -> str:
    return base_run_id + "-retry1"


def run_directory(identifier: str) -> Path:
    return RESULTS.joinpath(*identifier.split("/"))


def expected_deliverables(task: str) -> list[str]:
    config = load_json(LAB.joinpath("tasks", *task.split("/"), "task.json"))
    deliverables = config.get("deliverables")
    if not isinstance(deliverables, dict) or not deliverables:
        raise RuntimeError(f"Task has no deliverable mapping: {task}")
    return list(deliverables)


def validate_docx(path: Path) -> None:
    if path.suffix.lower() != ".docx" or path.stat().st_size == 0:
        raise RuntimeError(f"Missing or empty DOCX: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            if "word/document.xml" not in archive.namelist():
                raise RuntimeError(f"Malformed DOCX has no word/document.xml: {path}")
            archive.testzip()
    except zipfile.BadZipFile as error:
        raise RuntimeError(f"Malformed DOCX: {path}") from error


def source_mutation_attempts(receipts: dict[str, Any]) -> list[str]:
    attempts: list[str] = []
    for call in receipts.get("tool_calls") or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or "")
        inputs = call.get("input") if isinstance(call.get("input"), dict) else {}
        if name == "edit_document":
            attempts.append(name)
        elif name == "Edit":
            target = str(inputs.get("file_path") or "")
            if not target.lower().endswith(".md"):
                attempts.append(f"Edit:{target}")
    return attempts


def validate_run(
    spec: dict[str, Any], identifier: str, cell: dict[str, Any]
) -> dict[str, Any]:
    directory = run_directory(identifier)
    for name in REQUIRED_RUN_FILES:
        path = directory / name
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"{identifier}: missing {name}")
    metrics = load_json(directory / "metrics.json")
    receipts = load_json(directory / "beaver-receipts.json")
    state = load_json(directory / "run-state.json")
    if state.get("status") != "completed" or metrics.get("finished_cleanly") is not True:
        raise RuntimeError(f"{identifier}: run did not finish cleanly")
    if metrics.get("task") != cell["task"] or metrics.get("arm") != cell["arm"]:
        raise RuntimeError(f"{identifier}: task/arm receipt mismatch")
    if int(metrics.get("failed_tool_calls") or 0) != 0:
        raise RuntimeError(f"{identifier}: failed or malformed tool call")
    if int(metrics.get("compaction_count") or 0) != 0:
        raise RuntimeError(f"{identifier}: compaction is not allowed")
    for field in (
        "input_tokens",
        "uncached_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
        "wall_clock_seconds",
    ):
        if not isinstance(metrics.get(field), (int, float)):
            raise RuntimeError(f"{identifier}: missing numeric metric {field}")
    if metrics.get("cache_read_reporting_complete") is not True:
        raise RuntimeError(f"{identifier}: cache-read accounting is incomplete")
    mutations = source_mutation_attempts(receipts)
    if mutations:
        raise RuntimeError(f"{identifier}: source mutation attempt(s): {mutations}")

    expected = expected_deliverables(cell["task"])
    mapping = metrics.get("required_deliverable_mapping")
    if not isinstance(mapping, dict) or set(mapping) != set(expected):
        raise RuntimeError(f"{identifier}: required deliverable mapping is incomplete")
    hashes: list[str] = []
    for required in expected:
        actual = mapping.get(required)
        if not isinstance(actual, str) or not actual:
            raise RuntimeError(f"{identifier}: invalid mapping for {required}")
        output = directory / "output" / actual
        validate_docx(output)
        hashes.append(sha256(output))
    if len(hashes) != len(set(hashes)):
        raise RuntimeError(f"{identifier}: deliverables are byte-identical clones")
    deliverable_receipts = metrics.get("deliverable_receipts") or []
    if len(deliverable_receipts) != len(expected) or any(
        not isinstance(entry, dict)
        or entry.get("source") != "library"
        or not isinstance(entry.get("text_sha256"), str)
        for entry in deliverable_receipts
    ):
        raise RuntimeError(f"{identifier}: plain-text or silent fallback detected")
    semantic_hashes = [entry["text_sha256"] for entry in deliverable_receipts]
    if len(semantic_hashes) != len(set(semantic_hashes)):
        raise RuntimeError(f"{identifier}: deliverables are semantic clones")

    if cell["arm"] == spec["comparisons"]["primary"]["candidate"]:
        final = receipts.get("final_arm_receipt")
        if not isinstance(final, dict):
            raise RuntimeError(f"{identifier}: missing final-arm receipt")
        coverage = final.get("first_draft_coverage")
        if not isinstance(coverage, dict):
            raise RuntimeError(f"{identifier}: missing first-draft coverage")
        coverage_total = sum(
            len(coverage.get(name) or [])
            for name in ("bodyEvidence", "tocOnly", "unseen")
        )
        if coverage_total != int(metrics.get("total_documents") or 0):
            raise RuntimeError(f"{identifier}: first-draft coverage is incomplete")
        gap_count = len(coverage.get("tocOnly") or []) + len(
            coverage.get("unseen") or []
        )
        expected_gate = 1 if gap_count else 0
        if int(final.get("first_draft_count") or 0) != 1:
            raise RuntimeError(f"{identifier}: expected exactly one first draft")
        if int(final.get("signal_gate_count") or 0) != expected_gate:
            raise RuntimeError(f"{identifier}: signal-gate count disagrees with coverage")
        if int(final.get("source_edit_count") or 0) != 0 or int(
            final.get("source_edit_refusal_count") or 0
        ) != 0:
            raise RuntimeError(f"{identifier}: source Edit was attempted")
        if int(final.get("composition_check_shadow_count") or 0) < 1:
            raise RuntimeError(f"{identifier}: shadow check did not run")
    return metrics


def has_usable_output(directory: Path) -> bool:
    raw = directory / "raw-sse.txt"
    if not raw.is_file():
        return False
    for line in raw.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.startswith("data: {"):
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
        if event.get("type") == "tool_call_start":
            return True
        if event.get("type") in ("content_delta", "content_final") and str(
            event.get("text") or ""
        ).strip():
            return True
    return False


def retryable_transport_failure(identifier: str) -> bool:
    directory = run_directory(identifier)
    state_path = directory / "run-state.json"
    if not state_path.is_file() or has_usable_output(directory):
        return False
    try:
        state = load_json(state_path)
    except (OSError, json.JSONDecodeError):
        return False
    return state.get("status") == "failed" and bool(
        TRANSPORT_PATTERN.search(str(state.get("error") or ""))
    )


def complete_identifier(
    spec: dict[str, Any], base: str, cell: dict[str, Any]
) -> str | None:
    for identifier in (base, retry_run_id(base)):
        if not run_directory(identifier).exists():
            continue
        try:
            validate_run(spec, identifier, cell)
        except RuntimeError:
            continue
        return identifier
    return None


def log_root(spec: dict[str, Any], lane: str) -> Path:
    lane_spec = spec["lanes"][lane]
    experiment_slug = str(spec["experiment_id"]).removeprefix("harvey-lab-")
    return LAB / "run-logs" / experiment_slug / lane / lane_spec["run_stamp"]


def append_log(path: Path, message: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with path.open("a", encoding="utf-8") as stream:
        stream.write(f"{timestamp} {message}\n")
        stream.flush()
    print(message, flush=True)


def state_path(spec: dict[str, Any], lane: str, phase: str) -> Path:
    return log_root(spec, lane) / f"state-{phase}.json"


def load_state(spec: dict[str, Any], lane: str, phase: str) -> dict[str, Any]:
    path = state_path(spec, lane, phase)
    if path.is_file():
        return load_json(path)
    return {"lane": lane, "phase": phase, "cells": {}}


def cell_key(cell: dict[str, Any]) -> str:
    return (
        f"{int(cell.get('order', 0)):02d}|{cell['task']}|{cell['arm']}|"
        f"r{int(cell.get('replicate', 1))}"
    )


def performer_command(
    spec: dict[str, Any], lane: str, cell: dict[str, Any], identifier: str
) -> list[str]:
    lane_spec = spec["lanes"][lane]
    return [
        os.environ.get("NODE", "node"),
        str(BACKEND / "node_modules" / "tsx" / "dist" / "cli.mjs"),
        str(BACKEND / "scripts" / "lab-beaver-arm.ts"),
        "--task",
        cell["task"],
        "--arm",
        cell["arm"],
        "--model",
        lane_spec["performer_model"],
        "--effort",
        lane_spec["performer_effort"],
        "--retrieval-prompt",
        "neutral",
        "--run-id",
        identifier,
    ]


def ensure_lane_prerequisite(spec: dict[str, Any], lane: str) -> None:
    if lane != "luna":
        return
    stage1 = ANALYSIS_DIR / "deepseek-stage1.json"
    if not stage1.is_file():
        raise RuntimeError("Luna replication waits for the DeepSeek stage-1 decision")
    decision = load_json(stage1)
    if decision.get("pass") is True and not (
        ANALYSIS_DIR / "deepseek-final.json"
    ).is_file():
        raise RuntimeError("Luna replication waits for the DeepSeek final decision")


def run_performers(
    spec: dict[str, Any],
    lane: str,
    phase: str,
    max_performers: int,
    dry_run: bool,
) -> None:
    ensure_lane_prerequisite(spec, lane)
    if phase in ("stage1", "stage2"):
        effective_runs(spec, lane, "preflight")
    cells = phase_cells(spec, phase)
    root = log_root(spec, lane)
    event_log = root / f"{phase}.log"
    state = load_state(spec, lane, phase)
    pending: list[tuple[dict[str, Any], str, bool]] = []
    for cell in cells:
        base = run_id(spec, lane, phase, cell)
        complete = complete_identifier(spec, base, cell)
        if complete:
            state["cells"][cell_key(cell)] = {
                "status": "completed",
                "run_id": complete,
            }
            append_log(event_log, f"SKIP complete {complete}")
            continue
        base_dir = run_directory(base)
        retry = retry_run_id(base)
        retry_dir = run_directory(retry)
        if retry_dir.exists():
            raise RuntimeError(f"Incomplete retry evidence requires audit: {retry}")
        if base_dir.exists():
            if not retryable_transport_failure(base):
                raise RuntimeError(f"Incomplete non-retryable evidence: {base}")
            pending.append((cell, retry, True))
        else:
            pending.append((cell, base, False))
    atomic_json(state_path(spec, lane, phase), state)
    if dry_run:
        for cell, identifier, _ in pending:
            append_log(
                event_log,
                "DRY " + json.dumps(performer_command(spec, lane, cell, identifier)),
            )
        return

    environment = os.environ.copy()
    environment.update(
        {
            "LAB_SANDBOX_ENGINE": "docker",
            "PYTHONDONTWRITEBYTECODE": "1",
            # The orchestrator owns the single pre-output transport retry and
            # gives it a registered suffix; disable the runner's legacy retry.
            "LAB_BEAVER_TRANSPORT_RELAUNCH": "1",
        }
    )
    active: list[dict[str, Any]] = []
    hard_failure: str | None = None
    while pending or active:
        while pending and len(active) < max_performers and hard_failure is None:
            cell, identifier, is_retry = pending.pop(0)
            stdout_path = root / "performers" / (cell_key(cell).replace("|", "_") + (
                "-retry1" if is_retry else ""
            ) + ".stdout.log")
            stderr_path = stdout_path.with_name(stdout_path.name.replace(".stdout.", ".stderr."))
            stdout_path.parent.mkdir(parents=True, exist_ok=True)
            stdout = stdout_path.open("a", encoding="utf-8")
            stderr = stderr_path.open("a", encoding="utf-8")
            creationflags = 0
            if os.name == "nt":
                creationflags = (
                    subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS
                )
            process = subprocess.Popen(
                performer_command(spec, lane, cell, identifier),
                cwd=BACKEND,
                env=environment,
                stdout=stdout,
                stderr=stderr,
                text=True,
                creationflags=creationflags,
            )
            active.append(
                {
                    "cell": cell,
                    "run_id": identifier,
                    "retry": is_retry,
                    "process": process,
                    "stdout": stdout,
                    "stderr": stderr,
                    "started_at": time.time(),
                }
            )
            state["cells"][cell_key(cell)] = {
                "status": "running",
                "run_id": identifier,
                "pid": process.pid,
                "retry": is_retry,
            }
            atomic_json(state_path(spec, lane, phase), state)
            append_log(event_log, f"START pid={process.pid} {identifier}")

        for job in list(active):
            code = job["process"].poll()
            if code is None:
                continue
            active.remove(job)
            job["stdout"].close()
            job["stderr"].close()
            cell = job["cell"]
            identifier = job["run_id"]
            elapsed = time.time() - job["started_at"]
            if code == 0:
                try:
                    validate_run(spec, identifier, cell)
                except RuntimeError as error:
                    code = 1
                    hard_failure = str(error)
            if code != 0 and hard_failure is None:
                if not job["retry"] and retryable_transport_failure(identifier):
                    retry = retry_run_id(identifier)
                    pending.insert(0, (cell, retry, True))
                    state["cells"][cell_key(cell)] = {
                        "status": "retry_registered",
                        "run_id": identifier,
                        "retry_run_id": retry,
                    }
                    append_log(event_log, f"RETRY pre-output transport {retry}")
                else:
                    hard_failure = f"performer exit {code}: {identifier}"
            if code == 0:
                state["cells"][cell_key(cell)] = {
                    "status": "completed",
                    "run_id": identifier,
                    "elapsed_seconds": round(elapsed, 3),
                }
                append_log(event_log, f"DONE {elapsed:.1f}s {identifier}")
            elif hard_failure:
                state["cells"][cell_key(cell)] = {
                    "status": "failed",
                    "run_id": identifier,
                    "error": hard_failure,
                }
                append_log(event_log, f"FAIL {hard_failure}")
            atomic_json(state_path(spec, lane, phase), state)
        if active:
            time.sleep(2)
    if hard_failure:
        raise RuntimeError(hard_failure)


def effective_runs(
    spec: dict[str, Any], lane: str, phase: str
) -> list[tuple[dict[str, Any], str]]:
    resolved = []
    for cell in phase_cells(spec, phase):
        base = run_id(spec, lane, phase, cell)
        identifier = complete_identifier(spec, base, cell)
        if not identifier:
            raise RuntimeError(f"Performer cell is incomplete: {base}")
        resolved.append((cell, identifier))
    return resolved


def judge_complete(directory: Path, lane_spec: dict[str, Any]) -> bool:
    required = [directory / f"scores.k{k}.json" for k in range(1, 4)]
    required += [directory / "scores.majority.json", directory / "receipt.json"]
    if any(not path.is_file() or path.stat().st_size == 0 for path in required):
        return False
    majority = load_json(directory / "scores.majority.json")
    return (
        majority.get("n_samples") == 3
        and majority.get("judge_model") == lane_spec["judge_model"]
        and majority.get("judge_effort") == lane_spec["judge_effort"]
    )


def run_judges(
    spec: dict[str, Any], lane: str, phase: str, dry_run: bool
) -> None:
    ensure_lane_prerequisite(spec, lane)
    lane_spec = spec["lanes"][lane]
    python = LAB / ".venv" / "Scripts" / "python.exe"
    if not python.is_file():
        python = Path(sys.executable)
    root = log_root(spec, lane)
    event_log = root / f"judge-{phase}.log"
    for cell, identifier in effective_runs(spec, lane, phase):
        directory = run_directory(identifier)
        if judge_complete(directory, lane_spec):
            append_log(event_log, f"SKIP judged {identifier}")
            continue
        command = [
            str(python),
            "-m",
            "evaluation.run_eval",
            "--run-id",
            identifier,
            "--task",
            cell["task"],
            "--judge-model",
            lane_spec["judge_model"],
            "--judge-effort",
            lane_spec["judge_effort"],
            "--judge-samples",
            "3",
            "--parallel",
            str(spec["judging"]["parallel_criteria"]),
        ]
        if dry_run:
            append_log(event_log, "DRY " + json.dumps(command))
            continue
        label = cell_key(cell).replace("|", "_")
        stdout_path = root / "judges" / f"{phase}-{label}.stdout.log"
        stderr_path = root / "judges" / f"{phase}-{label}.stderr.log"
        stdout_path.parent.mkdir(parents=True, exist_ok=True)
        append_log(event_log, f"JUDGE START {identifier}")
        with stdout_path.open("a", encoding="utf-8") as stdout, stderr_path.open(
            "a", encoding="utf-8"
        ) as stderr:
            code = subprocess.call(
                command,
                cwd=LAB,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                stdout=stdout,
                stderr=stderr,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        if code != 0 or not judge_complete(directory, lane_spec):
            raise RuntimeError(f"Judge failed or produced incomplete receipts: {identifier}")
        append_log(event_log, f"JUDGE DONE {identifier}")


def criterion_rate(scores: dict[str, Any], ids: set[str] | None = None) -> float:
    criteria = scores.get("criteria_results") or []
    if ids is not None:
        criteria = [entry for entry in criteria if entry.get("id") in ids]
        if len(criteria) != len(ids):
            raise RuntimeError("Judgment is missing a preregistered criterion")
    if not criteria:
        raise RuntimeError("Judgment has no criteria")
    return sum(entry.get("verdict") == "pass" for entry in criteria) / len(criteria)


def median(values: list[float]) -> float:
    if not values or any(not math.isfinite(value) for value in values):
        raise RuntimeError("A preregistered metric is absent or non-finite")
    return float(statistics.median(values))


def analyze(spec: dict[str, Any], lane: str, final: bool) -> dict[str, Any]:
    lane_spec = spec["lanes"][lane]
    phases = ["stage1", "stage2"] if final else ["stage1"]
    records: list[dict[str, Any]] = []
    for phase in phases:
        for cell, identifier in effective_runs(spec, lane, phase):
            directory = run_directory(identifier)
            if not judge_complete(directory, lane_spec):
                raise RuntimeError(f"Run is not judged three times: {identifier}")
            scores = load_json(directory / "scores.majority.json")
            metrics = validate_run(spec, identifier, cell)
            uncached = float(metrics.get("uncached_input_tokens") or 0)
            cached = float(metrics.get("cache_read_input_tokens") or 0)
            raw_input = uncached + cached
            multiplier = float(lane_spec["cached_input_multiplier"])
            weighted_input = uncached + multiplier * cached
            reported_weighted = float(
                metrics.get("cache_adjusted_input_token_equivalent") or 0
            )
            if not math.isclose(
                weighted_input, reported_weighted, rel_tol=1e-12, abs_tol=1e-6
            ):
                raise RuntimeError(
                    f"Cache-weighted input drift in {identifier}: "
                    f"{reported_weighted} != {weighted_input}"
                )
            records.append(
                {
                    "phase": phase,
                    "cell": cell,
                    "run_id": identifier,
                    "scores": scores,
                    "metrics": metrics,
                    "rate": criterion_rate(scores),
                    "raw_input_tokens": raw_input,
                    "weighted_input_tokens": weighted_input,
                }
            )

    arms = list(spec["arms"])
    candidate = spec["comparisons"]["primary"]["candidate"]
    upstream = spec["comparisons"]["primary"]["control"]
    v5 = spec["comparisons"]["secondary"]["control"]
    tasks = list(dict.fromkeys(record["cell"]["task"] for record in records))
    task_rates: dict[str, dict[str, float]] = {arm: {} for arm in arms}
    for arm in arms:
        for task in tasks:
            values = [
                record["rate"]
                for record in records
                if record["cell"]["arm"] == arm and record["cell"]["task"] == task
            ]
            if not values:
                raise RuntimeError(f"Missing arm/task cells: {arm} {task}")
            task_rates[arm][task] = statistics.mean(values)
    macro = {
        arm: statistics.mean(task_rates[arm][task] for task in tasks) for arm in arms
    }

    groups: dict[str, dict[str, float]] = {}
    for name, group in spec["pass_gates"]["criterion_groups"].items():
        if group["task"] not in tasks:
            continue
        ids = set(group["criteria"])
        groups[name] = {}
        for arm in arms:
            values = [
                criterion_rate(record["scores"], ids)
                for record in records
                if record["cell"]["arm"] == arm
                and record["cell"]["task"] == group["task"]
            ]
            groups[name][arm] = statistics.mean(values)

    metrics_summary: dict[str, dict[str, float]] = {}
    for arm in arms:
        arm_records = [record for record in records if record["cell"]["arm"] == arm]
        gate_values = []
        for record in arm_records:
            metrics = record["metrics"]
            gate_values.append(
                float(
                    metrics.get("signal_gate_count")
                    if arm == candidate
                    else metrics.get("checkpoint_gate_calls")
                    or 0
                )
            )
        metrics_summary[arm] = {
            "median_wall_clock_seconds": median(
                [float(record["metrics"].get("wall_clock_seconds") or 0) for record in arm_records]
            ),
            "median_raw_input_tokens": median(
                [record["raw_input_tokens"] for record in arm_records]
            ),
            "median_weighted_input_tokens": median(
                [record["weighted_input_tokens"] for record in arm_records]
            ),
            "median_output_tokens": median(
                [float(record["metrics"].get("output_tokens") or 0) for record in arm_records]
            ),
            "median_authoring_gate_count": median(gate_values),
        }

    tolerance = float(spec["pass_gates"]["per_task_stronger_baseline_tolerance"])
    checks: dict[str, bool] = {
        "macro_meets_primary_upstream": macro[candidate] >= macro[upstream],
        "macro_meets_secondary_v5": macro[candidate] >= macro[v5],
        "each_non_tax_task_within_tolerance_of_stronger_baseline": all(
            task_rates[candidate][task]
            >= max(task_rates[upstream][task], task_rates[v5][task]) - tolerance
            for task in tasks
            if not task.startswith("tax/")
        ),
        "preregistered_detail_and_linkage_groups_do_not_regress": all(
            values[candidate] >= max(values[upstream], values[v5])
            for values in groups.values()
        ),
        "median_wall_time_strictly_beats_v5": metrics_summary[candidate][
            "median_wall_clock_seconds"
        ]
        < metrics_summary[v5]["median_wall_clock_seconds"],
        "median_weighted_input_strictly_beats_v5": metrics_summary[candidate][
            "median_weighted_input_tokens"
        ]
        < metrics_summary[v5]["median_weighted_input_tokens"],
        "median_authoring_gates_strictly_beat_v5": metrics_summary[candidate][
            "median_authoring_gate_count"
        ]
        < metrics_summary[v5]["median_authoring_gate_count"],
        "output_growth_at_most_ten_percent_vs_v5": metrics_summary[candidate][
            "median_output_tokens"
        ]
        <= 1.10 * metrics_summary[v5]["median_output_tokens"],
    }
    if final:
        tax = "tax/draft-transfer-pricing-documentation"
        tax_rates = {
            arm: [
                record["rate"]
                for record in records
                if record["cell"]["arm"] == arm and record["cell"]["task"] == tax
            ]
            for arm in arms
        }
        baseline_medians = {
            arm: median(tax_rates[arm]) for arm in (upstream, v5)
        }
        checks["tax_median_meets_both_baselines"] = median(tax_rates[candidate]) >= max(
            baseline_medians.values()
        )
        checks["tax_two_of_three_meet_each_baseline_median"] = all(
            sum(rate >= baseline_medians[arm] for rate in tax_rates[candidate]) >= 2
            for arm in (upstream, v5)
        )

    material_loss = (
        macro[candidate] < macro[upstream] - 0.02
        and macro[candidate] < macro[v5] - 0.02
    )
    result = {
        "schema_version": 1,
        "experiment_id": spec["experiment_id"],
        "lane": lane,
        "scope": "final" if final else "stage1",
        "primary_comparison": {
            "control": upstream,
            "candidate": candidate,
            "macro_delta": macro[candidate] - macro[upstream],
        },
        "secondary_comparison": {
            "control": v5,
            "candidate": candidate,
            "macro_delta": macro[candidate] - macro[v5],
        },
        "cache_accounting": {
            "raw_input_reported_separately": True,
            "cached_input_multiplier": lane_spec["cached_input_multiplier"],
            "deepseek_multiplier_is_0_02_not_0_1": lane != "deepseek"
            or lane_spec["cached_input_multiplier"] == 0.02,
        },
        "task_rates": task_rates,
        "task_macro_rates": macro,
        "criterion_groups": groups,
        "metrics": metrics_summary,
        "checks": checks,
        "material_loss_to_both_baselines": material_loss,
        "pass": all(checks.values()),
        "run_ids": [record["run_id"] for record in records],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    output = ANALYSIS_DIR / f"{lane}-{'final' if final else 'stage1'}.json"
    if output.exists():
        existing = load_json(output)
        comparable = {key: value for key, value in existing.items() if key != "created_at"}
        current = {key: value for key, value in result.items() if key != "created_at"}
        if comparable != current:
            raise RuntimeError(f"Refusing to overwrite changed analysis: {output}")
        return existing
    atomic_json(output, result)
    return result


def verify_stage_gate(spec: dict[str, Any], lane: str) -> None:
    path = ANALYSIS_DIR / f"{lane}-stage1.json"
    if not path.is_file() or load_json(path).get("pass") is not True:
        raise RuntimeError(f"Stage 2 is blocked: {lane} stage 1 did not pass")


def write_claim(
    spec: dict[str, Any], lane: str, phase: str, head: str, dry_run: bool
) -> None:
    if dry_run:
        return
    root = log_root(spec, lane)
    path = root / f"claim-{phase}.json"
    claim = {
        "experiment_id": spec["experiment_id"],
        "lane": lane,
        "phase": phase,
        "implementation_commit": head,
        "registration_sha256": sha256(REGISTRATION_PATH),
        "claimed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if path.exists():
        prior = load_json(path)
        for key in ("experiment_id", "lane", "phase", "implementation_commit", "registration_sha256"):
            if prior.get(key) != claim[key]:
                raise RuntimeError(f"Existing launch claim conflicts: {path}")
        return
    atomic_json(path, claim)


def print_status(spec: dict[str, Any], lane: str) -> None:
    for phase in ("preflight", "stage1", "stage2"):
        complete = 0
        cells = phase_cells(spec, phase)
        for cell in cells:
            base = run_id(spec, lane, phase, cell)
            if complete_identifier(spec, base, cell):
                complete += 1
        print(f"{lane} {phase}: {complete}/{len(cells)} performer cells complete")
    for name in ("stage1", "final"):
        report = ANALYSIS_DIR / f"{lane}-{name}.json"
        if report.is_file():
            value = load_json(report)
            print(f"{lane} {name}: pass={value.get('pass')}")


def main() -> None:
    global REGISTRATION_RELATIVE, REGISTRATION_PATH, ANALYSIS_DIR
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--registration",
        default=REGISTRATION_RELATIVE.as_posix(),
        help="Registration path relative to the repository root",
    )
    parser.add_argument("--lane", choices=("deepseek", "luna"), required=True)
    parser.add_argument(
        "--phase",
        choices=(
            "verify",
            "preflight",
            "run-stage1",
            "judge-stage1",
            "analyze-stage1",
            "run-stage2",
            "judge-stage2",
            "analyze-final",
            "status",
        ),
        required=True,
    )
    parser.add_argument("--max-performers", type=int, default=8)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_performers <= 8:
        raise RuntimeError("max-performers must be between 1 and 8")

    requested_registration = (ROOT / args.registration).resolve()
    requested_registration.relative_to(ROOT.resolve())
    REGISTRATION_RELATIVE = requested_registration.relative_to(ROOT.resolve())
    REGISTRATION_PATH = requested_registration
    spec = registration()
    experiment_slug = str(spec["experiment_id"]).removeprefix("harvey-lab-")
    ANALYSIS_DIR = LAB / "run-logs" / experiment_slug / "analysis"
    if args.phase == "status":
        print_status(spec, args.lane)
        return
    head = verify_commit_and_sources(spec)
    if args.phase in ("verify", "preflight", "run-stage1", "run-stage2"):
        verify_surfaces(spec, args.lane, args.phase.removeprefix("run-"))
    write_claim(spec, args.lane, args.phase, head, args.dry_run)
    if args.phase == "verify":
        print(json.dumps({"ok": True, "head": head, "lane": args.lane}))
    elif args.phase == "preflight":
        run_performers(spec, args.lane, "preflight", 1, args.dry_run)
    elif args.phase == "run-stage1":
        run_performers(
            spec, args.lane, "stage1", args.max_performers, args.dry_run
        )
    elif args.phase == "judge-stage1":
        run_judges(spec, args.lane, "stage1", args.dry_run)
    elif args.phase == "analyze-stage1":
        print(json.dumps(analyze(spec, args.lane, final=False), indent=2))
    elif args.phase == "run-stage2":
        verify_stage_gate(spec, args.lane)
        run_performers(
            spec, args.lane, "stage2", args.max_performers, args.dry_run
        )
    elif args.phase == "judge-stage2":
        verify_stage_gate(spec, args.lane)
        run_judges(spec, args.lane, "stage2", args.dry_run)
    elif args.phase == "analyze-final":
        verify_stage_gate(spec, args.lane)
        print(json.dumps(analyze(spec, args.lane, final=True), indent=2))


if __name__ == "__main__":
    main()
