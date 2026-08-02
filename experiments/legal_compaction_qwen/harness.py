#!/usr/bin/env python3
"""Toy address-backed legal compaction experiment for a local Ollama Qwen.

The runner is intentionally dependency-free. It freezes the Mike benchmark
contract in mike_baseline.py, exposes only those tools, and keeps the address
registry outside the model messages. It is an experiment harness, not a
production compaction implementation.
"""

from __future__ import annotations

import argparse
import atexit
import difflib
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
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
CARD_MIN_CHARS = 2000
CARD_MAX_CHARS = 24000
FINAL_MIN_CHARS = 1200
COMPACTION_TIERS = {
    "32k": {"num_ctx": 32768, "packet_chars": 65536, "card_min_chars": 2400, "card_max_chars": 30000, "final_min_chars": 1600},
    "16k": {"num_ctx": 16384, "packet_chars": 32768, "card_min_chars": 2000, "card_max_chars": 24000, "final_min_chars": 1200},
    "8k": {"num_ctx": 8192, "packet_chars": 16384, "card_min_chars": 2000, "card_max_chars": 24000, "final_min_chars": 1200},
    "4k": {"num_ctx": 4096, "packet_chars": 8000, "card_min_chars": 1200, "card_max_chars": 10000, "final_min_chars": 800},
    "2k": {"num_ctx": 2048, "packet_chars": 3600, "card_min_chars": 700, "card_max_chars": 5200, "final_min_chars": 500},
    "1k": {"num_ctx": 1024, "packet_chars": 1600, "card_min_chars": 350, "card_max_chars": 2600, "final_min_chars": 250},
}
MICRO_TIERS = {
    "32k": {"packet_chars": 12000, "card_min_chars": 1400, "card_max_chars": 14000, "final_min_chars": 1000, "num_predict": 5000},
    "16k": {"packet_chars": 8000, "card_min_chars": 1200, "card_max_chars": 10000, "final_min_chars": 800, "num_predict": 3000},
    "4k": {"packet_chars": 2600, "card_min_chars": 900, "card_max_chars": 6000, "final_min_chars": 700, "num_predict": 1800},
    "2k": {"packet_chars": 1200, "card_min_chars": 500, "card_max_chars": 3200, "final_min_chars": 400, "num_predict": 1000},
    "1k": {"packet_chars": 650, "card_min_chars": 280, "card_max_chars": 1800, "final_min_chars": 250, "num_predict": 600},
}
A2AJ_DB_DEFAULT = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "OpenLegalProducts/LegalData/providers/a2aj/a2aj-cases-fulltext.sqlite"
)
MARKER_RE = re.compile(r"(?m)^[ \t]*\[(\d+)\][ \t]*")
WS_RE = re.compile(r"\s+")

DYNAMIC_TASK = """Find Bhasin v. Hrynew, Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District, and C.M. Callow Inc. v. Zollinger in A2AJ. Analyze each and compare their good-faith doctrine. Preserve facts, issue, holding, reasoning, limits, and evidence handles. Interleave verified exact quotes with analysis."""
ABLATION_TASK = """Find Bhasin v. Hrynew, Wastech Services Ltd. v. Greater Vancouver Sewerage and Drainage District, and C.M. Callow Inc. v. Zollinger in A2AJ. Analyze each and compare their good-faith doctrine. Preserve facts, issue, holding, reasoning, and evidence handles. Interleave verified exact quotes with analysis."""
NO_QUESTIONS = "NEVER ASK THE USER A QUESTION. UNDER NO CIRCUMSTANCES ASK FOR CLARIFICATION. USE THE AVAILABLE STATE, DOCUMENT, AND TOOLS; THEN CONTINUE OR COMPLETE THE REQUIRED TOOL ACTION."
CAVEMAN_CONTROL = "YOU=QWEN. QWEN USE FEWEST WORDS. SUBSTANCE ONLY. NO FILLER."
CARD_SPAN_CONTRACT = """Each card claim must cite one paragraph address and a sentence range inside that paragraph. Use this exact shape:
evidence_id=\"<active>@session-snapshot#paragraph-1\", start_sentence=0, end_sentence=1.
Use the full paragraph address exactly as returned by the source. Sentence indexes restart at 0 for each paragraph. Call card_done only after reading the document and selecting valid paragraph addresses."""


def dynamic_card_prompt(doc_id: str, opaque: bool = False, min_chars: int = CARD_MIN_CHARS, omit_limits_unknowns: bool = False) -> str:
    span_contract = (
        "Each card claim must use only a local paragraph number and sentence range: paragraph=1, start_sentence=0, end_sentence=1. The host adds the case address. Do not submit document IDs."
        if opaque
        else CARD_SPAN_CONTRACT.replace("<active>", doc_id)
    )
    fields = "FACTS/PROCEDURE; ISSUE; HOLDING; RULE/REASONING; EVIDENCE HANDLES" if omit_limits_unknowns else "FACTS/PROCEDURE; ISSUE; HOLDING; RULE/REASONING; LIMITS; UNKNOWNS; EVIDENCE HANDLES"
    return f"""Build ONE COMPLETE CARD for the active case. Include substantive text under every field: {fields}. {span_contract} The card must be at least {min_chars} characters. Do not answer the final task. {NO_QUESTIONS} Call card_done only after every field and valid spans are present."""


def grug_card_prompt(doc_id: str, opaque: bool = False, min_chars: int = CARD_MIN_CHARS, omit_limits_unknowns: bool = False) -> str:
    span_contract = (
        "Claims: paragraph=1, start_sentence=0, end_sentence=1. Host adds case address. No doc IDs."
        if opaque
        else CARD_SPAN_CONTRACT.replace("<active>", doc_id)
    )
    fields = "FACTS/PROCEDURE; ISSUE; HOLDING; RULE/REASONING; EVIDENCE HANDLES" if omit_limits_unknowns else "FACTS/PROCEDURE; ISSUE; HOLDING; RULE/REASONING; LIMITS; UNKNOWNS; EVIDENCE HANDLES"
    return f"""MAKE 1 COMPLETE CASE CARD. FILL EXACT LABELS: {fields}. {span_contract} CARD >= {min_chars} CHARS. NO FINAL ANSWER. NEVER ASK. {CAVEMAN_CONTROL} CALL card_done WHEN CARD + VALID SPANS READY. CARD SMARTHEAD."""


def micro_card_prompt(
    opaque: bool = False,
    min_chars: int = CARD_MIN_CHARS,
    omit_limits_unknowns: bool = False,
    host_register: bool = False,
) -> str:
    span_contract = (
        "Claims: paragraph=1, start_sentence=0, end_sentence=1. Host adds case address."
        if opaque
        else "Claims use full evidence handles + sentence ranges."
    )
    fields = "f=FACTS/PROCEDURE, i=ISSUE, h=HOLDING, r=RULE/REASONING, e=EVIDENCE HANDLES" if omit_limits_unknowns else "f=FACTS/PROCEDURE, i=ISSUE, h=HOLDING, r=RULE/REASONING, l=LIMITS, u=UNKNOWNS, e=EVIDENCE HANDLES"
    register_rule = (
        " HOST OWNS SPAN REGISTER. PUT SPANS IN p CLAIMS; d CLAIMS ARE IGNORED. FIX REJECTED SPANS IN p BEFORE d."
        if host_register
        else ""
    )
    return f"""SOURCE PACKET BELOW. PATCH CARD FIELDS ONE AT A TIME: {fields}. Use p(field,text). {span_contract}{register_rule} CARD >= {min_chars} CHARS AFTER HOST MERGE. {CAVEMAN_CONTROL} CONTROL TEXT ONLY. TEXT INSIDE EACH FIELD MUST BE COMPLETE, GRAMMATICAL SMARTHEAD LEGAL PROSE. NEVER ASK. CALL d WHEN ALL FIELDS + VALID SPANS READY."""


DYNAMIC_CARD_PROMPT = dynamic_card_prompt("active")
CARD_PRISON_SYSTEM_PROMPT = f"""You are completing one legal case card. Produce no prose outside the card tool. Use only the source packet and card contract. {NO_QUESTIONS}"""
GRUG_SYSTEM_PROMPT = f"""{CAVEMAN_CONTROL} FIND REQUESTED CASES. USE TOOLS. NEVER ASK."""
GRUG_CARD_PRISON_SYSTEM_PROMPT = f"""{CAVEMAN_CONTROL} CONTROL TEXT ONLY. CARD TEXT MUST BE COMPLETE, GRAMMATICAL SMARTHEAD LEGAL PROSE. MAKE 1 CASE CARD. card_done ONLY. KEEP FACTS, ANALYSIS, AND EXACT SPAN ADDRESSES. NEVER ASK."""
GRUG_SYNTHESIS_SYSTEM_PROMPT = f"""{CAVEMAN_CONTROL} CARDS READY. USE VERIFIED SPANS. MAKE ANSWER. NEVER ASK. WRITE SYNTHESIS LIKE SMARTHEAD."""
DYNAMIC_FINAL_PROMPT = """Using the completed cards and their VERIFIED SPANS registers, write the integrated answer: compare the doctrine and interleave verified exact quotes with para #s. Copy evidence handles and sentence ranges from the registers exactly. Rehydrate only the spans needed for the answer, then submit exact quotes with submit_quote_spans before the prose answer."""
GRUG_FINAL_PROMPT = f"""{CAVEMAN_CONTROL} USE DONE CARDS + VERIFIED SPANS. COMPARE DOCTRINE. MIX EXACT QUOTATIONS + PARA #S. COPY HANDLES/RANGES EXACTLY. REHYDRATE NEEDED SPANS. CALL submit_quote_spans FIRST. THEN WRITE ANSWER LIKE SMARTHEAD."""
DYNAMIC_MIKE_SYSTEM_PROMPT = MIKE_SYSTEM_PROMPT.replace("doc-0", "s1").replace("doc-1", "s2").replace("doc-2", "s3") + "\n\n" + NO_QUESTIONS


def control_system_prompt(prompt_style: str) -> str:
    return GRUG_SYSTEM_PROMPT if prompt_style == "grug" else DYNAMIC_MIKE_SYSTEM_PROMPT


def card_prison_system_prompt(prompt_style: str) -> str:
    return GRUG_CARD_PRISON_SYSTEM_PROMPT if prompt_style == "grug" else CARD_PRISON_SYSTEM_PROMPT


def style_control_tools(tools: list[dict[str, Any]], prompt_style: str) -> list[dict[str, Any]]:
    """Shorten only schema/control prose; task text and card content stay normal."""
    styled = json.loads(json.dumps(tools, ensure_ascii=False))
    if prompt_style != "grug":
        return styled
    descriptions = {
        "search_a2aj_cases": "Find case in A2AJ. Metadata only.",
        "select_a2aj_documents": "Pick 3 cases. 1 case at time.",
        "read_document": "Read active case.",
        "r": "Read active case.",
        "find_in_document": "Find text in active case.",
        "card_done": "Save full case card + exact spans.",
        "rehydrate_evidence": "Get exact text for spans.",
        "submit_quote_spans": "Submit exact quote spans.",
        "submit_grounded_answer": "Submit answer with grounded quotes.",
        "p": "Patch one field.",
        "d": "Finish card.",
    }
    field_descriptions = {
        "doc_id": "Case ID.",
        "query": "Find text.",
        "max_results": "Max hits.",
        "context_chars": "Context size.",
        "card": "Full card.",
        "claims": "Span list.",
        "paragraph": "Para #.",
        "evidence_id": "Handle.",
    }

    def shorten(node: Any) -> None:
        if not isinstance(node, dict):
            return
        for name, spec in node.get("properties", {}).items():
            if isinstance(spec, dict):
                if name in field_descriptions:
                    spec["description"] = field_descriptions[name]
                else:
                    spec.pop("description", None)
                shorten(spec)
        shorten(node.get("items"))

    for tool in styled:
        function = tool.get("function", {})
        function["description"] = descriptions.get(function.get("name"), "Use tool.")
        shorten(function.get("parameters", {}))
    return styled


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

Use submit_grounded_answer only for actual verbatim quotations, not summaries or legal conclusions. Every quotation must have kind "quotation", the exact quoted text, and one or more evidence_ids copied from the stable handles in the compacted context. Include accepted quotations from Bhasin, Wastech, and Callow. The host verifier will report accepted and failed claim indexes plus a centered repair passage. Resubmit only failed claims. Do not invent quotations, paragraph numbers, or handles."""

CASE_CARD_SUFFIX = """
Return only a compact legal case card, no exact block quotations. Keep it under 500 tokens and preserve:
material facts and procedural posture; issue; holding; governing rule; limits, exceptions, or negative propositions; and the best evidence handles to verify later. This card is a deliberately lossy context representation, so prefer legally important distinctions over narrative detail."""


def case_card_prompt(prompt: str) -> str:
    return prompt + CASE_CARD_SUFFIX


ULTRA_CASE_CARD_SUFFIX = """
Return only a compressed legal case card under 260 tokens. Use terse labels: F=facts/posture, I=issue,
H=holding, R=rule, L=limits/negative propositions, E=evidence handles. No quotations and no narrative prose."""


DELTA_CASE_CARD_SUFFIX = """
Return only a compact relational case card under 400 tokens. Set the fields yourself from the case:
F=facts/posture, I=issue, H=holding, R=rule, L=limits/negative propositions, E=evidence handles.
For the first case, establish the baseline doctrine you find. For later cases, state the case-specific
delta: what it confirms, narrows, extends, or distinguishes relative to the retained cards. Do not use
predefined legal labels unless the case supports them. No exact quotations."""


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


class A2AJCatalog:
    """Read-only metadata search and lazy full-text loading for dynamic runs."""

    def __init__(self, db_path: Path, max_chars: int):
        self.db_path = db_path
        self.max_chars = max_chars

    def _connect(self) -> sqlite3.Connection:
        if not self.db_path.exists():
            raise FileNotFoundError(f"A2AJ database not found: {self.db_path}")
        return sqlite3.connect(f"file:{self.db_path.as_posix()}?mode=ro", uri=True)

    def search(self, query: str, max_results: int) -> list[dict[str, Any]]:
        stopwords = {"a", "an", "and", "canada", "doctrine", "for", "good", "in", "of", "performance", "supreme", "the", "v", "vs"}
        tokens = [token.casefold() for token in re.findall(r"[\w.]+", query) if len(token) > 1 and token.casefold() not in stopwords]
        if not tokens:
            return []
        clauses = []
        values: list[Any] = []
        haystack = "LOWER(COALESCE(citation_en,'') || ' ' || COALESCE(name_en,''))"
        for token in tokens:
            clauses.append(f"{haystack} LIKE ?")
            values.append(f"%{token}%")
        score = " + ".join(f"CASE WHEN {haystack} LIKE ? THEN 1 ELSE 0 END" for _ in tokens)
        score_values = [f"%{token}%" for token in tokens]
        values = score_values + values
        values.append(max(1, min(10, int(max_results))))
        with self._connect() as db:
            rows = db.execute(
                "SELECT id, citation_en, name_en, document_date_en, url_en, dataset, (" + score + ") AS relevance "
                "FROM document WHERE doc_type='cases' AND (" + " OR ".join(clauses) + ")" +
                " ORDER BY relevance DESC, document_date_en DESC, id LIMIT ?",
                values,
            ).fetchall()
        return [
            {
                "document_id": row[0],
                "citation": row[1],
                "name": row[2],
                "date": row[3],
                "url": row[4],
                "dataset": row[5],
            }
            for row in rows
        ]

    def load_selected(self, document_ids: list[int]) -> dict[str, CaseDocument]:
        cases: dict[str, CaseDocument] = {}
        with self._connect() as db:
            for index, document_id in enumerate(document_ids):
                row = db.execute(
                    "SELECT citation_en, name_en, url_en FROM document WHERE id=? AND doc_type='cases'",
                    (int(document_id),),
                ).fetchone()
                if row is None:
                    raise ValueError(f"selected A2AJ case not found: {document_id}")
                doc_id = f"s{index + 1}"
                spec = CaseSpec(
                    doc_id=doc_id,
                    filename=str(row[1] or row[0] or doc_id),
                    citation=str(row[0] or row[1] or doc_id),
                    path=None,
                    key_paragraphs=(),
                    descriptors={},
                    a2aj_document_id=int(document_id),
                )
                cases[doc_id] = load_case(spec, self.max_chars, self.db_path)
        return cases

    def document_exists(self, document_id: int) -> bool:
        with self._connect() as db:
            return db.execute(
                "SELECT 1 FROM document WHERE id=? AND doc_type='cases'",
                (int(document_id),),
            ).fetchone() is not None


def run_dynamic_selection(args: argparse.Namespace) -> Path:
    model = args.model or ("gpt-5.6-luna" if args.provider == "codex" else default_model())
    base_url = args.base_url or os.environ.get("OLLAMA_BASE_URL") or "http://127.0.0.1:11434"
    client = (
        CodexClient(model, args.effort, args.num_predict)
        if args.provider == "codex"
        else OllamaClient(
            base_url=base_url,
            model=model,
            num_ctx=args.num_ctx,
            num_predict=args.num_predict,
            temperature=args.temperature,
            think=args.think,
            host_header=args.host_header or os.environ.get("OLLAMA_HOST_HEADER"),
        )
    )
    output = resolve_output(args.out, "dynamic_selection")
    acquire_run_lock(output)
    progress_path = output.with_suffix(".progress.jsonl")
    catalog = A2AJCatalog(args.a2aj_db or A2AJ_DB_DEFAULT, args.packet_chars)
    discovery_messages: list[dict[str, Any]] = [
        {"role": "system", "content": control_system_prompt(args.prompt_style)},
        {"role": "user", "content": DYNAMIC_TASK + " Search the catalog first; do not read documents during selection."},
    ]
    selection_calls: list[dict[str, Any]] = []
    discovery_ledger: list[str] = []
    search_cache: dict[str, str] = {}
    selected_ids: list[int] | None = None
    append_progress(progress_path, {"kind": "run_started", "arm": "dynamic_selection", "provider": args.provider, "model": model, "effort": args.effort, "num_ctx": args.num_ctx})
    try:
        for round_number in range(args.max_tool_rounds):
            message, usage = client.chat(discovery_messages, discovery_mode=True, prompt_style=args.prompt_style)
            discovery_messages.append(message)
            calls = assistant_tool_calls(message)
            append_progress(progress_path, {"kind": "discovery_call", "round": round_number + 1, "tool_calls": [name for name, _ in calls], "arguments": [{"name": name, "arguments": raw_args} for name, raw_args in calls], "usage": usage})
            if not calls:
                discovery_messages.append({"role": "user", "content": "Use search_a2aj_cases and then select the three requested document IDs; do not answer yet."})
                continue
            for name, raw_args in calls:
                if name == "search_a2aj_cases":
                    query = collapse_ws(str(raw_args.get("q", ""))).casefold()
                    if query in search_cache:
                        result = json.dumps({"ok": True, "repeated": True, "reuse": search_cache[query]}, ensure_ascii=False)
                    else:
                        results = catalog.search(query, int(raw_args.get("n", 10)))
                        compact_hits = [
                            {
                                "i": item["document_id"],
                                "c": item.get("citation") or "-",
                                "n": item.get("name") or "-",
                                "d": item.get("date") or "-",
                            }
                            for item in results
                        ]
                        result = json.dumps({"ok": True, "hits": compact_hits}, ensure_ascii=False, separators=(",", ":"))
                        search_cache[query] = result
                elif name == "select_a2aj_documents":
                    values = [int(value) for value in raw_args.get("ids", [])]
                    invalid = [value for value in values if value <= 0 or not catalog.document_exists(value)]
                    if len(values) != 3 or len(set(values)) != 3:
                        result = json.dumps({"ok": False, "error": "select exactly three unique A2AJ document IDs"})
                    elif invalid:
                        result = json.dumps({"ok": False, "error": "unknown A2AJ case IDs: " + ", ".join(map(str, invalid))})
                    else:
                        selected_ids = values
                        result = json.dumps({"ok": True, "selected_document_ids": values, "text": "full text will be loaded one document at a time by the host"})
                else:
                    result = json.dumps({"ok": False, "error": "discovery tool unavailable"})
                selection_calls.append({"name": name, "arguments": raw_args, "result": result})
                append_progress(progress_path, {"kind": "discovery_tool_result", "round": round_number + 1, "tool": name, "arguments": raw_args, "result_preview": result[:2000]})
                discovery_messages.append({"role": "tool", "tool_name": name, "content": result})
                if name == "search_a2aj_cases":
                    try:
                        compact_results = json.loads(result).get("hits", [])
                    except json.JSONDecodeError:
                        compact_results = []
                    discovery_ledger.append("HITS " + json.dumps(compact_results, ensure_ascii=False, separators=(",", ":")))
                elif name == "select_a2aj_documents":
                    discovery_ledger.append("SELECT " + ",".join(str(item) for item in raw_args.get("ids", [])))
            if selected_ids is None:
                discovery_messages[:] = discovery_messages[:2] + [
                    {
                        "role": "user",
                        "content": "[A2AJ LEDGER]\n" + "\n".join(discovery_ledger[-8:]) +
                        "\nThese are compact metadata hits. Select exactly three integer i values now when the requested cases are present; do not repeat an already successful search. Full text is unavailable during discovery.",
                    }
                ]
            if selected_ids is not None:
                break
        if selected_ids is None:
            raise RuntimeError("Qwen did not select three A2AJ documents")

        cases = catalog.load_selected(selected_ids)
        executor = ToyMikeTools(cases)
        executor.set_compact_rehydration(True)
        executor.set_rehydration_mode(args.rehydration_mode)
        call_log: list[dict[str, Any]] = []
        turns: list[dict[str, Any]] = [{"phase": "discovery", "selected_document_ids": selected_ids}]
        first_key = next(iter(cases))
        if args.micro_card:
            card_prompt = lambda _doc_id, _opaque, minimum: micro_card_prompt(
                _opaque,
                minimum,
                args.omit_limits_unknowns,
                args.card_span_mode == "host_register",
            )
        else:
            card_prompt = (lambda doc_id, opaque, minimum: grug_card_prompt(doc_id, opaque, minimum, args.omit_limits_unknowns)) if args.prompt_style == "grug" else (lambda doc_id, opaque, minimum: dynamic_card_prompt(doc_id, opaque, minimum, args.omit_limits_unknowns))
        first_card_prompt = card_prompt(first_key, args.card_prison_opaque, args.card_min_chars)
        if not args.micro_card:
            first_card_prompt += f"\nCall r {first_key} once now; then complete the card."
        else:
            first_card_prompt += "\nPATCH FIELDS, THEN CALL d."
        first_response, messages = run_turn(
            client, [{"role": "system", "content": card_prison_system_prompt(args.prompt_style)}], first_card_prompt,
            first_key, executor, call_log, 1, max_tool_rounds=args.max_tool_rounds,
            state_compact_every=4, progress_path=progress_path,
            card_contract=card_prompt(first_key, args.card_prison_opaque, args.card_min_chars),
            compact_card_mode=True,
            card_max_chars=args.card_max_chars,
            card_min_chars=args.card_min_chars,
            final_min_chars=args.final_min_chars,
            card_span_mode=args.card_span_mode,
            prompt_style=args.prompt_style,
            card_prison_opaque=args.card_prison_opaque,
            micro_card=args.micro_card,
            omit_limits_unknowns=args.omit_limits_unknowns,
            post_verify_projection=args.post_verify_projection,
            auto_read_card=args.micro_card,
        )
        turns.append({"turn": 1, "prompt": first_card_prompt, "response": first_response})
        if not executor.card_queue_complete:
            raise RuntimeError("card queue did not complete before synthesis")
        final_prompt = GRUG_FINAL_PROMPT if args.prompt_style == "grug" else DYNAMIC_FINAL_PROMPT
        if args.rehydration_mode == "expanded_snippet":
            final_prompt += " USE THE EXPANDED PREFIX + CLOSEST SNIPPET AS QUOTE CONTEXT; SUBMIT STABLE HANDLES/RANGES."
        final_gate = (
            "VERIFIER OK. WRITE SMARTHEAD LEGAL ANSWER. EXACT QUOTES + ANALYSIS."
            if args.prompt_style == "grug"
            else "The verifier accepted the quotes. Write the integrated legal answer now, with analysis and exact quotes interleaved."
        )

        def synthesis_checkpoint(missing: list[str]) -> list[dict[str, Any]]:
            cards = "\n\n".join(
                f"CARD {doc_id}:\n{card}\n\n[VERIFIED SPANS]\n"
                + json.dumps(executor.card_claims.get(doc_id, []), ensure_ascii=False)
                for doc_id, card in executor.card_cards.items()
            )
            missing_block = (
                "\n\n[MISSING QUOTE COVERAGE]\n" + ", ".join(missing)
                if missing
                else ""
            )
            return [
                {
                    "role": "system",
                    "content": (
                        GRUG_SYNTHESIS_SYSTEM_PROMPT
                        if args.prompt_style == "grug"
                        else DYNAMIC_MIKE_SYSTEM_PROMPT
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "[ALL CARDS COMPLETE]\n"
                        + cards
                        + "\n\n[VERIFIED QUOTE REGISTER]\n"
                        + json.dumps(executor.verified_claims or [], ensure_ascii=False)
                        + missing_block
                    ),
                },
            ]

        missing_cases: list[str] = []
        final_messages = messages
        for synthesis_attempt in range(1 + args.max_synthesis_revisions):
            if synthesis_attempt:
                missing_text = ", ".join(missing_cases)
                final_prompt = (
                    "REPAIR REQUIRED. VERIFIED QUOTATION COVERAGE IS MISSING FOR: "
                    + missing_text
                    + ". Rehydrate evidence from that case, submit exact quote span(s) for it, "
                    "then rewrite the complete integrated answer. Do not stop with a partial answer."
                )
            final_messages = synthesis_checkpoint(missing_cases)
            final_response, final_messages = run_turn(
                client, final_messages, final_prompt, "final", executor, call_log, 2,
                include_rehydration_tool=True, include_span_tool=True,
                max_tool_rounds=args.max_tool_rounds,
                synthesis_mode=True,
                post_gate_prompt=final_gate,
                progress_path=progress_path,
                prompt_style=args.prompt_style,
                card_prison_opaque=args.card_prison_opaque,
                micro_card=args.micro_card,
                omit_limits_unknowns=args.omit_limits_unknowns,
                post_verify_projection=args.post_verify_projection,
                auto_read_card=False,
                require_synthesis_tool=True,
            )
            turns.append({"turn": 2 + synthesis_attempt, "prompt": final_prompt, "response": final_response})
            if len(final_response) < args.final_min_chars:
                raise RuntimeError(f"final answer below {args.final_min_chars} characters")
            if not executor.verified_claims:
                raise RuntimeError("final answer lacked verified quotation claims")
            verified_cases = {
                evidence_id.split("@", 1)[0]
                for claim in executor.verified_claims
                for evidence_id in claim.get("evidence_ids", [])
            }
            missing_cases = sorted(set(cases) - verified_cases)
            if not missing_cases:
                break
            if synthesis_attempt >= args.max_synthesis_revisions:
                raise RuntimeError(
                    "final answer lacked verified quotation coverage for: "
                    + ", ".join(missing_cases)
                )
        record = {
            "experiment": "legal_compaction_qwen",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "arm": "dynamic_selection",
            "model": model,
            "base_url": base_url,
            "num_ctx": args.num_ctx,
            "num_predict": args.num_predict,
            "temperature": args.temperature,
            "think": args.think,
            "provider": args.provider,
            "effort": args.effort,
            "max_tool_rounds": args.max_tool_rounds,
            "card_span_mode": args.card_span_mode,
            "card_prison_opaque": args.card_prison_opaque,
            "prompt_style": args.prompt_style,
            "context_tier": args.context_tier,
            "micro_card": args.micro_card,
            "omit_limits_unknowns": args.omit_limits_unknowns,
            "rehydration_mode": args.rehydration_mode,
            "post_verify_projection": args.post_verify_projection,
            "task": ABLATION_TASK if args.omit_limits_unknowns else DYNAMIC_TASK,
            "selected_a2aj_document_ids": selected_ids,
            "selection_calls": selection_calls,
            "cases": [case_receipt(case) for case in cases.values()],
            "turns": turns,
            "calls": call_log,
            "tool_calls": executor.tool_calls,
            "verifier_attempts": executor.verifier_attempts,
            "verified_claims": executor.verified_claims,
            "verified_answer": executor.render_verified_answer(),
            "final_answer": final_response,
            "messages_at_end": final_messages,
            "overflow": None,
        }
    except (OllamaError, RuntimeError, ValueError) as error:
        partial = locals()
        partial_executor = partial.get("executor")
        record = {
            "experiment": "legal_compaction_qwen",
            "created_utc": datetime.now(timezone.utc).isoformat(),
            "arm": "dynamic_selection",
            "model": model,
            "base_url": base_url,
            "num_ctx": args.num_ctx,
            "num_predict": args.num_predict,
            "think": args.think,
            "provider": args.provider,
            "effort": args.effort,
            "selected_a2aj_document_ids": selected_ids,
            "selection_calls": selection_calls,
            "turns": partial.get("turns", []),
            "calls": partial.get("call_log", []),
            "tool_calls": partial_executor.tool_calls if partial_executor else [],
            "verifier_attempts": partial_executor.verifier_attempts if partial_executor else [],
            "verified_claims": partial_executor.verified_claims if partial_executor else None,
            "final_answer": partial.get("final_response", ""),
            "messages_at_end": partial.get("final_messages", partial.get("messages", [])),
            "overflow": {"message": str(error), "context_overflow": getattr(error, "context_overflow", False)},
        }
    append_progress(progress_path, {"kind": "run_finished", "overflow": record.get("overflow"), "final_answer_length": len(record.get("final_answer", ""))})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {output}")
    return output


def handle_id(case: CaseDocument, paragraph: int) -> str:
    return f"{case.spec.doc_id}@session-snapshot#paragraph-{paragraph}"


def short_handle(case: CaseDocument, paragraph: int) -> str:
    return f"{case.spec.doc_id[-1].upper()}{paragraph}"


def canonical_handle(handle: str, case: CaseDocument) -> str:
    match = re.fullmatch(r"[A-Z](\d+)", handle)
    return handle_id(case, int(match.group(1))) if match else handle


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


CARD_WITNESS_PARAGRAPHS = {
    "case-a": (63, 73, 86),
    "case-b": (4, 70, 71),
    "case-c": (37, 90, 104),
}


def compact_span_witness(case: CaseDocument, paragraph: int, width: int = 96) -> dict[str, Any]:
    text = case.paragraph_map[paragraph].strip()
    if len(text) <= width * 2 + 16:
        preview = text
        prefix, suffix = preview, ""
    else:
        prefix = text[:width].rstrip()
        suffix = text[-width:].lstrip()
        preview = f"{prefix} ... {suffix}"
    return {
        "handle": handle_id(case, paragraph),
        "short_handle": short_handle(case, paragraph),
        "paragraph": paragraph,
        "preview": preview,
        "hash": sha256_text(text),
    }


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


def compact_case_card_checkpoint(
    cases: dict[str, CaseDocument], retained_responses: list[str]
) -> str:
    """Small legal-specific memory: analysis fields plus stable evidence handles."""
    lines = [
        "[CASE-CARD COMPACTION CHECKPOINT]",
        "Raw case text, tool exchanges, and exact quotations were removed.",
        "The following model-authored cards preserve legal analysis; handles are pointers, not quotations.",
        "",
    ]
    for index, response in enumerate(retained_responses):
        card = redact_quotes(response).strip()[:3500]
        lines.extend([f"CASE {chr(65 + index)} CARD:", card or "(no card returned)", ""])
    lines.append("EVIDENCE HANDLES:")
    for case in cases.values():
        lines.append(f"{case.spec.citation} | source={case.spec.doc_id}")
        for item in evidence_handles(case):
            lines.append(
                f"- {item['handle']} | {item['locator']} | {item['description']} | hash={item['content_sha256']}"
            )
    lines.extend(["", "COMPACT PARAGRAPH WITNESSES (host-generated previews):"])
    for case in cases.values():
        for paragraph in CARD_WITNESS_PARAGRAPHS[case.spec.doc_id]:
            witness = compact_span_witness(case, paragraph)
            lines.append(
                f"- {witness['handle']} | {witness['preview']} | hash={witness['hash']}"
            )
    lines.append("Exact evidence must be rehydrated and verified before quotation.")
    return "\n".join(lines)


def ultra_case_card_checkpoint(
    cases: dict[str, CaseDocument], retained_responses: list[str]
) -> str:
    """Minimal active-context card; durable hashes stay in the host receipt."""
    lines = ["[ULTRA CASE CARDS]", "Raw text and tool transcript omitted; handles remain stable."]
    for index, response in enumerate(retained_responses):
        card = collapse_ws(redact_quotes(response))[:1800]
        lines.append(f"{chr(65 + index)}:{card or '-'}")
    lines.append("ALIASES:")
    for case in cases.values():
        for paragraph in CARD_WITNESS_PARAGRAPHS[case.spec.doc_id]:
            lines.append(f"{short_handle(case, paragraph)}={handle_id(case, paragraph)}")
    lines.append("WITNESSES:")
    for case in cases.values():
        for paragraph in CARD_WITNESS_PARAGRAPHS[case.spec.doc_id]:
            witness = compact_span_witness(case, paragraph, width=32)
            lines.append(f"{witness['short_handle']}:{witness['preview']}")
    lines.append("Select handles; exact text is host-rehydrated and verified.")
    return "\n".join(lines)


def card_checkpoint(
    cases: dict[str, CaseDocument], responses: list[str], ultra: bool
) -> str:
    return ultra_case_card_checkpoint(cases, responses) if ultra else compact_case_card_checkpoint(cases, responses)


class OllamaError(RuntimeError):
    def __init__(self, message: str, context_overflow: bool = False):
        super().__init__(message)
        self.context_overflow = context_overflow


def append_progress(path: Path | None, event: dict[str, Any]) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {"utc": datetime.now(timezone.utc).isoformat(), **event}
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(event, ensure_ascii=False) + "\n")


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        model: str,
        num_ctx: int,
        num_predict: int,
        temperature: float,
        think: str | bool | None = None,
        host_header: str | None = None,
        timeout_seconds: int = 900,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.num_ctx = num_ctx
        self.num_predict = num_predict
        self.temperature = temperature
        self.think = think
        self.host_header = host_header
        self.timeout_seconds = timeout_seconds

    def chat(
        self,
        messages: list[dict[str, Any]],
        include_grounding_tool: bool = False,
        include_rehydration_tool: bool = False,
        include_span_tool: bool = False,
        card_rebuild_mode: bool = False,
        discovery_mode: bool = False,
        synthesis_mode: bool = False,
        compact_card_mode: bool = False,
        card_max_chars: int = CARD_MAX_CHARS,
        card_min_chars: int = CARD_MIN_CHARS,
        card_prison: bool = False,
        prompt_style: str = "normal",
        card_prison_opaque: bool = False,
        micro_card: bool = False,
        omit_limits_unknowns: bool = False,
        auto_read_card: bool = False,
        host_register: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        request_tools = ollama_tools()
        if compact_card_mode:
            request_tools = compact_card_tools(card_max_chars, prompt_style, card_prison_opaque, card_min_chars)
            if micro_card and (auto_read_card or card_prison):
                request_tools = list(micro_card_tools(omit_limits_unknowns, host_register))
            elif micro_card:
                request_tools = [tool for tool in request_tools if tool.get("function", {}).get("name") == "r"]
        if card_prison:
            micro_tools = micro_card_tools(omit_limits_unknowns, host_register) if micro_card else None
            request_tools = (
                list(micro_tools)
                if micro_card
                else [card_complete_tool(card_prison_opaque, card_min_chars, card_max_chars, omit_limits_unknowns)]
            )
        if discovery_mode:
            request_tools = [A2AJ_SEARCH_TOOL, A2AJ_SELECT_TOOL]
        if synthesis_mode:
            request_tools = [REHYDRATE_EVIDENCE_TOOL, SPAN_ANSWER_TOOL]
        if card_rebuild_mode and not card_prison:
            request_tools = [
                tool for tool in request_tools
                if tool.get("function", {}).get("name") in (
                    {"find_in_document", "read_document"}
                    if not compact_card_mode else {"find_in_document", "r"}
                )
            ] + [
                *(list(micro_card_tools(omit_limits_unknowns, host_register)) if micro_card else [card_complete_tool(card_prison_opaque, card_min_chars, card_max_chars, omit_limits_unknowns)])
            ]

        if include_rehydration_tool and not card_rebuild_mode and not synthesis_mode and not discovery_mode:
            request_tools.append(REHYDRATE_EVIDENCE_TOOL)
        if include_span_tool and not card_rebuild_mode and not synthesis_mode and not discovery_mode:
            request_tools.append(SPAN_ANSWER_TOOL)
        if include_grounding_tool and not card_rebuild_mode and not synthesis_mode and not discovery_mode:
            request_tools.append(GROUNDED_ANSWER_TOOL)
        request_tools = style_control_tools(request_tools, prompt_style)
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
        if self.think is not None:
            # Ollama's no-reasoning form is boolean false; "none" is not a
            # valid value on the desktop service.
            body["think"] = False if self.think == "none" else self.think
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


class CodexClient:
    """Codex/Luna transport using the same host turn and tool contracts."""

    def __init__(self, model: str, effort: str, num_predict: int):
        self.model = model
        self.effort = effort
        self.num_predict = num_predict
        self.num_ctx = 32768

    def _tools(self, include_grounding_tool: bool, include_rehydration_tool: bool,
               include_span_tool: bool, card_rebuild_mode: bool, discovery_mode: bool,
               synthesis_mode: bool, compact_card_mode: bool, card_max_chars: int,
               card_min_chars: int, card_prison: bool, prompt_style: str,
               card_prison_opaque: bool, micro_card: bool,
               omit_limits_unknowns: bool, host_register: bool) -> list[dict[str, Any]]:
        if discovery_mode:
            return [A2AJ_SEARCH_TOOL, A2AJ_SELECT_TOOL]
        if synthesis_mode:
            return [REHYDRATE_EVIDENCE_TOOL, SPAN_ANSWER_TOOL]
        if card_prison:
            return list(micro_card_tools(omit_limits_unknowns, host_register)) if micro_card else [card_complete_tool(card_prison_opaque, card_min_chars, card_max_chars, omit_limits_unknowns)]
        if compact_card_mode:
            tools = compact_card_tools(card_max_chars, prompt_style, card_prison_opaque, card_min_chars)
            if micro_card:
                tools = [tool for tool in tools if tool.get("function", {}).get("name") == "r"]
        else:
            tools = ollama_tools()
        if card_rebuild_mode:
            tools = [tool for tool in tools if tool.get("function", {}).get("name") in {"find_in_document", "read_document", "r"}]
            tools += list(micro_card_tools(omit_limits_unknowns, host_register)) if micro_card else [card_complete_tool(card_prison_opaque, card_min_chars, card_max_chars, omit_limits_unknowns)]
        if include_rehydration_tool:
            tools.append(REHYDRATE_EVIDENCE_TOOL)
        if include_span_tool:
            tools.append(SPAN_ANSWER_TOOL)
        if include_grounding_tool:
            tools.append(GROUNDED_ANSWER_TOOL)
        return tools

    def chat(self, messages: list[dict[str, Any]], include_grounding_tool: bool = False,
              include_rehydration_tool: bool = False, include_span_tool: bool = False,
              card_rebuild_mode: bool = False, discovery_mode: bool = False,
              synthesis_mode: bool = False, compact_card_mode: bool = False,
              card_max_chars: int = CARD_MAX_CHARS, card_min_chars: int = CARD_MIN_CHARS,
              card_prison: bool = False, prompt_style: str = "normal",
              card_prison_opaque: bool = False, micro_card: bool = False,
              omit_limits_unknowns: bool = False, auto_read_card: bool = False,
              host_register: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
        tools = self._tools(
            include_grounding_tool, include_rehydration_tool, include_span_tool,
            card_rebuild_mode, discovery_mode, synthesis_mode, compact_card_mode,
            card_max_chars, card_min_chars, card_prison, prompt_style,
            card_prison_opaque, micro_card, omit_limits_unknowns, host_register,
        )
        if auto_read_card and compact_card_mode and micro_card:
            tools = list(micro_card_tools(omit_limits_unknowns, host_register))
        prompt = (
            "You are one turn inside a legal compaction harness. Do not use shell, files, or external tools. "
            "Return JSON matching the required schema. Emit at most the listed host tool calls; do not describe a tool call as prose.\n\n"
            "AVAILABLE HOST TOOLS:\n" + json.dumps(tools, ensure_ascii=False, separators=(",", ":"))
            + "\n\nCURRENT HARNESS MESSAGES:\n" + json.dumps(messages, ensure_ascii=False)
        )
        with tempfile.NamedTemporaryFile(prefix="codex-turn-", suffix=".json", delete=False) as output_file:
            output_path = Path(output_file.name)
        schema = ROOT / "experiments" / "legal_compaction_qwen" / "codex_turn_schema.json"
        started = time.perf_counter()
        try:
            result = subprocess.run(
                [r"C:\Users\elias\AppData\Roaming\npm\codex.cmd", "exec", "--ephemeral",
                 "-m", self.model, "-c", f'model_reasoning_effort="{self.effort}"',
                 "-s", "read-only", "--output-schema", str(schema),
                 "-o", str(output_path), "-"],
                input=prompt, text=True, encoding="utf-8", errors="replace",
                capture_output=True, timeout=900,
            )
            if result.returncode:
                raise OllamaError(f"Codex exec failed ({result.returncode}): {result.stderr[-2000:]}")
            payload = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            raise OllamaError(f"Codex turn failed: {error}") from error
        finally:
            output_path.unlink(missing_ok=True)
        calls = []
        allowed_names = {
            tool.get("function", {}).get("name")
            for tool in tools
        }
        for call in payload.get("tool_calls") or []:
            name = str(call.get("name") or "")
            if name not in allowed_names:
                raise OllamaError(f"Codex returned unavailable tool: {name or '<empty>'}")
            raw_arguments = call.get("arguments") or "{}"
            if isinstance(raw_arguments, str):
                try:
                    arguments = json.loads(raw_arguments)
                except json.JSONDecodeError as error:
                    raise OllamaError(f"Codex returned invalid JSON arguments for {name}: {error}") from error
            else:
                arguments = raw_arguments
            if not isinstance(arguments, dict):
                raise OllamaError(f"Codex returned non-object arguments for {name}")
            calls.append({"function": {"name": name, "arguments": json.dumps(arguments)}})
        return {
            "role": "assistant",
            "content": str(payload.get("content") or ""),
            "tool_calls": calls,
        }, {
            "prompt_eval_count": 0,
            "eval_count": 0,
            "wall_seconds": round(time.perf_counter() - started, 3),
            "provider": "codex",
            "effort": self.effort,
        }


GROUNDED_ANSWER_TOOL_NAME = "submit_grounded_answer"
REHYDRATE_EVIDENCE_TOOL_NAME = "rehydrate_evidence"
SPAN_ANSWER_TOOL_NAME = "submit_quote_spans"
CARD_COMPLETE_TOOL_NAME = "card_done"
MICRO_PATCH_TOOL_NAME = "p"
MICRO_DONE_TOOL_NAME = "d"
CARD_COMPLETE_TOOL = {
    "type": "function",
    "function": {
        "name": CARD_COMPLETE_TOOL_NAME,
        "strict": True,
        "description": "Finish the case card after reviewing the packet.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "card": {
                    "type": "string",
                    "description": "Complete the card and submit paragraph-address span claims.",
                    "minLength": CARD_MIN_CHARS,
                    "maxLength": CARD_MAX_CHARS,
                }
                ,"claims": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 32,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "evidence_id": {"type": "string", "description": "Full paragraph address returned for the active case."},
                            "start_sentence": {"type": "integer", "minimum": 0},
                            "end_sentence": {"type": "integer", "minimum": 0},
                        },
                        "required": ["evidence_id", "start_sentence", "end_sentence"],
                    },
                }
            },
            "required": ["card", "claims"],
        },
    },
}

MICRO_PATCH_TOOL = {
    "type": "function",
    "function": {
        "name": MICRO_PATCH_TOOL_NAME,
        "strict": True,
        "description": "Patch one card field.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "field": {"type": "string", "enum": ["f", "i", "h", "r", "l", "u", "e"]},
                "text": {"type": "string", "maxLength": 1800},
                "claims": {
                    "type": "array",
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "paragraph": {"type": "integer", "minimum": 1},
                            "start_sentence": {"type": "integer", "minimum": 0},
                            "end_sentence": {"type": "integer", "minimum": 0},
                        },
                        "required": ["paragraph", "start_sentence", "end_sentence"],
                    },
                },
            },
            "required": ["field", "text"],
        },
    },
}

MICRO_DONE_TOOL = {
    "type": "function",
    "function": {
        "name": MICRO_DONE_TOOL_NAME,
        "strict": True,
        "description": "Finish merged card.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "claims": MICRO_PATCH_TOOL["function"]["parameters"]["properties"]["claims"],
            },
            "required": ["claims"],
        },
    },
}


def card_complete_tool(
    opaque: bool = False,
    card_min_chars: int = CARD_MIN_CHARS,
    card_max_chars: int = CARD_MAX_CHARS,
    omit_limits_unknowns: bool = False,
) -> dict[str, Any]:
    tool = json.loads(json.dumps(CARD_COMPLETE_TOOL, ensure_ascii=False))
    card = tool["function"]["parameters"]["properties"]["card"]
    card["minLength"] = card_min_chars
    card["maxLength"] = card_max_chars
    if opaque:
        claims = tool["function"]["parameters"]["properties"]["claims"]
        claims["items"]["properties"] = {
            "paragraph": {"type": "integer", "minimum": 1, "description": "Local paragraph number."},
            "start_sentence": {"type": "integer", "minimum": 0},
            "end_sentence": {"type": "integer", "minimum": 0},
        }
        claims["items"]["required"] = ["paragraph", "start_sentence", "end_sentence"]
        tool["function"]["description"] = "Save full case card + local paragraph spans."
        tool["function"]["parameters"]["properties"]["card"]["description"] = "Complete card; use local paragraph spans only."
    return tool


def opaque_card_result(result: str, current_doc: str) -> str:
    """Hide case IDs from the model while retaining canonical host receipts."""
    try:
        payload = json.loads(result)
    except json.JSONDecodeError:
        return result.replace(f"{current_doc}@session-snapshot#", "#")

    def scrub(value: Any) -> Any:
        if isinstance(value, dict):
            clean: dict[str, Any] = {}
            for key, item in value.items():
                if key in {"document_id", "next_document_id", "handle_format", "packet_sha256", "text_sha256"}:
                    continue
                if key == "evidence_id" and isinstance(item, str):
                    match = re.search(r"#paragraph-(\d+)$", item)
                    if match:
                        clean["paragraph"] = int(match.group(1))
                        continue
                clean[key] = scrub(item)
            return clean
        if isinstance(value, list):
            return [scrub(item) for item in value]
        if isinstance(value, str):
            return value.replace(f"{current_doc}@session-snapshot#", "#")
        return value

    return json.dumps(scrub(payload), ensure_ascii=False)


def compact_card_tools(
    card_max_chars: int = CARD_MAX_CHARS,
    prompt_style: str = "normal",
    opaque: bool = False,
    card_min_chars: int = CARD_MIN_CHARS,
) -> list[dict[str, Any]]:
    """Minimal dynamic-card schema; the frozen Mike schema remains unchanged."""
    tools = json.loads(json.dumps(ollama_tools(), ensure_ascii=False))
    result: list[dict[str, Any]] = []
    for tool in tools:
        function = tool.get("function", {})
        name = function.get("name")
        if name not in {"read_document", "find_in_document"}:
            continue
        if name == "read_document":
            function["name"] = "r"
            name = "r"
        function["description"] = "Read the active case once: r sN." if name == "r" else "Search the active document."
        properties = function.get("parameters", {}).get("properties", {})
        if "doc_id" in properties:
            properties["doc_id"]["description"] = "Active document ID supplied by the task."
        if name == "find_in_document":
            properties.get("query", {})["description"] = "Search text."
        result.append(tool)
    card_tool = card_complete_tool(opaque, card_min_chars, card_max_chars)
    card_tool["function"]["parameters"]["properties"]["card"]["maxLength"] = card_max_chars
    result.append(card_tool)
    return style_control_tools(result, prompt_style)


A2AJ_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_a2aj_cases",
        "strict": True,
        "description": "Search the local A2AJ case catalog. Returns metadata only, never full text.",
            "parameters": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                "q": {"type": "string"},
                "n": {"type": "integer", "minimum": 1, "maximum": 10},
            },
            "required": ["q", "n"],
        },
    },
}
A2AJ_SELECT_TOOL = {
    "type": "function",
    "function": {
        "name": "select_a2aj_documents",
        "strict": True,
        "description": "Select the A2AJ document IDs to analyze. Selection returns metadata only; text is loaded one document at a time by the host.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "ids": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 6,
                    "items": {"type": "integer"},
                }
            },
            "required": ["ids"],
        },
    },
}
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
SPAN_ANSWER_TOOL = {
    "type": "function",
    "function": {
        "name": SPAN_ANSWER_TOOL_NAME,
        "strict": True,
        "description": "Submit evidence handles and sentence ranges; the host will materialize the exact quotations.",
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
                            "evidence_id": {"type": "string"},
                            "start_sentence": {"type": "integer", "minimum": 0},
                            "end_sentence": {"type": "integer", "minimum": 0},
                        },
                        "required": ["evidence_id", "start_sentence", "end_sentence"],
                    },
                }
            },
            "required": ["claims"],
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
        self.card_queue = list(cases)
        self.card_index = 0
        self.card_cards: dict[str, str] = {}
        self.card_claims: dict[str, list[dict[str, Any]]] = {}
        self.card_queue_complete = False
        self.active_doc_ids: set[str] = set()
        self.final_rehydration_active = False
        self.compact_rehydration_active = False
        self.rehydration_mode = "full"
        self.generated_docx: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []
        self.verifier_attempts: list[dict[str, Any]] = []
        self.verified_claims: list[dict[str, Any]] | None = None
        self.accepted_claims: list[dict[str, Any]] = []
        self.accepted_span_claims: list[dict[str, Any]] = []

    def complete_card(self, doc_id: str, card: str, claims: list[dict[str, Any]] | None = None) -> str | None:
        self.card_cards[doc_id] = card[:5000]
        self.card_claims[doc_id] = list(claims or [])
        if doc_id == self.card_queue[self.card_index]:
            self.card_index += 1
        if self.card_index >= len(self.card_queue):
            self.card_queue_complete = True
            return None
        return self.card_queue[self.card_index]

    def set_phase(self, phase: str) -> None:
        if phase == "case-a":
            self.active_doc_ids = {"case-a"}
        elif phase == "case-b":
            self.active_doc_ids = {"case-b"}
        elif phase == "case-c":
            self.active_doc_ids = {"case-c"}
        elif phase == "final":
            self.active_doc_ids = set(self.cases)
        elif phase in self.cases:
            self.active_doc_ids = {phase}
        else:
            raise ValueError(f"unknown phase: {phase}")

    def set_final_rehydration(self, active: bool) -> None:
        self.final_rehydration_active = active

    def set_compact_rehydration(self, active: bool) -> None:
        self.compact_rehydration_active = active

    def set_rehydration_mode(self, mode: str) -> None:
        self.rehydration_mode = mode

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
            items = evidence_handles(case) if case.spec.key_paragraphs else [
                {"handle": handle_id(case, number), "paragraph": number}
                for number in paragraph_map
            ]
            for item in items:
                evidence[item["handle"]] = (case, paragraph_map[item["paragraph"]])
                evidence[short_handle(case, item["paragraph"])] = evidence[item["handle"]]
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
    def _sentences(cls, value: str) -> list[str]:
        text = cls._copy_ready_text(value)
        return [part.strip() for part in re.split(r"(?<=[.!?])\s+(?=[A-Z\"“\[])", text) if part.strip()]

    @classmethod
    def _card_span_context(
        cls,
        paragraph_text: str,
        start: Any,
        end: Any,
    ) -> tuple[str, str, int, int, int]:
        """Return compact prefix/snippet plus nearest valid sentence range."""

        copy_text = cls._copy_ready_text(paragraph_text)
        prefix = copy_text[:140].rstrip()
        if len(copy_text) > 140:
            prefix += " ..."
        sentences = cls._sentences(paragraph_text)
        if not sentences:
            return prefix, "", 0, 0, 0
        last = len(sentences) - 1
        requested_start = start if isinstance(start, int) else 0
        requested_end = end if isinstance(end, int) else requested_start
        closest_start = min(max(requested_start, 0), last)
        closest_end = min(max(requested_end, closest_start), last)
        snippet = collapse_ws(
            " ".join(
                f"S{index}: {sentences[index]}"
                for index in range(closest_start, closest_end + 1)
            )
        )
        if len(snippet) > 480:
            snippet = snippet[:477].rstrip() + "..."
        return prefix, snippet, closest_start, closest_end, last

    def validate_card_span(
        self,
        doc_id: str,
        raw_claim: Any,
        claim_index: int,
        opaque: bool,
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str | None]:
        claim = raw_claim if isinstance(raw_claim, dict) else {}
        paragraph = claim.get("paragraph") if opaque else None
        if opaque:
            case = self.cases.get(doc_id)
            handle = (
                handle_id(case, paragraph)
                if case is not None and isinstance(paragraph, int)
                else ""
            )
        else:
            handle = str(claim.get("evidence_id", ""))
            match = re.search(r"#paragraph-(\d+)$", handle)
            paragraph = int(match.group(1)) if match else None
        evidence = self._evidence_by_handle()
        if handle not in evidence or evidence[handle][0].spec.doc_id != doc_id:
            location = (
                f"paragraph {paragraph}"
                if opaque and paragraph is not None
                else (handle or "active case")
            )
            return (
                None,
                self.card_span_feedback(
                    doc_id,
                    claim_index,
                    paragraph,
                    claim.get("start_sentence"),
                    claim.get("end_sentence"),
                ),
                f"claims[{claim_index}] has no matching source span at {location}",
            )
        start = claim.get("start_sentence")
        end = claim.get("end_sentence")
        sentences = self._sentences(evidence[handle][1])
        if (
            not isinstance(start, int)
            or not isinstance(end, int)
            or start < 0
            or end < start
            or end >= len(sentences)
        ):
            location = f"paragraph {paragraph}" if opaque else handle
            return (
                None,
                self.card_span_feedback(doc_id, claim_index, paragraph, start, end),
                f"claims[{claim_index}] sentence range is invalid at {location}; valid range is 0..{len(sentences) - 1}",
            )
        return (
            {
                "evidence_id": handle,
                "start_sentence": start,
                "end_sentence": end,
            },
            None,
            None,
        )

    def card_span_feedback(
        self,
        doc_id: str,
        claim_index: int,
        paragraph: Any,
        start: Any,
        end: Any,
    ) -> dict[str, Any]:
        """Give card jail deterministic, compact repair context for one span."""

        case = self.cases.get(doc_id)
        try:
            paragraph_number = int(paragraph)
        except (TypeError, ValueError):
            paragraph_number = None
        if case is None or paragraph_number not in case.paragraph_map:
            available = sorted(case.paragraph_map) if case else []
            closest = min(available, key=lambda number: abs(number - paragraph_number)) if available and paragraph_number is not None else None
            feedback: dict[str, Any] = {
                "claim_index": claim_index,
                "status": "no_match",
                "requested_paragraph": paragraph_number,
                "repair": "Use a paragraph number present in the active packet.",
            }
            if closest is not None:
                prefix, snippet, closest_start, closest_end, last = self._card_span_context(case.paragraph_map[closest], start, end)
                feedback.update(
                    {
                        "closest_paragraph": closest,
                        "valid_range": f"0..{last}",
                        "paragraph_prefix": prefix,
                        "closest_snippet": snippet,
                        "copy_text": f"{prefix} {snippet}".strip(),
                        "contract": "paragraph prefix ... closest matching snippet; use supplied paragraph and sentence range, never guess",
                        "repair": f"Use paragraph={closest}, start_sentence={closest_start}, end_sentence={closest_end}.",
                    }
                )
            return feedback
        prefix, snippet, closest_start, closest_end, last = self._card_span_context(
            case.paragraph_map[paragraph_number], start, end
        )
        return {
            "claim_index": claim_index,
            "status": "range_invalid",
            "paragraph": paragraph_number,
            "requested_range": f"{start}..{end}",
            "valid_range": f"0..{last}",
            "paragraph_prefix": prefix,
            "closest_snippet": snippet,
            "copy_text": f"{prefix} {snippet}".strip(),
            "contract": "paragraph prefix ... closest matching snippet; use supplied paragraph and sentence range, never guess",
            "repair": f"Use paragraph={paragraph_number}, start_sentence={closest_start}, end_sentence={closest_end}.",
        }

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
        for claim in verified:
            key = (claim["kind"], claim["text"], tuple(claim["evidence_ids"]))
            if not any(
                (old["kind"], old["text"], tuple(old["evidence_ids"])) == key
                for old in self.accepted_claims
            ):
                self.accepted_claims.append(claim)
        covered_cases = {
            evidence_id.split("@", 1)[0]
            for claim in self.accepted_claims
            for evidence_id in claim["evidence_ids"]
        }
        missing_cases = sorted(set(self.cases) - covered_cases)
        if missing_cases:
            errors.append(f"missing required case coverage: {', '.join(missing_cases)}")
        self.verifier_attempts.append({"arguments": args, "errors": errors, "diagnostics": diagnostics})
        if errors:
            failed = [item["claim_index"] for item in diagnostics]
            return json.dumps(
                {
                    "ok": False,
                    "accepted_claims": len(self.accepted_claims),
                    "failed_claims": failed,
                    "missing_cases": missing_cases,
                    "errors": errors[:12],
                    "diagnostics": diagnostics[:12],
                },
                ensure_ascii=False,
            )
        self.verified_claims = self.accepted_claims
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
            sentences = self._sentences(passage)
            if self.compact_rehydration_active:
                copy_text = self._copy_ready_text(passage)
                prefix_chars, tail_chars = (240, 720) if self.rehydration_mode == "expanded_snippet" else (140, 360)
                prefix = copy_text[:prefix_chars].rstrip()
                tail = copy_text[-tail_chars:].lstrip() if len(copy_text) > prefix_chars + tail_chars else copy_text[prefix_chars:]
                candidate = prefix + (" … " + tail if len(copy_text) > prefix_chars + tail_chars else "")
                return json.dumps(
                    {
                        "ok": True,
                        "evidence_id": handle,
                        "locator": handle.rsplit("#", 1)[-1],
                        "content_sha256": sha256_text(passage),
                        "paragraph_prefix": prefix,
                        "closest_snippet": tail,
                        "copy_text": candidate,
                        "sentence_count": len(sentences),
                        "contract": "prefix … closest matching snippet; submit the stable handle and sentence range, not a guessed quote",
                    },
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "ok": True,
                    "evidence_id": handle,
                    "locator": handle.rsplit("#", 1)[-1],
                    "content_sha256": sha256_text(passage),
                    "exact_text": passage,
                    "copy_text": self._copy_ready_text(passage),
                    "sentences": [
                        {"index": index, "text": sentence}
                        for index, sentence in enumerate(sentences)
                    ],
                },
                ensure_ascii=False,
            )

        if name == SPAN_ANSWER_TOOL_NAME:
            claims = args.get("claims")
            evidence = self._evidence_by_handle()
            verified: list[dict[str, Any]] = []
            errors: list[str] = []
            if not isinstance(claims, list) or not claims:
                errors.append("submit_quote_spans requires a non-empty claims array")
                claims = []
            for index, raw in enumerate(claims):
                handle = raw.get("evidence_id") if isinstance(raw, dict) else None
                start = raw.get("start_sentence") if isinstance(raw, dict) else None
                end = raw.get("end_sentence") if isinstance(raw, dict) else None
                if handle not in evidence or not isinstance(start, int) or not isinstance(end, int):
                    errors.append(f"claims[{index}] has an invalid evidence handle or sentence range")
                    continue
                sentences = self._sentences(evidence[handle][1])
                if start < 0 or end < start or end >= len(sentences):
                    errors.append(f"claims[{index}] sentence range is outside the cited paragraph")
                    continue
                verified.append({
                    "text": " ".join(sentences[start:end + 1]),
                    "evidence_ids": [canonical_handle(handle, evidence[handle][0])],
                    "kind": "quotation",
                })
            self.verifier_attempts.append({"arguments": args, "errors": errors, "diagnostics": []})
            for claim in verified:
                key = (claim["kind"], claim["text"], tuple(claim["evidence_ids"]))
                if not any(
                    (old["kind"], old["text"], tuple(old["evidence_ids"])) == key
                    for old in self.accepted_span_claims
                ):
                    self.accepted_span_claims.append(claim)
            self.verified_claims = list(self.accepted_span_claims)
            covered_cases = sorted(
                {
                    evidence_id.split("@", 1)[0]
                    for claim in self.accepted_span_claims
                    for evidence_id in claim["evidence_ids"]
                }
            )
            if errors:
                return json.dumps(
                    {
                        "ok": False,
                        "errors": errors,
                        "accepted_claims": len(self.accepted_span_claims),
                        "covered_cases": covered_cases,
                    },
                    ensure_ascii=False,
                )
            return json.dumps(
                {
                    "ok": True,
                    "terminal": True,
                    "verified_claims": len(self.accepted_span_claims),
                    "verified_quotes": self.accepted_span_claims,
                    "covered_cases": covered_cases,
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
                        "handle_format": f"{doc_id}@session-snapshot#paragraph-N",
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
    include_span_tool: bool = False,
    max_tool_rounds: int = 10,
    post_gate_prompt: str | None = None,
    retrieval_compact_every: int | None = None,
    state_compact_every: int | None = None,
    progress_path: Path | None = None,
    synthesis_mode: bool = False,
    card_contract: str | None = None,
    compact_card_mode: bool = False,
    card_max_chars: int = CARD_MAX_CHARS,
    card_min_chars: int = CARD_MIN_CHARS,
    final_min_chars: int = FINAL_MIN_CHARS,
    card_span_mode: str = "mutable",
    prompt_style: str = "normal",
    card_prison_opaque: bool = False,
    micro_card: bool = False,
    omit_limits_unknowns: bool = False,
    post_verify_projection: bool = False,
    auto_read_card: bool = False,
    require_synthesis_tool: bool = False,
) -> tuple[str, list[dict[str, Any]]]:
    tools.set_phase(phase)
    if tools.card_queue_complete and phase != "final":
        return "", messages
    if synthesis_mode and prompt_style == "grug":
        messages[0] = {"role": "system", "content": GRUG_SYNTHESIS_SYSTEM_PROMPT}
    messages.append({"role": "user", "content": prompt})
    last_text = ""
    retrieval_candidates: list[dict[str, Any]] = []
    read_done = False
    last_tool = "none"
    card_rebuild_mode = False
    card_doc_id = phase
    card_draft = ""
    card_fields: dict[str, str] = {}
    card_patch_claims: list[dict[str, Any]] = []
    active_packet = ""
    frozen_claims: list[dict[str, Any]] = []
    span_register: dict[str, dict[str, Any]] = {}
    pending_span_repairs: dict[str, dict[str, Any]] = {}

    def model_visible_spans(claims: Any) -> list[dict[str, Any]]:
        values = list(claims or [])
        if not card_prison_opaque or not values:
            return values
        try:
            return json.loads(
                opaque_card_result(json.dumps(values, ensure_ascii=False), card_doc_id)
            )
        except (TypeError, json.JSONDecodeError):
            return values

    def card_span_state_prompt() -> str:
        sections: list[str] = []
        if card_span_mode == "immutable" and frozen_claims:
            sections.append(
                "[VERIFIED SPANS — PRESERVE EXACTLY]\n"
                + json.dumps(model_visible_spans(frozen_claims), ensure_ascii=False)
            )
        if card_span_mode == "host_register":
            sections.append(
                "[HOST SPAN REGISTER]\n"
                + json.dumps(model_visible_spans(span_register.values()), ensure_ascii=False)
            )
            if pending_span_repairs:
                sections.append(
                    "[PENDING SPAN REPAIRS]\n"
                    + json.dumps(list(pending_span_repairs.values()), ensure_ascii=False)
                )
        return "\n\n" + "\n\n".join(sections) if sections else ""
    if auto_read_card and card_contract and card_doc_id in tools.cases:
        read_done = True
        active_packet = tools.cases[card_doc_id].packet
        messages.append({"role": "user", "content": "[ACTIVE SOURCE PACKET]\n" + active_packet})
        append_progress(
            progress_path,
            {"kind": "host_read", "turn": turn_number, "phase": phase, "document": card_doc_id},
        )
    for tool_round in range(max_tool_rounds):
        try:
            message, usage = client.chat(
                messages,
                include_grounding_tool,
                include_rehydration_tool,
                include_span_tool,
                card_rebuild_mode,
                False,
                synthesis_mode,
                compact_card_mode,
                card_max_chars,
                card_min_chars,
                bool(card_contract and read_done),
                prompt_style,
                card_prison_opaque,
                micro_card,
                omit_limits_unknowns,
                auto_read_card,
                host_register=card_span_mode == "host_register",
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
        append_progress(
            progress_path,
            {
                "kind": "model_call",
                "turn": turn_number,
                "phase": phase,
                "tool_round": tool_round + 1,
                "tool_calls": [name for name, _ in assistant_tool_calls(message)],
                "assistant_text_preview": last_text[:1200],
                "usage": usage,
                "input_estimate": estimate_tokens(json.dumps(messages, ensure_ascii=False)),
            },
        )
        calls = assistant_tool_calls(message)
        if not calls:
            if synthesis_mode and require_synthesis_tool:
                synthesis_gate = (
                    "[QUOTE COVERAGE GATE] No prose answer counts yet. "
                    "Call rehydrate_evidence or submit_quote_spans now; "
                    "submit quote spans for every missing case before writing prose. "
                    + NO_QUESTIONS
                )
                messages[:] = messages[:2] + [
                    {"role": "user", "content": synthesis_gate}
                ]
                append_progress(
                    progress_path,
                    {
                        "kind": "stop_rejected",
                        "turn": turn_number,
                        "phase": phase,
                        "reason": "synthesis_tool_required",
                    },
                )
                continue
            if synthesis_mode and final_min_chars > 0 and len(last_text.strip()) < final_min_chars:
                messages.append(message)
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            f"[ANSWER GOAL GATE] The answer must be at least {final_min_chars} characters and include analysis plus verified quotes. "
                            "Use the available evidence tools if needed, then write the complete answer. "
                            + NO_QUESTIONS
                        ),
                    }
                )
                append_progress(
                    progress_path,
                    {
                        "kind": "stop_rejected",
                        "turn": turn_number,
                        "phase": phase,
                        "reason": "final_goal_incomplete",
                    },
                )
                continue
            if card_contract and not tools.card_queue_complete:
                gate = (
                    f"[GOAL GATE] Card incomplete; prose is rejected. {NO_QUESTIONS} "
                    f"Call {CARD_COMPLETE_TOOL_NAME} with the complete card and valid paragraph spans."
                )
                if card_draft:
                    messages[:] = [
                        {"role": "system", "content": card_prison_system_prompt(prompt_style)},
                        {
                            "role": "user",
                            "content": (
                                "[CURRENT CARD DRAFT]\n" + card_draft
                                + ("\n\n[ACTIVE SOURCE PACKET]\n" + active_packet if active_packet else "")
                                + "\n\n[CARD CONTRACT]\n" + (card_contract or "")
                                + card_span_state_prompt()
                                + "\n\n" + gate
                            ),
                        },
                    ]
                else:
                    messages.append(message)
                    messages.append({"role": "user", "content": gate})
                append_progress(
                    progress_path,
                    {
                        "kind": "stop_rejected",
                        "turn": turn_number,
                        "phase": phase,
                        "reason": "card_goal_incomplete",
                    },
                )
                continue
            return last_text, messages
        retry_feedback: list[dict[str, Any]] = []
        for name, arguments in calls:
            if name == "r":
                name = "read_document"
            if micro_card and name == MICRO_DONE_TOOL_NAME:
                labels = {
                    "f": "FACTS/PROCEDURE",
                    "i": "ISSUE",
                    "h": "HOLDING",
                    "r": "RULE/REASONING",
                    "e": "EVIDENCE HANDLES",
                }
                if not omit_limits_unknowns:
                    labels = {**labels, "l": "LIMITS", "u": "UNKNOWNS"}
                missing_fields = [key for key in labels if not str(card_fields.get(key) or "").strip()]
                host_claims = list(span_register.values())
                arguments = {
                    "card": "\n\n".join(f"{labels[key]}: {card_fields.get(key, '')}" for key in labels),
                    "claims": host_claims
                    if card_span_mode == "host_register"
                    else arguments.get("claims") or card_patch_claims,
                }
                if card_span_mode == "host_register":
                    arguments["_pending_span_repairs"] = list(pending_span_repairs.values())
                if missing_fields:
                    arguments["card"] = "CARD_INCOMPLETE; MISSING FIELDS: " + ", ".join(missing_fields)
                name = CARD_COMPLETE_TOOL_NAME
            last_tool = name
            entered_card_rebuild = False
            if micro_card and name == MICRO_PATCH_TOOL_NAME:
                field = str(arguments.get("field") or "")
                text = str(arguments.get("text") or "")
                allowed_fields = {"f", "i", "h", "r", "e"} if omit_limits_unknowns else {"f", "i", "h", "r", "l", "u", "e"}
                field_order = ["f", "i", "h", "r", "e"] if omit_limits_unknowns else ["f", "i", "h", "r", "l", "u", "e"]
                pending = next((key for key in field_order if not card_fields.get(key)), None)
                field_has_pending_span = any(
                    slot.startswith(field + ":") for slot in pending_span_repairs
                )
                if field not in allowed_fields or not text.strip():
                    result = json.dumps({"ok": False, "error": "bad_card_patch", "next_action": "Use p with one field and text."})
                elif card_fields.get(field) and pending and field != pending and not field_has_pending_span:
                    result = json.dumps({"ok": False, "error": "field_already_saved", "field": field, "completed": [key for key in field_order if card_fields.get(key)], "next_field": pending, "next_action": f"Patch {pending}, then call d."})
                else:
                    card_fields[field] = text
                    claims = [claim for claim in arguments.get("claims") or [] if isinstance(claim, dict)]
                    if card_span_mode == "host_register" and "claims" in arguments:
                        for slot in [key for key in pending_span_repairs if key.startswith(field + ":")]:
                            pending_span_repairs.pop(slot, None)
                        for slot in [key for key in span_register if key.startswith(field + ":")]:
                            span_register.pop(slot, None)
                        repairs: list[dict[str, Any]] = []
                        for claim_index, claim in enumerate(claims):
                            slot = f"{field}:{claim_index}"
                            valid, repair, error = tools.validate_card_span(
                                card_doc_id,
                                claim,
                                claim_index,
                                card_prison_opaque,
                            )
                            if error:
                                pending_span_repairs[slot] = {
                                    "slot": slot,
                                    **(repair or {"claim_index": claim_index}),
                                    "error": error,
                                }
                                repairs.append(pending_span_repairs[slot])
                            elif valid is not None:
                                span_register[slot] = valid
                        if repairs:
                            result = json.dumps(
                                {
                                    "ok": False,
                                    "error": "span_repair_required",
                                    "field": field,
                                    "field_saved": True,
                                    "span_repairs": repairs,
                                    "register_size": len(span_register),
                                    "next_action": f"Patch {field} again with each supplied repair before moving on.",
                                },
                                ensure_ascii=False,
                            )
                        else:
                            result = json.dumps(
                                {
                                    "ok": True,
                                    "field": field,
                                    "saved": len(text),
                                    "register_size": len(span_register),
                                    "next_action": "Patch next field or call d.",
                                }
                            )
                    else:
                        for claim in claims:
                            card_patch_claims.append(claim)
                        result = json.dumps({"ok": True, "field": field, "saved": len(text), "next_action": "Patch next field or call d."})
            elif synthesis_mode and name not in {REHYDRATE_EVIDENCE_TOOL_NAME, SPAN_ANSWER_TOOL_NAME}:
                result = json.dumps({"ok": False, "error": "tool_unavailable_in_synthesis", "next_action": "Use rehydrate_evidence for exact text or submit_quote_spans for quotations; then write analysis."})
            elif (card_rebuild_mode or card_contract) and name == CARD_COMPLETE_TOOL_NAME:
                card_text = str(arguments.get("card") or "")[:card_max_chars]
                card_draft = card_text
                current_doc = card_doc_id if card_doc_id in tools.cases else str(arguments.get("document_id") or "")
                required_labels = ("FACTS/PROCEDURE", "ISSUE", "HOLDING", "RULE/REASONING", "EVIDENCE HANDLES") if omit_limits_unknowns else ("FACTS/PROCEDURE", "ISSUE", "HOLDING", "RULE/REASONING", "LIMITS", "UNKNOWNS", "EVIDENCE HANDLES")
                if not read_done:
                    result = json.dumps({"ok": False, "error": "read_required", "next_action": f"Call r {current_doc}."})
                elif card_text.startswith("CARD_INCOMPLETE; MISSING FIELDS:"):
                    missing_fields = card_text.split(":", 1)[1].strip()
                    result = json.dumps({"ok": False, "error": "card_fields_missing", "missing_fields": missing_fields.split(", "), "next_action": "Patch every missing field with p(field,text), then call d."})
                elif len(card_text) < card_min_chars:
                    result = json.dumps({"ok": False, "error": "card_too_short", "length": len(card_text), "minimum_chars": card_min_chars, "next_action": f"Add substantive text to every field until the card is at least {card_min_chars} characters, then call card_done again."})
                elif not all(label in card_text.upper() for label in required_labels):
                    missing_labels = [label for label in required_labels if label not in card_text.upper()]
                    result = json.dumps({"ok": False, "error": "card_fields_missing", "missing_fields": missing_labels, "next_action": "Patch the missing fields with p(field,text), include exact evidence spans, then call card_done again."})
                elif card_span_mode == "host_register" and arguments.get("_pending_span_repairs"):
                    result = json.dumps(
                        {
                            "ok": False,
                            "error": "evidence_spans_invalid",
                            "errors": [
                                item.get("error", "span repair required")
                                for item in arguments["_pending_span_repairs"]
                            ],
                            "verified_claims": list(span_register.values()),
                            "span_repairs": arguments["_pending_span_repairs"],
                            "next_action": "Patch each pending span in p; d submits the host register only.",
                        },
                        ensure_ascii=False,
                    )
                else:
                    claims = (
                        list(span_register.values())
                        if card_span_mode == "host_register"
                        else arguments.get("claims")
                    )
                    valid_claims: list[dict[str, Any]] = []
                    errors: list[str] = []
                    span_repairs: list[dict[str, Any]] = []
                    if not isinstance(claims, list) or not claims:
                        errors.append("card_done requires non-empty span claims")
                    for index, raw in enumerate(claims or []):
                        valid, repair, error = tools.validate_card_span(
                            current_doc,
                            raw,
                            index,
                            card_prison_opaque and card_span_mode != "host_register",
                        )
                        if error:
                            errors.append(error)
                            if repair is not None:
                                span_repairs.append(repair)
                        elif valid is not None:
                            valid_claims.append(valid)
                    if card_span_mode == "immutable":
                        known = {item["evidence_id"]: item for item in frozen_claims}
                        for item in valid_claims:
                            known.setdefault(item["evidence_id"], item)
                        frozen_claims = list(known.values())
                    if errors:
                        result = json.dumps(
                            {
                                "ok": False,
                                "error": "evidence_spans_invalid",
                                "errors": errors,
                                "verified_claims": (
                                    list(span_register.values())
                                    if card_span_mode == "host_register"
                                    else frozen_claims if card_span_mode == "immutable" else valid_claims
                                ),
                                "span_repairs": span_repairs,
                                "next_action": "Repair only listed spans using each valid range and closest snippet; preserve verified spans exactly and call card_done again.",
                            }
                        )
                    else:
                        submitted_claims = (
                            list(span_register.values())
                            if card_span_mode == "host_register"
                            else frozen_claims if card_span_mode == "immutable" else valid_claims
                        )
                        next_doc = tools.complete_card(current_doc, card_text, submitted_claims) if current_doc in tools.cases else None
                        result = json.dumps(
                            {
                                "ok": True,
                                "card_complete": True,
                                "document_id": current_doc,
                                "card": card_text,
                                "claims": submitted_claims,
                                "next_document_id": next_doc,
                            },
                            ensure_ascii=False,
                        )
                        card_rebuild_mode = False
            elif read_done and name == "list_documents":
                result = json.dumps(
                    {
                        "ok": False,
                        "error": "document_already_loaded",
                        "next_action": "Do not list documents again; use the current case card, read_document for bounded card repair, or find_in_document for a missing fact.",
                    }
                )
            elif read_done and name in {"read_document", "fetch_documents"}:
                # Rehydrate only the bounded packet and turn the reread into
                # card repair; never put the raw source back in context.
                doc_id = str(arguments.get("doc_id") or phase)
                case = tools.cases.get(doc_id)
                if case is None:
                    result = json.dumps({"ok": False, "error": "document_already_loaded", "document_id": doc_id})
                else:
                    entered_card_rebuild = True
                    active_packet = case.packet
                    result = json.dumps(
                        {
                            "ok": True,
                            "rehydration": "bounded_card_rebuild",
                            "document_id": doc_id,
                            "citation": case.spec.citation,
                            "instruction": "You were reading this document. Re-read this bounded packet and rewrite your case card until complete. Preserve only material facts, issues, holdings, reasoning, unresolved questions, and exact evidence handles. Do not answer yet.",
                            "packet_sha256": case.packet_sha256,
                            "content": case.packet,
                        },
                        ensure_ascii=False,
                    )
            else:
                result = tools.execute(name, arguments)
            append_progress(
                progress_path,
                {
                    "kind": "tool_result",
                    "turn": turn_number,
                    "phase": phase,
                    "tool": name,
                    "arguments": arguments,
                    "result_preview": result[:1800],
                },
            )
            if name == "find_in_document":
                try:
                    payload = json.loads(result)
                    retrieval_candidates.append(
                        {
                            "document_id": payload.get("document_id"),
                            "query": payload.get("query"),
                            "matches": payload.get("matches", [])[:3],
                        }
                    )
                except (TypeError, json.JSONDecodeError):
                    pass
            if name in {"read_document", "fetch_documents"}:
                try:
                    payload = json.loads(result)
                    if payload.get("ok", False):
                        read_done = True
                        loaded = tools.cases.get(str(payload.get("document_id") or card_doc_id))
                        if loaded is not None:
                            active_packet = loaded.packet
                except (TypeError, json.JSONDecodeError):
                    pass
            if card_contract and read_done:
                messages[0] = {"role": "system", "content": card_prison_system_prompt(prompt_style)}
            model_result = (
                opaque_card_result(result, card_doc_id)
                if card_prison_opaque and card_contract
                else result
            )
            messages.append(
                {
                    "role": "tool",
                    "tool_name": name,
                    "content": model_result,
                }
            )
            if (
                card_contract
                and name == CARD_COMPLETE_TOOL_NAME
                and '"ok": false' in result
                and card_draft
            ):
                # Keep the accepted draft, discard the raw source and failed
                # tool transcript, and ask for only the deterministic repair.
                messages[:] = [
                    {"role": "system", "content": card_prison_system_prompt(prompt_style)},
                    {
                        "role": "user",
                        "content": (
                            "[CURRENT CARD DRAFT]\n" + card_draft
                            + ("\n\n[ACTIVE SOURCE PACKET]\n" + active_packet if active_packet else "")
                            + "\n\n[CARD CONTRACT]\n" + (card_contract or "")
                            + card_span_state_prompt()
                            + "\n\n[REPAIR FEEDBACK]\n" + model_result
                            + f"\n\nResubmit the complete current card with {CARD_COMPLETE_TOOL_NAME}; preserve valid fields and claims."
                        ),
                    },
                ]
            if entered_card_rebuild:
                messages[:] = messages[:1] + [
                    {
                        "role": "user",
                        "content": (
                            "[CARD REBUILD]\n"
                            f"Review packet; search only if needed; then call {CARD_COMPLETE_TOOL_NAME}. No final answer.\n\n"
                            + model_result
                        ),
                    }
                ]
                card_rebuild_mode = True
            elif name == CARD_COMPLETE_TOOL_NAME:
                payload = json.loads(result)
                next_doc = payload.get("next_document_id")
                if next_doc:
                    card_draft = ""
                    card_fields.clear()
                    card_patch_claims.clear()
                    frozen_claims = []
                    span_register.clear()
                    pending_span_repairs.clear()
                    card_doc_id = str(next_doc)
                    phase = str(next_doc)
                    last_tool = "new_case"
                    card_contract = (
                        micro_card_prompt(
                            card_prison_opaque,
                            card_min_chars,
                            omit_limits_unknowns,
                            card_span_mode == "host_register",
                        )
                        if micro_card
                        else grug_card_prompt(card_doc_id, card_prison_opaque, card_min_chars)
                        if prompt_style == "grug"
                        else dynamic_card_prompt(card_doc_id, card_prison_opaque, card_min_chars)
                    )
                    # The host has already injected the next bounded packet;
                    # do not force an impossible r->d loop in micro-card mode.
                    read_done = True
                    tools.set_phase(str(next_doc))
                    next_case = tools.cases[str(next_doc)]
                    active_packet = next_case.packet
                    messages[0] = {"role": "system", "content": card_prison_system_prompt(prompt_style)}
                    messages[:] = messages[:1] + [
                        {
                            "role": "user",
                            "content": (
                                "[NEW CASE CARD]\n"
                                f"Start a fresh card from this packet. Patch every field, then call {CARD_COMPLETE_TOOL_NAME}.\n\n"
                                + json.dumps(
                                    {
                                        "citation": next_case.spec.citation,
                                        "content": next_case.packet,
                                    },
                                    ensure_ascii=False,
                                )
                            ),
                        }
                    ]
                elif tools.card_queue_complete:
                    cards = "\n\n".join(
                        f"CARD {doc_id}:\n{card}\n\n[VERIFIED SPANS]\n"
                        + json.dumps(tools.card_claims.get(doc_id, []), ensure_ascii=False)
                        for doc_id, card in tools.card_cards.items()
                    )
                    messages[:] = messages[:1] + [
                        {
                            "role": "user",
                            "content": "[ALL CARDS COMPLETE]\n" + cards + "\n\nCompose the original legal answer now.",
                        }
                    ]
                    return "", messages
            if name in {GROUNDED_ANSWER_TOOL_NAME, SPAN_ANSWER_TOOL_NAME}:
                try:
                    if json.loads(result).get("terminal"):
                        if post_gate_prompt is None:
                            return tools.render_verified_answer(), messages
                        if post_verify_projection:
                            cards = "\n\n".join(
                                f"{doc_id}: {card}"
                                for doc_id, card in tools.card_cards.items()
                            )
                            quotes = json.dumps(tools.verified_claims or [], ensure_ascii=False)
                            messages[:] = [
                                {"role": "system", "content": GRUG_SYNTHESIS_SYSTEM_PROMPT if prompt_style == "grug" else DYNAMIC_MIKE_SYSTEM_PROMPT},
                                {
                                    "role": "user",
                                    "content": (
                                        "[POST-VERIFICATION STATE]\n"
                                        "Use the completed cards and verified quotations below. Write the final answer now.\n\n"
                                        "[CARDS]\n" + cards
                                        + "\n\n[VERIFIED QUOTATIONS]\n" + quotes
                                    ),
                                },
                            ]
                        messages.append({"role": "user", "content": post_gate_prompt})
                        final_message, final_usage = client.chat(messages, False, False, False, prompt_style=prompt_style)
                        messages.append(final_message)
                        call_log.append(
                            {
                                "turn": turn_number,
                                "phase": phase,
                                "tool_round": tool_round + 1,
                                "usage": final_usage,
                                "assistant_text": str(final_message.get("content") or ""),
                                "tool_calls": [],
                                "post_gate_answer": True,
                                "input_estimate": estimate_tokens(json.dumps(messages, ensure_ascii=False)),
                            }
                        )
                        append_progress(
                            progress_path,
                            {
                                "kind": "post_gate_answer",
                                "turn": turn_number,
                                "phase": phase,
                                "assistant_text_preview": str(final_message.get("content") or "")[:1200],
                                "usage": final_usage,
                            },
                        )
                        return str(final_message.get("content") or ""), messages
                    if include_grounding_tool:
                        retry_feedback.append(
                            {"role": "tool", "tool_name": name, "content": result}
                        )
                except json.JSONDecodeError:
                    pass
        if (
            retrieval_compact_every
            and (tool_round + 1) % retrieval_compact_every == 0
            and retrieval_candidates
        ):
            checkpoint = {
                "type": "retrieval_checkpoint",
                "phase": phase,
                "candidates": retrieval_candidates[-12:],
            }
            # Preserve the active task/checkpoint and replace only the raw
            # search transcript. This is deliberately a representation change,
            # not a new instruction to the model.
            messages[:] = messages[:3] + [
                {
                    "role": "user",
                    "content": json.dumps(checkpoint, ensure_ascii=False),
                }
            ]
        if retry_feedback:
            # ponytail: retain only the checkpoint, latest submission, and compact
            # verifier feedback; full retry transcripts add tokens without evidence.
            messages[:] = messages[:3] + [message] + retry_feedback
        if (
            state_compact_every
            and estimate_tokens(json.dumps(messages, ensure_ascii=False))
            >= int(client.num_ctx * 0.75)
        ):
            state_input = messages + [
                {
                    "role": "user",
                    "content": (
                        "Rewrite the current working state as a concise note. Preserve the task, active case, substantive card fields, evidence handles, and next action. " +
                        NO_QUESTIONS + f" Use the document and call {CARD_COMPLETE_TOOL_NAME}. No invented facts."
                    ),
                }
            ]
            state_message, state_usage = client.chat(
                state_input, False, False, False,
                compact_card_mode=compact_card_mode,
                prompt_style=prompt_style,
                card_prison_opaque=card_prison_opaque,
                card_min_chars=card_min_chars,
                micro_card=micro_card,
                omit_limits_unknowns=omit_limits_unknowns,
                auto_read_card=auto_read_card,
                host_register=card_span_mode == "host_register",
            )
            state_text = str(state_message.get("content") or "")[:2200]
            call_log.append(
                {
                    "turn": turn_number,
                    "phase": phase,
                    "tool_round": tool_round + 1,
                    "usage": state_usage,
                    "assistant_text": state_text,
                    "tool_calls": [],
                    "state_compaction": True,
                    "input_estimate": estimate_tokens(json.dumps(state_input, ensure_ascii=False)),
                }
            )
            append_progress(
                progress_path,
                {
                    "kind": "state_compaction",
                    "turn": turn_number,
                    "phase": phase,
                    "state_preview": state_text[:1600],
                    "cursor": state_cursor(card_doc_id, read_done, last_tool, micro_card),
                    "usage": state_usage,
                },
            )
            cursor = state_cursor(card_doc_id, read_done, last_tool, micro_card)
            micro_register = ""
            if micro_card:
                field_order = ["f", "i", "h", "r", "e"] if omit_limits_unknowns else ["f", "i", "h", "r", "l", "u", "e"]
                completed = [key for key in field_order if card_fields.get(key)]
                pending = next((key for key in field_order if key not in completed), "none")
                micro_register = (
                    "\n\n[MICRO CARD REGISTER]\n"
                    + "DONE: " + (",".join(completed) or "none")
                    + "\nNEXT: " + pending
                    + "\nHost retains DONE field text. Do not patch a DONE field."
                )
            # O(1) projection: retain only the standing Mike contract and the
            # new register. Old turn prompts/tool messages can re-trigger the
            # baseline's list/read workflow after compaction.
            messages[:] = messages[:1] + [
                {
                    "role": "user",
                        "content": (
                            "[FIXED STATE REGISTER]\n" + state_text + "\n\n" + cursor
                        + micro_register
                        + ("\n\n[ACTIVE DOCUMENT PACKET]\n" + active_packet if active_packet else "")
                        + ("\n\n[CURRENT CARD DRAFT]\n" + card_draft if card_draft else "")
                        + (
                            "\n\n[CARD CONTRACT]\n"
                            f"{card_contract}\n" +
                            NO_QUESTIONS + f" Call {CARD_COMPLETE_TOOL_NAME}."
                            if card_contract
                            else ""
                        )
                    ),
                }
            ]
    raise RuntimeError(
        f"model exceeded the {max_tool_rounds}-round tool budget on turn {turn_number}"
    )


def state_cursor(phase: str, read_done: bool, last_tool: str, micro_card: bool = False) -> str:
    """Keep the tiny procedural state the model summary cannot reliably infer."""
    if micro_card:
        return (
            "[PROCEDURAL CURSOR]\n"
            f"last_tool={last_tool}; continue card fields for this packet. {NO_QUESTIONS} Call d when complete."
        )
    if read_done:
        read_rule = "source already read; remain in card completion."
    else:
        read_rule = "source not yet read; obtain it once, then reuse it."
    return (
        "[PROCEDURAL CURSOR]\n"
        f"last_tool={last_tool}; {read_rule} "
        f"Continue from the existing state. {NO_QUESTIONS} "
        + (f"Call {CARD_COMPLETE_TOOL_NAME}." if read_done else "Read once, then complete the card.")
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


def micro_card_tools(
    omit_limits_unknowns: bool = False,
    host_register: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return the micro tools with the ablated field enum when requested."""
    patch = json.loads(json.dumps(MICRO_PATCH_TOOL))
    if omit_limits_unknowns:
        patch["function"]["parameters"]["properties"]["field"]["enum"] = ["f", "i", "h", "r", "e"]
    if host_register:
        patch["function"]["description"] = "Patch one card field and submit its span claims."
        patch["function"]["parameters"]["required"] = ["field", "text", "claims"]
    return patch, MICRO_DONE_TOOL


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
                    },
                    {
                        "text": cases["case-b"].paragraph_map[cases["case-b"].spec.key_paragraphs[0]],
                        "evidence_ids": [handle_id(cases["case-b"], cases["case-b"].spec.key_paragraphs[0])],
                        "kind": "quotation",
                    },
                    {
                        "text": cases["case-c"].paragraph_map[cases["case-c"].spec.key_paragraphs[0]],
                        "evidence_ids": [handle_id(cases["case-c"], cases["case-c"].spec.key_paragraphs[0])],
                        "kind": "quotation",
                    },
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
        think=args.think,
        host_header=args.host_header or os.environ.get("OLLAMA_HOST_HEADER"),
    )
    executor = ToyMikeTools(cases)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": MIKE_SYSTEM_PROMPT},
    ]
    call_log: list[dict[str, Any]] = []
    turns: list[dict[str, Any]] = []
    ultra_card = args.arm == "case_card" and args.card_mode == "ultra"
    overflow: dict[str, Any] | None = None
    final_messages: list[dict[str, Any]] = messages
    verified_answer = ""
    output = resolve_output(args.out, args.arm)
    progress_path = output.with_suffix(".progress.jsonl")
    append_progress(progress_path, {"kind": "run_started", "arm": args.arm, "model": model, "num_ctx": args.num_ctx})

    try:
        card_suffix = (
            ULTRA_CASE_CARD_SUFFIX if ultra_card
            else DELTA_CASE_CARD_SUFFIX if args.card_mode == "delta"
            else CASE_CARD_SUFFIX
        )
        turn_one_prompt = (TURN_ONE + card_suffix) if args.arm == "case_card" else TURN_ONE
        turn_two_prompt = (TURN_TWO + card_suffix) if args.arm == "case_card" else TURN_TWO
        turn_three_prompt = (TURN_THREE + card_suffix) if args.arm == "case_card" else TURN_THREE
        first_response, messages = run_turn(
            client, messages, turn_one_prompt, "case-a", executor, call_log, 1,
            max_tool_rounds=args.max_tool_rounds,
            state_compact_every=4 if args.arm == "state_register" else None,
            progress_path=progress_path,
        )
        turns.append({"turn": 1, "prompt": turn_one_prompt, "response": first_response})

        if args.arm in {"full_history", "state_register"}:
            second_messages = messages
        else:
            checkpoint = (
                card_checkpoint(cases, [first_response], ultra_card)
                if args.arm == "case_card"
                else compact_checkpoint(cases, [first_response], False)
            )
            second_messages = compact_messages(checkpoint)
        second_response, messages = run_turn(
            client, second_messages, turn_two_prompt, "case-b", executor, call_log, 2,
            max_tool_rounds=args.max_tool_rounds,
            state_compact_every=4 if args.arm == "state_register" else None,
            progress_path=progress_path,
        )
        turns.append({"turn": 2, "prompt": turn_two_prompt, "response": second_response})

        if args.arm in {"full_history", "state_register"}:
            third_messages = messages
        else:
            checkpoint = (
                card_checkpoint(cases, [first_response, second_response], ultra_card)
                if args.arm == "case_card"
                else compact_checkpoint(cases, [first_response, second_response], False)
            )
            third_messages = compact_messages(checkpoint)
        third_response, messages = run_turn(
            client, third_messages, turn_three_prompt, "case-c", executor, call_log, 3,
            max_tool_rounds=args.max_tool_rounds,
            state_compact_every=4 if args.arm == "state_register" else None,
            progress_path=progress_path,
        )
        turns.append({"turn": 3, "prompt": turn_three_prompt, "response": third_response})

        if args.arm in {"full_history", "state_register"}:
            final_messages = messages
        else:
            checkpoint = (
                card_checkpoint(cases, [first_response, second_response, third_response], ultra_card)
                if args.arm == "case_card"
                else compact_checkpoint(
                    cases,
                    [first_response, second_response, third_response],
                    args.arm == "address_rehydrate",
                )
            )
            final_messages = compact_messages(checkpoint)
        executor.set_final_rehydration(args.arm == "address_rehydrate")
        final_prompt = TURN_FOUR
        if args.arm == "address_on_demand":
            final_prompt += " Before quoting, call rehydrate_evidence for each handle whose text you need, and copy quotations from its deterministic copy_text field. Omit paragraph labels from quotation text."
        elif args.arm == "span_selector":
            final_prompt += " Before submitting, call rehydrate_evidence to inspect sentence indexes, then use submit_quote_spans. Do not transcribe quotation text yourself."
        elif args.arm == "case_card":
            final_prompt += " Use the compact case cards for analysis. Before submitting quotations, call rehydrate_evidence to inspect sentence indexes, then use submit_quote_spans. Do not transcribe quotation text yourself."
        elif args.arm == "state_register":
            final_prompt += " Use only the fixed state register for analysis. Before submitting quotations, call rehydrate_evidence to inspect sentence indexes, then use submit_quote_spans. Do not transcribe quotation text yourself."
        final_response, final_messages = run_turn(
            client,
            final_messages,
            final_prompt,
            "final",
            executor,
            call_log,
            4,
            include_grounding_tool=args.arm in {"address_on_demand"},
            include_rehydration_tool=args.arm in {"address_on_demand", "span_selector", "case_card", "state_register"},
            include_span_tool=args.arm in {"span_selector", "case_card", "state_register"},
            max_tool_rounds=args.max_tool_rounds,
            post_gate_prompt=(
                "The deterministic quote verifier has accepted the quotations. Now write the final legal research answer. "
                "Include concise summaries of each case, the relationship among them, and the accepted exact quotations "
                "with SCC paragraph references. Do not call tools and do not invent additional quotations."
            ),
            retrieval_compact_every=8 if args.arm in {"span_selector", "case_card"} else None,
            state_compact_every=4 if args.arm == "state_register" else None,
            progress_path=progress_path,
        )
        turns.append({"turn": 4, "prompt": TURN_FOUR, "response": final_response})
        verified_answer = executor.render_verified_answer()
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
        "verified_answer": verified_answer,
        "final_answer": final_response,
        "messages_at_end": final_messages if not overflow else messages,
    }
    append_progress(progress_path, {"kind": "run_finished", "overflow": overflow, "final_answer_length": len(final_response)})
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


def acquire_run_lock(output: Path) -> None:
    lock = output.with_suffix(".lock")
    if lock.exists():
        try:
            old_pid = int(lock.read_text(encoding="ascii").strip())
            os.kill(old_pid, 0)
        except (OSError, ValueError):
            lock.unlink(missing_ok=True)
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as error:
        raise RuntimeError(f"run output already active: {output.name}") from error
    with os.fdopen(descriptor, "w", encoding="ascii") as stream:
        stream.write(str(os.getpid()))
    atexit.register(lock.unlink, missing_ok=True)


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
    run.add_argument("--provider", choices=("ollama", "codex"), default="ollama")
    run.add_argument("--model", default=None)
    run.add_argument(
        "--arm",
        choices=("full_history", "address_only", "address_rehydrate", "address_on_demand", "span_selector", "case_card", "state_register", "dynamic_selection"),
        required=True,
    )
    run.add_argument("--card-mode", choices=("standard", "ultra", "delta"), default="standard")
    run.add_argument("--card-span-mode", choices=("mutable", "immutable", "host_register"), default="mutable")
    run.add_argument("--card-prison-opaque", action="store_true")
    run.add_argument("--prompt-style", choices=("normal", "grug"), default="normal")
    run.add_argument("--context-tier", choices=tuple(COMPACTION_TIERS), default="8k")
    run.add_argument("--micro-card", action="store_true")
    run.add_argument("--no-final-minimum", action="store_true")
    run.add_argument("--omit-limits-unknowns", action="store_true")
    run.add_argument("--rehydration-mode", choices=("prefix_snippet", "expanded_snippet"), default="prefix_snippet")
    run.add_argument("--post-verify-projection", action="store_true")
    run.add_argument("--base-url", default=None)
    run.add_argument("--host-header", default=None)
    run.add_argument("--num-ctx", type=int, default=int(os.environ.get("OLLAMA_NUM_CTX", DEFAULT_NUM_CTX)))
    run.add_argument("--num-predict", type=int, default=DEFAULT_NUM_PREDICT)
    run.add_argument("--temperature", type=float, default=0.0)
    run.add_argument("--think", choices=("none", "low", "medium", "high", "max"), default="none")
    run.add_argument("--effort", choices=("low", "medium", "high", "max"), default="low")
    run.add_argument("--max-tool-rounds", type=int, default=10)
    run.add_argument("--max-synthesis-revisions", type=int, default=1)
    run.add_argument("--packet-chars", type=int, default=DEFAULT_PACKET_CHARS)
    run.add_argument("--source-a", type=resolve_path, default=None)
    run.add_argument("--source-b", type=resolve_path, default=None)
    run.add_argument("--a2aj-db", type=resolve_path, default=None)
    run.add_argument("--out", default=None)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        packet_chars = args.packet_chars
        if args.command == "run" and args.arm == "dynamic_selection":
            tier = COMPACTION_TIERS[args.context_tier]
            args.num_ctx = tier["num_ctx"]
            args.packet_chars = min(packet_chars, tier["packet_chars"])
            args.card_min_chars = tier["card_min_chars"]
            args.card_max_chars = tier["card_max_chars"]
            args.final_min_chars = tier["final_min_chars"]
            if args.micro_card:
                if args.context_tier == "8k":
                    raise ValueError("--micro-card requires --context-tier 4k, 2k, or 1k")
                micro = MICRO_TIERS[args.context_tier]
                args.packet_chars = min(args.packet_chars, micro["packet_chars"])
                args.card_min_chars = micro["card_min_chars"]
                args.card_max_chars = micro["card_max_chars"]
                args.final_min_chars = micro["final_min_chars"]
                args.num_predict = min(args.num_predict, micro["num_predict"])
            if args.no_final_minimum:
                args.final_min_chars = 0
            run_dynamic_selection(args)
            return 0
        if args.command == "run" and args.arm == "case_card":
            packet_chars = min(packet_chars, args.num_ctx * (2 if args.card_mode == "ultra" else 3))
            args.packet_chars = packet_chars
        elif args.command == "run" and args.arm == "state_register":
            packet_chars = min(packet_chars, args.num_ctx * 2)
            args.packet_chars = packet_chars
        cases = load_cases(
            packet_chars,
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
