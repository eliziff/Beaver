#!/usr/bin/env python3
"""Small, dependency-free legal-session compaction benchmark.

The benchmark scores exact durable state, not semantic similarity. It supports:

* full transcript;
* an oracle structured state capsule plus an eight-turn tail;
* a deliberately ordinary prose summary plus the same tail;
* field-removal ablations; and
* OpenAI's opaque standalone /responses/compact window.

The synthetic fixtures are safe to redistribute. External legal benchmarks are
catalogued in the accompanying report but are not vendored here.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from typing import Any
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parent
RESULTS_DIR = ROOT / "results"
TAIL_TURNS = 8

ARRAY_FIELDS = {
    "superseded_instruction_ids",
    "accepted_edit_ids",
    "rejected_edit_ids",
}
INTEGER_FIELDS = {"tool_exit_code", "tool_result_count"}
BOOLEAN_FIELDS = {"tool_truncated"}

FIELDS = [
    "active_instruction_id",
    "active_instruction_text",
    "superseded_instruction_ids",
    "authority_document_id",
    "authority_version",
    "authority_sha256",
    "locator_kind",
    "locator_value",
    "quote_exact",
    "qualifier_exact",
    "source_url",
    "accepted_edit_ids",
    "rejected_edit_ids",
    "tool_receipt_id",
    "tool_status",
    "tool_exit_code",
    "tool_result_count",
    "tool_next_cursor",
    "tool_artifact_sha256",
    "tool_truncated",
    "matter_deadline",
]

GROUPS = {
    "instruction_retention": FIELDS[0:3],
    "authority_and_version": FIELDS[3:6],
    "pinpoint_quote_qualifier": FIELDS[6:11],
    "multi_turn_edits": FIELDS[11:13],
    "tool_receipts": FIELDS[13:20],
    "long_session_update": FIELDS[20:21],
}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        field: (
            {"type": ["array", "null"], "items": {"type": "string"}}
            if field in ARRAY_FIELDS
            else {"type": ["integer", "null"]}
            if field in INTEGER_FIELDS
            else {"type": ["boolean", "null"]}
            if field in BOOLEAN_FIELDS
            else {"type": ["string", "null"]}
        )
        for field in FIELDS
    },
    "required": FIELDS,
    "additionalProperties": False,
}

FIXTURE_TEMPLATES = [
    {
        "id": "ca_paragraph_revision",
        "matter": "Fictional Canadian judicial-review record",
        "old": {
            "instruction_id": "R-01",
            "instruction_text": "Use the first retrieved decision and summarize its general rule.",
            "authority_document_id": "D-003",
            "authority_version": "v1",
            "authority_sha256": "sha256:0ab3c08e6f-old-draft",
            "locator_kind": "paragraph",
            "locator_value": "61",
            "quote_exact": "The reviewing court may consider evidence gathered after the decision.",
            "qualifier_exact": "subject to fairness.",
            "source_url": "https://example.invalid/ca/chamberlain#par61",
            "edit_id": "E-17",
            "tool_receipt_id": "J-203",
            "tool_status": "partial",
            "tool_exit_code": 143,
            "tool_result_count": 7,
            "tool_next_cursor": "cursor-ca-0007",
            "tool_artifact_sha256": "NONE",
            "tool_truncated": True,
            "matter_deadline": "2026-09-01",
        },
        "state": {
            "active_instruction_id": "R-02",
            "active_instruction_text": (
                "Use only authority version D-004 and preserve every limiting qualifier."
            ),
            "superseded_instruction_ids": ["R-01"],
            "authority_document_id": "D-004",
            "authority_version": "v2",
            "authority_sha256": "sha256:61f9e9a28b7d5f4d-ca-v2",
            "locator_kind": "paragraph",
            "locator_value": "62",
            "quote_exact": (
                "The reviewing court must assess the record as it stood when the decision was made."
            ),
            "qualifier_exact": (
                "unless the governing statute expressly authorizes fresh evidence."
            ),
            "source_url": (
                "https://example.invalid/ca/chamberlain#par62:~:text=The%20reviewing%20court,"
                "unless%20the%20governing%20statute"
            ),
            "accepted_edit_ids": ["E-22"],
            "rejected_edit_ids": ["E-17", "E-18"],
            "tool_receipt_id": "J-204",
            "tool_status": "complete",
            "tool_exit_code": 0,
            "tool_result_count": 23,
            "tool_next_cursor": "NONE",
            "tool_artifact_sha256": "sha256:cc8f13c9d2d19c4a-ca-artifact",
            "tool_truncated": False,
            "matter_deadline": "2026-09-14",
        },
    },
    {
        "id": "us_section_revision",
        "matter": "Fictional American commercial-contract record",
        "old": {
            "instruction_id": "R-11",
            "instruction_text": "Rely on the working contract extract and omit implementation details.",
            "authority_document_id": "K-110",
            "authority_version": "draft-3",
            "authority_sha256": "sha256:old5e55b-contract-draft",
            "locator_kind": "section",
            "locator_value": "7.2",
            "quote_exact": "A party may terminate immediately by oral notice.",
            "qualifier_exact": "if convenient.",
            "source_url": "https://example.invalid/us/redwood#sec7.2",
            "edit_id": "E-71",
            "tool_receipt_id": "J-881",
            "tool_status": "timed_out",
            "tool_exit_code": 124,
            "tool_result_count": 4,
            "tool_next_cursor": "cursor-us-0004",
            "tool_artifact_sha256": "NONE",
            "tool_truncated": True,
            "matter_deadline": "2026-10-02",
        },
        "state": {
            "active_instruction_id": "R-12",
            "active_instruction_text": (
                "Quote section 7.3 exactly and state the surviving-payment proviso."
            ),
            "superseded_instruction_ids": ["R-11"],
            "authority_document_id": "K-111",
            "authority_version": "executed-1",
            "authority_sha256": "sha256:bd50e76d2e2f41b0-us-final",
            "locator_kind": "section",
            "locator_value": "7.3",
            "quote_exact": "A party may terminate after thirty days' written notice.",
            "qualifier_exact": (
                "provided that all accrued payment obligations remain enforceable."
            ),
            "source_url": (
                "https://example.invalid/us/redwood#sec7.3:~:text=A%20party%20may%20terminate,"
                "provided%20that%20all%20accrued"
            ),
            "accepted_edit_ids": ["E-75", "E-76"],
            "rejected_edit_ids": ["E-71", "E-72"],
            "tool_receipt_id": "J-882",
            "tool_status": "complete",
            "tool_exit_code": 0,
            "tool_result_count": 19,
            "tool_next_cursor": "NONE",
            "tool_artifact_sha256": "sha256:7449440f0c26059d-us-artifact",
            "tool_truncated": False,
            "matter_deadline": "2026-10-19",
        },
    },
]

BENCHMARK_INSTRUCTIONS = """\
This is a closed-record legal state-recovery test. Treat later express updates as
authoritative over older values. Preserve exact quotes, qualifiers, identifiers,
hashes, locators, URLs, edit dispositions, and tool receipt status. A partial,
timed-out, killed, or truncated tool receipt is not a completed result. Do not
use external knowledge or tools. When the final question arrives, return every
requested field as JSON. Use null only when the supplied context genuinely does
not contain a value; do not invent one."""


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def build_turns(
    template: dict[str, Any], noise_repeats: int = 1
) -> list[dict[str, Any]]:
    """Create a fixed 64-turn session with stale values and later corrections."""

    if noise_repeats < 1:
        raise ValueError("noise_repeats must be at least 1")
    old = template["old"]
    state = template["state"]
    critical = {
        1: (
            "user",
            f"Instruction {old['instruction_id']} is active: {old['instruction_text']}",
        ),
        2: (
            "assistant",
            f"Recorded {old['instruction_id']} as the current drafting instruction.",
        ),
        6: (
            "user",
            "Initial source record JSON: "
            + json.dumps(
                {
                    "document": old["authority_document_id"],
                    "version": old["authority_version"],
                    "sha256": old["authority_sha256"],
                    "locator_kind": old["locator_kind"],
                    "locator_value": old["locator_value"],
                    "url": old["source_url"],
                },
                ensure_ascii=False,
            ),
        ),
        10: (
            "assistant",
            "Working extraction from the initial source: "
            f'quote="{old["quote_exact"]}" qualifier="{old["qualifier_exact"]}"',
        ),
        14: (
            "user",
            "[TOOL RECEIPT] "
            f"id={old['tool_receipt_id']}; status={old['tool_status']}; "
            f"exit_code={old['tool_exit_code']}; result_count={old['tool_result_count']}; "
            f"next_cursor={old['tool_next_cursor']}; "
            f"artifact_sha256={old['tool_artifact_sha256']}; "
            f"truncated={str(old['tool_truncated']).lower()}.",
        ),
        18: (
            "user",
            f"Edit review: accept {old['edit_id']}; reject "
            f"{state['rejected_edit_ids'][-1]}. This is provisional.",
        ),
        22: (
            "user",
            f"The provisional matter deadline is {old['matter_deadline']}.",
        ),
        27: (
            "user",
            "AUTHORITATIVE CORRECTION: "
            f"{state['authority_document_id']} {state['authority_version']} with "
            f"{state['authority_sha256']} supersedes "
            f"{old['authority_document_id']} {old['authority_version']}.",
        ),
        29: (
            "assistant",
            "Corrected pinpoint record JSON: "
            + json.dumps(
                {
                    "locator_kind": state["locator_kind"],
                    "locator_value": state["locator_value"],
                    "quote_exact": state["quote_exact"],
                    "qualifier_exact": state["qualifier_exact"],
                    "url": state["source_url"],
                },
                ensure_ascii=False,
            ),
        ),
        34: (
            "user",
            f"Instruction {state['active_instruction_id']} now supersedes "
            f"{old['instruction_id']}. Exact active instruction: "
            f"{state['active_instruction_text']}",
        ),
        39: (
            "user",
            "[TOOL RECEIPT] "
            f"id={state['tool_receipt_id']}; status={state['tool_status']}; "
            f"exit_code={state['tool_exit_code']}; "
            f"result_count={state['tool_result_count']}; "
            f"next_cursor={state['tool_next_cursor']}; "
            f"artifact_sha256={state['tool_artifact_sha256']}; "
            f"truncated={str(state['tool_truncated']).lower()}. "
            f"This receipt supersedes {old['tool_receipt_id']}.",
        ),
        45: (
            "user",
            "FINAL EDIT DISPOSITION: accepted="
            f"{json.dumps(state['accepted_edit_ids'])}; rejected="
            f"{json.dumps(state['rejected_edit_ids'])}. This replaces the provisional review.",
        ),
        57: (
            "user",
            f"FINAL DEADLINE UPDATE: {state['matter_deadline']} supersedes "
            f"{old['matter_deadline']}.",
        ),
        64: (
            "assistant",
            "The closed record is ready for exact-state verification; no further changes.",
        ),
    }

    turns = []
    for number in range(1, 65):
        if number in critical:
            role, content = critical[number]
        else:
            role = "assistant" if number % 2 == 0 else "user"
            base_content = (
                f"Administrative exchange {number:02d} for {template['matter']}. "
                "It discusses scheduling, formatting, and issue triage only. It does not "
                "change any instruction, source version, quote, qualifier, pinpoint, URL, "
                "edit disposition, tool receipt, artifact, cursor, or deadline. Historical "
                "values remain historical unless an express authoritative update says otherwise."
            )
            distractors = [
                (
                    f"NON-AUTHORITATIVE DISTRACTOR {number:02d}-{repeat:02d}: a hypothetical "
                    f"research lead mentions draft H-{number:02d}{repeat:02d}, page "
                    f"{number + repeat}, and a possible procedural exception. It is unverified, "
                    "does not concern the closed record, and must not update durable state."
                )
                for repeat in range(2, noise_repeats + 1)
            ]
            content = " ".join([base_content, *distractors])
        turns.append({"turn": number, "role": role, "content": content})
    return turns


def fixture_by_id(fixture_id: str, noise_repeats: int = 1) -> dict[str, Any]:
    for template in FIXTURE_TEMPLATES:
        if template["id"] == fixture_id:
            fixture = dict(template)
            fixture["turns"] = build_turns(template, noise_repeats=noise_repeats)
            fixture["noise_repeats"] = noise_repeats
            return fixture
    raise ValueError(f"unknown fixture: {fixture_id}")


def fixture_ids() -> list[str]:
    return [item["id"] for item in FIXTURE_TEMPLATES]


def narrative_summary(fixture: dict[str, Any]) -> str:
    state = fixture["state"]
    return (
        "The matter moved from an obsolete working source to a corrected final source. "
        f"The controlling material is the later {state['authority_version']} version, and "
        f"the relevant {state['locator_kind']} is near {state['locator_value']}. The quoted "
        "rule must be reproduced accurately with its exception or proviso. A later instruction "
        "requires use of the final authority and retention of limitations. The first retrieval "
        "did not finish, while a later retrieval completed and returned roughly twenty records. "
        "Some provisional edits were reversed and later edits accepted. The final deadline was "
        f"moved to {state['matter_deadline']}. Exact identifiers, hashes, receipt metadata, "
        "wording, and URL are omitted from this ordinary prose summary."
    )


def exact_capsule(fixture: dict[str, Any], arm: str) -> dict[str, Any]:
    state = dict(fixture["state"])
    removals = {
        "no_instruction_state": {
            "active_instruction_id",
            "active_instruction_text",
            "superseded_instruction_ids",
        },
        "no_pinpoint_state": {
            "locator_kind",
            "locator_value",
            "quote_exact",
            "qualifier_exact",
            "source_url",
        },
        "no_edit_state": {"accepted_edit_ids", "rejected_edit_ids"},
        "no_tool_receipt_state": {
            "tool_receipt_id",
            "tool_status",
            "tool_exit_code",
            "tool_result_count",
            "tool_next_cursor",
            "tool_artifact_sha256",
            "tool_truncated",
        },
    }
    for field in removals.get(arm, set()):
        state.pop(field, None)
    return {
        "schema": "mike.legal-session-state.v0",
        "fixture_id": fixture["id"],
        "authoritative_state": state,
        "rule": "Fields in this capsule are exact and authoritative.",
    }


def as_api_message(turn: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": turn["role"],
        "content": f"[TURN {turn['turn']:02d}] {turn['content']}",
    }


def query_text() -> str:
    return (
        "Recover the final authoritative state. Return one JSON object with exactly these "
        f"fields: {', '.join(FIELDS)}. Preserve exact strings and array order. Use null for a "
        "value absent from the supplied context. Do not explain the answer."
    )


def arm_input(fixture: dict[str, Any], arm: str) -> list[dict[str, Any]]:
    turns = fixture["turns"]
    first = [{"role": "user", "content": BENCHMARK_INSTRUCTIONS}]
    if arm in {"full_history", "native_openai_compact"}:
        return first + [as_api_message(turn) for turn in turns]
    if arm == "prose_summary":
        body = [{"role": "user", "content": "[PROSE SUMMARY]\n" + narrative_summary(fixture)}]
    elif arm in {
        "structured_capsule",
        "no_instruction_state",
        "no_pinpoint_state",
        "no_edit_state",
        "no_tool_receipt_state",
    }:
        capsule = json.dumps(exact_capsule(fixture, arm), indent=2, ensure_ascii=False)
        body = [{"role": "user", "content": "[AUTHORITATIVE STATE CAPSULE]\n" + capsule}]
    else:
        raise ValueError(f"unknown arm: {arm}")
    return first + body + [as_api_message(turn) for turn in turns[-TAIL_TURNS:]]


ARMS = [
    "full_history",
    "structured_capsule",
    "prose_summary",
    "native_openai_compact",
    "no_instruction_state",
    "no_pinpoint_state",
    "no_edit_state",
    "no_tool_receipt_state",
]


def codex_prompt(fixture: dict[str, Any], arm: str) -> str:
    supplied = arm_input(fixture, arm)
    if arm == "native_openai_compact":
        raise ValueError("native_openai_compact requires the OpenAI API runner")
    return (
        "Do not call tools. Use only the supplied benchmark messages.\n\n"
        "[SUPPLIED MESSAGES]\n"
        + json.dumps(supplied, indent=2, ensure_ascii=False)
        + "\n\n[FINAL USER MESSAGE]\n"
        + query_text()
    )


def score_prediction(
    expected: dict[str, Any], prediction: dict[str, Any] | None
) -> dict[str, Any]:
    prediction = prediction or {}
    fields = {
        field: {
            "pass": prediction.get(field) == expected[field],
            "expected": expected[field],
            "actual": prediction.get(field),
        }
        for field in FIELDS
    }
    groups = {}
    for name, group_fields in GROUPS.items():
        passed = sum(fields[field]["pass"] for field in group_fields)
        groups[name] = {
            "passed": passed,
            "total": len(group_fields),
            "score": passed / len(group_fields),
        }
    passed = sum(item["pass"] for item in fields.values())
    return {
        "passed": passed,
        "total": len(FIELDS),
        "score": passed / len(FIELDS),
        "hard_pass": passed == len(FIELDS),
        "groups": groups,
        "fields": fields,
    }


def parse_json_object(text: str) -> dict[str, Any]:
    candidate = text.strip()
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        candidate = "\n".join(lines[1:-1]).strip()
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end <= start:
            raise
        value = json.loads(candidate[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("model output was not a JSON object")
    return value


def summarize_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    by_arm: dict[str, list[float]] = {}
    hard_passes: dict[str, int] = {}
    failures: dict[str, int] = {}
    for record in records:
        arm = record["arm"]
        if record.get("score"):
            by_arm.setdefault(arm, []).append(record["score"]["score"])
            hard_passes[arm] = hard_passes.get(arm, 0) + int(
                record["score"]["hard_pass"]
            )
        else:
            failures[arm] = failures.get(arm, 0) + 1
    return {
        arm: {
            "successful_runs": len(scores),
            "failed_runs": failures.get(arm, 0),
            "mean_exact_score": sum(scores) / len(scores),
            "hard_passes": hard_passes.get(arm, 0),
        }
        for arm, scores in by_arm.items()
    } | {
        arm: {
            "successful_runs": 0,
            "failed_runs": count,
            "mean_exact_score": None,
            "hard_passes": 0,
        }
        for arm, count in failures.items()
        if arm not in by_arm
    }


def save_run(prefix: str, metadata: dict[str, Any], records: list[dict[str, Any]]) -> Path:
    RESULTS_DIR.mkdir(exist_ok=True)
    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RESULTS_DIR / f"{prefix}-{timestamp}.json"
    payload = {
        "metadata": metadata,
        "summary": summarize_records(records),
        "records": records,
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def run_codex_one(
    fixture: dict[str, Any],
    arm: str,
    model: str,
    effort: str,
    timeout: int,
) -> dict[str, Any]:
    codex_binary = shutil.which("codex.cmd" if os.name == "nt" else "codex")
    if not codex_binary:
        raise RuntimeError("codex executable was not found on PATH")
    prompt = codex_prompt(fixture, arm)
    started = time.perf_counter()
    record: dict[str, Any] = {
        "fixture_id": fixture["id"],
        "fixture_sha256": sha256_json(
            {"state": fixture["state"], "turns": fixture["turns"]}
        ),
        "arm": arm,
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "prompt_chars": len(prompt),
    }
    try:
        with tempfile.TemporaryDirectory(prefix="mike-context-b-") as temp:
            temp_path = Path(temp)
            schema_path = temp_path / "schema.json"
            output_path = temp_path / "answer.json"
            schema_path.write_text(json.dumps(OUTPUT_SCHEMA), encoding="utf-8")
            command = [
                codex_binary,
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "-C",
                str(temp_path),
                "-m",
                model,
                "-c",
                f'model_reasoning_effort="{effort}"',
                "--output-schema",
                str(schema_path),
                "-o",
                str(output_path),
                "-",
            ]
            completed = subprocess.run(
                command,
                input=prompt,
                text=True,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
                check=False,
            )
            record["exit_code"] = completed.returncode
            record["event_lines"] = len(completed.stdout.splitlines())
            if completed.returncode != 0:
                record["error"] = (completed.stderr or completed.stdout)[-3000:]
            elif not output_path.exists():
                record["error"] = "Codex did not create the requested final-message file."
            else:
                prediction = parse_json_object(output_path.read_text(encoding="utf-8"))
                record["prediction"] = prediction
                record["score"] = score_prediction(fixture["state"], prediction)
    except Exception as error:  # keep a batch reproducible even if one call fails
        record["error"] = f"{type(error).__name__}: {error}"
    record["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    return record


def api_post(path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    request = urllib.request.Request(
        "https://api.openai.com/v1" + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI HTTP {error.code}: {body[:3000]}") from error


def responses_payload(
    model: str, effort: str, supplied_input: list[dict[str, Any]]
) -> dict[str, Any]:
    return {
        "model": model,
        "input": supplied_input
        + [{"role": "user", "content": query_text()}],
        "store": False,
        "reasoning": {"effort": effort},
        "max_output_tokens": 2500,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "legal_state",
                "strict": True,
                "schema": OUTPUT_SCHEMA,
            }
        },
    }


def extract_response_text(response: dict[str, Any]) -> str:
    chunks = []
    for item in response.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if content.get("type") == "output_text":
                chunks.append(content.get("text", ""))
    if not chunks and isinstance(response.get("output_text"), str):
        chunks.append(response["output_text"])
    if not chunks:
        raise ValueError("Responses API result contained no output_text")
    return "".join(chunks)


def run_openai_one(
    fixture: dict[str, Any],
    arm: str,
    model: str,
    effort: str,
    timeout: int,
) -> dict[str, Any]:
    supplied = arm_input(fixture, arm)
    started = time.perf_counter()
    record: dict[str, Any] = {
        "fixture_id": fixture["id"],
        "fixture_sha256": sha256_json(
            {"state": fixture["state"], "turns": fixture["turns"]}
        ),
        "arm": arm,
        "input_sha256": sha256_json(supplied),
        "input_chars": len(stable_json(supplied)),
    }
    try:
        if arm == "native_openai_compact":
            compacted = api_post(
                "/responses/compact",
                {"model": model, "input": supplied},
                timeout,
            )
            compacted_output = compacted.get("output")
            if not isinstance(compacted_output, list):
                raise ValueError("compact response did not contain an output array")
            record["compaction"] = {
                "output_item_count": len(compacted_output),
                "output_item_types": [
                    item.get("type", "unknown") for item in compacted_output
                ],
                "output_chars": len(stable_json(compacted_output)),
                "output_sha256": sha256_json(compacted_output),
                "usage": compacted.get("usage"),
            }
            response = api_post(
                "/responses",
                responses_payload(model, effort, compacted_output),
                timeout,
            )
        else:
            response = api_post(
                "/responses",
                responses_payload(model, effort, supplied),
                timeout,
            )
        prediction = parse_json_object(extract_response_text(response))
        record["prediction"] = prediction
        record["score"] = score_prediction(fixture["state"], prediction)
        record["usage"] = response.get("usage")
        record["response_model"] = response.get("model")
    except Exception as error:  # keep other paired arms runnable
        record["error"] = f"{type(error).__name__}: {error}"
    record["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    return record


def select_fixtures(value: str, noise_repeats: int = 1) -> list[dict[str, Any]]:
    selected = fixture_ids() if value == "all" else value.split(",")
    unknown = sorted(set(selected) - set(fixture_ids()))
    if unknown:
        raise ValueError(f"unknown fixtures: {', '.join(unknown)}")
    return [
        fixture_by_id(fixture_id, noise_repeats=noise_repeats)
        for fixture_id in selected
    ]


def select_arms(value: str, allowed: set[str]) -> list[str]:
    selected = value.split(",")
    unknown = sorted(set(selected) - allowed)
    if unknown:
        raise ValueError(f"unsupported arms for this runner: {', '.join(unknown)}")
    return selected


def command_inspect(args: argparse.Namespace) -> int:
    report = {}
    for fixture in select_fixtures(args.fixtures, args.noise_repeats):
        arms = {}
        for arm in ARMS:
            supplied = arm_input(fixture, arm)
            arms[arm] = {
                "messages": len(supplied),
                "characters": len(stable_json(supplied)),
                "rough_tokens_at_4_chars": round(len(stable_json(supplied)) / 4),
            }
        report[fixture["id"]] = {
            "turns": len(fixture["turns"]),
            "noise_repeats": fixture["noise_repeats"],
            "fixture_sha256": sha256_json(
                {"state": fixture["state"], "turns": fixture["turns"]}
            ),
            "assertions": len(FIELDS),
            "arms": arms,
        }
    print(json.dumps(report, indent=2))
    return 0


def command_selftest(_: argparse.Namespace) -> int:
    fixture = fixture_by_id(fixture_ids()[0])
    perfect = score_prediction(fixture["state"], dict(fixture["state"]))
    corrupted_prediction = dict(fixture["state"])
    corrupted_prediction["qualifier_exact"] = None
    corrupted_prediction["tool_status"] = "partial"
    corrupted = score_prediction(fixture["state"], corrupted_prediction)
    assert perfect["hard_pass"] and perfect["score"] == 1.0
    assert corrupted["passed"] == len(FIELDS) - 2
    assert not corrupted["hard_pass"]
    assert len(fixture["turns"]) == 64
    assert len(arm_input(fixture, "structured_capsule")) == TAIL_TURNS + 2
    print("selftest passed")
    return 0


def command_run_codex(args: argparse.Namespace) -> int:
    arms = select_arms(
        args.arms,
        set(ARMS) - {"native_openai_compact"},
    )
    fixtures = select_fixtures(args.fixtures, args.noise_repeats)
    records = []
    codex_binary = shutil.which("codex.cmd" if os.name == "nt" else "codex")
    if not codex_binary:
        raise RuntimeError("codex executable was not found on PATH")
    version = subprocess.run(
        [codex_binary, "--version"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    ).stdout.strip()
    for repetition in range(1, args.repetitions + 1):
        for fixture in fixtures:
            for arm in arms:
                print(
                    f"codex repetition={repetition} fixture={fixture['id']} arm={arm}",
                    flush=True,
                )
                record = run_codex_one(
                    fixture, arm, args.model, args.effort, args.timeout
                )
                record["repetition"] = repetition
                records.append(record)
                if record.get("score"):
                    print(
                        f"  exact={record['score']['passed']}/{record['score']['total']}",
                        flush=True,
                    )
                else:
                    print(f"  failed: {record.get('error', 'unknown error')[:300]}", flush=True)
    metadata = {
        "runner": "codex_exec",
        "codex_version": version,
        "model": args.model,
        "effort": args.effort,
        "tail_turns": TAIL_TURNS,
        "noise_repeats": args.noise_repeats,
        "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    path = save_run("codex", metadata, records)
    print(path)
    return int(any("score" not in record for record in records))


def command_run_openai(args: argparse.Namespace) -> int:
    arms = select_arms(args.arms, set(ARMS))
    fixtures = select_fixtures(args.fixtures, args.noise_repeats)
    records = []
    for repetition in range(1, args.repetitions + 1):
        for fixture in fixtures:
            for arm in arms:
                print(
                    f"openai repetition={repetition} fixture={fixture['id']} arm={arm}",
                    flush=True,
                )
                record = run_openai_one(
                    fixture, arm, args.model, args.effort, args.timeout
                )
                record["repetition"] = repetition
                records.append(record)
                if record.get("score"):
                    print(
                        f"  exact={record['score']['passed']}/{record['score']['total']}",
                        flush=True,
                    )
                else:
                    print(f"  failed: {record.get('error', 'unknown error')[:300]}", flush=True)
    metadata = {
        "runner": "openai_responses",
        "model": args.model,
        "effort": args.effort,
        "tail_turns": TAIL_TURNS,
        "noise_repeats": args.noise_repeats,
        "native_compaction_contract": (
            "The /responses/compact output array was passed through unchanged and the "
            "new user message appended, per OpenAI documentation."
        ),
        "timestamp_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    path = save_run("openai", metadata, records)
    print(path)
    return int(any("score" not in record for record in records))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect_parser = subparsers.add_parser("inspect", help="show fixture sizes and hashes")
    inspect_parser.add_argument("--fixtures", default="all")
    inspect_parser.add_argument("--noise-repeats", type=int, default=1)
    inspect_parser.set_defaults(function=command_inspect)

    selftest_parser = subparsers.add_parser("selftest", help="test local scoring")
    selftest_parser.set_defaults(function=command_selftest)

    codex_parser = subparsers.add_parser(
        "run-codex", help="run non-native arms through saved Codex authentication"
    )
    codex_parser.add_argument("--model", default="gpt-5.6-terra")
    codex_parser.add_argument("--effort", default="low")
    codex_parser.add_argument(
        "--arms",
        default="full_history,structured_capsule,prose_summary",
    )
    codex_parser.add_argument("--fixtures", default="all")
    codex_parser.add_argument("--noise-repeats", type=int, default=1)
    codex_parser.add_argument("--repetitions", type=int, default=1)
    codex_parser.add_argument("--timeout", type=int, default=300)
    codex_parser.set_defaults(function=command_run_codex)

    openai_parser = subparsers.add_parser(
        "run-openai", help="run arms through Responses and /responses/compact"
    )
    openai_parser.add_argument("--model", default="gpt-5.6")
    openai_parser.add_argument("--effort", default="low")
    openai_parser.add_argument(
        "--arms",
        default="full_history,structured_capsule,prose_summary,native_openai_compact",
    )
    openai_parser.add_argument("--fixtures", default="all")
    openai_parser.add_argument("--noise-repeats", type=int, default=1)
    openai_parser.add_argument("--repetitions", type=int, default=1)
    openai_parser.add_argument("--timeout", type=int, default=300)
    openai_parser.set_defaults(function=command_run_openai)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.function(args)
    except ValueError as error:
        parser.error(str(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
