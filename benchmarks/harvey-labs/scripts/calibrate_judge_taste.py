"""Find the flat-rate Codex judge closest to AA's Gemini LAB judge.

The oracle is deliberately small, resumable, and spend-capped.  It samples
only already-judged visible-dev Beaver A/B outputs and reproduces AA's
published two-message Harvey LAB-AA judge prompt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

from google import genai
from google.genai import types

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from evaluation.scoring import DocxTrackChanges, _load_all_output, _read_file_as_text


REPO_ROOT = ROOT.parent.parent
RESULTS = ROOT / "results"
TASKS = ROOT / "tasks"
SPLIT = REPO_ROOT / "benchmarks" / "lab" / "corpus-split.json"
DEFAULT_RUN_DIR = ROOT / "run-logs" / "judge-taste-gemini31-20260808"
MODEL = "gemini-3.1-pro-preview"
# Conservative ceiling for the user's C$10 authorization.
HARD_CAP_USD = 7.00
MAX_OUTPUT_TOKENS = 4096
SEED = "judge-taste-v1-20260808"

SYSTEM = """You are evaluating a legal AI agent's work product against one binary quality criterion.

<task_context_for_work_product>
The work product below was produced for this legal task. Use the task only as context for what the deliverables were meant to address - judge the work product, not the task.

{task_title}

{task_instructions}
</task_context_for_work_product>

<work_product>
{agent_output}
</work_product>"""

USER = """<criterion>
<title>
{criterion_title}
</title>
<match_criteria>
{match_criteria}
</match_criteria>
</criterion>

Return `pass` only if the work product satisfies the criterion as described; otherwise `fail`."""

CANDIDATES = {
    "luna-high": ("gpt-5.6-luna", "high"),
    "luna-max": ("gpt-5.6-luna", "max"),
    "sol-high": ("gpt-5.6-sol", "high"),
    "sol-max": ("gpt-5.6-sol", "max"),
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def append_log(path: Path, event: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def load_state(run_dir: Path) -> dict:
    path = run_dir / "state.json"
    if path.exists():
        state = json.loads(path.read_text(encoding="utf-8"))
        if state.get("seed") != SEED or state.get("hard_cap_usd") != HARD_CAP_USD:
            raise ValueError(f"incompatible state: {path}")
        return state
    return {
        "version": 1,
        "seed": SEED,
        "created_at": now(),
        "hard_cap_usd": HARD_CAP_USD,
        "gemini": {"model": MODEL, "items": {}, "stop_reason": None},
        "candidates": {},
    }


def save_state(run_dir: Path, state: dict) -> None:
    state["updated_at"] = now()
    atomic_json(run_dir / "state.json", state)


def visible_dev_tasks() -> set[str]:
    split = json.loads(SPLIT.read_text(encoding="utf-8"))
    return {row["task"] for row in split["tasks"] if row["tier"] == "dev"}


def arm_and_lane(run_id: str) -> tuple[str, str] | None:
    if "/beaver-mike_upstream_native_v1-" in run_id:
        arm = "upstream"
    elif "/beaver-coding_markdown_final_v5-" in run_id:
        arm = "treatment"
    else:
        return None
    if "-codex-gpt-5-6-luna/" in run_id:
        lane = "luna-performer"
    elif "-deepseek-v4-flash/" in run_id:
        lane = "deepseek-performer"
    else:
        return None
    return arm, lane


def build_pool() -> tuple[list[dict], list[tuple[str, str, str]]]:
    """Return a deterministic pool and its task/arm/reference-label strata."""
    dev = visible_dev_tasks()
    runs: dict[tuple[str, str, str], tuple[Path, dict]] = {}
    for score_path in RESULTS.rglob("scores.json"):
        if not score_path.parent.name.startswith("coding-agent-expansion-v1-"):
            continue
        scores = json.loads(score_path.read_text(encoding="utf-8"))
        task = scores.get("task")
        parsed = arm_and_lane(scores.get("run_id", ""))
        if task not in dev or not parsed or not scores.get("criteria_results"):
            continue
        arm, lane = parsed
        key = task, lane, arm
        if key in runs:
            raise ValueError(f"duplicate calibration run for {key}")
        runs[key] = score_path, scores

    tasks = sorted(
        task
        for task in {key[0] for key in runs}
        if all((task, lane, arm) in runs for lane in ("luna-performer", "deepseek-performer") for arm in ("upstream", "treatment"))
    )
    if not tasks:
        raise ValueError("no fully judged visible-dev Beaver A/B tasks found")

    pool = []
    for task in tasks:
        config_path = TASKS / Path(*task.split("/")) / "task.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        criteria = {criterion["id"]: criterion for criterion in config["criteria"]}
        for lane in ("luna-performer", "deepseek-performer"):
            for arm in ("upstream", "treatment"):
                score_path, scores = runs[task, lane, arm]
                for prior in scores["criteria_results"]:
                    criterion = criteria.get(prior["id"])
                    verdict = str(prior.get("verdict", "")).lower()
                    if not criterion or verdict not in ("pass", "fail"):
                        continue
                    item_id = digest("|".join((scores["run_id"], criterion["id"])))[:24]
                    pool.append(
                        {
                            "id": item_id,
                            "task": task,
                            "arm": arm,
                            "lane": lane,
                            "run_id": scores["run_id"],
                            "score_path": str(score_path.relative_to(ROOT)),
                            "criterion_id": criterion["id"],
                            "criterion_title": criterion["title"],
                            "reference_verdict": verdict,
                        }
                    )

    grouped: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for item in pool:
        grouped[item["task"], item["arm"], item["reference_verdict"]].append(item)
    strata = sorted(grouped)
    expected = {(task, arm, verdict) for task in tasks for arm in ("upstream", "treatment") for verdict in ("fail", "pass")}
    if set(strata) != expected:
        raise ValueError(f"incomplete sampling strata: missing {sorted(expected - set(strata))}")

    # Alternate performer lanes within every stratum, hashing only to break
    # ties.  The first round is the 28-label pilot; later rounds are expansion.
    ordered_groups = {}
    for stratum_index, stratum in enumerate(strata):
        items = grouped[stratum]
        lanes = defaultdict(list)
        for item in items:
            lanes[item["lane"]].append(item)
        for lane_items in lanes.values():
            lane_items.sort(key=lambda item: digest(SEED + item["id"]))
        lane_order = sorted(lanes)
        if stratum_index % 2:
            lane_order.reverse()
        ordered = []
        for index in range(max(map(len, lanes.values()))):
            for lane in lane_order:
                if index < len(lanes[lane]):
                    ordered.append(lanes[lane][index])
        ordered_groups[stratum] = ordered

    order = []
    for index in range(max(map(len, ordered_groups.values()))):
        for stratum in strata:
            if index < len(ordered_groups[stratum]):
                order.append(ordered_groups[stratum][index])
    return order, strata


_task_cache: dict[str, dict] = {}
_score_cache: dict[str, dict] = {}
_text_cache: dict[tuple[str, str], str] = {}


def materialize(item: dict) -> tuple[str, str]:
    task = item["task"]
    if task not in _task_cache:
        path = TASKS / Path(*task.split("/")) / "task.json"
        _task_cache[task] = json.loads(path.read_text(encoding="utf-8"))
    config = _task_cache[task]
    criterion = next(c for c in config["criteria"] if c["id"] == item["criterion_id"])

    score_path = str(ROOT / item["score_path"])
    if score_path not in _score_cache:
        _score_cache[score_path] = json.loads(Path(score_path).read_text(encoding="utf-8"))
    scores = _score_cache[score_path]
    run_dir = RESULTS / Path(*item["run_id"].split("/"))
    output_dir = run_dir / "output"
    declared = criterion.get("deliverables", [])
    if declared:
        sections = []
        matches = scores.get("deliverable_match") or {}
        for name in declared:
            resolved = (matches.get(name) or {}).get("resolved", name)
            path = output_dir / resolved
            if not path.exists():
                found = list(output_dir.rglob(resolved))
                path = found[0] if len(found) == 1 else path
            if not path.exists():
                sections.append(f"## Agent Output: {name}\n(File not found: {resolved})")
                continue
            mode = DocxTrackChanges.ALL if criterion.get("evaluation_options", {}).get("include_docx_redlines", False) else DocxTrackChanges.ACCEPT
            key = str(path), mode.value
            if key not in _text_cache:
                _text_cache[key] = _read_file_as_text(path, track_changes=mode)
            sections.append(f"## Agent Output: {name}\n{_text_cache[key]}")
        output = "\n\n".join(sections) or "(No agent output found)"
    else:
        key = str(output_dir), "all"
        if key not in _text_cache:
            _text_cache[key] = _load_all_output(output_dir)
        output = _text_cache[key]

    system = SYSTEM.format(
        task_title=config["title"],
        task_instructions=config["instructions"],
        agent_output=output,
    )
    user = USER.format(
        criterion_title=criterion["title"],
        match_criteria=criterion["match_criteria"],
    )
    return system, user


def verdict(text: str) -> str:
    matches = re.findall(r"(?i)(?<![a-z])(pass|fail)(?![a-z])", text)
    distinct = {match.lower() for match in matches}
    if len(distinct) != 1:
        raise ValueError(f"not a single pass/fail verdict: {text[:160]!r}")
    return distinct.pop()


def prices(prompt_tokens: int) -> tuple[float, float]:
    return (2.0, 12.0) if prompt_tokens <= 200_000 else (4.0, 18.0)


def actual_cost(usage: dict) -> float:
    prompt = int(usage.get("prompt_tokens", 0) or 0)
    output = int(usage.get("candidate_tokens", 0) or 0) + int(usage.get("thought_tokens", 0) or 0)
    input_price, output_price = prices(prompt)
    return (prompt * input_price + output * output_price) / 1_000_000


def conservative_gemini_spend(state: dict) -> float:
    total = 0.0
    for record in state["gemini"]["items"].values():
        for attempt in record.get("attempts", []):
            total += float(attempt.get("cost_usd", attempt.get("reserved_cost_usd", 0.0)))
    return total


def gemini_client():
    for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        value = os.environ.get(name, "").strip()
        if value and value != "your-gemini-key":
            return genai.Client(api_key=value)
    env_path = REPO_ROOT / "backend" / ".env"
    if env_path.exists():
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            if not raw or raw.lstrip().startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            if key.strip() in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
                value = value.strip().strip('"').strip("'")
                if value and value != "your-gemini-key":
                    return genai.Client(api_key=value)
    project = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    if project:
        return genai.Client(
            vertexai=True,
            project=project,
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "global"),
        )
    raise RuntimeError("valid Gemini API key or GOOGLE_CLOUD_PROJECT not found")


def response_text(response) -> str:
    try:
        if response.text:
            return response.text
    except Exception:
        pass
    return "".join(
        part.text or ""
        for candidate in (response.candidates or [])
        for part in (candidate.content.parts if candidate.content else [])
        if getattr(part, "text", None)
    )


def run_gemini(run_dir: Path, state: dict, order: list[dict], limit: int) -> None:
    client = gemini_client()
    log_path = run_dir / "progress.jsonl"
    successful = sum(1 for record in state["gemini"]["items"].values() if record.get("verdict"))
    for item in order:
        if successful >= limit:
            state["gemini"]["stop_reason"] = f"sample_limit:{limit}"
            break
        record = state["gemini"]["items"].setdefault(item["id"], {**item, "attempts": []})
        if record.get("verdict"):
            continue
        system, user = materialize(item)
        counted = client.models.count_tokens(
            model=MODEL,
            contents=f"{system}\n\n{user}",
        )
        prompt_tokens = int(counted.total_tokens or 0)
        input_price, output_price = prices(prompt_tokens)
        reserve = (prompt_tokens * input_price + MAX_OUTPUT_TOKENS * output_price) / 1_000_000
        if conservative_gemini_spend(state) + reserve > HARD_CAP_USD:
            state["gemini"]["stop_reason"] = "hard_budget_gate"
            save_state(run_dir, state)
            print(f"budget gate: {successful} oracle labels, ${conservative_gemini_spend(state):.4f} conservative spend", flush=True)
            break

        attempt = {
            "started_at": now(),
            "status": "inflight",
            "counted_prompt_tokens": prompt_tokens,
            "reserved_cost_usd": reserve,
            "prompt_chars": len(system) + len(user),
            "system_sha256": digest(system),
            "user_sha256": digest(user),
        }
        record["attempts"].append(attempt)
        save_state(run_dir, state)  # an interrupted request remains fully reserved
        started = time.monotonic()
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=user,
                config=types.GenerateContentConfig(
                    system_instruction=system,
                    temperature=0.6,
                    max_output_tokens=MAX_OUTPUT_TOKENS,
                    thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.HIGH),
                ),
            )
            raw = response_text(response).strip()
            parsed = verdict(raw)
            metadata = response.usage_metadata
            usage = {
                "prompt_tokens": int(metadata.prompt_token_count or 0),
                "candidate_tokens": int(metadata.candidates_token_count or 0),
                "thought_tokens": int(metadata.thoughts_token_count or 0),
                "total_tokens": int(metadata.total_token_count or 0),
            }
            attempt.update(
                {
                    "status": "complete",
                    "completed_at": now(),
                    "wall_seconds": round(time.monotonic() - started, 3),
                    "usage": usage,
                    "cost_usd": actual_cost(usage),
                    "raw_response": raw,
                    "model_version": response.model_version,
                    "response_id": response.response_id,
                }
            )
            record["verdict"] = parsed
            successful += 1
            event = {
                "at": now(), "stage": "gemini", "status": "complete", "item_id": item["id"],
                "n": successful, "verdict": parsed, "cost_usd": attempt["cost_usd"],
                "total_cost_usd": conservative_gemini_spend(state),
            }
        except Exception as error:
            message = str(error).replace(api_key, "[redacted]")[:1000]
            attempt.update({"status": "error", "completed_at": now(), "wall_seconds": round(time.monotonic() - started, 3), "error": message})
            event = {"at": now(), "stage": "gemini", "status": "error", "item_id": item["id"], "error": message}
        save_state(run_dir, state)
        append_log(log_path, event)
        print(json.dumps(event, ensure_ascii=False), flush=True)
    client.close()


def cli_call(run_dir: Path, item: dict, model: str, effort: str) -> dict:
    system, user = materialize(item)
    tmp_root = run_dir / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="codex-judge-", dir=tmp_root) as raw_tmp:
        workdir = Path(raw_tmp)
        instruction_path = workdir / "instructions.md"
        instruction_path.write_text(system, encoding="utf-8")
        shim_path = shutil.which("codex.cmd" if os.name == "nt" else "codex")
        if not shim_path:
            raise RuntimeError("codex CLI not found")
        shim = Path(shim_path)
        native = list((shim.parent / "node_modules" / "@openai" / "codex").glob("node_modules/@openai/codex-win32-*/vendor/*/bin/codex.exe")) if os.name == "nt" else []
        executable = str(native[0] if len(native) == 1 else shim)
        args = [
            executable, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
            "--sandbox", "read-only", "--json", "--color", "never", "--skip-git-repo-check",
            "--cd", str(workdir), "--model", model,
            "--config", 'approval_policy="never"',
            "--config", 'web_search="disabled"',
            "--config", f'model_reasoning_effort="{effort}"',
            "--config", "model_instructions_file=" + json.dumps(instruction_path.as_posix()),
            "-",
        ]
        env = os.environ.copy()
        for name in ("OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT", "AZURE_OPENAI_API_KEY"):
            env.pop(name, None)
        run = subprocess.run(
            args,
            input=user,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
            cwd=workdir,
            env=env,
            creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 0),
        )
    messages, usage = [], {}
    events = []
    for line in run.stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        events.append(event.get("type"))
        if event.get("type") == "item.completed" and (event.get("item") or {}).get("type") == "agent_message":
            messages.append(event["item"].get("text", ""))
        if event.get("type") == "turn.completed":
            usage = event.get("usage") or {}
    if run.returncode:
        raise RuntimeError(f"codex exit {run.returncode}: {run.stderr.strip()[:500]}; events={events[-5:]}")
    if not messages:
        raise RuntimeError(f"codex returned no agent message; events={events[-5:]}")
    raw = messages[-1].strip()
    return {
        "verdict": verdict(raw),
        "raw_response": raw,
        "wall_seconds": round(time.monotonic() - started, 3),
        "usage": {key: int(value or 0) for key, value in usage.items()},
    }


def run_candidate(run_dir: Path, state: dict, items: list[dict], name: str, workers: int) -> None:
    model, effort = CANDIDATES[name]
    lock = threading.Lock()
    candidate = state["candidates"].setdefault(name, {"model": model, "effort": effort, "items": {}})
    pending = [item for item in items if not (candidate["items"].get(item["id"]) or {}).get("verdict")]
    log_path = run_dir / "progress.jsonl"
    stage_started = time.monotonic()
    candidate["last_started_at"] = now()
    save_state(run_dir, state)

    def one(item: dict) -> tuple[dict, dict]:
        with lock:
            record = candidate["items"].setdefault(item["id"], {**item, "attempts": []})
            attempt = {"started_at": now(), "status": "inflight"}
            record["attempts"].append(attempt)
            save_state(run_dir, state)
        try:
            result = cli_call(run_dir, item, model, effort)
            event = {"at": now(), "stage": name, "status": "complete", "item_id": item["id"], "verdict": result["verdict"]}
        except Exception as error:
            result = {"error": str(error)[:1000]}
            event = {"at": now(), "stage": name, "status": "error", "item_id": item["id"], "error": str(error)[:500]}
        with lock:
            if event["status"] == "complete":
                attempt.update({"status": "complete", "completed_at": now(), **result})
                record["verdict"] = result["verdict"]
            else:
                attempt.update({"status": "error", "completed_at": now(), **result})
            save_state(run_dir, state)
            append_log(log_path, event)
        return item, event

    completed = len(items) - len(pending)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, item) for item in pending]
        for future in as_completed(futures):
            _, event = future.result()
            completed += event["status"] == "complete"
            event["n"] = completed
            event["total"] = len(items)
            print(json.dumps(event, ensure_ascii=False), flush=True)
    candidate["elapsed_seconds"] = round(float(candidate.get("elapsed_seconds", 0)) + time.monotonic() - stage_started, 3)
    candidate["last_completed_at"] = now()
    save_state(run_dir, state)


def split_items(items: list[dict], truth: dict[str, str]) -> dict[str, str]:
    grouped = defaultdict(list)
    for item in items:
        grouped[item["arm"], truth[item["id"]]].append(item)
    result = {}
    for group, rows in grouped.items():
        rows.sort(key=lambda item: digest(SEED + "|split|" + item["id"]))
        cut = (len(rows) + 1) // 2
        for index, item in enumerate(rows):
            result[item["id"]] = "tune" if index < cut else "heldout"
    return result


def metrics(ids: list[str], truth: dict[str, str], predicted: dict[str, str]) -> dict:
    tp = sum(truth[i] == predicted[i] == "pass" for i in ids)
    tn = sum(truth[i] == predicted[i] == "fail" for i in ids)
    fp = sum(truth[i] == "fail" and predicted[i] == "pass" for i in ids)
    fn = sum(truth[i] == "pass" and predicted[i] == "fail" for i in ids)
    n = len(ids)
    tpr = tp / (tp + fn) if tp + fn else math.nan
    tnr = tn / (tn + fp) if tn + fp else math.nan
    accuracy = (tp + tn) / n if n else math.nan
    predicted_pass = tp + fp
    actual_pass = tp + fn
    expected = ((predicted_pass * actual_pass) + ((n - predicted_pass) * (n - actual_pass))) / (n * n) if n else math.nan
    kappa = (accuracy - expected) / (1 - expected) if n and expected != 1 else math.nan
    return {
        "n": n,
        "balanced_accuracy": (tpr + tnr) / 2,
        "accuracy": accuracy,
        "cohen_kappa": kappa,
        "true_pass": tp,
        "true_fail": tn,
        "false_pass": fp,
        "false_pass_rate": fp / (tn + fp) if tn + fp else math.nan,
        "false_fail": fn,
        "false_fail_rate": fn / (tp + fn) if tp + fn else math.nan,
    }


def build_report(run_dir: Path, state: dict, order: list[dict]) -> dict:
    item_by_id = {item["id"]: item for item in order}
    truth = {item_id: row["verdict"] for item_id, row in state["gemini"]["items"].items() if row.get("verdict")}
    items = [item_by_id[item_id] for item_id in truth]
    splits = split_items(items, truth)
    rows = {}
    for name, candidate in state["candidates"].items():
        predicted = {item_id: row["verdict"] for item_id, row in candidate["items"].items() if item_id in truth and row.get("verdict")}
        if set(predicted) != set(truth):
            raise ValueError(f"{name}: missing {len(set(truth) - set(predicted))} oracle labels")
        token_totals = defaultdict(int)
        wall = 0.0
        for row in candidate["items"].values():
            complete = [attempt for attempt in row.get("attempts", []) if attempt.get("status") == "complete"]
            if not complete:
                continue
            attempt = complete[-1]
            wall += float(attempt.get("wall_seconds", 0))
            for key, value in attempt.get("usage", {}).items():
                token_totals[key] += int(value or 0)
        rows[name] = {
            "model": candidate["model"], "effort": candidate["effort"],
            "tune": metrics([i for i in truth if splits[i] == "tune"], truth, predicted),
            "heldout": metrics([i for i in truth if splits[i] == "heldout"], truth, predicted),
            "all": metrics(list(truth), truth, predicted),
            "elapsed_wall_seconds": candidate.get("elapsed_seconds", 0),
            "call_wall_seconds_sum": round(wall, 3), "tokens": dict(token_totals),
        }
    if set(rows) != set(CANDIDATES):
        raise ValueError(f"missing candidates: {sorted(set(CANDIDATES) - set(rows))}")
    winner = max(rows, key=lambda name: (rows[name]["tune"]["balanced_accuracy"], rows[name]["tune"]["cohen_kappa"], -rows[name]["tune"]["false_pass_rate"], name))
    gemini_usage = defaultdict(int)
    gemini_wall = 0.0
    for row in state["gemini"]["items"].values():
        for attempt in row.get("attempts", []):
            if attempt.get("status") == "complete":
                gemini_wall += float(attempt.get("wall_seconds", 0))
                for key, value in attempt.get("usage", {}).items():
                    gemini_usage[key] += int(value or 0)
    report = {
        "generated_at": now(), "oracle_model": MODEL, "oracle_labels": len(truth),
        "oracle_cost_usd": conservative_gemini_spend(state), "oracle_usage": dict(gemini_usage),
        "oracle_call_wall_seconds_sum": round(gemini_wall, 3),
        "split_counts": {part: sum(value == part for value in splits.values()) for part in ("tune", "heldout")},
        "candidates": rows, "winner_by_tune": winner,
        "winner_heldout": rows[winner]["heldout"],
    }
    atomic_json(run_dir / "report.json", report)
    lines = [
        "# Judge-taste calibration", "",
        f"Gemini oracle: {len(truth)} labels, US${report['oracle_cost_usd']:.4f}; tune {report['split_counts']['tune']}, heldout {report['split_counts']['heldout']}.", "",
        "| Candidate | Tune BA | Tune κ | Heldout BA | Heldout κ | FP | FF | Wall (s) | Input tokens | Output tokens |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in CANDIDATES:
        row = rows[name]
        lines.append(
            f"| {name} | {row['tune']['balanced_accuracy']:.3f} | {row['tune']['cohen_kappa']:.3f} | "
            f"{row['heldout']['balanced_accuracy']:.3f} | {row['heldout']['cohen_kappa']:.3f} | "
            f"{row['heldout']['false_pass']} | {row['heldout']['false_fail']} | {row['elapsed_wall_seconds']:.1f} | "
            f"{row['tokens'].get('input_tokens', 0)} | {row['tokens'].get('output_tokens', 0)} |"
        )
    lines += ["", f"Winner selected on tune only: **{winner}**. Heldout BA {rows[winner]['heldout']['balanced_accuracy']:.3f}, κ {rows[winner]['heldout']['cohen_kappa']:.3f}.", ""]
    (run_dir / "report.md").write_text("\n".join(lines), encoding="utf-8")
    return report


def self_check() -> None:
    order, strata = build_pool()
    assert len(strata) == 28
    assert len(order) > 28
    pilot = order[: len(strata)]
    assert len({(i["task"], i["arm"], i["reference_verdict"]) for i in pilot}) == 28
    assert {lane: sum(i["lane"] == lane for i in pilot) for lane in ("luna-performer", "deepseek-performer")} == {"luna-performer": 14, "deepseek-performer": 14}
    assert prices(200_000) == (2.0, 12.0) and prices(200_001) == (4.0, 18.0)
    truth = {str(i): "pass" if i % 2 else "fail" for i in range(8)}
    predicted = dict(truth)
    result = metrics(list(truth), truth, predicted)
    assert result["balanced_accuracy"] == result["cohen_kappa"] == 1.0
    print(f"self-check ok: {len(order)} eligible labels, {len(strata)} pilot strata")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=("self-check", "pilot", "expand", "candidate", "report"))
    parser.add_argument("--run-dir", type=Path, default=DEFAULT_RUN_DIR)
    parser.add_argument("--candidate", choices=tuple(CANDIDATES))
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if args.stage == "self-check":
        self_check()
        return
    run_dir = args.run_dir.resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    order, strata = build_pool()
    state = load_state(run_dir)
    if args.stage == "pilot":
        run_gemini(run_dir, state, order[: len(strata)], len(strata))
    elif args.stage == "expand":
        run_gemini(run_dir, state, order, len(order))
    elif args.stage == "candidate":
        if not args.candidate:
            parser.error("--candidate is required")
        oracle_ids = {item_id for item_id, row in state["gemini"]["items"].items() if row.get("verdict")}
        run_candidate(run_dir, state, [item for item in order if item["id"] in oracle_ids], args.candidate, args.workers)
    else:
        print(json.dumps(build_report(run_dir, state, order), indent=2))


if __name__ == "__main__":
    main()
