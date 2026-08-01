#!/usr/bin/env python3
"""Toy address-backed legal compaction experiment for a local Ollama Qwen.

The runner is intentionally dependency-free. It freezes the Mike benchmark
contract in mike_baseline.py, exposes only those tools, and keeps the address
registry outside the model messages. It is an experiment harness, not a
production compaction implementation.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    from mike_baseline import (
        MIKE_SYSTEM_PROMPT,
        MIKE_TOOLS,
        UPSTREAM_MIKE_COMMIT,
        UPSTREAM_MIKE_SCHEMA_SHA256,
        ollama_tools,
        tool_names,
    )
except ModuleNotFoundError:  # package import for small offline probes
    from .mike_baseline import (
        MIKE_SYSTEM_PROMPT,
        MIKE_TOOLS,
        UPSTREAM_MIKE_COMMIT,
        UPSTREAM_MIKE_SCHEMA_SHA256,
        ollama_tools,
        tool_names,
    )


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_NUM_CTX = 32768
DEFAULT_PACKET_CHARS = 72000
DEFAULT_NUM_PREDICT = 4096
A2AJ_DB_DEFAULT = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "OpenLegalProducts/LegalData/providers/a2aj/a2aj-cases-fulltext.sqlite"
)
MARKER_RE = re.compile(r"(?m)^[ \t]*\[(\d+)\][ \t]*")
WS_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class Paragraph:
    number: int
    text: str


@dataclass(frozen=True)
class CaseSpec:
    doc_id: str
    filename: str
    citation: str
    path: Path | None
    key_paragraphs: tuple[int, ...]
    descriptors: dict[int, str]
    a2aj_document_id: int | None = None


@dataclass
class CaseDocument:
    spec: CaseSpec
    source_text: str
    paragraphs: tuple[Paragraph, ...]
    packet: str
    source_sha256: str
    packet_sha256: str
    raw_sha256: str | None
    source_url: str
    included_paragraphs: tuple[int, ...]

    @property
    def paragraph_map(self) -> dict[int, str]:
        return {paragraph.number: paragraph.text for paragraph in self.paragraphs}


CASE_SPECS = (
    CaseSpec(
        doc_id="case-a",
        filename="Bhasin v. Hrynew (2014 SCC 71)",
        citation="Bhasin v. Hrynew, 2014 SCC 71",
        path=ROOT
        / "benchmarks/legal-generalization-corpus/text/ca-case-2014-scc-bhasin-v-hrynew.txt",
        key_paragraphs=(63, 65, 66, 73, 80, 86, 112),
        descriptors={
            63: "organizing principle of good faith",
            65: "appropriate regard and limits of good faith",
            66: "manifestation through existing doctrines",
            73: "general duty of honest performance",
            80: "minimum standard of honesty",
            86: "honest performance versus disclosure or loyalty",
            112: "disposition and damages",
        },
    ),
    CaseSpec(
        doc_id="case-b",
        filename="Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District (2021 SCC 7)",
        citation="Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District, 2021 SCC 7",
        path=ROOT
        / "benchmarks/legal-generalization-corpus/text/ca-case-2021-scc-wastech-services.txt",
        key_paragraphs=(4, 5, 6, 7, 63, 64, 70, 71, 73, 74, 75),
        descriptors={
            4: "rule for contractual discretion exercised in good faith",
            5: "purpose-connected discretion",
            6: "contractual purpose and the bargain",
            7: "application of the rule in the appeal",
            63: "statement of the discretionary-power duty",
            64: "Bhasin and the purpose of discretion",
            70: "touchstone for reasonableness",
            71: "outside the contractual purpose",
            73: "role of the reviewing court",
            74: "deference and contractual context",
            75: "application to the contract",
        },
    ),
    CaseSpec(
        doc_id="case-c",
        filename="C.M. Callow Inc. v. Zollinger (2020 SCC 45)",
        citation="C.M. Callow Inc. v. Zollinger, 2020 SCC 45",
        path=None,
        a2aj_document_id=193842,
        key_paragraphs=(2, 3, 5, 37, 38, 40, 42, 44, 47, 74, 75, 90, 91, 99, 101, 104),
        descriptors={
            2: "Bhasin organizing principle and honest performance",
            3: "honesty applies to all contracts",
            5: "holding and active deception",
            37: "termination right must be exercised honestly",
            38: "misleading conduct versus positive disclosure",
            40: "no new duty required; honest exercise of clause",
            42: "honesty applies to exercise of contractual rights",
            44: "existing honest-performance doctrine resolves appeal",
            47: "legitimate interests and the contractual bargain",
            74: "dishonesty directly linked to contract performance",
            75: "wrongful manner of exercising termination right",
            90: "misleading conduct can include omissions or silence",
            91: "fact-specific knowingly-misled standard",
            99: "failure to correct a known false impression",
            101: "breach from failing to correct misapprehension",
            104: "minimum rule against false representations",
        },
    ),
)


TURN_ONE = """Begin with Bhasin v. Hrynew only. Use the available document tools to read the case before answering. Do not analyze or read the Wastech case yet.

Return an inline legal research answer with:
1. a concise summary of the material facts, issue, holding, and reasoning; and
2. three key quotations, quoted verbatim, each labeled with its SCC paragraph number.

After read_document, use the returned text directly. Make no more than three targeted find_in_document calls, then answer. Do not create a DOCX for this toy run. Use only the source text."""

TURN_TWO = """Now handle Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District only. Use the available document tools to read the case before answering. Do not compare it with Bhasin yet.

Return an inline legal research answer with:
1. a concise summary of the material facts, issue, holding, and reasoning; and
2. three key quotations, quoted verbatim, each labeled with its SCC paragraph number.

After read_document, use the returned text directly. Make no more than three targeted find_in_document calls, then answer. Do not create a DOCX for this toy run. Use only the source text."""

TURN_THREE = """Now handle C.M. Callow Inc. v. Zollinger only. Use the available document tools to read the case before answering. Do not compare it with Bhasin or Wastech yet.

Return an inline legal research answer with:
1. a concise summary of the material facts, issue, holding, and reasoning; and
2. three key quotations, quoted verbatim, each labeled with its SCC paragraph number.

After read_document, use the returned text directly. Make no more than three targeted find_in_document calls, then answer. Do not create a DOCX for this toy run. Use only the source text."""

TURN_FOUR = """Compare Bhasin v. Hrynew, Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District, and C.M. Callow Inc. v. Zollinger.

Explain the relationship among the three decisions: what Wastech confirms or narrows about Bhasin, what Callow applies or clarifies, and where the cases distinguish honest performance, contractual discretion, and misleading conduct. Produce a concise comparative legal research answer with exact quotations and SCC paragraph references.

Use submit_grounded_answer only for actual verbatim quotations, not summaries or legal conclusions. Every quotation must have kind "quotation", the exact quoted text, and one or more evidence_ids copied from the stable handles in the compacted context. The host verifier will report accepted and failed claim indexes plus a centered repair passage. Resubmit only failed claims. Do not invent quotations, paragraph numbers, or handles."""


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def collapse_ws(value: str) -> str:
    return WS_RE.sub(" ", value).strip()


def estimate_tokens(value: str) -> int:
    """Transparent conservative-ish estimate used only for planning.

    The live receipt records Ollama's prompt_eval_count. This estimate is a
    structural guard, not a tokenizer substitute.
    """

    return math.ceil(len(value.encode("utf-8")) / 4)


def resolve_path(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


def manifest_metadata(path: Path) -> tuple[str | None, str | None]:
    """Return (raw_sha256, official source URL) when the local manifest knows it."""

    manifest = ROOT / "benchmarks/legal-generalization-corpus/manifest.jsonl"
    try:
        relative = path.relative_to(ROOT).as_posix()
    except ValueError:
        return None, None
    if not manifest.exists():
        return None, None
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("text_file") == relative:
            return row.get("sha256"), row.get("source_url")
    return None, None


def extract_english_spine(text: str) -> tuple[Paragraph, ...]:
    """Keep the first sequential court paragraph spine from a bilingual extract.

    The local SCC text interleaves English and French material. The first
    occurrence of [1], [2], ... is the English spine for these judgments; the
    duplicate marker is the French rendering. This rule is recorded in the
    run receipt and intentionally stops when the sequence resets for later
    separate reasons.
    """

    matches = list(MARKER_RE.finditer(text))
    first = next((i for i, match in enumerate(matches) if int(match.group(1)) == 1), None)
    if first is None:
        raise ValueError("source has no court paragraph marker [1]")

    expected = 1
    paragraphs: list[Paragraph] = []
    for index in range(first, len(matches)):
        match = matches[index]
        number = int(match.group(1))
        if number != expected:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.start() : end].strip()
        paragraphs.append(Paragraph(number=number, text=body))
        expected += 1
    if not paragraphs or paragraphs[0].number != 1:
        raise ValueError("could not recover a sequential English paragraph spine")
    return tuple(paragraphs)


def build_packet(
    spec: CaseSpec,
    text: str,
    paragraphs: tuple[Paragraph, ...],
    max_chars: int,
) -> tuple[str, tuple[int, ...]]:
    header = (
        f"DOCUMENT: {spec.filename}\n"
        f"CITATION: {spec.citation}\n"
        "TEXT SCOPE: English sequential court-paragraph spine from the local "
        "bilingual extraction; paragraph boundaries preserved."
    )
    parts = [header]
    included: list[int] = []
    length = len(header)
    for paragraph in paragraphs:
        addition = "\n\n" + paragraph.text
        if included and length + len(addition) > max_chars:
            break
        parts.append(paragraph.text)
        included.append(paragraph.number)
        length += len(addition)
    if not included:
        raise ValueError(f"packet cap is too small to include paragraph 1 for {spec.doc_id}")
    return "\n\n".join(parts), tuple(included)


def load_a2aj_case(db_path: Path, document_id: int) -> tuple[str, str, str]:
    if not db_path.exists():
        raise FileNotFoundError(f"A2AJ full-text database not found: {db_path}")
    uri = f"file:{db_path.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        row = connection.execute(
            "SELECT citation_en, name_en, url_en, unofficial_text_en "
            "FROM document WHERE id = ?",
            (document_id,),
        ).fetchone()
    if row is None or not row[3]:
        raise ValueError(f"A2AJ document {document_id} has no English full text")
    return str(row[3]), str(row[2] or ""), f"a2aj:document:{document_id}"


def load_case(
    spec: CaseSpec,
    max_chars: int,
    a2aj_db: Path | None = None,
) -> CaseDocument:
    if spec.a2aj_document_id is not None:
        source_text, source_url, source_ref = load_a2aj_case(
            a2aj_db or A2AJ_DB_DEFAULT,
            spec.a2aj_document_id,
        )
    else:
        if spec.path is None or not spec.path.exists():
            raise FileNotFoundError(f"case source not found: {spec.path}")
        source_text = spec.path.read_text(encoding="utf-8")
        _, source_url = manifest_metadata(spec.path)
        source_ref = str(spec.path)
    paragraphs = extract_english_spine(source_text)
    packet, included = build_packet(spec, source_text, paragraphs, max_chars)
    raw_sha256 = None
    if spec.path is not None:
        raw_sha256, manifest_url = manifest_metadata(spec.path)
        source_url = source_url or manifest_url
    return CaseDocument(
        spec=spec,
        source_text=source_text,
        paragraphs=paragraphs,
        packet=packet,
        source_sha256=sha256_text(source_text),
        packet_sha256=sha256_text(packet),
        raw_sha256=raw_sha256,
        source_url=source_url or Path(source_ref).as_uri(),
        included_paragraphs=included,
    )


def load_cases(
    max_chars: int = DEFAULT_PACKET_CHARS,
    source_a: Path | None = None,
    source_b: Path | None = None,
    a2aj_db: Path | None = None,
) -> dict[str, CaseDocument]:
    specs = list(CASE_SPECS)
    if source_a is not None:
        specs[0] = CaseSpec(**{**asdict(specs[0]), "path": source_a})
    if source_b is not None:
        specs[1] = CaseSpec(**{**asdict(specs[1]), "path": source_b})
    return {
        spec.doc_id: load_case(spec, max_chars, a2aj_db)
        for spec in specs
    }


def handle_id(case: CaseDocument, paragraph: int) -> str:
    return f"{case.spec.doc_id}@session-snapshot#paragraph-{paragraph}"


def evidence_handles(case: CaseDocument) -> list[dict[str, Any]]:
    paragraph_map = case.paragraph_map
    handles: list[dict[str, Any]] = []
    for number in case.spec.key_paragraphs:
        text = paragraph_map.get(number)
        if text is None:
            raise ValueError(f"missing key paragraph {number} in {case.spec.citation}")
        handles.append(
            {
                "handle": handle_id(case, number),
                "source": case.spec.citation,
                "locator": f"SCC paragraph {number}",
                "paragraph": number,
                "description": case.spec.descriptors[number],
                "content_sha256": sha256_text(text),
            }
        )
    return handles


def rehydrate(cases: dict[str, CaseDocument]) -> str:
    """Page exact selected evidence back into the final context."""

    sections = [
        "[REHYDRATED EXACT EVIDENCE - source text, not a summary]",
        "The following paragraphs were fetched from stable source handles. Quote only text within these passages.",
    ]
    for case in cases.values():
        sections.append(f"\nSOURCE: {case.spec.citation}\nSOURCE_URL: {case.source_url}")
        paragraph_map = case.paragraph_map
        for item in evidence_handles(case):
            sections.append(
                f"\nHANDLE: {item['handle']}\n"
                f"LOCATOR: {item['locator']}\n"
                f"CONTENT_SHA256: {item['content_sha256']}\n"
                f"{paragraph_map[item['paragraph']]}"
            )
    return "\n".join(sections)


def redact_quotes(text: str) -> str:
    """Remove likely exact quote bodies from a retained model response.

    This is deliberately a crude toy compactor. The address registry, not
    this redactor, is the authority for exact evidence. A later experiment can
    replace it with a source-span-aware extractor.
    """

    lines: list[str] = []
    for line in text.splitlines():
        if line.lstrip().startswith(">") and len(line.strip()) > 24:
            lines.append("[exact block quotation omitted; see evidence handles]")
        else:
            lines.append(line)
    value = "\n".join(lines)
    value = re.sub(
        r"([\"“])[^\"”\n]{20,}([\"”])",
        "[exact quotation omitted; see evidence handles]",
        value,
    )
    return value.strip()


def compact_checkpoint(
    cases: dict[str, CaseDocument],
    retained_responses: list[str],
    include_rehydrated: bool,
) -> str:
    lines = [
        "[COMPACTION CHECKPOINT]",
        "Exact case text and prior tool observations were removed from the active context.",
        "The source artifacts are stable for this session. Evidence handles are pointers, not quotations.",
        "",
    ]
    for index, response in enumerate(retained_responses):
        lines.extend(
            [
                f"CASE {chr(65 + index)} RETAINED SUMMARY (model-authored; quotations removed):",
                redact_quotes(response) or "(no turn text was returned)",
                "",
            ]
        )
    lines.extend(
        [
        "EXACT EVIDENCE REGISTRY:",
        ]
    )
    for case in cases.values():
        lines.append(f"{case.spec.citation} | source={case.spec.doc_id} | snapshot=session")
        for item in evidence_handles(case):
            lines.append(
                f"- {item['handle']} | {item['locator']} | {item['description']} | "
                f"hash={item['content_sha256']}"
            )
    if include_rehydrated:
        lines.extend(["", rehydrate(cases)])
    else:
        lines.extend(
            [
                "",
                "Exact evidence has not been rehydrated. Do not invent a quotation from a handle.",
            ]
        )
    return "\n".join(lines)


class OllamaError(RuntimeError):
    def __init__(self, message: str, context_overflow: bool = False):
        super().__init__(message)
        self.context_overflow = context_overflow


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        num_ctx: int,
        num_predict: int,
        temperature: float,
        host_header: str | None = None,
        timeout_seconds: int = 900,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.num_ctx = num_ctx
        self.num_predict = num_predict
        self.temperature = temperature
        self.host_header = host_header
        self.timeout_seconds = timeout_seconds

    def chat(
        self,
        messages: list[dict[str, Any]],
        include_grounding_tool: bool = False,
        include_rehydration_tool: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        request_tools = ollama_tools()
        if include_rehydration_tool:
            request_tools.append(REHYDRATE_EVIDENCE_TOOL)
        if include_grounding_tool:
            request_tools.append(GROUNDED_ANSWER_TOOL)
        body = {
            "model": self.model,
            "messages": messages,
            "tools": request_tools,
            "stream": False,
            "options": {
                "temperature": self.temperature,
                "num_ctx": self.num_ctx,
                "num_predict": self.num_predict,
            },
        }
        headers = {"Content-Type": "application/json"}
        if self.host_header:
            headers["Host"] = self.host_header
        request = urllib.request.Request(
            f"{self.base_url}/api/chat",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            overflow = any(
                phrase in detail.lower()
                for phrase in ("context", "prompt is too long", "maximum")
            )
            raise OllamaError(f"HTTP {error.code}: {detail}", overflow) from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise OllamaError(f"Ollama request failed: {error}") from error
        elapsed = time.perf_counter() - started
        message = payload.get("message") or {}
        usage = {
            "prompt_eval_count": payload.get("prompt_eval_count") or 0,
            "eval_count": payload.get("eval_count") or 0,
            "total_duration_ns": payload.get("total_duration") or 0,
            "wall_seconds": round(elapsed, 3),
        }
        return message, usage


GROUNDED_ANSWER_TOOL_NAME = "submit_grounded_answer"
REHYDRATE_EVIDENCE_TOOL_NAME = "rehydrate_evidence"
REHYDRATE_EVIDENCE_TOOL = {
    "type": "function",
    "function": {
        "name": REHYDRATE_EVIDENCE_TOOL_NAME,
        "strict": True,
        "description": "Fetch one immutable paragraph. Quote from its deterministic copy_text; exact_text is retained for audit.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"evidence_id": {"type": "string"}},
            "required": ["evidence_id"],
        },
    },
}
GROUNDED_ANSWER_TOOL = {
    "type": "function",
    "function": {
        "name": GROUNDED_ANSWER_TOOL_NAME,
        "strict": True,
        "description": (
            "Finish the legal comparison as independently checkable support units. "
            "Every quotation must be copied exactly from one cited evidence handle. "
            "Do not emit a separate prose answer."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "claims": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 32,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "text": {"type": "string", "minLength": 5, "maxLength": 4000},
                            "evidence_ids": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 8,
                                "items": {"type": "string"},
                            },
                            "kind": {
                                "type": "string",
                                "enum": ["quotation"],
                            },
                        },
                        "required": ["text", "evidence_ids", "kind"],
                    },
                },
            },
            "required": ["claims"],
        },
    },
}


class ToyMikeTools:
    def __init__(self, cases: dict[str, CaseDocument]):
        self.cases = cases
        self.active_doc_ids: set[str] = set()
        self.final_rehydration_active = False
        self.generated_docx: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.verifier_attempts: list[dict[str, Any]] = []
        self.verified_claims: list[dict[str, Any]] | None = None

    def set_phase(self, phase: str) -> None:
        if phase == "case-a":
            self.active_doc_ids = {"case-a"}
        elif phase == "case-b":
            self.active_doc_ids = {"case-b"}
        elif phase == "case-c":
            self.active_doc_ids = {"case-c"}
        elif phase == "final":
            self.active_doc_ids = set(self.cases)
        else:
            raise ValueError(f"unknown phase: {phase}")

    def set_final_rehydration(self, active: bool) -> None:
        self.final_rehydration_active = active

    def _allowed(self, doc_id: str) -> CaseDocument | None:
        if doc_id not in self.cases:
            return None
        if doc_id not in self.active_doc_ids:
            return None
        return self.cases[doc_id]

    def _evidence_by_handle(self) -> dict[str, tuple[CaseDocument, str]]:
        evidence: dict[str, tuple[CaseDocument, str]] = {}
        for case in self.cases.values():
            paragraph_map = case.paragraph_map
            for item in evidence_handles(case):
                evidence[item["handle"]] = (case, paragraph_map[item["paragraph"]])
        return evidence

    @staticmethod
    def _quote_body(value: str) -> str:
        value = value.strip()
        value = unicodedata.normalize("NFKC", value)
        value = (
            value.replace("â€œ", '"')
            .replace("â€", '"')
            .replace("â€™", "'")
            .replace("â€”", "-")
            .replace("â€“", "-")
        )
        value = re.sub(r"^\s*(?:\[\d{1,4}\]|\(?(?:para(?:graph)?\s*)?\d{1,4}\)?)[.:]?\s*", "", value, flags=re.IGNORECASE)
        value = value.translate(str.maketrans({"‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-"}))
        value = re.sub(r"(?<=[^\W_])-\s*(?=[^\W_])", "", value)
        value = re.sub(r'^["“”‘’]+|["“”‘’]+$', "", value)
        return collapse_ws(value)

    @classmethod
    def _quote_match(cls, quote: str, source: str) -> tuple[float, bool]:
        candidate = cls._quote_body(quote).casefold()
        target = cls._quote_body(source).casefold()
        if not candidate or not target:
            return 0.0, False
        if candidate in target:
            return 1.0, True
        quote_words = re.findall(r"[\w']+", candidate)
        source_words = re.findall(r"[\w']+", target)
        if not quote_words or not source_words:
            return 0.0, False
        blocks = difflib.SequenceMatcher(
            a=source_words, b=quote_words, autojunk=False
        ).get_matching_blocks()
        return sum(block.size for block in blocks) / len(quote_words), False

    @classmethod
    def _copy_ready_text(cls, value: str) -> str:
        return cls._quote_body(value)

    @classmethod
    def _repair_excerpt(cls, quote: str, source: str) -> str:
        source_text = collapse_ws(source)
        quote_words = re.findall(r"[\w']+", cls._quote_body(quote).casefold())
        source_matches = list(re.finditer(r"[\w']+", source_text.casefold()))
        source_words = [match.group(0) for match in source_matches]
        if not quote_words or not source_words:
            return source_text[:280]
        blocks = difflib.SequenceMatcher(
            a=source_words, b=quote_words, autojunk=False
        ).get_matching_blocks()
        block = max(blocks, key=lambda item: item.size, default=None)
        if block is None or block.size == 0:
            return source_text[:280]
        start = max(0, source_matches[block.a].start() - 24)
        end_word = min(len(source_matches) - 1, block.a + block.size - 1)
        end = min(len(source_text), source_matches[end_word].end() + 120)
        prefix = source_text[:100]
        snippet = source_text[start:end]
        return f"{prefix} … {snippet}"[:420]

    def _submit_grounded_answer(self, args: dict[str, Any]) -> str:
        errors: list[str] = []
        diagnostics: list[dict[str, Any]] = []
        claims = args.get("claims")
        evidence = self._evidence_by_handle()
        if set(args) != {"claims"} or not isinstance(claims, list) or not claims:
            errors.append("submit_grounded_answer requires a non-empty claims array")
            claims = []
        verified: list[dict[str, Any]] = []
        for index, raw in enumerate(claims):
            if not isinstance(raw, dict) or set(raw) != {"text", "evidence_ids", "kind"}:
                errors.append(f"claims[{index}] has the wrong fields")
                continue
            text = raw.get("text")
            ids = raw.get("evidence_ids")
            kind = raw.get("kind")
            if not isinstance(text, str) or not 5 <= len(text) <= 4000:
                errors.append(f"claims[{index}].text is invalid")
                continue
            if not isinstance(ids, list) or not ids or not all(isinstance(item, str) for item in ids):
                errors.append(f"claims[{index}].evidence_ids must contain handles")
                continue
            missing = [item for item in ids if item not in evidence]
            if missing:
                errors.append(f"claims[{index}] cites unknown evidence handle(s): {missing[:2]}")
                continue
            if kind != "quotation":
                errors.append(f"claims[{index}] is not a quotation; submit only verbatim quotations")
                continue
            matches = []
            for handle, (_case, passage) in evidence.items():
                score, exact = self._quote_match(text, passage)
                matches.append((score, exact, handle, passage))
            matches.sort(key=lambda item: (-item[1], -item[0]))
            cited = sorted(
                (item for item in matches if item[2] in ids),
                key=lambda item: (-item[1], -item[0]),
            )
            exact = next((item for item in cited if item[1] and len(self._quote_body(text)) >= 25), None)
            if exact is None:
                requested_best = cited[0] if cited else None
                best = requested_best or (matches[0] if matches else None)
                if best is None or best[0] < 0.25:
                    errors.append(f"claims[{index}] no_match; submit an exact passage from the cited handle")
                    diagnostics.append({"claim_index": index, "status": "no_match"})
                else:
                    alternate = best[2] not in ids
                    errors.append(
                        f"claims[{index}] partial_match at {best[2]} score={best[0]:.2f}"
                        + ("; cited handle has no match" if alternate else "; copy the closest passage exactly")
                    )
                    diagnostics.append({
                        "claim_index": index,
                        "status": "partial_match",
                        "requested_handles": ids,
                        "requested_best_handle": requested_best[2] if requested_best else None,
                        "requested_best_score": round(requested_best[0], 2) if requested_best else 0.0,
                        "closest_handle": best[2],
                        "closest_scope": "alternate" if alternate else "requested",
                        "score": round(best[0], 2),
                        "source_excerpt": self._repair_excerpt(text, best[3]),
                    })
                continue
            verified.append({"text": text, "evidence_ids": ids, "kind": kind})
        self.verifier_attempts.append({"arguments": args, "errors": errors, "diagnostics": diagnostics})
        if errors:
            failed = [item["claim_index"] for item in diagnostics]
            return json.dumps(
                {
                    "ok": False,
                    "accepted_claims": [index for index in range(len(claims)) if index not in failed],
                    "failed_claims": failed,
                    "errors": errors[:12],
                    "diagnostics": diagnostics[:12],
                },
                ensure_ascii=False,
            )
        self.verified_claims = verified
        return json.dumps(
            {"ok": True, "terminal": True, "verified_claims": len(verified)},
            ensure_ascii=False,
        )

    def render_verified_answer(self) -> str:
        if self.verified_claims is None:
            return ""
        lines = ["## Verified grounded submission", ""]
        for claim in self.verified_claims:
            lines.append(
                f"- **{claim['kind']}** {claim['text']} "
                f"`evidence_ids={','.join(claim['evidence_ids'])}`"
            )
        return "\n".join(lines)

    def execute(self, name: str, arguments: str | dict[str, Any]) -> str:
        if isinstance(arguments, str):
            try:
                args = json.loads(arguments)
            except json.JSONDecodeError:
                return "Error: invalid JSON arguments"
        else:
            args = arguments
        self.tool_calls.append({"name": name, "arguments": args})

        if name == REHYDRATE_EVIDENCE_TOOL_NAME:
            handle = str(args.get("evidence_id", ""))
            evidence = self._evidence_by_handle()
            item = evidence.get(handle)
            if item is None:
                return json.dumps({"ok": False, "error": "unknown evidence handle"})
            _case, passage = item
            return json.dumps(
                {
                    "ok": True,
                    "evidence_id": handle,
                    "locator": handle.rsplit("#", 1)[-1],
                    "content_sha256": sha256_text(passage),
                    "exact_text": passage,
                    "copy_text": self._copy_ready_text(passage),
                },
                ensure_ascii=False,
            )

        if name == GROUNDED_ANSWER_TOOL_NAME:
            return self._submit_grounded_answer(args)

        if name == "list_documents":
            rows = [
                {
                    "id": case.spec.doc_id,
                    "filename": case.spec.filename,
                    "file_type": "court judgment text",
                    "citation": case.spec.citation,
                }
                for doc_id, case in self.cases.items()
                if doc_id in self.active_doc_ids
            ]
            return json.dumps({"documents": rows}, ensure_ascii=False)

        if name in {"read_document", "find_in_document"}:
            doc_id = str(args.get("doc_id", ""))
            case = self._allowed(doc_id)
            if case is None:
                return f"Error: document {doc_id!r} is not available in this phase"
            if name == "read_document":
                if self.final_rehydration_active:
                    return json.dumps(
                        {
                            "ok": True,
                            "document_id": doc_id,
                            "citation": case.spec.citation,
                            "source_url": case.source_url,
                            "compaction": "full packet suppressed; exact selected evidence is already rehydrated in the active context",
                        },
                        ensure_ascii=False,
                    )
                return json.dumps(
                    {
                        "ok": True,
                        "document_id": doc_id,
                        "filename": case.spec.filename,
                        "citation": case.spec.citation,
                        "source_url": case.source_url,
                        "text_sha256": case.source_sha256,
                        "packet_sha256": case.packet_sha256,
                        "content": case.packet,
                    },
                    ensure_ascii=False,
                )
            return self._find(case, args)

        if name == "fetch_documents":
            doc_ids = args.get("doc_ids") or []
            if not isinstance(doc_ids, list):
                return "Error: doc_ids must be an array"
            results: list[dict[str, Any]] = []
            for raw_id in doc_ids:
                doc_id = str(raw_id)
                case = self._allowed(doc_id)
                if case is None:
                    results.append({"ok": False, "document_id": doc_id, "error": "not available in this phase"})
                else:
                    result = {
                        "ok": True,
                        "document_id": doc_id,
                        "filename": case.spec.filename,
                        "citation": case.spec.citation,
                        "source_url": case.source_url,
                        "text_sha256": case.source_sha256,
                        "packet_sha256": case.packet_sha256,
                    }
                    if self.final_rehydration_active:
                        result["compaction"] = "full packet suppressed; exact selected evidence is already rehydrated in the active context"
                    else:
                        result["content"] = case.packet
                    results.append(result)
            return json.dumps({"documents": results}, ensure_ascii=False)

        if name == "generate_docx":
            receipt = {
                "ok": True,
                "artifact_type": "toy-docx-receipt",
                "title": args.get("title"),
                "section_count": len(args.get("sections") or []),
                "note": "No binary document is written by this isolated experiment.",
            }
            self.generated_docx.append({"arguments": args, "receipt": receipt})
            return json.dumps(receipt, ensure_ascii=False)

        return f"Error: unknown tool {name!r}"

    @staticmethod
    def _find(case: CaseDocument, args: dict[str, Any]) -> str:
        query = collapse_ws(str(args.get("query", "")))
        if not query:
            return "Error: query is required"
        max_results = max(1, min(int(args.get("max_results", 20)), 20))
        context_chars = max(20, min(int(args.get("context_chars", 80)), 1000))
        # The read packet is bounded for context experiments, but find is a
        # source-backed retrieval tool. Search the immutable full artifact so
        # later paragraph handles remain reachable without reloading the whole
        # document into the model context.
        text = case.source_text
        normalized = collapse_ws(text)
        lower = normalized.lower()
        needle = query.lower()
        offset = 0
        matches: list[str] = []
        while len(matches) < max_results:
            index = lower.find(needle, offset)
            if index < 0:
                break
            start = max(0, index - context_chars)
            end = min(len(normalized), index + len(query) + context_chars)
            matches.append(normalized[start:end])
            offset = index + max(1, len(needle))
        return json.dumps(
            {
                "ok": True,
                "document_id": case.spec.doc_id,
                "query": query,
                "source_scope": "full_stable_source",
                "matches": matches,
            },
            ensure_ascii=False,
        )


def assistant_tool_calls(message: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []
    for raw in message.get("tool_calls") or []:
        function = raw.get("function") or {}
        name = str(function.get("name", ""))
        raw_arguments = function.get("arguments") or {}
        if isinstance(raw_arguments, str):
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError:
                arguments = {}
        else:
            arguments = raw_arguments
        calls.append((name, arguments))
    return calls


def run_turn(
    client: OllamaClient,
    messages: list[dict[str, Any]],
    prompt: str,
    phase: str,
    tools: ToyMikeTools,
    call_log: list[dict[str, Any]],
    turn_number: int,
    include_grounding_tool: bool = False,
    include_rehydration_tool: bool = False,
    max_tool_rounds: int = 10,
) -> tuple[str, list[dict[str, Any]]]:
    tools.set_phase(phase)
    messages.append({"role": "user", "content": prompt})
    last_text = ""
    for tool_round in range(max_tool_rounds):
        try:
            message, usage = client.chat(
                messages,
                include_grounding_tool,
                include_rehydration_tool,
            )
        except OllamaError as error:
            call_log.append(
                {
                    "turn": turn_number,
                    "phase": phase,
                    "tool_round": tool_round + 1,
                    "error": str(error),
                    "context_overflow": error.context_overflow,
                    "input_estimate": estimate_tokens(json.dumps(messages, ensure_ascii=False)),
                }
            )
            raise
        messages.append(message)
        last_text = str(message.get("content") or "")
        call_log.append(
            {
                "turn": turn_number,
                "phase": phase,
                "tool_round": tool_round + 1,
                "usage": usage,
                "assistant_text": last_text,
                "tool_calls": [name for name, _ in assistant_tool_calls(message)],
                "input_estimate": estimate_tokens(json.dumps(messages, ensure_ascii=False)),
            }
        )
        calls = assistant_tool_calls(message)
        if not calls:
            return last_text, messages
        retry_feedback: list[dict[str, Any]] = []
        for name, arguments in calls:
            result = tools.execute(name, arguments)
            messages.append(
                {
                    "role": "tool",
                    "tool_name": name,
                    "content": result,
                }
            )
            if name == GROUNDED_ANSWER_TOOL_NAME:
                try:
                    if json.loads(result).get("terminal"):
                        return tools.render_verified_answer(), messages
                    if include_grounding_tool:
                        retry_feedback.append(
                            {"role": "tool", "tool_name": name, "content": result}
                        )
                except json.JSONDecodeError:
                    pass
        if retry_feedback:
            # ponytail: retain only the checkpoint, latest submission, and compact
            # verifier feedback; full retry transcripts add tokens without evidence.
            messages[:] = messages[:3] + [message] + retry_feedback
    raise RuntimeError(
        f"model exceeded the {max_tool_rounds}-round tool budget on turn {turn_number}"
    )


def compact_messages(checkpoint: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": MIKE_SYSTEM_PROMPT},
        {"role": "user", "content": checkpoint},
    ]


def case_receipt(case: CaseDocument) -> dict[str, Any]:
    return {
        "doc_id": case.spec.doc_id,
        "filename": case.spec.filename,
        "citation": case.spec.citation,
        "path": str(case.spec.path) if case.spec.path else None,
        "a2aj_document_id": case.spec.a2aj_document_id,
        "source_url": case.source_url,
        "raw_sha256": case.raw_sha256,
        "text_sha256": case.source_sha256,
        "packet_sha256": case.packet_sha256,
        "source_chars": len(case.source_text),
        "packet_chars": len(case.packet),
        "packet_estimated_tokens": estimate_tokens(case.packet),
        "paragraph_count": len(case.paragraphs),
        "included_paragraphs": list(case.included_paragraphs),
        "key_paragraphs": list(case.spec.key_paragraphs),
    }


def inspect_cases(cases: dict[str, CaseDocument], num_ctx: int) -> None:
    tools_json = json.dumps(MIKE_TOOLS, ensure_ascii=False)
    base_tokens = estimate_tokens(MIKE_SYSTEM_PROMPT + tools_json)
    print(f"context_limit={num_ctx}")
    print(f"baseline_tools={','.join(tool_names())}")
    print(f"system_plus_tools_estimate={base_tokens}")
    for case in cases.values():
        print(
            f"{case.spec.doc_id}: packet_chars={len(case.packet)} "
            f"packet_estimate={estimate_tokens(case.packet)} "
            f"paragraphs={case.included_paragraphs[0]}-{case.included_paragraphs[-1]}"
        )
    combined = sum(len(case.packet) for case in cases.values())
    combined_estimate = estimate_tokens(MIKE_SYSTEM_PROMPT + tools_json) + estimate_tokens(
        TURN_ONE + TURN_TWO + TURN_THREE + TURN_FOUR
    ) + estimate_tokens(json.dumps("".join(case.packet for case in cases.values())))
    print(f"combined_history_estimate={combined_estimate} (raw_packet_chars={combined})")
    print("key_handles:")
    for case in cases.values():
        for item in evidence_handles(case):
            print(f"  {item['handle']} -> {item['locator']} ({item['description']})")


def self_test(cases: dict[str, CaseDocument], num_ctx: int) -> None:
    expected_tools = [
        "read_document",
        "find_in_document",
        "list_documents",
        "fetch_documents",
        "generate_docx",
    ]
    assert tool_names() == expected_tools, tool_names()
    assert num_ctx == DEFAULT_NUM_CTX, "self-test uses the 32k experiment budget"
    for case in cases.values():
        assert case.included_paragraphs
        assert estimate_tokens(case.packet) < num_ctx
        paragraph_map = case.paragraph_map
        for number in case.spec.key_paragraphs:
            assert number in paragraph_map, (case.spec.doc_id, number)
    combined = "\n".join(case.packet for case in cases.values())
    full_estimate = estimate_tokens(
        MIKE_SYSTEM_PROMPT
        + json.dumps(MIKE_TOOLS, ensure_ascii=False)
        + TURN_ONE
        + TURN_TWO
        + TURN_THREE
        + TURN_FOUR
        + combined
    )
    assert full_estimate > num_ctx, full_estimate
    checkpoint = compact_checkpoint(
        cases,
        ["summary A \"long quote that must disappear from context\"", "summary B"],
        False,
    )
    assert "EXACT EVIDENCE REGISTRY" in checkpoint
    assert "long quote that must disappear" not in checkpoint
    hydrated = compact_checkpoint(cases, ["summary A", "summary B", "summary C"], True)
    assert "REHYDRATED EXACT EVIDENCE" in hydrated
    for case in cases.values():
        assert handle_id(case, case.spec.key_paragraphs[0]) in checkpoint
    executor = ToyMikeTools(cases)
    executor.set_phase("case-a")
    listing = json.loads(executor.execute("list_documents", {}))
    assert [row["id"] for row in listing["documents"]] == ["case-a"]
    read_result = json.loads(executor.execute("read_document", {"doc_id": "case-a"}))
    assert read_result["packet_sha256"] == cases["case-a"].packet_sha256
    assert "[63]" in read_result["content"]
    assert "not available" in executor.execute("read_document", {"doc_id": "case-b"})
    executor.set_phase("final")
    handle = handle_id(cases["case-a"], cases["case-a"].spec.key_paragraphs[0])
    accepted = json.loads(
        executor.execute(
            GROUNDED_ANSWER_TOOL_NAME,
            {
                "claims": [
                    {
                        "text": cases["case-a"].paragraph_map[cases["case-a"].spec.key_paragraphs[0]],
                        "evidence_ids": [handle],
                        "kind": "quotation",
                    }
                ]
            },
        )
    )
    assert accepted["ok"] is True, accepted
    assert executor.verified_claims
    rejected = json.loads(
        executor.execute(
            GROUNDED_ANSWER_TOOL_NAME,
            {
                "claims": [
                    {
                        "text": "This is a fabricated quotation that is not in the source.",
                        "evidence_ids": [handle],
                        "kind": "quotation",
                    }
                ]
            },
        )
    )
    assert rejected["ok"] is False, rejected
    print("PASS legal_compaction_qwen self-test")
    print(f"full_history_estimate={full_estimate} > context_limit={num_ctx}")
    print("address_checkpoint_handles=present; exact_quote_body=omitted")
    print("grounded_submission=deterministically_verified")


def default_model() -> str:
    return os.environ.get("QWEN_MODEL") or os.environ.get("OLLAMA_MODEL") or "qwen3:32b"


def run_live(args: argparse.Namespace, cases: dict[str, CaseDocument]) -> Path:
    model = args.model or default_model()
    base_url = args.base_url or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434"
    client = OllamaClient(
        base_url=base_url,
        model=model,
        num_ctx=args.num_ctx,
        num_predict=args.num_predict,
        temperature=args.temperature,
        host_header=args.host_header or os.environ.get("OLLAMA_HOST_HEADER"),
    )
    executor = ToyMikeTools(cases)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": MIKE_SYSTEM_PROMPT},
    ]
    call_log: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    overflow: dict[str, Any] | None = None
    final_messages: list[dict[str, Any]] = messages

    try:
        first_response, messages = run_turn(
            client, messages, TURN_ONE, "case-a", executor, call_log, 1,
            max_tool_rounds=args.max_tool_rounds,
        )
        turns.append({"turn": 1, "prompt": TURN_ONE, "response": first_response})

        if args.arm == "full_history":
            second_messages = messages
        else:
            second_messages = compact_messages(
                compact_checkpoint(cases, [first_response], False)
            )
        second_response, messages = run_turn(
            client, second_messages, TURN_TWO, "case-b", executor, call_log, 2,
            max_tool_rounds=args.max_tool_rounds,
        )
        turns.append({"turn": 2, "prompt": TURN_TWO, "response": second_response})

        if args.arm == "full_history":
            third_messages = messages
        else:
            third_messages = compact_messages(
                compact_checkpoint(cases, [first_response, second_response], False)
            )
        third_response, messages = run_turn(
            client, third_messages, TURN_THREE, "case-c", executor, call_log, 3,
            max_tool_rounds=args.max_tool_rounds,
        )
        turns.append({"turn": 3, "prompt": TURN_THREE, "response": third_response})

        if args.arm == "full_history":
            final_messages = messages
        else:
            final_messages = compact_messages(
                compact_checkpoint(
                    cases,
                    [first_response, second_response, third_response],
                    args.arm == "address_rehydrate",
                )
            )
        executor.set_final_rehydration(args.arm == "address_rehydrate")
        final_prompt = TURN_FOUR
        if args.arm == "address_on_demand":
            final_prompt += " Before quoting, call rehydrate_evidence for each handle whose text you need, and copy quotations from its deterministic copy_text field. Omit paragraph labels from quotation text."
        final_response, final_messages = run_turn(
            client,
            final_messages,
            final_prompt,
            "final",
            executor,
            call_log,
            4,
            include_grounding_tool=True,
            include_rehydration_tool=args.arm == "address_on_demand",
            max_tool_rounds=args.max_tool_rounds,
        )
        turns.append({"turn": 4, "prompt": TURN_FOUR, "response": final_response})
    except OllamaError as error:
        overflow = {"message": str(error), "context_overflow": error.context_overflow}
        turns.append({"error": str(error)})
        final_response = ""
    except RuntimeError as error:
        overflow = {"message": str(error), "context_overflow": False}
        turns.append({"error": str(error)})
        final_response = ""

    record = {
        "experiment": "legal_compaction_qwen",
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "arm": args.arm,
        "model": model,
        "base_url": base_url,
        "host_header": args.host_header or os.environ.get("OLLAMA_HOST_HEADER"),
        "num_ctx": args.num_ctx,
        "num_predict": args.num_predict,
        "temperature": args.temperature,
        "max_tool_rounds": args.max_tool_rounds,
        "baseline": {
            "source": "frozen local mike_baseline.py",
            "upstream_commit": UPSTREAM_MIKE_COMMIT,
            "upstream_schema_sha256": UPSTREAM_MIKE_SCHEMA_SHA256,
            "tool_names": tool_names(),
        },
        "configuration": {
            "packet_chars": args.packet_chars,
            "source_a": str(cases["case-a"].spec.path),
            "source_b": str(cases["case-b"].spec.path),
            "a2aj_db": str(args.a2aj_db) if args.a2aj_db else str(A2AJ_DB_DEFAULT),
        },
        "cases": [case_receipt(case) for case in cases.values()],
        "turns": turns,
        "calls": call_log,
        "tool_calls": executor.tool_calls,
        "verifier_attempts": executor.verifier_attempts,
        "verified_claims": executor.verified_claims,
        "generated_docx": executor.generated_docx,
        "overflow": overflow,
        "final_answer": final_response,
        "messages_at_end": final_messages if not overflow else messages,
    }
    output = resolve_output(args.out, args.arm)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {output}")
    if overflow:
        print(f"model run stopped: {overflow['message']}", file=sys.stderr)
    else:
        print("final answer follows:\n")
        print(final_response)
    return output


def resolve_output(value: str | None, arm: str) -> Path:
    if value:
        return resolve_path(value)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return Path(__file__).resolve().parent / "runs" / f"{stamp}-{arm}.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    for name in ("self-test", "inspect"):
        sub = subparsers.add_parser(name)
        sub.add_argument("--packet-chars", type=int, default=DEFAULT_PACKET_CHARS)
        sub.add_argument("--num-ctx", type=int, default=DEFAULT_NUM_CTX)
        sub.add_argument("--source-a", type=resolve_path, default=None)
        sub.add_argument("--source-b", type=resolve_path, default=None)

    run = subparsers.add_parser("run")
    run.add_argument("--model", default=None)
    run.add_argument(
        "--arm",
        choices=("full_history", "address_only", "address_rehydrate", "address_on_demand"),
        required=True,
    )
    run.add_argument("--base-url", default=None)
    run.add_argument("--host-header", default=None)
    run.add_argument("--num-ctx", type=int, default=int(os.environ.get("OLLAMA_NUM_CTX", DEFAULT_NUM_CTX)))
    run.add_argument("--num-predict", type=int, default=DEFAULT_NUM_PREDICT)
    run.add_argument("--temperature", type=float, default=0.0)
    run.add_argument("--max-tool-rounds", type=int, default=10)
    run.add_argument("--packet-chars", type=int, default=DEFAULT_PACKET_CHARS)
    run.add_argument("--source-a", type=resolve_path, default=None)
    run.add_argument("--source-b", type=resolve_path, default=None)
    run.add_argument("--a2aj-db", type=resolve_path, default=None)
    run.add_argument("--out", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        cases = load_cases(
            args.packet_chars,
            args.source_a,
            args.source_b,
            args.a2aj_db if hasattr(args, "a2aj_db") else None,
        )
        if args.command == "self-test":
            self_test(cases, args.num_ctx)
        elif args.command == "inspect":
            inspect_cases(cases, args.num_ctx)
        elif args.command == "run":
            run_live(args, cases)
        return 0
    except (AssertionError, FileNotFoundError, OSError, ValueError, RuntimeError) as error:
        print(f"FAIL legal_compaction_qwen: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
