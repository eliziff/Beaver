#!/usr/bin/env python3
"""Dependency-free context-compaction ablation fixture.

This harness does two deliberately separate things:

1. It verifies deterministic properties of candidate context builders:
   exact-state coverage, exposure to superseded values, and approximate size.
2. It emits identical, exact-match probes for blinded calls to any model.

It does not pretend that string coverage predicts model accuracy.  A live model
run is required to test the quality hypothesis.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Event:
    seq: int
    role: str
    kind: str
    text: str


@dataclass(frozen=True)
class LedgerEntry:
    entry_id: str
    key: str
    value: str
    seq: int
    status: str = "active"
    superseded_by: str | None = None


@dataclass(frozen=True)
class Probe:
    probe_id: str
    question: str
    required: tuple[str, ...]
    forbidden: tuple[str, ...] = ()
    context_conflicts: tuple[str, ...] | None = None


@dataclass(frozen=True)
class Fixture:
    events: tuple[Event, ...]
    ledger: tuple[LedgerEntry, ...]
    summary: str
    probes: tuple[Probe, ...]


@dataclass(frozen=True)
class Variant:
    name: str
    context: str


def _noise(label: str, repetitions: int = 90) -> str:
    line = (
        f"{label}: retry=0 status=ok elapsed_ms=17 "
        "diagnostic=intermediate-output-not-needed-after-milestone"
    )
    return "\n".join(line for _ in range(repetitions))


def build_fixture() -> Fixture:
    quote = "The tribunal must decide the issue on the record before it."
    quote_hash = hashlib.sha256(quote.encode("utf-8")).hexdigest()
    document_hash_v1 = hashlib.sha256(b"synthetic-document-version-1").hexdigest()
    document_hash_v3 = hashlib.sha256(b"synthetic-document-version-3").hexdigest()

    events = (
        Event(1, "user", "objective", "Build a local legal research workspace for Matter M-204."),
        Event(2, "assistant", "plan", "I will preserve exact source provenance and document versions."),
        Event(3, "user", "constraint", "ACCOUNTS=REQUIRED for this early prototype."),
        Event(4, "assistant", "ack", "Recorded the account requirement."),
        Event(5, "user", "constraint", "STORAGE=CLOUD_SUPABASE for the first deployment."),
        Event(6, "assistant", "ack", "Recorded the cloud-storage choice."),
        Event(7, "tool", "tool_bulk", _noise("dependency-scan-a")),
        Event(
            8,
            "tool",
            "document_receipt",
            f"DOCUMENT_ID=DOC-17 VERSION=1 CONTENT_SHA256={document_hash_v1}",
        ),
        Event(9, "assistant", "work", "The first document version has been indexed."),
        Event(10, "tool", "tool_bulk", _noise("pdf-layout-trace")),
        Event(11, "user", "request", "Locate the proposition supported by paragraph 62."),
        Event(12, "assistant", "work", "I am checking the source and its pinpoint."),
        Event(13, "tool", "tool_bulk", _noise("retrieval-candidates")),
        Event(14, "assistant", "work", "Candidate results require source verification."),
        Event(15, "user", "request", "Keep the exact quotation and a deterministic link."),
        Event(16, "assistant", "ack", "The verified evidence will be durable state."),
        Event(17, "tool", "tool_bulk", _noise("link-debug")),
        Event(
            18,
            "user",
            "constraint_update",
            "Supersede the prototype settings: use local AppData storage and no accounts.",
        ),
        Event(
            19,
            "assistant",
            "constraint_update",
            "Current settings are STORAGE=LOCAL_APPDATA and ACCOUNTS=DISABLED.",
        ),
        Event(20, "tool", "tool_receipt", "SETTINGS_WRITE_OK matter=M-204 revision=2"),
        Event(
            21,
            "tool",
            "document_receipt",
            f"DOCUMENT_ID=DOC-17 VERSION=3 CONTENT_SHA256={document_hash_v3}",
        ),
        Event(22, "assistant", "work", "Version 3 supersedes version 1."),
        Event(
            23,
            "tool",
            "evidence_receipt",
            "\n".join(
                (
                    "EVIDENCE_ID=E-62",
                    "SOURCE_ID=CASE-17",
                    "LOCATOR=#par62",
                    f"QUOTE={quote}",
                    f"QUOTE_SHA256={quote_hash}",
                    "PINPOINT_URL=https://example.invalid/case-17#par62",
                )
            ),
        ),
        Event(24, "assistant", "work", "The verified paragraph-62 evidence is now linked."),
        Event(25, "user", "request", "Run the remaining non-authoritative diagnostics."),
        Event(26, "tool", "tool_bulk", _noise("non-authoritative-diagnostics")),
        Event(27, "assistant", "work", "Diagnostics passed; no durable facts changed."),
        Event(28, "user", "request", "Show two retrieval strategies before drafting."),
        Event(
            29,
            "assistant",
            "decision_surface",
            "OPTION_A=VECTOR_FIRST retrieves broad semantic chunks. "
            "OPTION_B=PINPOINT_FIRST resolves structured legal locators before semantic expansion.",
        ),
        Event(30, "user", "selection", "Use the second option."),
        Event(31, "assistant", "confirmation", "Understood; I will apply the selected option."),
        Event(32, "assistant", "tool_call", "lookup_source(source_id=CASE-17, locator=#par62)"),
        Event(33, "tool", "tool_bulk", _noise("lookup-render-trace", repetitions=120)),
        Event(34, "tool", "tool_receipt", "LOOKUP_OK evidence_id=E-62 locator=#par62"),
        Event(
            35,
            "assistant",
            "work",
            "WORKFLOW_PHASE=SOURCE_VERIFIED NEXT_ACTION=DRAFT_WITH_PINPOINT",
        ),
        Event(36, "user", "request", "Answer the next state question from authoritative information."),
    )

    ledger = (
        LedgerEntry(
            "L-storage-1",
            "storage",
            "STORAGE=CLOUD_SUPABASE",
            5,
            status="superseded",
            superseded_by="L-storage-2",
        ),
        LedgerEntry("L-storage-2", "storage", "STORAGE=LOCAL_APPDATA", 19),
        LedgerEntry(
            "L-accounts-1",
            "accounts",
            "ACCOUNTS=REQUIRED",
            3,
            status="superseded",
            superseded_by="L-accounts-2",
        ),
        LedgerEntry("L-accounts-2", "accounts", "ACCOUNTS=DISABLED", 19),
        LedgerEntry(
            "L-document-1",
            "document",
            f"DOCUMENT_ID=DOC-17 VERSION=1 CONTENT_SHA256={document_hash_v1}",
            8,
            status="superseded",
            superseded_by="L-document-3",
        ),
        LedgerEntry(
            "L-document-3",
            "document",
            f"DOCUMENT_ID=DOC-17 VERSION=3 CONTENT_SHA256={document_hash_v3}",
            21,
        ),
        LedgerEntry(
            "L-evidence-62",
            "evidence:E-62",
            "\n".join(
                (
                    "EVIDENCE_ID=E-62",
                    "SOURCE_ID=CASE-17",
                    "LOCATOR=#par62",
                    f"QUOTE={quote}",
                    f"QUOTE_SHA256={quote_hash}",
                    "PINPOINT_URL=https://example.invalid/case-17#par62",
                )
            ),
            23,
        ),
        LedgerEntry(
            "L-workflow-1",
            "workflow",
            "WORKFLOW_PHASE=SOURCE_VERIFIED NEXT_ACTION=DRAFT_WITH_PINPOINT",
            35,
        ),
    )

    summary = "\n".join(
        (
            "Objective: finish a local, account-free legal research workflow for Matter M-204.",
            "Current work: the newest document is authoritative and a paragraph-level source was verified.",
            "Constraints: keep exact provenance and deterministic links; avoid cloud storage.",
            "Recent decision: the user selected one of two retrieval strategies in the recent exchange.",
            "Next: answer the state probe, then draft with the verified pinpoint.",
        )
    )

    probes = (
        Probe(
            "storage",
            "What is the current storage setting? Return its canonical token.",
            ("STORAGE=LOCAL_APPDATA",),
            ("STORAGE=CLOUD_SUPABASE",),
        ),
        Probe(
            "accounts",
            "Are accounts enabled? Return the canonical current token.",
            ("ACCOUNTS=DISABLED",),
            ("ACCOUNTS=REQUIRED",),
        ),
        Probe(
            "document_version",
            "Identify the authoritative document version and content hash.",
            (
                "DOCUMENT_ID=DOC-17",
                "VERSION=3",
                f"CONTENT_SHA256={document_hash_v3}",
            ),
            (
                "VERSION=1",
                f"CONTENT_SHA256={document_hash_v1}",
            ),
        ),
        Probe(
            "exact_evidence",
            "Return the source ID, locator, quotation hash, and deterministic URL for E-62.",
            (
                "SOURCE_ID=CASE-17",
                "LOCATOR=#par62",
                f"QUOTE_SHA256={quote_hash}",
                "PINPOINT_URL=https://example.invalid/case-17#par62",
            ),
        ),
        Probe(
            "recent_deixis",
            "Which retrieval strategy did the user select? Return its canonical token.",
            ("OPTION_B=PINPOINT_FIRST",),
            ("OPTION_A=VECTOR_FIRST",),
            context_conflicts=(),
        ),
        Probe(
            "workflow",
            "What is the current workflow phase and next action?",
            ("WORKFLOW_PHASE=SOURCE_VERIFIED", "NEXT_ACTION=DRAFT_WITH_PINPOINT"),
        ),
    )

    return Fixture(events=events, ledger=ledger, summary=summary, probes=probes)


def render_events(events: Iterable[Event]) -> str:
    return "\n\n".join(
        f"[event seq={event.seq} role={event.role} kind={event.kind}]\n{event.text}"
        for event in events
    )


def render_ledger(entries: Iterable[LedgerEntry]) -> str:
    rendered: list[str] = []
    for entry in entries:
        metadata = (
            f"[ledger id={entry.entry_id} key={entry.key} seq={entry.seq} "
            f"status={entry.status}"
        )
        if entry.superseded_by:
            metadata += f" superseded_by={entry.superseded_by}"
        rendered.append(f"{metadata}]\n{entry.value}")
    return "\n\n".join(rendered)


def _sections(*parts: tuple[str, str]) -> str:
    return "\n\n".join(f"## {heading}\n{body}" for heading, body in parts if body)


def build_variants(fixture: Fixture) -> tuple[Variant, ...]:
    recent = fixture.events[-8:]
    user_tail = tuple(
        event for event in recent if event.role in {"user", "developer", "system"}
    )
    event_tail = tuple(
        event
        for event in recent
        if event.role in {"user", "developer", "system"}
        or event.kind in {"decision_surface", "tool_receipt", "approval"}
    )
    active_ledger = tuple(entry for entry in fixture.ledger if entry.status == "active")

    return (
        Variant("full_history", _sections(("RAW HISTORY", render_events(fixture.events)))),
        Variant(
            "summary_recent_tail",
            _sections(
                ("LOSSY TASK SUMMARY", fixture.summary),
                ("RECENT VERBATIM TAIL", render_events(recent)),
            ),
        ),
        Variant(
            "full_ledger_summary_recent_tail",
            _sections(
                ("EXACT LEDGER INCLUDING SUPERSEDED ENTRIES", render_ledger(fixture.ledger)),
                ("LOSSY TASK SUMMARY", fixture.summary),
                ("RECENT VERBATIM TAIL", render_events(recent)),
            ),
        ),
        Variant(
            "active_ledger_summary_recent_tail",
            _sections(
                ("ACTIVE EXACT LEDGER", render_ledger(active_ledger)),
                ("LOSSY TASK SUMMARY", fixture.summary),
                ("RECENT VERBATIM TAIL", render_events(recent)),
            ),
        ),
        Variant(
            "active_ledger_summary_user_tail",
            _sections(
                ("ACTIVE EXACT LEDGER", render_ledger(active_ledger)),
                ("LOSSY TASK SUMMARY", fixture.summary),
                ("RECENT USER-ROLE TAIL", render_events(user_tail)),
            ),
        ),
        Variant(
            "active_ledger_summary_event_tail",
            _sections(
                ("ACTIVE EXACT LEDGER", render_ledger(active_ledger)),
                ("LOSSY TASK SUMMARY", fixture.summary),
                ("RECENT EVENT-AWARE TAIL", render_events(event_tail)),
            ),
        ),
    )


def estimate_tokens(text: str) -> int:
    """Transparent provider-neutral proxy; live runs must use provider counts."""
    return math.ceil(len(text.encode("utf-8")) / 4)


def analyze_variant(variant: Variant, probes: Sequence[Probe]) -> dict[str, object]:
    probe_results = []
    for probe in probes:
        required_hits = sum(token in variant.context for token in probe.required)
        conflict_tokens = (
            probe.forbidden
            if probe.context_conflicts is None
            else probe.context_conflicts
        )
        forbidden_hits = tuple(
            token for token in conflict_tokens if token in variant.context
        )
        probe_results.append(
            {
                "probe_id": probe.probe_id,
                "required_hits": required_hits,
                "required_total": len(probe.required),
                "complete": required_hits == len(probe.required),
                "forbidden_hits": forbidden_hits,
            }
        )
    return {
        "variant": variant.name,
        "characters": len(variant.context),
        "estimated_tokens": estimate_tokens(variant.context),
        "complete_probes": sum(bool(result["complete"]) for result in probe_results),
        "probe_total": len(probes),
        "forbidden_token_hits": sum(
            len(result["forbidden_hits"]) for result in probe_results
        ),
        "probes": probe_results,
    }


def markdown_report(fixture: Fixture, variants: Sequence[Variant]) -> str:
    analyses = [analyze_variant(variant, fixture.probes) for variant in variants]
    lines = [
        "# Track A structural ablation",
        "",
        "Token counts are UTF-8 bytes / 4 estimates, not provider billing counts.",
        "Coverage is a deterministic precondition, not a claim about model accuracy.",
        "",
        "| variant | est. tokens | exact probes covered | stale-token exposures |",
        "|---|---:|---:|---:|",
    ]
    for result in analyses:
        lines.append(
            f"| {result['variant']} | {result['estimated_tokens']} | "
            f"{result['complete_probes']}/{result['probe_total']} | "
            f"{result['forbidden_token_hits']} |"
        )
    return "\n".join(lines)


def prompt_records(
    fixture: Fixture, variants: Sequence[Variant]
) -> Iterable[dict[str, object]]:
    instruction = (
        "Answer only from the supplied context. Prefer active authoritative state over "
        "superseded state. Copy requested canonical tokens exactly. Do not infer a value "
        "that is absent. If the context is insufficient or irreconcilably ambiguous, "
        "answer INSUFFICIENT_CONTEXT."
    )
    for variant in variants:
        for probe in fixture.probes:
            yield {
                "case_id": f"{variant.name}::{probe.probe_id}",
                "variant": variant.name,
                "probe_id": probe.probe_id,
                "instruction": instruction,
                "context": variant.context,
                "question": probe.question,
                "gold_required": list(probe.required),
                "gold_forbidden": list(probe.forbidden),
            }


def score_answers(
    fixture: Fixture, variants: Sequence[Variant], answer_path: Path
) -> dict[str, object]:
    expected = {
        record["case_id"]: record
        for record in prompt_records(fixture, variants)
    }
    supplied: dict[str, str] = {}
    with answer_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            case_id = record.get("case_id")
            answer = record.get("answer")
            if case_id not in expected:
                raise ValueError(f"line {line_number}: unknown case_id {case_id!r}")
            if not isinstance(answer, str):
                raise ValueError(f"line {line_number}: answer must be a string")
            supplied[str(case_id)] = answer

    by_variant: dict[str, dict[str, int]] = {
        variant.name: {"passed": 0, "failed": 0, "missing": 0}
        for variant in variants
    }
    cases: list[dict[str, object]] = []
    for case_id, record in expected.items():
        variant_name = str(record["variant"])
        if case_id not in supplied:
            by_variant[variant_name]["missing"] += 1
            cases.append({"case_id": case_id, "status": "missing"})
            continue
        answer = supplied[case_id]
        missing_required = [
            token for token in record["gold_required"] if token not in answer
        ]
        forbidden_present = [
            token for token in record["gold_forbidden"] if token in answer
        ]
        passed = not missing_required and not forbidden_present
        by_variant[variant_name]["passed" if passed else "failed"] += 1
        cases.append(
            {
                "case_id": case_id,
                "status": "passed" if passed else "failed",
                "missing_required": missing_required,
                "forbidden_present": forbidden_present,
            }
        )
    return {"by_variant": by_variant, "cases": cases}


def self_test(fixture: Fixture, variants: Sequence[Variant]) -> None:
    analyses = {
        result["variant"]: result
        for result in (analyze_variant(variant, fixture.probes) for variant in variants)
    }
    probe_total = len(fixture.probes)
    full_history = analyses["full_history"]
    summary_tail = analyses["summary_recent_tail"]
    full_ledger = analyses["full_ledger_summary_recent_tail"]
    active_recent = analyses["active_ledger_summary_recent_tail"]
    active_user = analyses["active_ledger_summary_user_tail"]
    active_event = analyses["active_ledger_summary_event_tail"]

    assert full_history["complete_probes"] == probe_total
    assert full_history["forbidden_token_hits"] > 0
    assert summary_tail["complete_probes"] < probe_total
    assert full_ledger["complete_probes"] == probe_total
    assert full_ledger["forbidden_token_hits"] > 0
    assert active_recent["complete_probes"] == probe_total
    assert active_recent["forbidden_token_hits"] == 0
    assert active_event["complete_probes"] == probe_total
    assert active_event["forbidden_token_hits"] == 0
    assert active_event["estimated_tokens"] < active_recent["estimated_tokens"]
    assert active_event["estimated_tokens"] < full_history["estimated_tokens"]

    user_probe = next(
        result
        for result in active_user["probes"]
        if result["probe_id"] == "recent_deixis"
    )
    assert not user_probe["complete"]
    print("self-test: ok")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("report", help="print the structural ablation table")
    subparsers.add_parser("prompts", help="emit blinded live-model cases as JSONL")
    score_parser = subparsers.add_parser(
        "score", help="score JSONL answers with exact-match gates"
    )
    score_parser.add_argument("answers", type=Path)
    subparsers.add_parser("self-test", help="run deterministic harness assertions")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    fixture = build_fixture()
    variants = build_variants(fixture)
    command = args.command or "report"

    if command == "report":
        print(markdown_report(fixture, variants))
    elif command == "prompts":
        for record in prompt_records(fixture, variants):
            print(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    elif command == "score":
        print(
            json.dumps(
                score_answers(fixture, variants, args.answers),
                ensure_ascii=False,
                indent=2,
            )
        )
    elif command == "self-test":
        self_test(fixture, variants)
    else:
        raise AssertionError(f"unhandled command: {command}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
