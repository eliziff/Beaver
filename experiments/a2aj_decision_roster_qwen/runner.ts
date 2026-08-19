#!/usr/bin/env node

/**
 * Random A2AJ decision-roster sidecar experiment.
 *
 * Paragraph structure is deliberately not implemented here. The runner uses
 * the backend's SourceDoc/A2AJ compiler and lookup/evidence contracts, then
 * adds only the experiment-specific opinion-role extraction task.
 */

import { createHash, randomInt } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocument,
  fetchLocalA2AJDocumentsByIds,
  getLocalA2AJStructure,
} from "../../backend/src/lib/a2ajLocalBulk";
import {
  a2ajLegalSourceProvider,
  type A2AJDocument,
} from "../../backend/src/lib/legalSources/a2aj";
import {
  A2AJ_TOOLS,
  executeA2AJTool,
} from "../../backend/src/lib/chat/tools/a2ajTools";
import {
  createA2AJDocumentEvidence,
  type LegalEvidenceReceipt,
} from "../../backend/experiments/legal-evidence/legalEvidenceExperiment";
import {
  withReadonlySqlite,
} from "../../backend/src/lib/legalDataPath";
import {
  sourceDocQuoteWords,
  tokenizeSourceText,
  type SourceDoc,
  type SourceDocBlock,
} from "../../backend/src/lib/sourceDoc";
import {
  analyzeOpinionStructure,
  analyzeTextOpinionStructure,
  deriveTextOpinionStructure,
  MIN_OPINION_WORDS,
  partitionOpinionStructure,
  type JudgeOpinionRelationship,
  type JudgeResultSide,
  type OpinionAlignment,
  type OpinionStructure,
  type TextOpinionStructure,
} from "../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";

type Role = "majority" | "minority" | "concurring" | "unknown";
type Provider = "ollama" | "luna" | "dry";
type Range = { from: number; to: number };

type Candidate = {
  documentId: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
};

type MechanicalOpinion = {
  role: Role;
  from: number | null;
  to: number | null;
  excerpt: string;
};

type MechanicalHints = {
  judgeCandidates: string[];
  opinions: MechanicalOpinion[];
  header: string;
  status: "usable" | "unresolved" | "unavailable";
};

type PreflightSearch = {
  term: string;
  paragraph_hits: string[];
  snippets: string[];
};

type Preflight = {
  searches: PreflightSearch[];
  note: string;
};

type CaseRecord = {
  candidate: Candidate;
  document: A2AJDocument;
  source: SourceDoc;
  paragraphs: SourceDocBlock[];
  sourceEvidence: LegalEvidenceReceipt;
  sourceSha256: string;
  structure: OpinionStructure;
  deterministic: TextOpinionStructure;
  hints: MechanicalHints;
  preflight: Preflight;
};

type Prediction = {
  opinions: Array<{
    id: string;
    authors: string[];
    alignment: OpinionAlignment;
    start_quote: string;
    end_quote: string;
    start: number;
    end_exclusive: number;
    text_sha256: string;
    substantive_words: number;
    paragraphs: Range[];
  }>;
  judges: Array<{
    name: string;
    result_side: JudgeResultSide;
    relationship: JudgeOpinionRelationship;
    opinion_ids: string[];
  }>;
};

type MechanicalReference = {
  source: "mechanical";
  status: "ready" | "unresolved";
  judges: Array<{ name: string; role: Role }>;
  spans: Record<Role, Range[]>;
  note?: string;
};

type HumanReference = {
  source: "human";
  status: "ready";
  prediction: Prediction;
};

type Reference = MechanicalReference | HumanReference;

type Validation = {
  ok: boolean;
  error?: string;
  errors?: string[];
  next?: string;
};

type Args = Record<string, string | number | boolean | undefined>;

const HERE = __dirname;
const RUN_DIR = path.join(HERE, "runs");
const DEFAULT_MODEL = process.env.QWEN_MODEL?.trim() || "qwen3.5:9b";
const DEFAULT_CODEX_MODEL = "gpt-5.6-luna";
const DEFAULT_CODEX_EFFORT = "high";
const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const DEFAULT_SIDECAR = path.join(RUN_DIR, "decision-roster.sqlite");
const DEFAULT_NUM_CTX = 32_768;
const DEFAULT_NUM_PREDICT = 4_096;
const PROMPT_VERSION = "a2aj-opinion-v4";
const CODEX_PROMPT_VERSION = "a2aj-opinion-codex-v4";
const VALIDATOR_VERSION = "a2aj-opinion-validator-v4";
const DETERMINISTIC_VERSION = "a2aj-opinion-deterministic-v4";
const RESPONSE_SCHEMA_NAME = "a2aj_opinion_votes";
const MAX_LOOKUP_PARAGRAPHS = 12;
const MAX_ATTEMPTS = 20;
const MAX_CODEX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_LUNA_SOURCE_CHARS = 400_000;

const ROLE_KEYS: Role[] = ["majority", "minority", "concurring", "unknown"];
const OPINION_ALIGNMENTS: OpinionAlignment[] = [
  "lead",
  "same_result_separate_reasons",
  "different_result",
  "mixed",
  "unknown",
];
const RESULT_SIDES: JudgeResultSide[] = ["majority", "minority", "mixed", "unknown"];
const RELATIONSHIPS: JudgeOpinionRelationship[] = [
  "authors",
  "joins_reasons",
  "concurs_in_result_only",
  "mixed",
  "unknown",
];
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const ROSTER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    opinions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^o[1-9][0-9]*$" },
          authors: {
            type: "array",
            minItems: 1,
            maxItems: 30,
            items: { type: "string", minLength: 2 },
          },
          alignment: { type: "string", enum: OPINION_ALIGNMENTS },
          start_quote: { type: "string", minLength: 12 },
          end_quote: { type: "string", minLength: 12 },
        },
        required: ["id", "authors", "alignment", "start_quote", "end_quote"],
      },
    },
    judges: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          result_side: { type: "string", enum: RESULT_SIDES },
          relationship: { type: "string", enum: RELATIONSHIPS },
          opinion_ids: {
            type: "array",
            minItems: 0,
            maxItems: 20,
            items: { type: "string", pattern: "^o[1-9][0-9]*$" },
          },
        },
        required: ["name", "result_side", "relationship", "opinion_ids"],
      },
    },
  },
  required: ["opinions", "judges"],
} as const;

/** The same schema in the Responses API `text.format` shape. */
const GPT_RESPONSES_SCHEMA = {
  type: "json_schema",
  name: RESPONSE_SCHEMA_NAME,
  strict: true,
  schema: ROSTER_JSON_SCHEMA,
} as const;

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_roster",
    description:
      "Submit source-grounded substantive opinion blocks and judge voting relationships.",
    parameters: ROSTER_JSON_SCHEMA,
  },
} as const;

const LOOKUP_TOOL = (A2AJ_TOOLS as unknown as Array<Record<string, unknown>>).find(
  (tool) =>
    (tool.function as Record<string, unknown> | undefined)?.name ===
    "a2aj_lookup",
) ?? {
  type: "function",
  function: {
    name: "a2aj_lookup",
    description: "Look up an exact A2AJ decision paragraph or paragraph range.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        citation: { type: "string" },
        doc_type: { type: "string", enum: ["cases"] },
        locator_type: { type: "string", enum: ["paragraph"] },
        locator: { type: "string" },
        end_locator: { type: "string" },
      },
      required: ["citation", "locator_type", "locator"],
    },
  },
};

const OPINION_INSTRUCTIONS = `Extract substantive judicial opinions and the judges' voting relationships from this one closed-record decision.
An opinion is a substantive body of judicial reasons. A judge name, signature, disposition-only line, "I agree", "I concur", or "concurred in by" is a vote or joinder and is never a separate opinion by itself.
Use one opinion object per independently reasoned body. alignment=lead for the prevailing reasons; same_result_separate_reasons for independently reasoned concurrence in the result; different_result for dissenting reasons; mixed only for a genuinely mixed result; unknown only when the source is genuinely indeterminate.
Every member of the deciding panel belongs in judges. Exclude anyone whom the source says took no part, did not participate, or was otherwise not a member of the deciding panel. result_side=majority for every judge supporting the prevailing disposition, including a judge who joins the lead reasons and a judge who writes separate reasons but concurs in the result. If every participating judge reaches the same disposition, every judge is majority; never use unknown merely because the source does not say the word "majority".
relationship=authors when the judge wrote an opinion; joins_reasons for "I agree" or equivalent adoption of another opinion; concurs_in_result_only only when the judge agrees with the disposition but not the lead reasons; mixed or unknown only when supported by the source. opinion_ids identifies the authored or joined opinion bodies.
For each opinion copy an exact, verbatim start_quote from its first heading or substantive opening and an exact, verbatim end_quote through the terminal punctuation of its final substantive sentence. Use enough distinctive words for each quote to occur only once. Exclude panel metadata, signatures, bare joinders, solicitors, and corrections from the boundaries. Do not count character offsets; the validator resolves quotes against the source.
Return only JSON matching the supplied schema.`;

const SYSTEM_PROMPT = `YOU=QWEN. ONE A2AJ DECISION. DO NOT ASK A QUESTION.
${OPINION_INSTRUCTIONS}
Use deterministic preflight only as a search hint; it does not prove an opinion or vote. Read exact source paragraphs with a2aj_lookup when paragraph structure is available, then call submit_roster. NO PROSE AFTER THE TOOL CALL.`;

const CODEX_SYSTEM_PROMPT = `Closed-record extraction. Use only the supplied case; do not use tools or external knowledge.
${OPINION_INSTRUCTIONS}
The deterministic term-search preflight is only a navigation hint and is not an answer.`;

const PREFLIGHT_TERMS: Array<{ term: string; re: RegExp }> = [
  { term: "majority", re: /\bmajority\b/iu },
  { term: "minority", re: /\bminority\b/iu },
  { term: "dissent", re: /\bdissent(?:ing)?\b/iu },
  { term: "concurring", re: /\bconcurring\b/iu },
  { term: "reasons", re: /\breasons?\s+for\s+(?:judg(?:e)?ment|decision)\b/iu },
];

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compact(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function now() {
  return new Date().toISOString();
}

function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  if (!cause) return error.message;
  if (cause instanceof Error) return `${error.message}: ${cause.message}`;
  if (typeof cause === "object" && cause && "code" in cause) {
    return `${error.message}: ${String((cause as { code?: unknown }).code ?? "unknown cause")}`;
  }
  return `${error.message}: ${String(cause)}`;
}

async function appendJsonl(file: string, event: Record<string, unknown>) {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify({ utc: now(), ...event })}\n`, "utf8");
}

function parseIntFlag(args: Args, name: string, fallback: number) {
  const value = Number(args[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function flag(args: Args, name: string, fallback: string) {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function roleMap(): Record<Role, Range[]> {
  return { majority: [], minority: [], concurring: [], unknown: [] };
}

function words(value: string): string[] {
  return value.toLocaleLowerCase().match(WORD_RE) ?? [];
}

function nameKey(value: string) {
  // `words()` splits dotted judicial suffixes (`J.A.`, `J.S.C.`, etc.) into
  // single letters. Ignore every suffix component so the key remains the
  // judge's surname instead of collapsing an appellate panel to `a`.
  const ignored = new Set(["a", "b", "c", "f", "j", "n", "o", "q", "s", "t", "cj", "ja", "jj", "jca", "justice"]);
  const surnameFirst = value.includes(",") ? value.slice(0, value.indexOf(",")) : value;
  const tokens = words(surnameFirst).filter((token) => !ignored.has(token));
  return tokens.at(-1) ?? "";
}

function sourceNameMatches(header: string, name: string) {
  const key = nameKey(name);
  if (key.length < 2) return false;
  return words(header).includes(key);
}

function compressNumbers(numbers: number[]): Range[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (const number of sorted) {
    const last = ranges.at(-1);
    if (last && number === last.to + 1) last.to = number;
    else ranges.push({ from: number, to: number });
  }
  return ranges;
}

function paragraphNumbers(paragraphs: SourceDocBlock[]) {
  return paragraphs.flatMap((block) => {
    const match = /^par(\d+)$/iu.exec(block.label);
    return match ? [Number(match[1])] : [];
  });
}

function numbersInRange(range: Range, available: number[]) {
  return available.filter((number) => number >= range.from && number <= range.to);
}

function rangeText(source: SourceDoc, paragraphs: SourceDocBlock[], range: Range) {
  const selected = paragraphs.filter((block) => {
    const match = /^par(\d+)$/iu.exec(block.label);
    const number = match ? Number(match[1]) : NaN;
    return Number.isFinite(number) && number >= range.from && number <= range.to;
  });
  return selected.length
    ? source.text.slice(selected[0].start, selected.at(-1)!.end).trim()
    : "";
}

function paragraphText(source: SourceDoc, block: SourceDocBlock) {
  return source.text.slice(block.start, block.end);
}

function extractPreflight(source: SourceDoc, paragraphs: SourceDocBlock[]): Preflight {
  const searches = PREFLIGHT_TERMS.map(({ term, re }) => {
    const paragraph_hits: string[] = [];
    const snippets: string[] = [];
    for (const block of paragraphs) {
      const text = paragraphText(source, block);
      const match = re.exec(text);
      if (!match) continue;
      paragraph_hits.push(block.label);
      const start = Math.max(0, match.index - 70);
      const end = Math.min(text.length, match.index + match[0].length + 110);
      snippets.push(`${block.label}: ${compact(text.slice(start, end))}`);
      if (snippets.length >= 8) break;
    }
    return { term, paragraph_hits, snippets };
  });
  return {
    searches,
    note: "Case-sensitive role assignment was not performed. These are paragraph-level term hits only; verify against exact source.",
  };
}

function runnerRole(role: OpinionStructure["bindings"][number]["role"]): Role {
  return role === "separate" ? "unknown" : role;
}

function extractMechanicalHints(
  source: SourceDoc,
  paragraphs: SourceDocBlock[],
  structure: OpinionStructure,
): MechanicalHints {
  if (!paragraphs.length) {
    return { judgeCandidates: [], opinions: [], header: source.text.slice(0, 8_000), status: "unavailable" };
  }
  const firstParagraph = paragraphs[0].start;
  const header = source.text.slice(0, Math.min(firstParagraph, 12_000));
  const judgeCandidates: string[] = [];
  const candidateNames = [
    ...structure.panel,
    ...structure.bindings.flatMap((binding) => [...binding.names, ...binding.concurred]),
    ...structure.bodyMarkers.flatMap((marker) => (marker.name ? [marker.name] : [])),
  ];
  for (const name of candidateNames) {
    if (name && !judgeCandidates.some((item) => nameKey(item) === nameKey(name))) {
      judgeCandidates.push(name);
    }
  }
  const opinions: MechanicalOpinion[] = structure.bindings.map((binding) => ({
    role: runnerRole(binding.role),
    from: binding.from,
    to: binding.to,
    excerpt: binding.excerpt,
  }));
  return {
    judgeCandidates,
    opinions,
    header: header.slice(0, 8_000),
    status: structure.status,
  };
}

function mechanicalReference(record: CaseRecord): MechanicalReference {
  const partition = partitionOpinionStructure(
    record.structure,
    paragraphNumbers(record.paragraphs),
  );
  const available = paragraphNumbers(record.paragraphs);
  const spans = roleMap();
  for (const [role, ranges] of Object.entries(partition.spans)) {
    const key = role === "separate" ? "unknown" : (role as Role);
    spans[key].push(...ranges);
  }
  for (const role of ROLE_KEYS) {
    spans[role] = compressNumbers(
      spans[role].flatMap((range) => numbersInRange(range, available)),
    );
  }
  return {
    source: "mechanical",
    status: partition.status,
    judges: partition.judges.map(({ name, role }) => ({ name, role: runnerRole(role) })),
    spans,
    note: partition.note,
  };
}

function deterministicPrediction(record: CaseRecord): Prediction | null {
  if (record.deterministic.status !== "ready") return null;
  return {
    opinions: record.deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      authors: opinion.authors,
      alignment: opinion.alignment,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
      start: opinion.start,
      end_exclusive: opinion.end,
      text_sha256: sha256(record.source.text.slice(opinion.start, opinion.end)),
      substantive_words: opinion.substantiveWords,
      paragraphs: compressNumbers(record.paragraphs.flatMap((block) => {
        if (block.end <= opinion.start || block.start >= opinion.end) return [];
        const match = /^par(\d+)$/iu.exec(block.label);
        return match ? [Number(match[1])] : [];
      })),
    })),
    judges: record.deterministic.judges.map((judge) => ({
      name: judge.name,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.opinionIds,
    })),
  };
}

function paragraphIndex(paragraphs: SourceDocBlock[]) {
  return compressNumbers(paragraphNumbers(paragraphs))
    .map(({ from, to }) => (from === to ? `par${from}` : `par${from}-par${to}`))
    .join(", ");
}

function packet(record: CaseRecord, includeBody = false, packetChars = 24_000) {
  const header = record.hints.header.slice(0, Math.max(1, packetChars));
  const hintLines = record.hints.opinions.map((opinion) => ({
    role: opinion.role,
    range: opinion.from !== null && opinion.to !== null ? [opinion.from, opinion.to] : null,
    source_excerpt: opinion.excerpt,
  }));
  const body = includeBody
    ? record.document.text.slice(0, Math.max(1, packetChars))
    : null;
  return [
    "[CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[SOURCE PARAGRAPH INDEX]",
    paragraphIndex(record.paragraphs),
    "[SOURCE HEADER]",
    header,
    "[DETERMINISTIC SEARCH PREFLIGHT — HINTS ONLY]",
    json(record.preflight),
    "[DETERMINISTIC HEADER OBSERVATIONS — VERIFY AGAINST SOURCE]",
    json({
      judge_candidates: record.hints.judgeCandidates,
      opinion_headers: hintLines,
      body_markers: record.structure.bodyMarkers.slice(0, 60).map((marker) => ({
        paragraph: marker.paragraph,
        kind: marker.kind,
        name: marker.name,
        role: marker.role === "separate" ? "unknown" : marker.role,
        line: marker.line,
      })),
    }),
    ...(body ? ["[SOURCE TEXT PREFIX]", body] : []),
    "[TASK]",
    "Identify substantive opinion bodies and judge voting relationships. Read exact paragraphs with a2aj_lookup when available before submitting.",
  ].join("\n\n");
}

function codexPacket(record: CaseRecord) {
  return [
    CODEX_SYSTEM_PROMPT,
    "[CASE]",
    json({
      document_id: record.candidate.documentId,
      dataset: record.candidate.dataset,
      citation: record.candidate.citation,
      name: record.candidate.name,
      date: record.candidate.date,
      source_sha256: record.sourceSha256,
    }),
    "[SOURCE STRUCTURE]",
    json({
      paragraph_index: paragraphIndex(record.paragraphs) || null,
      paragraph_structure_available: record.paragraphs.length > 0,
    }),
    "[DETERMINISTIC TERM-SEARCH PREFLIGHT — HINTS ONLY]",
    json(record.preflight),
    "[SOURCE TEXT]",
    record.source.text,
  ].join("\n\n");
}

function exactQuoteSpans(text: string, quote: string, limit = 3) {
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (spans.length < limit) {
    const start = text.indexOf(quote, cursor);
    if (start < 0) break;
    spans.push({ start, end: start + quote.length });
    cursor = start + Math.max(1, quote.length);
  }
  return spans;
}

function groundedQuoteSpans(text: string, quote: string, limit = 3) {
  const exact = exactQuoteSpans(text, quote, limit);
  if (exact.length) return exact;
  const wanted = sourceDocQuoteWords(quote);
  if (wanted.length < 4) return [];
  const source = tokenizeSourceText(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index + wanted.length <= source.length && spans.length < limit; index += 1) {
    if (source[index].word !== wanted[0]) continue;
    let matches = true;
    for (let offset = 1; offset < wanted.length; offset += 1) {
      if (source[index + offset].word === wanted[offset]) continue;
      matches = false;
      break;
    }
    if (!matches) continue;
    let start = source[index].start;
    let end = source[index + wanted.length - 1].end;
    if (/^\s*\[\s*\d+\s*\]/u.test(quote)) {
      const bracket = text.lastIndexOf("[", start);
      const close = text.indexOf("]", start);
      if (bracket >= Math.max(0, start - 12) && close >= source[index].end && close - start <= 12) {
        start = bracket;
      }
    }
    if (/[.!?…]["'”’\])}]*\s*$/u.test(quote)) {
      while (end < text.length && /[.!?…"'”’\])}]/u.test(text[end])) end += 1;
    }
    spans.push({ start, end });
  }
  return spans;
}

function preferredGroundedSpans(
  text: string,
  firstParagraphStart: number | null,
  spans: Array<{ start: number; end: number }>,
  edge: "start" | "end",
  opinionCount: number,
) {
  if (spans.length <= 1) return spans;
  const marker = text.toLocaleLowerCase().lastIndexOf("decision content");
  const inBody = marker >= 0 ? spans.filter((span) => span.start > marker) : spans;
  const candidates = inBody.length ? inBody : spans;
  if (candidates.length <= 1 || opinionCount !== 1) return candidates;
  if (edge === "end") return [candidates.at(-1)!];
  if (firstParagraphStart !== null) {
    const beforeFirstParagraph = candidates.filter((span) => span.start <= firstParagraphStart);
    if (beforeFirstParagraph.length) return [beforeFirstParagraph.at(-1)!];
  }
  return [candidates[0]];
}

function expandedBoundaryQuote(
  text: string,
  span: { start: number; end: number },
  edge: "start" | "end",
  targetWords = 12,
) {
  if (edge === "start") {
    const suffix = text.slice(span.start);
    const matches = [...suffix.matchAll(WORD_RE)];
    const last = matches[Math.min(targetWords, matches.length) - 1];
    return last ? suffix.slice(0, last.index! + last[0].length).trimEnd() : text.slice(span.start, span.end);
  }
  const prefix = text.slice(0, span.end);
  const matches = [...prefix.matchAll(WORD_RE)];
  const first = matches[Math.max(0, matches.length - targetWords)];
  return first ? prefix.slice(first.index!).trimStart() : text.slice(span.start, span.end);
}

function normalizedOpinionAlignment(
  alignment: OpinionAlignment | null,
  opinionCount: number,
): OpinionAlignment | null {
  return alignment && opinionCount === 1 ? "lead" : alignment;
}

function validatePrediction(record: CaseRecord, raw: unknown): { prediction: Prediction | null; validation: Validation } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { prediction: null, validation: { ok: false, error: "extraction must be an object", next: "Submit opinions and judges." } };
  }
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  const candidates = [
    ...record.deterministic.panel,
    ...record.deterministic.judges.map((judge) => judge.name),
    ...record.hints.judgeCandidates,
  ];
  const canonicalName = (name: string) =>
    candidates.find((candidate) => nameKey(candidate) === nameKey(name)) ?? name;
  const paragraphsFor = (start: number, end: number) => compressNumbers(
    record.paragraphs.flatMap((block) => {
      if (block.end <= start || block.start >= end) return [];
      const match = /^par(\d+)$/iu.exec(block.label);
      return match ? [Number(match[1])] : [];
    }),
  );
  const rawOpinions = Array.isArray(value.opinions) ? value.opinions : [];
  if (!rawOpinions.length) errors.push("opinions must contain each substantive opinion body");
  const opinions: Prediction["opinions"] = [];
  const opinionIds = new Set<string>();
  for (const item of rawOpinions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each opinion must be an object");
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const alignment = OPINION_ALIGNMENTS.includes(row.alignment as OpinionAlignment)
      ? row.alignment as OpinionAlignment
      : null;
    const normalizedAlignment = normalizedOpinionAlignment(alignment, rawOpinions.length);
    const startQuote = typeof row.start_quote === "string" ? row.start_quote.trim() : "";
    const endQuote = typeof row.end_quote === "string" ? row.end_quote.trim() : "";
    const authors = Array.isArray(row.authors)
      ? row.authors.flatMap((author) => typeof author === "string" && author.trim() ? [canonicalName(author.trim())] : [])
      : [];
    if (!/^o[1-9]\d*$/u.test(id) || opinionIds.has(id)) errors.push(`duplicate or invalid opinion id: ${id || "(empty)"}`);
    else opinionIds.add(id);
    if (!alignment) errors.push(`${id || "opinion"} has an invalid alignment`);
    if (!authors.length) errors.push(`${id || "opinion"} must name its author or authors`);
    for (const author of authors) {
      if (!sourceNameMatches(record.source.text, author)) errors.push(`${id || "opinion"} author not found in source: ${author}`);
    }
    const startWords = sourceDocQuoteWords(startQuote);
    const endWords = sourceDocQuoteWords(endQuote);
    if (!startWords.length || !endWords.length) {
      errors.push(`${id || "opinion"} boundary quotes must contain source words`);
      continue;
    }
    const firstParagraphStart = record.paragraphs[0]?.start ?? null;
    const starts = preferredGroundedSpans(
      record.source.text,
      firstParagraphStart,
      groundedQuoteSpans(record.source.text, startQuote, 10),
      "start",
      rawOpinions.length,
    );
    const ends = preferredGroundedSpans(
      record.source.text,
      firstParagraphStart,
      groundedQuoteSpans(record.source.text, endQuote, 10),
      "end",
      rawOpinions.length,
    );
    if (starts.length !== 1) errors.push(`${id || "opinion"} start_quote resolves ${starts.length} times; provide a unique exact quote`);
    if (ends.length !== 1) errors.push(`${id || "opinion"} end_quote resolves ${ends.length} times; provide a unique exact quote`);
    if (starts.length !== 1 || ends.length !== 1) continue;
    const start = starts[0].start;
    const end = ends[0].end;
    if (end <= start) {
      errors.push(`${id || "opinion"} end_quote precedes its start_quote`);
      continue;
    }
    const body = record.source.text.slice(start, end);
    const substantiveWords = words(body).length;
    if (substantiveWords < MIN_OPINION_WORDS) {
      errors.push(`${id || "opinion"} has only ${substantiveWords} substantive words; a signature, joinder, or disposition line is not an opinion`);
      continue;
    }
    opinions.push({
      id,
      authors: [...new Map(authors.map((author) => [nameKey(author), author])).values()],
      alignment: normalizedAlignment ?? "unknown",
      start_quote: startWords.length < 4
        ? expandedBoundaryQuote(record.source.text, starts[0], "start")
        : record.source.text.slice(starts[0].start, starts[0].end),
      end_quote: endWords.length < 4
        ? expandedBoundaryQuote(record.source.text, ends[0], "end")
        : record.source.text.slice(ends[0].start, ends[0].end),
      start,
      end_exclusive: end,
      text_sha256: sha256(body),
      substantive_words: substantiveWords,
      paragraphs: paragraphsFor(start, end),
    });
  }
  const ordered = [...opinions].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end_exclusive) {
      errors.push(`opinion boundaries overlap: ${ordered[index - 1].id} and ${ordered[index].id}`);
    }
  }
  if (opinions.length && !opinions.some((opinion) => opinion.alignment === "lead")) {
    errors.push("at least one opinion must be the lead reasons for the prevailing disposition");
  }

  const rawJudges = Array.isArray(value.judges) ? value.judges : [];
  if (!rawJudges.length) errors.push("judges must list every panel member");
  const judges: Prediction["judges"] = [];
  const seenJudges = new Set<string>();
  for (const item of rawJudges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each judge must be an object");
      continue;
    }
    const row = item as Record<string, unknown>;
    const submittedName = typeof row.name === "string" ? row.name.trim() : "";
    const name = canonicalName(submittedName);
    const key = nameKey(name);
    const resultSide = RESULT_SIDES.includes(row.result_side as JudgeResultSide)
      ? row.result_side as JudgeResultSide
      : null;
    const relationship = RELATIONSHIPS.includes(row.relationship as JudgeOpinionRelationship)
      ? row.relationship as JudgeOpinionRelationship
      : null;
    const ids = Array.isArray(row.opinion_ids)
      ? [...new Set(row.opinion_ids.flatMap((id) => typeof id === "string" ? [id] : []))]
      : [];
    if (!key || seenJudges.has(key)) errors.push(`duplicate or empty judge: ${submittedName || "(empty)"}`);
    else seenJudges.add(key);
    if (!sourceNameMatches(record.source.text, submittedName)) errors.push(`judge name not found in source: ${submittedName}`);
    if (!resultSide) errors.push(`${submittedName || "judge"} has an invalid result_side`);
    if (!relationship) errors.push(`${submittedName || "judge"} has an invalid relationship`);
    for (const id of ids) if (!opinionIds.has(id)) errors.push(`${submittedName || "judge"} refers to missing opinion ${id}`);
    if (relationship !== "unknown" && !ids.length) errors.push(`${submittedName || "judge"} must identify the authored or joined opinion`);
    const related = opinions.filter((opinion) => ids.includes(opinion.id));
    const authored = related.filter((opinion) => opinion.authors.some((author) => nameKey(author) === key));
    if (relationship === "authors" && !authored.length) errors.push(`${submittedName || "judge"} is marked authors but is not an opinion author`);
    const expected = new Set(related.map((opinion) =>
      opinion.alignment === "different_result"
        ? "minority"
        : opinion.alignment === "mixed"
          ? "mixed"
          : opinion.alignment === "unknown"
            ? "unknown"
            : "majority",
    ));
    const derivedSide: JudgeResultSide = expected.size === 1
      ? [...expected][0] as JudgeResultSide
      : expected.size > 1
        ? "mixed"
        : resultSide ?? "unknown";
    if (resultSide && resultSide !== "unknown" && derivedSide !== "unknown" && resultSide !== derivedSide) {
      errors.push(`${submittedName || "judge"} result_side=${resultSide} conflicts with the referenced opinion alignment`);
    }
    judges.push({
      name,
      result_side: resultSide === "unknown" && derivedSide !== "unknown" ? derivedSide : resultSide ?? "unknown",
      relationship: relationship ?? "unknown",
      opinion_ids: ids,
    });
  }
  for (const opinion of opinions) {
    for (const author of opinion.authors) {
      const judge = judges.find((candidate) => nameKey(candidate.name) === nameKey(author));
      if (!judge || judge.relationship !== "authors" || !judge.opinion_ids.includes(opinion.id)) {
        errors.push(`${opinion.id} author ${author} must have an authors voting record referencing that opinion`);
      }
    }
  }
  for (const panelMember of record.deterministic.panel) {
    if (!judges.some((judge) => nameKey(judge.name) === nameKey(panelMember))) {
      errors.push(`panel member missing from judges: ${panelMember}`);
    }
  }
  if (errors.length) {
    return {
      prediction: null,
      validation: {
        ok: false,
        error: "opinion_extraction_invalid",
        errors,
        next: "Correct only the named errors and resubmit exact source-grounded opinions and voting relationships.",
      },
    };
  }
  return { prediction: { opinions: ordered, judges }, validation: { ok: true } };
}

function extractToolCall(message: Record<string, unknown>) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const first = calls[0];
  if (!first || typeof first !== "object") return null;
  const fn = (first as Record<string, unknown>).function;
  if (!fn || typeof fn !== "object") return null;
  const row = fn as Record<string, unknown>;
  let args: unknown = row.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = { _invalid_json: args }; }
  }
  return { name: String(row.name ?? ""), args };
}

function assistantMessage(message: Record<string, unknown>) {
  return {
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
  };
}

async function ollamaChat(args: {
  baseUrl: string;
  hostHeader?: string;
  model: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  messages: Array<Record<string, unknown>>;
}) {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${args.baseUrl.replace(/\/$/u, "")}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.hostHeader ? { host: args.hostHeader } : {}),
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        tools: [LOOKUP_TOOL, SUBMIT_TOOL],
        stream: false,
        think: false,
        options: {
          temperature: args.temperature,
          num_ctx: args.numCtx,
          num_predict: args.numPredict,
        },
      }),
      signal: AbortSignal.timeout(900_000),
    });
  } catch (error) {
    throw new Error(`Ollama request failed: ${errorMessage(error)}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${json(body)}`);
  const payload = body as Record<string, unknown>;
  return {
    message: (payload.message && typeof payload.message === "object" ? payload.message : {}) as Record<string, unknown>,
    usage: {
      prompt_eval_count: payload.prompt_eval_count ?? null,
      eval_count: payload.eval_count ?? null,
      total_duration: payload.total_duration ?? null,
      wall_seconds: Math.round((performance.now() - started) / 10) / 100,
    },
  };
}

function compactLookupResult(execution: Awaited<ReturnType<typeof executeA2AJTool>>) {
  if (!execution) return { ok: false, error: "lookup tool unavailable" };
  const lookup = execution.lookup;
  if (!lookup) return execution.payload;
  return {
    ok: lookup.status === "found",
    citation: lookup.citation,
    requested: lookup.requested,
    matches: lookup.matches,
    structure: lookup.structure,
    evidence_id: execution.evidence?.evidence_id ?? null,
    block: lookup.block
      ? {
          kind: lookup.block.kind,
          label: lookup.block.label,
          start: lookup.block.start,
          end: lookup.block.end,
          text: lookup.block.text,
        }
      : null,
    error: lookup.status === "found" ? undefined : `lookup ${lookup.status}`,
  };
}

async function lookupForModel(record: CaseRecord, args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "lookup arguments must be an object" };
  const value = args as Record<string, unknown>;
  const citation = String(value.citation ?? "").trim();
  if (citation.toLocaleLowerCase() !== record.candidate.citation.toLocaleLowerCase()) {
    return { ok: false, error: "selected case is the only readable source" };
  }
  if (value.doc_type && value.doc_type !== "cases") return { ok: false, error: "only case paragraphs are available" };
  if (value.locator_type && value.locator_type !== "paragraph") return { ok: false, error: "use paragraph locators" };
  const start = paragraphNumber(value.locator);
  const endValue = value.end_locator === undefined ? start : paragraphNumber(value.end_locator);
  const available = paragraphNumbers(record.paragraphs);
  const selected = numbersInRange({ from: start, to: endValue }, available);
  if (!selected.length || selected[0] !== start || selected.at(-1) !== endValue) {
    return {
      ok: false,
      error: "paragraph locator not in source index",
      valid_paragraphs: paragraphIndex(record.paragraphs),
      next: "Use one exact paragraph number or an inclusive range from the valid paragraph index.",
    };
  }
  if (selected.length > MAX_LOOKUP_PARAGRAPHS) {
    return {
      ok: false,
      error: `read at most ${MAX_LOOKUP_PARAGRAPHS} paragraphs per lookup`,
      valid_paragraphs: paragraphIndex(record.paragraphs),
      next: `Split the range into blocks of at most ${MAX_LOOKUP_PARAGRAPHS} paragraphs.`,
    };
  }
  const execution = await executeA2AJTool("a2aj_lookup", {
    citation: record.candidate.citation,
    doc_type: "cases",
    locator_type: "paragraph",
    locator: String(start),
    ...(endValue !== start ? { end_locator: String(endValue) } : {}),
    context_blocks: 0,
  });
  return compactLookupResult(execution);
}

function paragraphNumber(value: unknown) {
  const raw = String(value ?? "").trim();
  const match = /^(?:par(?:agraph)?[\s#:-]*)?(\d+)$/iu.exec(raw);
  return match ? Number(match[1]) : Number.NaN;
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function codexInvocation() {
  const override = process.env.CODEX_CMD?.trim();
  if (override) return { command: override, prefix: [] as string[], shell: /\.cmd$/iu.test(override) };
  const script = path.join(process.env.APPDATA || "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (existsSync(script)) return { command: process.execPath, prefix: [script], shell: false };
  return { command: process.platform === "win32" ? "codex.cmd" : "codex", prefix: [] as string[], shell: process.platform === "win32" };
}

function codexVersion() {
  const invocation = codexInvocation();
  const result = spawnSync(invocation.command, [...invocation.prefix, "--version"], {
    encoding: "utf8",
    shell: invocation.shell,
  });
  return result.status === 0 ? `${result.stdout ?? ""}`.trim() : null;
}

function codexEvents(output: string) {
  const events = output.split(/\r?\n/u).flatMap((line) => {
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const started = events.find((event) => event.type === "thread.started");
  const completed = [...events].reverse().find((event) => event.type === "turn.completed");
  return {
    event_count: events.length,
    thread_id: typeof started?.thread_id === "string" ? started.thread_id : null,
    usage: completed?.usage && typeof completed.usage === "object" ? completed.usage : null,
  };
}

type AsyncCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  error: Error | null;
};

function spawnCodex(
  invocation: ReturnType<typeof codexInvocation>,
  args: string[],
  input: string,
  timeoutMs: number,
): Promise<AsyncCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let timer: ReturnType<typeof setTimeout>;
    const child = spawn(invocation.command, [...invocation.prefix, ...args], {
      shell: invocation.shell,
      windowsHide: true,
    });

    const finish = (status: number | null, error: Error | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const finalError = error
        ?? (timedOut ? new Error(`Codex exec timed out after ${timeoutMs / 1_000}s`) : null)
        ?? (outputTooLarge ? new Error(`Codex exec output exceeded ${MAX_CODEX_OUTPUT_BYTES} bytes`) : null);
      resolve({ stdout, stderr, status, error: finalError });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_CODEX_OUTPUT_BYTES && !outputTooLarge) {
        outputTooLarge = true;
        child.kill();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_CODEX_OUTPUT_BYTES) {
        stderr = stderr.slice(-MAX_CODEX_OUTPUT_BYTES);
      }
    });
    child.once("error", (error) => finish(null, error));
    child.once("close", (status) => finish(status));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      child.stdin?.end(input, "utf8");
    } catch (error) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function runLuna(prompt: string, model: string, effort: string, timeoutSeconds: number) {
  if (!/^[\w.:-]+$/u.test(model)) throw new Error(`invalid Codex model: ${model}`);
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`invalid Codex effort: ${effort}`);
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "beaver-a2aj-codex-"));
  const schemaPath = path.join(temp, "roster.schema.json");
  const answerPath = path.join(temp, "answer.json");
  await writeFile(schemaPath, JSON.stringify(SUBMIT_TOOL.function.parameters), "utf8");
  const invocation = codexInvocation();
  const cliArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--json",
    "-C",
    temp,
    "-m",
    model,
    "-c",
    `model_reasoning_effort="${effort}"`,
    "--output-schema",
    schemaPath,
    "-o",
    answerPath,
    "-",
  ];
  const started = performance.now();
  try {
    const result = await spawnCodex(
      invocation,
      cliArgs,
      prompt,
      Math.max(1, timeoutSeconds) * 1_000,
    );
    const stdout = result.stdout;
    const answer = existsSync(answerPath) ? await readFile(answerPath, "utf8") : "";
    return {
      raw: answer,
      parsed: extractJsonObject(answer),
      stderr: result.stderr.slice(-4_000),
      returnCode: result.status,
      error: result.error ? errorMessage(result.error) : null,
      elapsedSeconds: Math.round((performance.now() - started) / 10) / 100,
      promptSha256: sha256(prompt),
      promptChars: prompt.length,
      outputSha256: answer ? sha256(answer) : null,
      stdoutSha256: stdout ? sha256(stdout) : null,
      ...codexEvents(stdout),
      cli: {
        model,
        effort,
        ephemeral: true,
        ignore_user_config: true,
        sandbox: "read-only",
        output_schema: RESPONSE_SCHEMA_NAME,
        response_format: GPT_RESPONSES_SCHEMA,
      },
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function hydratePrediction(record: CaseRecord, prediction: Prediction) {
  return prediction.opinions.map((opinion) => ({
    opinion_id: opinion.id,
    alignment: opinion.alignment,
    start: opinion.start,
    end_exclusive: opinion.end_exclusive,
    text_sha256: opinion.text_sha256,
    source_sha256: record.sourceSha256,
    source_evidence_id: record.sourceEvidence.evidence_id,
    paragraphs: opinion.paragraphs,
  }));
}

function predictionSpans(prediction: Prediction) {
  const spans = roleMap();
  for (const opinion of prediction.opinions) {
    const role: Role = opinion.alignment === "lead"
      ? "majority"
      : opinion.alignment === "different_result"
        ? "minority"
        : opinion.alignment === "same_result_separate_reasons"
          ? "concurring"
          : "unknown";
    spans[role].push(...opinion.paragraphs);
  }
  for (const role of ROLE_KEYS) {
    spans[role] = compressNumbers(spans[role].flatMap((range) => {
      const numbers: number[] = [];
      for (let number = range.from; number <= range.to; number += 1) numbers.push(number);
      return numbers;
    }));
  }
  return spans;
}

function score(prediction: Prediction, reference: Reference | null, available: number[]) {
  if (!reference || reference.status !== "ready") return { reference: null };
  if (reference.source === "human") {
    return {
      reference: "human",
      opinion_exact: JSON.stringify(prediction.opinions) === JSON.stringify(reference.prediction.opinions),
      judge_exact: JSON.stringify(prediction.judges) === JSON.stringify(reference.prediction.judges),
    };
  }
  const spans = predictionSpans(prediction);
  const exact = ROLE_KEYS.every((role) => JSON.stringify(spans[role]) === JSON.stringify(reference.spans[role]));
  const gold = new Map<number, Role>();
  const predicted = new Map<number, Role>();
  for (const role of ROLE_KEYS) {
    for (const range of reference.spans[role]) for (const number of numbersInRange(range, available)) gold.set(number, role);
    for (const range of spans[role]) for (const number of numbersInRange(range, available)) predicted.set(number, role);
  }
  const matches = available.filter((number) => gold.get(number) === predicted.get(number)).length;
  const predictedJudges = prediction.judges.map((judge) => ({
    name: judge.name,
    role: judge.result_side === "minority"
      ? "minority"
      : judge.relationship === "authors" && judge.opinion_ids.some((id) =>
          prediction.opinions.some((opinion) => opinion.id === id && opinion.alignment === "same_result_separate_reasons"),
        )
        ? "concurring"
        : judge.result_side === "majority"
          ? "majority"
          : "unknown",
  }));
  const judgeExact = reference.judges.length > 0 && JSON.stringify(predictedJudges) === JSON.stringify(reference.judges);
  return {
    reference: reference.source,
    span_exact: exact,
    paragraph_accuracy: available.length ? Math.round((matches / available.length) * 1_000_000) / 1_000_000 : null,
    judge_exact: judgeExact,
  };
}

async function initSidecar(file: string) {
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  database.exec(`
    CREATE TABLE IF NOT EXISTS opinion_run (
      run_id TEXT PRIMARY KEY, created_utc TEXT NOT NULL, seed INTEGER NOT NULL,
      sample_size INTEGER NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, effort TEXT NOT NULL, num_ctx INTEGER NOT NULL,
      num_predict INTEGER NOT NULL, prompt_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opinion_decision (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
      dataset TEXT NOT NULL, citation TEXT NOT NULL, name TEXT, decision_date TEXT,
      structure_status TEXT NOT NULL, paragraph_count INTEGER NOT NULL,
      deterministic_status TEXT NOT NULL,
      result_status TEXT NOT NULL, source_evidence_id TEXT, prediction_json TEXT,
      reference_json TEXT, validation_json TEXT NOT NULL, metrics_json TEXT,
      PRIMARY KEY (run_id, document_id)
    );
    CREATE TABLE IF NOT EXISTS opinion_judge (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      name TEXT NOT NULL, result_side TEXT NOT NULL, relationship TEXT NOT NULL,
      opinion_ids_json TEXT NOT NULL, provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS opinion_text (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, opinion_id TEXT NOT NULL,
      alignment TEXT NOT NULL, authors_json TEXT NOT NULL,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
      start_quote TEXT NOT NULL, end_quote TEXT NOT NULL,
      text_sha256 TEXT NOT NULL, paragraphs_json TEXT NOT NULL,
      source_evidence_id TEXT, provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, opinion_id)
    );
    CREATE TABLE IF NOT EXISTS opinion_reference (
      document_id INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL,
      prediction_json TEXT NOT NULL, created_utc TEXT NOT NULL
    );
  `);
  return database;
}

function saveCase(
  database: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  runId: string,
  record: CaseRecord,
  prediction: Prediction | null,
  evidence: Awaited<ReturnType<typeof hydratePrediction>>,
  reference: Reference,
  validation: Validation,
  metrics: Record<string, unknown>,
  resultStatus: string,
  provenance: string,
) {
  database.prepare("DELETE FROM opinion_judge WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare("DELETE FROM opinion_text WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare(`
    INSERT OR REPLACE INTO opinion_decision
    (run_id,document_id,source_sha256,dataset,citation,name,decision_date,structure_status,paragraph_count,deterministic_status,result_status,source_evidence_id,prediction_json,reference_json,validation_json,metrics_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    runId,
    record.candidate.documentId,
    record.sourceSha256,
    record.candidate.dataset,
    record.candidate.citation,
    record.candidate.name,
    record.candidate.date,
    record.source.status,
    record.paragraphs.length,
    record.deterministic.status,
    resultStatus,
    record.sourceEvidence.evidence_id,
    prediction ? JSON.stringify(prediction) : null,
    JSON.stringify(reference),
    JSON.stringify(validation),
    JSON.stringify(metrics),
  );
  for (const [ordinal, judge] of (prediction?.judges ?? []).entries()) {
    database.prepare("INSERT INTO opinion_judge VALUES (?,?,?,?,?,?,?,?)").run(
      runId,
      record.candidate.documentId,
      ordinal,
      judge.name,
      judge.result_side,
      judge.relationship,
      JSON.stringify(judge.opinion_ids),
      provenance,
    );
  }
  for (const opinion of prediction?.opinions ?? []) {
    const item = evidence.find((candidate) => candidate.opinion_id === opinion.id);
    database.prepare("INSERT INTO opinion_text VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      runId,
      record.candidate.documentId,
      opinion.id,
      opinion.alignment,
      JSON.stringify(opinion.authors),
      opinion.start,
      opinion.end_exclusive,
      opinion.start_quote,
      opinion.end_quote,
      opinion.text_sha256,
      JSON.stringify(opinion.paragraphs),
      item?.source_evidence_id ?? record.sourceEvidence.evidence_id,
      provenance,
    );
  }
}

export function candidatePoolIds(scope: string, database: import("node:sqlite").DatabaseSync): number[] {
  const params: string[] = [];
  const filters = [
    "doc_type = 'cases'",
    "unofficial_text_en IS NOT NULL",
    "length(unofficial_text_en) > 0",
    "COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL",
  ];
  if (scope.toLocaleUpperCase() !== "ALL") {
    filters.push("UPPER(dataset) = UPPER(?)");
    params.push(scope);
  }
  const where = filters.join(" AND ");
  return (
    database.prepare(`SELECT id FROM document WHERE ${where} ORDER BY id`).all(...params) as Array<{ id: number }>
  ).map((row) => Number(row.id));
}

function candidatesForIds(database: import("node:sqlite").DatabaseSync, documentIds: number[]): Candidate[] {
  const rows = new Map<number, Record<string, unknown>>();
  for (let index = 0; index < documentIds.length; index += 500) {
    const chunk = documentIds.slice(index, index + 500);
    const marks = chunk.map(() => "?").join(",");
    for (const row of database.prepare(`
      SELECT id, dataset,
        COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) AS citation,
        name_en, document_date_en
      FROM document
      WHERE id IN (${marks}) AND doc_type='cases'
    `).all(...chunk) as Array<Record<string, unknown>>) {
      rows.set(Number(row.id), row);
    }
  }
  const missing = documentIds.filter((id) => !rows.has(id));
  if (missing.length) throw new Error(`A2AJ case document IDs not found: ${missing.join(", ")}`);
  return documentIds.map((documentId) => {
    const row = rows.get(documentId)!;
    return {
      documentId,
      dataset: String(row.dataset ?? ""),
      citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null,
      date: row.document_date_en ? String(row.document_date_en) : null,
    };
  });
}

export function drawOffsets(seed: number, size: number, poolLength: number): number[] {
  const wanted = Math.min(Math.max(1, size), poolLength);
  let state = (seed >>> 0) || 1;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const offsets = new Set<number>();
  while (offsets.size < wanted) offsets.add(Math.floor(next() * poolLength));
  // Set preserves pseudo-random draw order. Do not sort: sorted offsets make
  // partial corpus runs systematically overrepresent early dataset blocks.
  return [...offsets];
}

export function selectedCandidates(
  seed: number,
  size: number,
  scope: string,
  database?: import("node:sqlite").DatabaseSync,
): Candidate[] {
  if (!database) {
    return withReadonlySqlite(
      a2ajLocalBulkPath(),
      (open) => selectedCandidates(seed, size, scope, open),
    ) ?? [];
  }
  const allIds = candidatePoolIds(scope, database);
  if (!allIds.length) throw new Error(`no A2AJ cases found for scope ${scope}`);
  const drawn = drawOffsets(seed, size, allIds.length).map((offset) => allIds[offset]);
  return candidatesForIds(database, drawn);
}

function datasetSeed(seed: number, dataset: string) {
  let value = seed >>> 0;
  for (const character of dataset.toLocaleUpperCase()) {
    value = Math.imul(value ^ character.codePointAt(0)!, 16_777_619) >>> 0;
  }
  return value || 1;
}

function stratifiedCandidates(seed: number, perDataset: number) {
  return withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const eligible = database.prepare(`
      SELECT id, dataset
      FROM document
      WHERE doc_type='cases'
        AND unofficial_text_en IS NOT NULL
        AND length(unofficial_text_en) > 0
        AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL
        AND dataset IS NOT NULL AND dataset <> ''
      ORDER BY id
    `).all() as Array<{ id: number; dataset: string }>;
    const byDataset = new Map<string, number[]>();
    for (const { id, dataset } of eligible) {
      const bucket = byDataset.get(String(dataset)) ?? [];
      bucket.push(Number(id));
      byDataset.set(String(dataset), bucket);
    }
    const buckets = [...byDataset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dataset, ids]) =>
        drawOffsets(datasetSeed(seed, dataset), perDataset, ids.length).map((offset) => ids[offset]),
      );
    const interleavedIds: number[] = [];
    for (let index = 0; buckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of buckets) {
        const documentId = bucket[index];
        if (documentId) interleavedIds.push(documentId);
      }
    }
    return candidatesForIds(database, interleavedIds);
  }) ?? [];
}

export function parseDocumentIds(value: string) {
  const tokens = value.split(/[\s,]+/u).filter(Boolean);
  const ids = tokens.map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("case selectors must contain positive integer A2AJ document IDs");
  }
  return [...new Set(ids)];
}

export function candidatesByDocumentIds(documentIds: number[]) {
  const selected = withReadonlySqlite(a2ajLocalBulkPath(), (database) => candidatesForIds(database, documentIds));
  if (!selected) throw new Error(`A2AJ database not found: ${a2ajLocalBulkPath()}`);
  return selected;
}

async function documentIdsFromFile(file: string) {
  const raw = await readFile(path.resolve(file), "utf8");
  let value = raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    value = Array.isArray(parsed)
      ? parsed.join(",")
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { document_ids?: unknown }).document_ids)
        ? (parsed as { document_ids: unknown[] }).document_ids.join(",")
        : raw;
  } catch { /* newline/comma-delimited text is also accepted */ }
  return parseDocumentIds(value);
}

async function selectedRunCandidates(args: Args, seed: number, sampleSize: number, scope: string) {
  const direct = flag(args, "document-ids", "");
  const caseFile = flag(args, "case-file", "");
  if (direct && caseFile) throw new Error("use either --document-ids or --case-file, not both");
  if (direct) return candidatesByDocumentIds(parseDocumentIds(direct));
  if (caseFile) {
    return candidatesByDocumentIds(await documentIdsFromFile(caseFile));
  }
  return selectedCandidates(seed, sampleSize, scope);
}

export async function loadCase(candidate: Candidate): Promise<CaseRecord | null> {
  const document = fetchLocalA2AJDocument({
    citation: candidate.citation,
    dataset: candidate.dataset,
    docType: "cases",
    language: "en",
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  if (!document) return null;
  return buildCaseRecord(candidate, document);
}

function buildCaseRecord(candidate: Candidate, document: A2AJDocument): CaseRecord {
  const source = getLocalA2AJStructure(document) ?? a2ajLegalSourceProvider.source(document);
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const sourceEvidence = createA2AJDocumentEvidence(document);
  const analysis = analyzeTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const { structure, deterministic } = analysis;
  return {
    candidate,
    document,
    source,
    paragraphs,
    sourceEvidence,
    sourceSha256: sha256(source.text),
    structure,
    deterministic,
    hints: extractMechanicalHints(source, paragraphs, structure),
    preflight: extractPreflight(source, paragraphs),
  };
}

async function humanReference(database: InstanceType<typeof import("node:sqlite").DatabaseSync>, record: CaseRecord) {
  const row = database.prepare("SELECT prediction_json FROM opinion_reference WHERE document_id=? AND source_sha256=?").get(record.candidate.documentId, record.sourceSha256) as Record<string, unknown> | undefined;
  if (!row) return null;
  const prediction = JSON.parse(String(row.prediction_json)) as Prediction;
  return { source: "human", status: "ready", prediction } satisfies HumanReference;
}

async function runCase(args: {
  record: CaseRecord;
  provider: Provider;
  model: string;
  effort: string;
  timeoutSeconds: number;
  baseUrl: string;
  hostHeader?: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  packetChars: number;
  progress: string;
  maxAttempts: number;
  forceLlm: boolean;
  referenceOverride?: Reference | null;
}) {
  const { record } = args;
  const mechanical = mechanicalReference(record);
  const reference = args.referenceOverride ?? mechanical;
  const deterministic = deterministicPrediction(record);
  if (args.provider === "luna" && deterministic && !args.forceLlm) {
    const evidence = await hydratePrediction(record, deterministic);
    return {
      status: "accepted",
      route: "deterministic",
      prediction: deterministic,
      evidence,
      reference,
      validation: { ok: true } satisfies Validation,
      metrics: score(deterministic, reference, paragraphNumbers(record.paragraphs)),
      attempts: [],
    };
  }
  if (args.provider === "dry") {
    await appendJsonl(args.progress, {
      kind: "dry_skip",
      phase: "roster",
      validation: { ok: false, error: "dry_run" },
      mechanical_status: mechanical.status,
      mechanical_note: mechanical.note ?? null,
      deterministic_status: record.deterministic.status,
      deterministic_opinions: record.deterministic.opinions.length,
    });
    return {
      status: "dry",
      route: "dry",
      prediction: null,
      evidence: [],
      reference: mechanical,
      validation: { ok: false, error: "dry_run" },
      metrics: { reference: null },
      attempts: [],
    };
  }
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: packet(record, args.provider === "luna", args.packetChars) },
  ];
  const attempts: Array<Record<string, unknown>> = [];
  let prediction: Prediction | null = null;
  let validation: Validation = { ok: false, error: "no_submission" };
  let teacherRaw: unknown = null;
  let modelReceipt: Record<string, unknown> | null = null;
  if (args.provider === "luna") {
    const prompt = codexPacket(record);
    const teacher = await runLuna(prompt, args.model, args.effort, args.timeoutSeconds);
    teacherRaw = teacher.parsed;
    const result = validatePrediction(record, teacherRaw);
    prediction = result.prediction;
    validation = result.validation;
    modelReceipt = {
      runner: "codex_exec",
      prompt_version: CODEX_PROMPT_VERSION,
      validator_version: VALIDATOR_VERSION,
      prompt_sha256: teacher.promptSha256,
      prompt_chars: teacher.promptChars,
      output_sha256: teacher.outputSha256,
      stdout_sha256: teacher.stdoutSha256,
      return_code: teacher.returnCode,
      error: teacher.error,
      stderr: teacher.stderr,
      elapsed_seconds: teacher.elapsedSeconds,
      event_count: teacher.event_count,
      thread_id: teacher.thread_id,
      usage: teacher.usage,
      cli: teacher.cli,
    };
    attempts.push({ provider: "luna", validation, ...modelReceipt });
    await appendJsonl(args.progress, {
      kind: "model_call",
      document: record.candidate.documentId,
      citation: record.candidate.citation,
      phase: "roster",
      provider: "luna",
      tool_calls: [],
      assistant_text_preview: teacher.raw.slice(-1_200),
      validation,
      ...modelReceipt,
    });
  } else {
    for (let attempt = 1; attempt <= args.maxAttempts; attempt += 1) {
      const response = await ollamaChat({
        baseUrl: args.baseUrl,
        hostHeader: args.hostHeader,
        model: args.model,
        numCtx: args.numCtx,
        numPredict: args.numPredict,
        temperature: args.temperature,
        messages,
      });
      const call = extractToolCall(response.message);
      const assistant = assistantMessage(response.message);
      messages.push(assistant);
      await appendJsonl(args.progress, {
        kind: "model_call",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        provider: "ollama",
        tool_calls: call ? [call.name] : [],
        tool_call: call,
        assistant_text_preview: String(response.message.content ?? "").slice(0, 800),
        assistant_content: String(response.message.content ?? "").slice(0, 4_000),
        thinking_preview: String(response.message.thinking ?? "").slice(0, 4_000),
        message_keys: Object.keys(response.message),
        usage: response.usage,
      });
      if (!call) {
        validation = { ok: false, error: "tool_required", next: "Call submit_roster now. No prose." };
        messages.push({ role: "user", content: JSON.stringify(validation) });
      } else if (call.name === "a2aj_lookup") {
        const result = await lookupForModel(record, call.args);
        messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(result) });
        validation = { ok: false, error: "lookup_completed", next: "Continue reading source, then call submit_roster." };
        await appendJsonl(args.progress, {
          kind: "tool_result",
          document: record.candidate.documentId,
          citation: record.candidate.citation,
          phase: "roster",
          round: attempt,
          tool: call.name,
          tool_args: call.args,
          result_preview: JSON.stringify(result).slice(0, 1_500),
          result_audit: JSON.stringify(result).slice(0, 4_000),
        });
        continue;
      } else if (call.name === "submit_roster") {
        const result = validatePrediction(record, call.args);
        prediction = result.prediction;
        validation = result.validation;
        messages.push({ role: "tool", tool_name: call.name, content: JSON.stringify(validation) });
      } else {
        validation = { ok: false, error: `unknown tool ${call.name}`, next: "Call submit_roster." };
        messages.push({ role: "user", content: JSON.stringify(validation) });
      }
      attempts.push({ attempt, tool: call?.name ?? null, validation });
      await appendJsonl(args.progress, {
        kind: "tool_result",
        document: record.candidate.documentId,
        citation: record.candidate.citation,
        phase: "roster",
        round: attempt,
        tool: call?.name ?? null,
        tool_args: call?.args ?? null,
        result_preview: JSON.stringify(validation).slice(0, 1_500),
        result_audit: JSON.stringify(validation).slice(0, 4_000),
      });
      if (prediction && validation.ok) break;
    }
  }
  const evidence = prediction ? await hydratePrediction(record, prediction) : [];
  const metrics = prediction ? score(prediction, reference, paragraphNumbers(record.paragraphs)) : { reference: null };
  return {
    status: prediction ? "accepted" : "rejected",
    route: args.provider,
    prediction,
    evidence,
    reference,
    validation,
    metrics,
    attempts,
    ...(teacherRaw ? { teacher_raw: teacherRaw } : {}),
    ...(modelReceipt ? { model_receipt: modelReceipt } : {}),
  };
}

async function mapPool<T, R>(
  items: T[],
  workerCount: number,
  fn: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number) => Promise<void>,
) {
  const results = new Array<R>(items.length);
  let next = 0;
  const count = Math.min(Math.max(1, Math.trunc(workerCount)), items.length);
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const result = await fn(items[index], index);
      results[index] = result;
      if (onResult) await onResult(result, index);
    }
  };
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

type LunaCaseConfig = Omit<Parameters<typeof runCase>[0], "record" | "referenceOverride">;
type LunaCaseWork = {
  candidate: Candidate;
  record: CaseRecord | null;
  result: Awaited<ReturnType<typeof runCase>> | null;
  error: string | null;
};

async function dispatchLunaCase(
  candidate: Candidate,
  index: number,
  sampleSize: number,
  config: LunaCaseConfig,
): Promise<LunaCaseWork> {
  console.log(`[${index + 1}/${sampleSize}] ${candidate.citation} (${candidate.documentId})`);
  await appendJsonl(config.progress, {
    kind: "case_started",
    document: candidate.documentId,
    citation: candidate.citation,
    worker_case: 1,
  });
  try {
    const record = await loadCase(candidate);
    if (!record) {
      await appendJsonl(config.progress, {
        kind: "case_finished",
        document: candidate.documentId,
        status: "load_failed",
      });
      console.log("  load_failed");
      return { candidate, record: null, result: null, error: "load_failed" };
    }
    await appendJsonl(config.progress, {
      kind: "case_loaded",
      document: candidate.documentId,
      citation: candidate.citation,
      structure_status: record.source.status,
      paragraph_count: record.paragraphs.length,
      source_sha256: record.sourceSha256,
      deterministic_status: record.deterministic.status,
      deterministic_opinions: record.deterministic.opinions.length,
      needs_llm: record.deterministic.status !== "ready",
      judge_candidates: record.hints.judgeCandidates,
      opinion_candidates: record.hints.opinions.map(({ role, from, to }) => ({ role, from, to })),
      preflight: record.preflight,
    });
    const result = await runCase({ ...config, record, referenceOverride: null });
    await appendJsonl(config.progress, {
      kind: "case_finished",
      document: candidate.documentId,
      status: result.status,
      metrics: result.metrics,
    });
    console.log(`  ${result.status}`);
    return { candidate, record, result, error: null };
  } catch (error) {
    const message = errorMessage(error);
    await appendJsonl(config.progress, {
      kind: "case_failed",
      document: candidate.documentId,
      error: message,
    });
    console.log(`  failed: ${message}`);
    return { candidate, record: null, result: null, error: message };
  }
}

type ReceiptMode = "full" | "compact";

function fullCaseReceipt(
  candidate: Candidate,
  record: CaseRecord,
  result: Awaited<ReturnType<typeof runCase>>,
) {
  return {
    source: {
      document_id: candidate.documentId,
      dataset: candidate.dataset,
      citation: candidate.citation,
      name: candidate.name,
      date: candidate.date,
      source_sha256: record.sourceSha256,
      source_evidence_id: record.sourceEvidence.evidence_id,
    },
    structure: {
      status: record.source.status,
      paragraph_count: record.paragraphs.length,
      paragraph_index: paragraphIndex(record.paragraphs),
      source_chars: record.source.text.length,
    },
    deterministic: record.deterministic,
    mechanical: record.hints,
    preflight: record.preflight,
    ...result,
  };
}

function compactModelReceipt(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const cli = row.cli && typeof row.cli === "object" && !Array.isArray(row.cli)
    ? row.cli as Record<string, unknown>
    : null;
  return {
    runner: row.runner ?? null,
    prompt_version: row.prompt_version ?? null,
    validator_version: row.validator_version ?? null,
    prompt_sha256: row.prompt_sha256 ?? null,
    prompt_chars: row.prompt_chars ?? null,
    output_sha256: row.output_sha256 ?? null,
    stdout_sha256: row.stdout_sha256 ?? null,
    return_code: row.return_code ?? null,
    error: row.error ?? null,
    elapsed_seconds: row.elapsed_seconds ?? null,
    event_count: row.event_count ?? null,
    thread_id: row.thread_id ?? null,
    usage: row.usage ?? null,
    cli: cli ? {
      model: cli.model ?? null,
      effort: cli.effort ?? null,
      ephemeral: cli.ephemeral ?? null,
      ignore_user_config: cli.ignore_user_config ?? null,
      sandbox: cli.sandbox ?? null,
      output_schema: cli.output_schema ?? null,
    } : null,
  };
}

function compactCaseReceipt(
  full: Record<string, unknown>,
) {
  const source = full.source as Record<string, unknown> | undefined;
  const structure = full.structure as Record<string, unknown> | undefined;
  const deterministic = full.deterministic as Record<string, unknown> | undefined;
  return {
    source: source ? {
      document_id: source.document_id ?? null,
      dataset: source.dataset ?? null,
      citation: source.citation ?? null,
      name: source.name ?? null,
      date: source.date ?? null,
      source_sha256: source.source_sha256 ?? null,
      source_evidence_id: source.source_evidence_id ?? null,
    } : null,
    structure: structure ? {
      status: structure.status ?? null,
      paragraph_count: structure.paragraph_count ?? null,
      source_chars: structure.source_chars ?? null,
    } : null,
    deterministic: deterministic ? {
      status: deterministic.status ?? null,
      panel: deterministic.panel ?? [],
      nonparticipants: deterministic.nonparticipants ?? [],
      opinions: deterministic.opinions ?? [],
      judges: deterministic.judges ?? [],
      refusals: deterministic.refusals ?? [],
    } : null,
    status: full.status ?? null,
    route: full.route ?? null,
    prediction: full.prediction ?? null,
    // A rejected compact receipt must retain the exact schema submission;
    // hashes and an unlinked progress preview are not enough to revalidate it.
    rejected_submission: full.status === "rejected" ? full.teacher_raw ?? null : null,
    evidence: full.evidence ?? [],
    reference: full.reference ?? null,
    validation: full.validation ?? null,
    metrics: full.metrics ?? null,
    model_receipt: compactModelReceipt(full.model_receipt),
  };
}

async function readJsonl(file: string, visit: (event: Record<string, unknown>) => void) {
  if (!existsSync(file)) return;
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line) as Record<string, unknown>); } catch { /* resume retries a truncated final line */ }
  }
}

async function readReceiptEvents(file: string, visit: (event: Record<string, unknown>) => void) {
  if (!file.toLocaleLowerCase().endsWith(".json")) {
    await readJsonl(file, visit);
    return;
  }
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const receipts = Array.isArray(value.receipts) ? value.receipts : [];
  receipts.forEach((receipt, index) => {
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return;
    const row = receipt as Record<string, unknown>;
    const source = row.source && typeof row.source === "object" && !Array.isArray(row.source)
      ? row.source as Record<string, unknown>
      : {};
    visit({ kind: "case_receipt", index, document: source.document_id ?? null, receipt: row });
  });
}

async function readReceiptStreamIds(file: string) {
  const ids = new Set<number>();
  await readJsonl(file, (event) => {
    if (event.kind !== "case_receipt") return;
    const receipt = event.receipt as Record<string, unknown> | undefined;
    const source = receipt?.source as Record<string, unknown> | undefined;
    const documentId = Number(source?.document_id ?? event.document);
    if (Number.isSafeInteger(documentId) && documentId > 0) ids.add(documentId);
  });
  return ids;
}

async function run(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : randomInt(0, 2 ** 31 - 1);
  const requestedSampleSize = Math.max(1, parseIntFlag(args, "sample-size", 1));
  const scope = flag(args, "scope", "ALL");
  const provider = flag(args, "provider", "ollama") as Provider;
  if (provider !== "ollama" && provider !== "luna" && provider !== "dry")
    throw new Error("--provider must be ollama, luna, or dry");
  const model = flag(args, "model", provider === "luna" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL);
  const effort = flag(args, "effort", provider === "luna" ? DEFAULT_CODEX_EFFORT : "none");
  const runId = flag(args, "run-id", provider === "dry" ? `a2aj-roster-dry-${seed}` : `a2aj-roster-${provider}-${model.replaceAll(":", "-")}-${seed}`);
  const output = flag(args, "out", path.join(RUN_DIR, `${runId}.json`));
  const progress = output.endsWith(".json")
    ? output.replace(/\.json$/u, ".progress.jsonl")
    : `${output}.progress.jsonl`;
  const receiptStream = output.endsWith(".json")
    ? output.replace(/\.json$/u, ".receipts.jsonl")
    : `${output}.receipts.jsonl`;
  const requestedReceiptMode = flag(args, "receipt-mode", "full").toLocaleLowerCase();
  if (requestedReceiptMode !== "full" && requestedReceiptMode !== "compact") {
    throw new Error("--receipt-mode must be full or compact");
  }
  const receiptMode = requestedReceiptMode as ReceiptMode;
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const forceLlm = args.force === true || String(args.force ?? "").toLocaleLowerCase() === "true";
  const sidecar = flag(args, "sidecar-db", DEFAULT_SIDECAR);
  const numCtx = parseIntFlag(args, "num-ctx", DEFAULT_NUM_CTX);
  const numPredict = parseIntFlag(args, "num-predict", DEFAULT_NUM_PREDICT);
  const packetChars = parseIntFlag(args, "packet-chars", 24_000);
  const temperature = Number(args.temperature ?? 0);
  const baseUrl = flag(args, "base-url", DEFAULT_BASE_URL);
  const hostHeader = flag(args, "host-header", process.env.OLLAMA_HOST_HEADER?.trim() || "");
  const maxAttempts = Math.max(1, parseIntFlag(args, "max-attempts", MAX_ATTEMPTS));
  const timeoutSeconds = Math.max(1, parseIntFlag(args, "timeout-seconds", 900));
  const workers = provider === "luna"
    ? Math.min(10, Math.max(1, parseIntFlag(args, "workers", 8)))
    : 1;
  const selected = await selectedRunCandidates(args, seed, requestedSampleSize, scope);
  const completedIds = resume ? await readReceiptStreamIds(receiptStream) : new Set<number>();
  if (resume && receiptMode !== "compact") {
    throw new Error("--resume requires --receipt-mode compact");
  }
  const candidates = selected.filter((candidate) => !completedIds.has(candidate.documentId));
  const sampleSize = candidates.length;
  const cohortSize = selected.length;
  const cliVersion = provider === "luna" ? codexVersion() : null;
  const selection = flag(args, "document-ids", "")
    ? { kind: "document_ids", value: selected.map((candidate) => candidate.documentId) }
    : flag(args, "case-file", "")
      ? { kind: "case_file", value: path.resolve(flag(args, "case-file", "")), document_ids: selected.map((candidate) => candidate.documentId) }
      : {
          kind: "seeded_sample",
          seed,
          scope,
          requested_sample_size: requestedSampleSize,
          order: "seeded_pseudorandom_draw",
        };
  await mkdir(path.dirname(progress), { recursive: true });
  if (!resume) {
    await writeFile(progress, "", "utf8");
    await writeFile(receiptStream, "", "utf8");
  }
  const database = await initSidecar(sidecar);
  const receipts: unknown[] = [];
  let processedCount = completedIds.size;
  try {
    database.prepare("INSERT OR REPLACE INTO opinion_run VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      runId, now(), seed, cohortSize, scope, provider, model,
      effort, numCtx, numPredict, provider === "luna" ? CODEX_PROMPT_VERSION : PROMPT_VERSION,
    );
    await appendJsonl(progress, {
      kind: "run_started",
      run_id: runId,
      arm: "a2aj_decision_roster",
      provider,
      model,
      effort,
      num_ctx: numCtx,
      sample_size: cohortSize,
      pending_sample_size: sampleSize,
      resumed: resume,
      already_completed: completedIds.size,
      seed,
      scope,
      workers,
      dispatch: provider === "luna" ? "one-case-per-ephemeral-codex-exec" : "serial",
      routing: provider === "luna" && !forceLlm ? "deterministic-ready-local; unresolved-to-luna" : "forced",
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      selection,
      codex_version: cliVersion,
      prompt_version: provider === "luna" ? CODEX_PROMPT_VERSION : PROMPT_VERSION,
      validator_version: VALIDATOR_VERSION,
      deterministic_version: DETERMINISTIC_VERSION,
    });
    if (provider === "luna") {
      const config: LunaCaseConfig = {
        provider,
        model,
        effort,
        timeoutSeconds,
        baseUrl,
        hostHeader,
        numCtx,
        numPredict,
        temperature,
        packetChars,
        progress,
        maxAttempts,
        forceLlm,
      };
      await mapPool(
        candidates,
        workers,
        (candidate, index) => dispatchLunaCase(candidate, index, sampleSize, config),
        async (item, index) => {
          let receipt: Record<string, unknown>;
          if (!item.record || !item.result) {
            receipt = {
              source: {
                document_id: item.candidate.documentId,
                dataset: item.candidate.dataset,
                citation: item.candidate.citation,
                name: item.candidate.name,
                date: item.candidate.date,
              },
              status: item.error ?? "case_failed",
            };
          } else {
            const { candidate, record, result } = item;
            saveCase(database, runId, record, result.prediction, result.evidence, result.reference, result.validation, result.metrics, result.status, result.route ?? provider);
            receipt = fullCaseReceipt(candidate, record, result);
          }
          const persisted = receiptMode === "compact" ? compactCaseReceipt(receipt) : receipt;
          if (receiptMode === "full") receipts[index] = persisted;
          processedCount += 1;
          await appendJsonl(receiptStream, {
            kind: "case_receipt",
            run_id: runId,
            index,
            document: item.candidate.documentId,
            receipt: persisted,
          });
        },
      );
    } else {
      for (const [index, candidate] of candidates.entries()) {
        console.log(`[${index + 1}/${sampleSize}] ${candidate.citation} (${candidate.documentId})`);
        await appendJsonl(progress, { kind: "case_started", document: candidate.documentId, citation: candidate.citation });
        const record = await loadCase(candidate);
        if (!record) {
          receipts.push({ source: candidate, status: "load_failed" });
          console.log(`  load_failed`);
          continue;
        }
        await appendJsonl(progress, {
          kind: "case_loaded",
          document: candidate.documentId,
          citation: candidate.citation,
          structure_status: record.source.status,
          paragraph_count: record.paragraphs.length,
          source_sha256: record.sourceSha256,
          deterministic_status: record.deterministic.status,
          deterministic_opinions: record.deterministic.opinions.length,
          needs_llm: record.deterministic.status !== "ready",
          judge_candidates: record.hints.judgeCandidates,
          opinion_candidates: record.hints.opinions.map(({ role, from, to }) => ({ role, from, to })),
          preflight: record.preflight,
        });
        const result = await runCase({
          record,
          provider,
          model,
          effort,
          timeoutSeconds,
          baseUrl,
          hostHeader,
          numCtx,
          numPredict,
          temperature,
          packetChars,
          progress,
          maxAttempts,
          forceLlm,
          referenceOverride: await humanReference(database, record),
        });
        saveCase(database, runId, record, result.prediction, result.evidence, result.reference, result.validation, result.metrics, result.status, result.route ?? provider);
        const full = fullCaseReceipt(candidate, record, result);
        const persisted = receiptMode === "compact" ? compactCaseReceipt(full) : full;
        receipts.push(persisted);
        processedCount += 1;
        await appendJsonl(receiptStream, {
          kind: "case_receipt",
          run_id: runId,
          index,
          document: candidate.documentId,
          receipt: persisted,
        });
        await appendJsonl(progress, { kind: "case_finished", document: candidate.documentId, status: result.status, metrics: result.metrics });
        console.log(`  ${result.status}`);
      }
    }
    const receipt = {
      run_id: runId,
      created_utc: now(),
      status: "finished",
      seed,
      sample_size: cohortSize,
      processed_cases: processedCount,
      scope,
      provider,
      model,
      effort,
      num_ctx: numCtx,
      num_predict: numPredict,
      workers,
      dispatch: provider === "luna" ? "one-case-per-ephemeral-codex-exec" : "serial",
      routing: provider === "luna" && !forceLlm ? "deterministic-ready-local; unresolved-to-luna" : "forced",
      prompt_version: provider === "luna" ? CODEX_PROMPT_VERSION : PROMPT_VERSION,
      validator_version: VALIDATOR_VERSION,
      deterministic_version: DETERMINISTIC_VERSION,
      response_schema: provider === "luna" ? GPT_RESPONSES_SCHEMA : null,
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      resumed: resume,
      selection,
      codex_version: cliVersion,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts: receiptMode === "compact" ? [] : receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: true, cases: processedCount, output, receipt_stream: receiptStream });
    database.close();
    console.log(`wrote ${output}`);
    console.log(`progress ${progress}`);
    console.log(`sidecar ${sidecar}`);
  } catch (error) {
    const message = errorMessage(error);
    try { database.close(); } catch { /* already closed */ }
    const receipt = {
      run_id: runId,
      created_utc: now(),
      status: "failed",
      error: message,
      seed,
      sample_size: cohortSize,
      processed_cases: processedCount,
      scope,
      provider,
      model,
      effort,
      num_ctx: numCtx,
      num_predict: numPredict,
      workers,
      dispatch: provider === "luna" ? "one-case-per-ephemeral-codex-exec" : "serial",
      routing: provider === "luna" && !forceLlm ? "deterministic-ready-local; unresolved-to-luna" : "forced",
      prompt_version: provider === "luna" ? CODEX_PROMPT_VERSION : PROMPT_VERSION,
      validator_version: VALIDATOR_VERSION,
      deterministic_version: DETERMINISTIC_VERSION,
      response_schema: provider === "luna" ? GPT_RESPONSES_SCHEMA : null,
      receipt_mode: receiptMode,
      receipt_stream: receiptStream,
      resumed: resume,
      selection,
      codex_version: cliVersion,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts: receiptMode === "compact" ? [] : receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: false, error: message, output });
    throw error;
  }
}

type LegacySignals = {
  status: string;
  classes: string[];
  one_paragraph_secondary_ranges: number;
};

function legacySignals(receipt: Record<string, unknown>): LegacySignals {
  const status = String(receipt.status ?? "unknown");
  const prediction = receipt.prediction && typeof receipt.prediction === "object" && !Array.isArray(receipt.prediction)
    ? receipt.prediction as Record<string, unknown>
    : {};
  const judges = Array.isArray(prediction.judges)
    ? prediction.judges.filter((judge): judge is Record<string, unknown> => Boolean(judge) && typeof judge === "object" && !Array.isArray(judge))
    : [];
  const spans = prediction.spans && typeof prediction.spans === "object" && !Array.isArray(prediction.spans)
    ? prediction.spans as Record<string, unknown>
    : {};
  const ranges = (role: string) => Array.isArray(spans[role])
    ? (spans[role] as unknown[]).flatMap((range) => {
        if (Array.isArray(range) && range.length === 2) return [{ from: Number(range[0]), to: Number(range[1]) }];
        if (range && typeof range === "object" && !Array.isArray(range)) {
          const row = range as Record<string, unknown>;
          return [{ from: Number(row.from), to: Number(row.to) }];
        }
        return [];
      }).filter((range) => Number.isInteger(range.from) && Number.isInteger(range.to))
    : [];
  const secondary = [...ranges("minority"), ...ranges("concurring")];
  const secondaryJudge = judges.some((judge) => judge.role === "minority" || judge.role === "concurring");
  const classes: string[] = [];
  if (status === "structure_unavailable") classes.push("paragraph_structure_blocked_model");
  if (judges.length && judges.every((judge) => judge.role === "unknown")) classes.push("all_judges_unknown");
  if (secondaryJudge && !secondary.length) classes.push("secondary_judge_without_secondary_opinion");
  const oneParagraph = secondary.filter((range) => range.from === range.to).length;
  if (oneParagraph) classes.push("one_paragraph_secondary_opinion");
  if (status === "rejected") classes.push("schema_rejected");
  return { status, classes, one_paragraph_secondary_ranges: oneParagraph };
}

function llmReasons(record: CaseRecord) {
  if (record.deterministic.status === "ready") return [];
  const reasons: string[] = [];
  if (!record.deterministic.opinions.length) reasons.push("no_substantive_opinion_boundary");
  if (record.deterministic.opinions.some((opinion) => !opinion.authors.length)) reasons.push("opinion_author_unresolved");
  if (record.deterministic.opinions.some((opinion) => opinion.alignment === "unknown")) reasons.push("opinion_alignment_unresolved");
  if (record.deterministic.judges.some((judge) => judge.resultSide === "unknown")) reasons.push("judge_vote_unresolved");
  if (!record.paragraphs.length) reasons.push("no_paragraph_structure");
  if (!reasons.length) reasons.push("deterministic_evidence_conflict");
  return reasons;
}

type AuditCounts = {
  total: number;
  load_failed: number;
  ready: number;
  unresolved: number;
  unavailable: number;
  needs_llm: number;
  oracle_ready: number;
  oracle_span_exact: number;
  by_dataset: Record<string, AuditBreakdown>;
  legacy_classes: Record<string, number>;
  legacy_class_routing: Record<string, AuditBreakdown>;
  llm_reasons: Record<string, number>;
  receipt_cases: number;
  receipt_accepted: number;
  receipt_source_hash_match: number;
  receipt_oracle_ready: number;
  receipt_oracle_text_exact: number;
  receipt_oracle_paragraph_exact: number;
  receipt_oracle_judges_exact: number;
};

type AuditBreakdown = {
  total: number;
  load_failed: number;
  ready: number;
  unresolved: number;
  unavailable: number;
  needs_llm: number;
};

function emptyAuditBreakdown(): AuditBreakdown {
  return { total: 0, load_failed: 0, ready: 0, unresolved: 0, unavailable: 0, needs_llm: 0 };
}

function emptyAuditCounts(): AuditCounts {
  return {
    total: 0,
    load_failed: 0,
    ready: 0,
    unresolved: 0,
    unavailable: 0,
    needs_llm: 0,
    oracle_ready: 0,
    oracle_span_exact: 0,
    by_dataset: {},
    legacy_classes: {},
    legacy_class_routing: {},
    llm_reasons: {},
    receipt_cases: 0,
    receipt_accepted: 0,
    receipt_source_hash_match: 0,
    receipt_oracle_ready: 0,
    receipt_oracle_text_exact: 0,
    receipt_oracle_paragraph_exact: 0,
    receipt_oracle_judges_exact: 0,
  };
}

function countBreakdown(target: AuditBreakdown, status: string, needsLlm: boolean) {
  target.total += 1;
  if (status === "load_failed") target.load_failed += 1;
  else if (status === "ready" || status === "unresolved" || status === "unavailable") target[status] += 1;
  if (needsLlm) target.needs_llm += 1;
}

function countAudit(counts: AuditCounts, receipt: Record<string, unknown>) {
  counts.total += 1;
  const source = receipt.source && typeof receipt.source === "object" ? receipt.source as Record<string, unknown> : {};
  const dataset = String(source.dataset ?? "unknown");
  const datasetCounts = counts.by_dataset[dataset] ?? emptyAuditBreakdown();
  counts.by_dataset[dataset] = datasetCounts;
  if (receipt.status === "load_failed") {
    counts.load_failed += 1;
    countBreakdown(datasetCounts, "load_failed", false);
    return;
  }
  const deterministic = receipt.deterministic && typeof receipt.deterministic === "object"
    ? receipt.deterministic as Record<string, unknown>
    : {};
  const status = String(deterministic.status ?? "unavailable") as "ready" | "unresolved" | "unavailable";
  if (status in counts) counts[status] += 1;
  const routing = receipt.routing && typeof receipt.routing === "object" ? receipt.routing as Record<string, unknown> : {};
  const needsLlm = routing.needs_llm === true;
  if (needsLlm) counts.needs_llm += 1;
  countBreakdown(datasetCounts, status, needsLlm);
  for (const reason of Array.isArray(routing.reasons) ? routing.reasons : []) {
    const key = String(reason);
    counts.llm_reasons[key] = (counts.llm_reasons[key] ?? 0) + 1;
  }
  const legacy = receipt.legacy && typeof receipt.legacy === "object" ? receipt.legacy as Record<string, unknown> : {};
  for (const name of Array.isArray(legacy.classes) ? legacy.classes : []) {
    const key = String(name);
    counts.legacy_classes[key] = (counts.legacy_classes[key] ?? 0) + 1;
    const classCounts = counts.legacy_class_routing[key] ?? emptyAuditBreakdown();
    counts.legacy_class_routing[key] = classCounts;
    countBreakdown(classCounts, status, needsLlm);
  }
  const oracle = receipt.oracle && typeof receipt.oracle === "object" ? receipt.oracle as Record<string, unknown> : {};
  if (oracle.status === "ready") counts.oracle_ready += 1;
  if (oracle.span_exact === true) counts.oracle_span_exact += 1;
  const comparison = receipt.receipt_comparison && typeof receipt.receipt_comparison === "object"
    ? receipt.receipt_comparison as Record<string, unknown>
    : null;
  if (comparison) {
    counts.receipt_cases += 1;
    if (comparison.receipt_status === "accepted") counts.receipt_accepted += 1;
    if (comparison.source_hash_match === true) counts.receipt_source_hash_match += 1;
    if (comparison.oracle_ready === true) counts.receipt_oracle_ready += 1;
    if (comparison.text_exact === true) counts.receipt_oracle_text_exact += 1;
    if (comparison.paragraph_exact === true) counts.receipt_oracle_paragraph_exact += 1;
    if (comparison.judges_exact === true) counts.receipt_oracle_judges_exact += 1;
  }
}

function opinionBoundaryKeys(prediction: Record<string, unknown> | null) {
  if (!prediction || !Array.isArray(prediction.opinions)) return null;
  const keys: string[] = [];
  for (const raw of prediction.opinions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const opinion = raw as Record<string, unknown>;
    const start = Number(opinion.start);
    const end = Number(opinion.end_exclusive);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    keys.push(`${start}|${end}|${String(opinion.alignment ?? "unknown")}|${String(opinion.text_sha256 ?? "")}`);
  }
  return keys.sort();
}

function judgeVoteKeys(prediction: Record<string, unknown> | null) {
  if (!prediction || !Array.isArray(prediction.judges)) return null;
  return prediction.judges.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const judge = raw as Record<string, unknown>;
    const ids = Array.isArray(judge.opinion_ids) ? judge.opinion_ids.map(String).sort() : [];
    return [`${nameKey(String(judge.name ?? ""))}|${String(judge.result_side ?? judge.role ?? "unknown")}|${String(judge.relationship ?? "unknown")}|${ids.join(",")}`];
  }).sort();
}

function frozenReceiptComparison(
  record: CaseRecord,
  frozen: Record<string, unknown> | undefined,
  oraclePrediction: Prediction | null,
) {
  if (!frozen) return null;
  const frozenSource = frozen.source && typeof frozen.source === "object" && !Array.isArray(frozen.source)
    ? frozen.source as Record<string, unknown>
    : {};
  const modelPrediction = predictionFromReceipt(frozen);
  const oracleRecord = oraclePrediction as unknown as Record<string, unknown> | null;
  const modelBoundaries = opinionBoundaryKeys(modelPrediction);
  const oracleBoundaries = opinionBoundaryKeys(oracleRecord);
  const available = paragraphNumbers(record.paragraphs);
  const modelRoles = predictionRoleMap(modelPrediction, available);
  const oracleRoles = predictionRoleMap(oracleRecord, available);
  const modelJudges = judgeVoteKeys(modelPrediction);
  const oracleJudges = judgeVoteKeys(oracleRecord);
  return {
    receipt_status: String(frozen.status ?? "unknown"),
    source_hash_match: typeof frozenSource.source_sha256 === "string"
      ? frozenSource.source_sha256 === record.sourceSha256
      : null,
    oracle_ready: Boolean(oraclePrediction),
    text_exact: modelBoundaries && oracleBoundaries
      ? JSON.stringify(modelBoundaries) === JSON.stringify(oracleBoundaries)
      : null,
    paragraph_exact: modelPrediction && oraclePrediction && available.length
      ? available.every((number) => modelRoles.get(number) === oracleRoles.get(number))
      : null,
    judges_exact: modelJudges && oracleJudges
      ? JSON.stringify(modelJudges) === JSON.stringify(oracleJudges)
      : null,
  };
}

async function deterministicAudit(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : 1;
  const scope = flag(args, "scope", "ALL");
  const receiptInput = flag(args, "receipt-stream", "");
  const all = args.all === true || String(args.all ?? "").toLocaleLowerCase() === "true";
  const perDataset = Math.max(0, parseIntFlag(args, "per-dataset", 0));
  const requested = Math.max(1, parseIntFlag(args, "sample-size", 30_000));
  const output = path.resolve(flag(args, "out", path.join(RUN_DIR, `deterministic-audit-${scope.toLocaleLowerCase()}-${seed}.json`)));
  const resultsFile = output.replace(/\.json$/u, ".results.jsonl");
  const progressFile = output.replace(/\.json$/u, ".progress.jsonl");
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const workers = Math.min(10, Math.max(1, parseIntFlag(args, "workers", 10)));
  const legacy = new Map<number, LegacySignals>();
  const frozenReceipts = new Map<number, Record<string, unknown>>();
  const receiptIds: number[] = [];
  if (receiptInput) {
    await readReceiptEvents(path.resolve(receiptInput), (event) => {
      if (event.kind !== "case_receipt") return;
      const receipt = event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)
        ? event.receipt as Record<string, unknown>
        : {};
      const source = receipt.source && typeof receipt.source === "object" ? receipt.source as Record<string, unknown> : {};
      const documentId = Number(source.document_id ?? event.document);
      if (!Number.isSafeInteger(documentId) || documentId < 1 || legacy.has(documentId)) return;
      receiptIds.push(documentId);
      legacy.set(documentId, legacySignals(receipt));
      frozenReceipts.set(documentId, receipt);
    });
  }
  const selected = receiptIds.length
    ? candidatesByDocumentIds(receiptIds)
    : all
      ? candidatesByDocumentIds(withReadonlySqlite(a2ajLocalBulkPath(), (database) => candidatePoolIds(scope, database)) ?? [])
      : perDataset
        ? stratifiedCandidates(seed, perDataset)
        : await selectedRunCandidates(args, seed, requested, scope);
  const sourceLabel = receiptInput
    ? path.resolve(receiptInput)
    : all
      ? "all_local_cases"
      : perDataset
        ? `stratified:${perDataset}_per_dataset`
        : "selection";
  const completed = new Set<number>();
  const counts = emptyAuditCounts();
  if (resume) {
    await readJsonl(resultsFile, (event) => {
      if (event.kind !== "audit_result") return;
      const documentId = Number(event.document);
      if (Number.isSafeInteger(documentId)) completed.add(documentId);
      if (event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)) {
        countAudit(counts, event.receipt as Record<string, unknown>);
      }
    });
  } else {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(resultsFile, "", "utf8");
    await writeFile(progressFile, "", "utf8");
  }
  const candidates = selected.filter((candidate) => !completed.has(candidate.documentId));
  await appendJsonl(progressFile, {
    kind: "audit_started",
    source: sourceLabel,
    selected: selected.length,
    pending: candidates.length,
    resumed: resume,
    workers,
  });
  let persisted = counts.total;
  const pool = candidates.length
    ? await DeterministicScreenPool.create(Math.min(workers, candidates.length))
    : null;
  try {
    const batchSize = 128;
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const receipts = await pool!.runAudit(batch.map((candidate) => ({
        documentId: candidate.documentId,
        candidate,
        legacy: legacy.get(candidate.documentId),
        frozen: frozenReceipts.get(candidate.documentId),
      })));
      for (const [batchIndex, receipt] of receipts.entries()) {
        countAudit(counts, receipt);
        persisted += 1;
        await appendJsonl(resultsFile, {
          kind: "audit_result",
          index: offset + batchIndex,
          document: (receipt.source as Record<string, unknown>).document_id,
          receipt,
        });
        if (persisted % 100 === 0 || persisted === selected.length) {
          console.log(`[${persisted}/${selected.length}] ready=${counts.ready} needs_luna=${counts.needs_llm}`);
          await appendJsonl(progressFile, { kind: "audit_progress", completed: persisted, total: selected.length, counts });
        }
      }
    }
  } finally {
    await pool?.close();
  }
  const summary = {
    format: "a2aj-opinion-deterministic-audit-v2",
    created_utc: now(),
    source: sourceLabel,
    seed,
    scope,
    selected_cases: selected.length,
    results_file: resultsFile,
    minimum_opinion_words: MIN_OPINION_WORDS,
    deterministic_version: DETERMINISTIC_VERSION,
    counts,
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await appendJsonl(progressFile, { kind: "audit_finished", output, counts });
  console.log(`wrote ${output}`);
  console.log(`results ${resultsFile}`);
}

function parsedObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function revalidateFrozenReceipts(args: Args) {
  const receiptStream = path.resolve(flag(args, "receipt-stream", ""));
  if (!flag(args, "receipt-stream", "")) throw new Error("revalidate requires --receipt-stream");
  const progressStream = path.resolve(flag(
    args,
    "progress-stream",
    receiptStream.replace(/\.receipts\.jsonl$/iu, ".progress.jsonl"),
  ));
  const output = path.resolve(flag(
    args,
    "out",
    receiptStream.replace(/\.receipts\.jsonl$/iu, `.revalidated-${VALIDATOR_VERSION}.json`),
  ));
  const resultsFile = output.replace(/\.json$/iu, ".results.jsonl");
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const rawByHash = new Map<string, Record<string, unknown>>();
  await readJsonl(progressStream, (event) => {
    if (event.kind !== "model_call" || typeof event.output_sha256 !== "string") return;
    const parsed = parsedObject(event.assistant_text_preview);
    if (parsed) rawByHash.set(event.output_sha256, parsed);
  });
  const work = new Map<number, {
    receipt: Record<string, unknown>;
    submission: Record<string, unknown> | null;
  }>();
  await readReceiptEvents(receiptStream, (event) => {
    const receipt = event.receipt && typeof event.receipt === "object" && !Array.isArray(event.receipt)
      ? event.receipt as Record<string, unknown>
      : null;
    if (!receipt || receipt.status !== "rejected") return;
    const source = receipt.source && typeof receipt.source === "object" && !Array.isArray(receipt.source)
      ? receipt.source as Record<string, unknown>
      : {};
    const documentId = Number(source.document_id ?? event.document);
    if (!Number.isSafeInteger(documentId) || documentId < 1 || work.has(documentId)) return;
    const modelReceipt = receipt.model_receipt && typeof receipt.model_receipt === "object" && !Array.isArray(receipt.model_receipt)
      ? receipt.model_receipt as Record<string, unknown>
      : {};
    const submission = parsedObject(receipt.rejected_submission)
      ?? (typeof modelReceipt.output_sha256 === "string" ? rawByHash.get(modelReceipt.output_sha256) ?? null : null);
    work.set(documentId, { receipt, submission });
  });
  await mkdir(path.dirname(output), { recursive: true });
  const completed = new Set<number>();
  if (resume) {
    await readJsonl(resultsFile, (event) => {
      const documentId = Number(event.document);
      if (event.kind === "revalidation_result" && Number.isSafeInteger(documentId)) completed.add(documentId);
    });
  } else {
    await writeFile(resultsFile, "", "utf8");
  }
  const pendingIds = [...work.keys()].filter((documentId) => !completed.has(documentId));
  const candidates = new Map(candidatesByDocumentIds(pendingIds).map((candidate) => [candidate.documentId, candidate]));
  let persisted = completed.size;
  for (let offset = 0; offset < pendingIds.length; offset += 64) {
    const ids = pendingIds.slice(offset, offset + 64);
    const documents = fetchLocalA2AJDocumentsByIds({
      ids,
      docType: "cases",
      language: "en",
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    for (const documentId of ids) {
      const item = work.get(documentId)!;
      const candidate = candidates.get(documentId);
      const document = documents.get(documentId);
      const frozenSource = item.receipt.source && typeof item.receipt.source === "object" && !Array.isArray(item.receipt.source)
        ? item.receipt.source as Record<string, unknown>
        : {};
      let result: Record<string, unknown>;
      if (!item.submission) {
        result = { status: "raw_submission_unavailable", source_hash_match: null, validation: null, prediction: null };
      } else if (!candidate || !document) {
        result = { status: "source_unavailable", source_hash_match: null, validation: null, prediction: null };
      } else {
        const record = buildCaseRecord(candidate, document);
        const sourceHashMatch = typeof frozenSource.source_sha256 === "string"
          ? frozenSource.source_sha256 === record.sourceSha256
          : null;
        if (sourceHashMatch === false) {
          result = { status: "source_hash_mismatch", source_hash_match: false, validation: null, prediction: null };
        } else {
          const revalidated = validatePrediction(record, item.submission);
          result = {
            status: revalidated.validation.ok ? "salvaged" : "still_rejected",
            source_hash_match: sourceHashMatch,
            validation: revalidated.validation,
            prediction: revalidated.prediction,
          };
        }
      }
      persisted += 1;
      await appendJsonl(resultsFile, {
        kind: "revalidation_result",
        document: documentId,
        citation: frozenSource.citation ?? candidate?.citation ?? null,
        old_validation: item.receipt.validation ?? null,
        submission: item.submission,
        validator_version: VALIDATOR_VERSION,
        result,
      });
      if (persisted % 100 === 0 || persisted === work.size) {
        console.log(`[revalidate ${persisted}/${work.size}]`);
      }
    }
  }
  const counts: Record<string, number> = {};
  const newErrors: Record<string, number> = {};
  await readJsonl(resultsFile, (event) => {
    if (event.kind !== "revalidation_result") return;
    const result = event.result && typeof event.result === "object" && !Array.isArray(event.result)
      ? event.result as Record<string, unknown>
      : {};
    const status = String(result.status ?? "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
    const validation = result.validation && typeof result.validation === "object" && !Array.isArray(result.validation)
      ? result.validation as Record<string, unknown>
      : {};
    for (const error of Array.isArray(validation.errors) ? validation.errors : []) {
      const key = String(error);
      newErrors[key] = (newErrors[key] ?? 0) + 1;
    }
  });
  const summary = {
    format: "a2aj-opinion-revalidation-v1",
    created_utc: now(),
    receipt_stream: receiptStream,
    progress_stream: progressStream,
    validator_version: VALIDATOR_VERSION,
    frozen_rejections: work.size,
    completed: Object.values(counts).reduce((sum, count) => sum + count, 0),
    counts,
    top_errors: Object.entries(newErrors)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 50)
      .map(([error, count]) => ({ error, count })),
    results_file: resultsFile,
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`wrote ${output}`);
  console.log(`results ${resultsFile}`);
}

function llmEligibleRows(scope: string, enforceMaximumChars: boolean) {
  return withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const params: string[] = [];
    const scopeFilter = scope.toLocaleUpperCase() === "ALL"
      ? ""
      : (params.push(scope), " AND UPPER(dataset)=UPPER(?)");
    if (!enforceMaximumChars) {
      return database.prepare(`
        SELECT id, dataset
        FROM document INDEXED BY document_dataset_idx
        WHERE doc_type='cases'${scopeFilter}
        ORDER BY dataset, id
      `).all(...params) as Array<{ id: number; dataset: string }>;
    }
    return database.prepare(`
      SELECT id, dataset
      FROM document
      WHERE doc_type='cases'
        AND unofficial_text_en IS NOT NULL
        AND length(unofficial_text_en) <= ${MAX_LUNA_SOURCE_CHARS}
        AND COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) IS NOT NULL
        AND dataset IS NOT NULL AND dataset <> ''${scopeFilter}
      ORDER BY id
    `).all(...params) as Array<{ id: number; dataset: string }>;
  }) ?? [];
}

function broadRandomSample(candidates: Candidate[], seed: number, target: number) {
  const byDataset = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const bucket = byDataset.get(candidate.dataset) ?? [];
    bucket.push(candidate);
    byDataset.set(candidate.dataset, bucket);
  }
  const broadBuckets = [...byDataset.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dataset, bucket]) =>
      drawOffsets(datasetSeed(seed, dataset), Math.min(100, bucket.length), bucket.length)
        .map((offset) => bucket[offset]),
    );
  const broad: Candidate[] = [];
  for (let index = 0; broadBuckets.some((bucket) => index < bucket.length); index += 1) {
    for (const bucket of broadBuckets) {
      const candidate = bucket[index];
      if (candidate) broad.push(candidate);
    }
  }
  const seen = new Set(broad.map((candidate) => candidate.documentId));
  const remaining = candidates.filter((candidate) => !seen.has(candidate.documentId));
  const needed = Math.max(0, target - broad.length);
  const random = drawOffsets(seed, needed, remaining.length).map((offset) => remaining[offset]);
  return [...broad, ...random].slice(0, target);
}

function llmScreenOrder(seed: number, eligible: Array<{ id: number; dataset: string }>) {
  return (() => {
    const byDataset = new Map<string, number[]>();
    for (const { id, dataset } of eligible) {
      const bucket = byDataset.get(String(dataset)) ?? [];
      bucket.push(Number(id));
      byDataset.set(String(dataset), bucket);
    }
    const broadBuckets = [...byDataset.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dataset, ids]) =>
        drawOffsets(datasetSeed(seed, dataset), Math.min(100, ids.length), ids.length).map((offset) => ids[offset]),
      );
    const broad: number[] = [];
    for (let index = 0; broadBuckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of broadBuckets) {
        const documentId = bucket[index];
        if (documentId) broad.push(documentId);
      }
    }
    const seen = new Set(broad);
    const globalIds = eligible.map(({ id }) => Number(id));
    const random = drawOffsets(seed, globalIds.length, globalIds.length)
      .map((offset) => globalIds[offset])
      .filter((documentId) => !seen.has(documentId));
    return [...broad, ...random];
  })();
}

type DeterministicScreenItem = {
  documentId: number;
  candidate?: Candidate;
  document?: A2AJDocument;
};

type DeterministicAuditItem = DeterministicScreenItem & {
  legacy?: LegacySignals;
  frozen?: Record<string, unknown>;
};

function deterministicAuditReceipt(item: DeterministicAuditItem): Record<string, unknown> {
  if (!item.candidate || !item.document) {
    return {
      source: {
        document_id: item.documentId,
        dataset: item.candidate?.dataset ?? null,
        citation: item.candidate?.citation ?? null,
      },
      status: "load_failed",
      legacy: item.legacy ?? null,
    };
  }
  const record = buildCaseRecord(item.candidate, item.document);
  const prediction = deterministicPrediction(record);
  const reference = mechanicalReference(record);
  const spans = prediction ? predictionSpans(prediction) : null;
  const spanExact = reference.status === "ready" && spans
    ? ROLE_KEYS.every((role) => JSON.stringify(spans[role]) === JSON.stringify(reference.spans[role]))
    : null;
  const reasons = llmReasons(record);
  return {
    source: {
      document_id: item.candidate.documentId,
      dataset: item.candidate.dataset,
      citation: item.candidate.citation,
      name: item.candidate.name,
      date: item.candidate.date,
      source_sha256: record.sourceSha256,
    },
    status: "audited",
    structure: { paragraph_count: record.paragraphs.length, source_chars: record.source.text.length },
    deterministic: record.deterministic,
    routing: { needs_llm: reasons.length > 0, reasons },
    oracle: {
      status: reference.status,
      span_exact: spanExact,
      note: "note" in reference ? reference.note ?? null : null,
    },
    receipt_comparison: frozenReceiptComparison(record, item.frozen, prediction),
    legacy: item.legacy ?? null,
  };
}

function deterministicScreenEvent(item: DeterministicScreenItem): Record<string, unknown> {
  if (!item.candidate || !item.candidate.citation || !item.document) {
    return { kind: "screen_case", document: item.documentId, status: "load_failed", source_chars: 0, needs_llm: false };
  }
  const source = getLocalA2AJStructure(item.document) ?? a2ajLegalSourceProvider.source(item.document);
  if (!source.text.length) {
    return {
      kind: "screen_case",
      document: item.documentId,
      source: item.candidate,
      status: "source_empty",
      source_chars: 0,
      needs_llm: false,
    };
  }
  if (source.text.length > MAX_LUNA_SOURCE_CHARS) {
    return {
      kind: "screen_case",
      document: item.documentId,
      source: item.candidate,
      status: "source_too_large",
      source_chars: source.text.length,
      needs_llm: false,
    };
  }
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const deterministic = deriveTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  return {
    kind: "screen_case",
    document: item.documentId,
    source: item.candidate,
    source_chars: source.text.length,
    deterministic_status: deterministic.status,
    deterministic_opinions: deterministic.opinions.length,
    needs_llm: deterministic.status !== "ready",
  };
}

function hydrateDeterministicItems<T extends DeterministicScreenItem>(items: T[]): T[] {
  const missing = items.filter((item) => !item.document).map((item) => item.documentId);
  if (!missing.length) return items;
  const documents = fetchLocalA2AJDocumentsByIds({
    ids: missing,
    docType: "cases",
    language: "en",
    maxChars: Number.MAX_SAFE_INTEGER,
  });
  return items.map((item) => item.document
    ? item
    : { ...item, document: documents.get(item.documentId) });
}

type ScreenWorkerReply = {
  kind: "screen_result" | "audit_result";
  events: Record<string, unknown>[];
};

class DeterministicScreenPool {
  private readonly workers: ChildProcess[];

  private constructor(workers: ChildProcess[]) {
    this.workers = workers;
  }

  static async create(size: number) {
    const workers = await Promise.all(Array.from({ length: size }, () => new Promise<ChildProcess>((resolve, reject) => {
      const worker = fork(__filename, ["deterministic-screen-worker"], {
        execArgv: process.execArgv,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: Record<string, unknown>) => {
        worker.off("error", onError);
        if (message.kind !== "screen_ready") {
          reject(new Error("deterministic screen worker did not become ready"));
          return;
        }
        resolve(worker);
      });
    })));
    return new DeterministicScreenPool(workers);
  }

  async run(items: DeterministicScreenItem[]) {
    const chunks = this.workers.map(() => [] as DeterministicScreenItem[]);
    items.forEach((item, index) => chunks[index % chunks.length].push(item));
    const replies = await Promise.all(this.workers.map((worker, index) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: ScreenWorkerReply) => {
        worker.off("error", onError);
        if (message.kind !== "screen_result") {
          reject(new Error("unexpected deterministic screen worker reply"));
          return;
        }
        resolve(message.events);
      });
      worker.send({ kind: "screen_batch", items: chunks[index] });
    })));
    const byDocument = new Map(replies.flat().map((event) => [Number(event.document), event]));
    return items.map((item) => byDocument.get(item.documentId) ?? {
      kind: "screen_case",
      document: item.documentId,
      status: "worker_result_missing",
      source_chars: 0,
      needs_llm: false,
    });
  }

  async runAudit(items: DeterministicAuditItem[]) {
    const chunks = this.workers.map(() => [] as DeterministicAuditItem[]);
    items.forEach((item, index) => chunks[index % chunks.length].push(item));
    const replies = await Promise.all(this.workers.map((worker, index) => new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      worker.once("error", onError);
      worker.once("message", (message: ScreenWorkerReply) => {
        worker.off("error", onError);
        if (message.kind !== "audit_result") {
          reject(new Error("unexpected deterministic audit worker reply"));
          return;
        }
        resolve(message.events);
      });
      worker.send({ kind: "audit_batch", items: chunks[index] });
    })));
    const byDocument = new Map(replies.flat().map((event) => {
      const source = event.source && typeof event.source === "object" && !Array.isArray(event.source)
        ? event.source as Record<string, unknown>
        : {};
      return [Number(source.document_id), event] as const;
    }));
    return items.map((item) => byDocument.get(item.documentId) ?? deterministicAuditReceipt({
      documentId: item.documentId,
      candidate: item.candidate,
      legacy: item.legacy,
      frozen: item.frozen,
    }));
  }

  async close() {
    for (const worker of this.workers) worker.kill();
  }
}

async function needsLlmManifestCandidates(args: {
  seed: number;
  scope: string;
  target: number;
  screenFile: string;
  resume: boolean;
  excludedIds: Set<number>;
  workers: number;
}) {
  const completed = new Map<number, Record<string, unknown>>();
  if (args.resume) {
    await readJsonl(args.screenFile, (event) => {
      if (event.kind !== "screen_case") return;
      const documentId = Number(event.document);
      if (Number.isSafeInteger(documentId) && documentId > 0) completed.set(documentId, event);
    });
  }
  const hasLegacyCache = [...completed.values()].some((event) => !Number.isFinite(Number(event.source_chars)));
  const eligibleStarted = performance.now();
  const eligibleRows = llmEligibleRows(args.scope, hasLegacyCache);
  console.log(`[screen setup] eligible=${eligibleRows.length} metadata_ms=${Math.round(performance.now() - eligibleStarted)}`);
  const eligibleIds = new Set(eligibleRows.map(({ id }) => Number(id)));
  const cached = [...completed.entries()].flatMap(([documentId, event]) => {
    if (event.needs_llm !== true || !eligibleIds.has(documentId) || args.excludedIds.has(documentId)) return [];
    const source = event.source as Candidate | undefined;
    return source ? [source] : [];
  });
  if (cached.length >= args.target) {
    const selected = broadRandomSample(cached, args.seed, args.target);
    console.log(`[screen cache] eligible_needs_luna=${cached.length} selected=${selected.length}`);
    return selected;
  }
  const orderStarted = performance.now();
  const order = llmScreenOrder(args.seed, eligibleRows).filter((documentId) => !args.excludedIds.has(documentId));
  console.log(`[screen setup] order=${order.length} randomize_ms=${Math.round(performance.now() - orderStarted)}`);
  const selected: Candidate[] = [];
  let considered = 0;
  const batchSize = 128;
  const poolStarted = performance.now();
  const pool = await DeterministicScreenPool.create(args.workers);
  console.log(`[screen setup] workers=${args.workers} startup_ms=${Math.round(performance.now() - poolStarted)}`);
  try {
    for (let offset = 0; offset < order.length && selected.length < args.target; offset += batchSize) {
      const ids = order.slice(offset, offset + batchSize);
      const missing = ids.filter((documentId) => !completed.has(documentId));
      const candidates = missing.length ? candidatesByDocumentIds(missing) : [];
      const byId = new Map(candidates.map((candidate) => [candidate.documentId, candidate]));
      const events = missing.length
        ? await pool.run(missing.map((documentId) => ({
            documentId,
            candidate: byId.get(documentId),
          })))
        : [];
      for (const event of events) completed.set(Number(event.document), event);
      for (const documentId of ids) {
        considered += 1;
        const event = completed.get(documentId)!;
        if (event.needs_llm === true) {
          const source = event.source as Candidate | undefined;
          if (source) selected.push(source);
        }
        if (selected.length >= args.target) break;
      }
      if (events.length) {
        await appendFile(
          args.screenFile,
          events.map((event) => JSON.stringify({ utc: now(), ...event })).join("\n") + "\n",
          "utf8",
        );
      }
      if (considered % 512 < batchSize || selected.length >= args.target) {
        console.log(`[screen ${considered}/${order.length}] needs_luna=${selected.length}/${args.target}`);
      }
    }
  } finally {
    await pool.close();
  }
  if (selected.length < args.target) {
    throw new Error(`only ${selected.length} deterministic-unresolved cases exist in the selected ${args.scope} corpus; requested ${args.target}`);
  }
  return selected.slice(0, args.target);
}

async function manifest(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : randomInt(1, 2 ** 31 - 1);
  const requestedSampleSize = Math.max(1, parseIntFlag(args, "sample-size", 30_000));
  const scope = flag(args, "scope", "ALL");
  if (flag(args, "document-ids", "") || flag(args, "case-file", "")) {
    throw new Error("manifest creates a random cohort; do not pass --document-ids or --case-file");
  }
  const output = flag(
    args,
    "out",
    path.join(RUN_DIR, `luna-low-${scope.toLocaleLowerCase()}-${seed}-manifest.json`),
  );
  const needsLlm = args["needs-llm"] === true || String(args["needs-llm"] ?? "").toLocaleLowerCase() === "true";
  const resume = args.resume === true || String(args.resume ?? "").toLocaleLowerCase() === "true";
  const screenWorkers = Math.min(10, Math.max(1, parseIntFlag(args, "workers", 10)));
  const excludeCaseFile = flag(args, "exclude-case-file", "");
  const excludedIds = excludeCaseFile ? new Set(await documentIdsFromFile(excludeCaseFile)) : new Set<number>();
  const screenFile = output.replace(/\.json$/u, ".screen.jsonl");
  await mkdir(path.dirname(output), { recursive: true });
  if (needsLlm && !resume) await writeFile(screenFile, "", "utf8");
  const candidates = needsLlm
    ? await needsLlmManifestCandidates({
        seed,
        scope,
        target: requestedSampleSize,
        screenFile,
        resume,
        excludedIds,
        workers: screenWorkers,
      })
    : selectedCandidates(seed, requestedSampleSize, scope);
  const datasetCounts = Object.fromEntries(
    [...new Set(candidates.map((candidate) => candidate.dataset))]
      .sort()
      .map((dataset) => [dataset, candidates.filter((candidate) => candidate.dataset === dataset).length]),
  );
  const value = {
    format: "a2aj-luna-manifest-v2",
    created_utc: now(),
    seed,
    scope,
    requested_sample_size: requestedSampleSize,
    sample_size: candidates.length,
    selection_order: "seeded_pseudorandom_draw",
    selection_filter: needsLlm ? "deterministic_status_not_ready" : "none",
    deterministic_version: DETERMINISTIC_VERSION,
    deterministic_screen_workers: needsLlm ? screenWorkers : null,
    maximum_source_chars: needsLlm ? MAX_LUNA_SOURCE_CHARS : null,
    screen_file: needsLlm ? screenFile : null,
    excluded_case_file: excludeCaseFile ? path.resolve(excludeCaseFile) : null,
    excluded_case_count: excludedIds.size,
    dataset_counts: datasetCounts,
    document_ids: candidates.map((candidate) => candidate.documentId),
    cases: candidates.map((candidate) => ({
      document_id: candidate.documentId,
      dataset: candidate.dataset,
      citation: candidate.citation,
      name: candidate.name,
      date: candidate.date,
    })),
  };
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`wrote ${output}`);
  console.log(`seed ${seed} scope ${scope} cases ${candidates.length}`);
}

async function annotate(args: Args) {
  const documentId = parseIntFlag(args, "document-id", 0);
  const file = flag(args, "file", "");
  const sidecar = flag(args, "sidecar-db", DEFAULT_SIDECAR);
  if (!documentId || !file) throw new Error("annotate requires --document-id and --file");
  const candidate = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const row = database.prepare(`
      SELECT id, dataset, COALESCE(NULLIF(citation_en,''),NULLIF(citation2_en,'')) AS citation,
             name_en, document_date_en FROM document WHERE id=? AND doc_type='cases'
    `).get(documentId) as Record<string, unknown> | undefined;
    return row ? {
      documentId: Number(row.id), dataset: String(row.dataset ?? ""), citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null, date: row.document_date_en ? String(row.document_date_en) : null,
    } satisfies Candidate : null;
  });
  if (!candidate) throw new Error(`A2AJ case ${documentId} not found`);
  const record = await loadCase(candidate);
  if (!record) throw new Error(`A2AJ case ${documentId} could not be loaded`);
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  const result = validatePrediction(record, raw);
  if (!result.prediction || !result.validation.ok) throw new Error(json(result.validation));
  const database = await initSidecar(sidecar);
  database.prepare("INSERT OR REPLACE INTO opinion_reference VALUES (?,?,?,?)").run(
    documentId,
    record.sourceSha256,
    JSON.stringify(result.prediction),
    now(),
  );
  database.close();
  console.log(`stored human reference for ${documentId}`);
}

function runReceiptPath(value: string) {
  return path.isAbsolute(value)
    ? value
    : value.toLocaleLowerCase().endsWith(".json")
      ? path.resolve(value)
      : path.join(RUN_DIR, `${value}.json`);
}

function predictionFromReceipt(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prediction = (value as Record<string, unknown>).prediction;
  if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) return null;
  return prediction as Record<string, unknown>;
}

function compatibleJudgeRole(judge: Record<string, unknown>, opinions: Array<Record<string, unknown>>): Role {
  if (typeof judge.role === "string" && ROLE_KEYS.includes(judge.role as Role)) return judge.role as Role;
  if (judge.result_side === "minority") return "minority";
  const opinionIds = Array.isArray(judge.opinion_ids) ? judge.opinion_ids.map(String) : [];
  if (
    judge.relationship === "authors" &&
    opinions.some((opinion) => opinionIds.includes(String(opinion.id)) && opinion.alignment === "same_result_separate_reasons")
  ) return "concurring";
  if (judge.result_side === "majority") return "majority";
  return "unknown";
}

function judgeKeySet(prediction: Record<string, unknown> | null) {
  const opinions = Array.isArray(prediction?.opinions)
    ? prediction.opinions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  const judges = Array.isArray(prediction?.judges)
    ? prediction.judges.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  return new Set(judges.map((judge) =>
    `${compact(String(judge.name ?? "")).toLocaleLowerCase()}|${compatibleJudgeRole(judge, opinions)}`,
  ));
}

function sameSet(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function parseParagraphIndex(value: unknown) {
  if (typeof value !== "string") return [];
  const numbers: number[] = [];
  for (const token of value.split(",")) {
    const match = /^\s*par(\d+)(?:-par(\d+))?\s*$/iu.exec(token);
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    for (let number = from; number <= to; number += 1) numbers.push(number);
  }
  return numbers;
}

function predictionRoleMap(prediction: Record<string, unknown> | null, available: number[]) {
  const roles = new Map<number, Role>();
  if (!prediction) return roles;
  const spans = prediction.spans && typeof prediction.spans === "object" && !Array.isArray(prediction.spans)
    ? prediction.spans as Record<string, unknown>
    : null;
  if (spans) {
    for (const role of ROLE_KEYS) {
      const ranges = Array.isArray(spans[role]) ? spans[role] as unknown[] : [];
      for (const raw of ranges) {
        const range = Array.isArray(raw) && raw.length === 2
          ? { from: Number(raw[0]), to: Number(raw[1]) }
          : raw && typeof raw === "object" && !Array.isArray(raw)
            ? { from: Number((raw as Record<string, unknown>).from), to: Number((raw as Record<string, unknown>).to) }
            : null;
        if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
          for (const number of numbersInRange(range, available)) roles.set(number, role);
        }
      }
    }
    return roles;
  }
  const opinions = Array.isArray(prediction.opinions)
    ? prediction.opinions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
  for (const opinion of opinions) {
    const role: Role = opinion.alignment === "lead"
      ? "majority"
      : opinion.alignment === "different_result"
        ? "minority"
        : opinion.alignment === "same_result_separate_reasons"
          ? "concurring"
          : "unknown";
    for (const raw of Array.isArray(opinion.paragraphs) ? opinion.paragraphs : []) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const range = { from: Number((raw as Record<string, unknown>).from), to: Number((raw as Record<string, unknown>).to) };
      if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) continue;
      for (const number of numbersInRange(range, available)) roles.set(number, role);
    }
  }
  return roles;
}

async function compareRuns(args: Args) {
  const lunaValue = flag(args, "luna-run", "");
  const qwenValue = flag(args, "qwen-run", "");
  if (!lunaValue || !qwenValue) throw new Error("compare requires --luna-run and --qwen-run (run IDs or receipt paths)");
  const lunaPath = runReceiptPath(lunaValue);
  const qwenPath = runReceiptPath(qwenValue);
  const luna = JSON.parse(await readFile(lunaPath, "utf8")) as Record<string, unknown>;
  const qwen = JSON.parse(await readFile(qwenPath, "utf8")) as Record<string, unknown>;
  const lunaRows = Array.isArray(luna.receipts) ? luna.receipts : [];
  const qwenRows = Array.isArray(qwen.receipts) ? qwen.receipts : [];
  const qwenByDocument = new Map(
    qwenRows.map((row) => [Number((row as Record<string, unknown>).source && ((row as Record<string, unknown>).source as Record<string, unknown>).document_id), row]),
  );
  const cases = lunaRows.map((lunaRow) => {
    const source = (lunaRow as Record<string, unknown>).source as Record<string, unknown> | undefined;
    const documentId = Number(source?.document_id);
    const qwenRow = qwenByDocument.get(documentId) as Record<string, unknown> | undefined;
    const lunaPrediction = predictionFromReceipt(lunaRow);
    const qwenPrediction = predictionFromReceipt(qwenRow);
    const available = parseParagraphIndex((lunaRow as Record<string, unknown>).structure && ((lunaRow as Record<string, unknown>).structure as Record<string, unknown>).paragraph_index);
    const lunaRoles = predictionRoleMap(lunaPrediction, available);
    const qwenRoles = predictionRoleMap(qwenPrediction, available);
    const roleMatches = available.filter((number) => lunaRoles.get(number) === qwenRoles.get(number)).length;
    return {
      document_id: documentId,
      citation: source?.citation ?? null,
      luna_status: (lunaRow as Record<string, unknown>).status ?? null,
      qwen_status: qwenRow?.status ?? "missing",
      judge_agreement: sameSet(judgeKeySet(lunaPrediction), judgeKeySet(qwenPrediction)),
      span_exact: Boolean(lunaPrediction && qwenPrediction && available.every((number) => lunaRoles.get(number) === qwenRoles.get(number))),
      paragraph_role_accuracy: available.length ? Math.round((roleMatches / available.length) * 1_000_000) / 1_000_000 : null,
      luna_prediction: lunaPrediction,
      qwen_prediction: qwenPrediction,
    };
  });
  const comparison = {
    luna_run: luna.run_id ?? lunaValue,
    qwen_run: qwen.run_id ?? qwenValue,
    same_case_count: cases.filter((item) => item.qwen_status !== "missing").length,
    cases,
  };
  const output = typeof args.out === "string" && args.out.trim() ? args.out.trim() : "";
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
    console.log(`wrote ${output}`);
  }
  console.log(json(comparison));
}

async function selfTest() {
  const recordText = [
    "Example Decision\nJudges\nAlpha J.; Beta J.; Gamma J.\nJoint Reasons for Judgment: (paras. 1 to 2)\nAlpha J. and Beta J.\nDissenting Reasons: (paras. 3 to 4)\nGamma J.\n",
    "[1] Majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler. The first majority proposition concerns jurisdiction and the governing statutory language.\n",
    "[2] More majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block without experiment-local paragraph parsing. The majority finally dismisses the appeal and awards ordinary costs to the respondent.\n",
    "[3] Dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler. The dissent instead applies a different standard of review.\n",
    "[4] More dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block without experiment-local paragraph parsing. The dissent would allow the appeal, set aside the order, and remit the matter for reconsideration.\n",
  ].join("");
  const { compileA2AJSourceDoc } = await import("../../backend/src/lib/sourceDocA2AJ");
  const source = compileA2AJSourceDoc({ citation: "2099 SCC 1", dataset: "SCC", docType: "cases", text: recordText });
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  if (paragraphs.map((block) => block.label).join(",") !== "par1,par2,par3,par4") throw new Error(`SourceDoc self-test failed: ${paragraphs.map((block) => block.label).join(",")}`);
  const candidate: Candidate = { documentId: 1, dataset: "SCC", citation: "2099 SCC 1", name: "Example", date: "2099" };
  const document = { docType: "cases", dataset: "SCC", citation: candidate.citation, alternateCitation: null, name: candidate.name, date: candidate.date, url: null, text: recordText, language: "en", upstreamLicense: null, structure: { status: "usable", source: "flat_text", counts: { paragraph: 4, page: 0, section: 0 } } } satisfies A2AJDocument;
  const { structure, deterministic } = analyzeTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const record: CaseRecord = { candidate, document, source, paragraphs, sourceEvidence: createA2AJDocumentEvidence(document), sourceSha256: sha256(recordText), structure, deterministic, hints: extractMechanicalHints(source, paragraphs, structure), preflight: extractPreflight(source, paragraphs) };
  const raw = {
    opinions: deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      authors: opinion.authors,
      alignment: opinion.alignment,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
    })),
    judges: deterministic.judges.map((judge) => ({
      name: judge.name,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.opinionIds,
    })),
  };
  const result = validatePrediction(record, raw);
  if (!result.validation.ok || !result.prediction) throw new Error(json(result.validation));
  if (
    nameKey("Sharlow J.A.") !== "sharlow" ||
    nameKey("Chipman, J.A.") !== "chipman" ||
    nameKey("Clarke, C.J.N.S.") !== "clarke" ||
    nameKey("Feldman, Kathryn N.") !== "feldman"
  ) {
    throw new Error("dotted judicial suffixes changed judge-name identity");
  }
  if (
    normalizedOpinionAlignment("unknown", 1) !== "lead" ||
    normalizedOpinionAlignment("different_result", 2) !== "different_result"
  ) {
    throw new Error("sole-opinion lead normalization changed");
  }
  const duplicateText = "REASONS FOR JUDGMENT\nDisposition.\nDecision Content\nREASONS FOR JUDGMENT\n[1] Reasons.\nDisposition.";
  const preferredStart = preferredGroundedSpans(
    duplicateText,
    duplicateText.indexOf("[1]"),
    exactQuoteSpans(duplicateText, "REASONS FOR JUDGMENT", 10),
    "start",
    1,
  );
  const preferredEnd = preferredGroundedSpans(
    duplicateText,
    duplicateText.indexOf("[1]"),
    exactQuoteSpans(duplicateText, "Disposition.", 10),
    "end",
    1,
  );
  if (
    preferredStart.length !== 1 || preferredStart[0].start !== duplicateText.lastIndexOf("REASONS FOR JUDGMENT") ||
    preferredEnd.length !== 1 || preferredEnd[0].start !== duplicateText.lastIndexOf("Disposition.")
  ) {
    throw new Error("decision-body duplicate anchors were not disambiguated");
  }
  const shortAnchors = structuredClone(raw);
  shortAnchors.opinions[0].start_quote = "Majority reasoning";
  shortAnchors.opinions[0].end_quote = "respondent.";
  const expanded = validatePrediction(record, shortAnchors);
  if (
    !expanded.validation.ok ||
    !expanded.prediction ||
    sourceDocQuoteWords(expanded.prediction.opinions[0].start_quote).length < 4 ||
    sourceDocQuoteWords(expanded.prediction.opinions[0].end_quote).length < 4
  ) {
    throw new Error(`unique short boundary anchors were not expanded: ${json(expanded.validation)}`);
  }
  const normalizedAnchors = structuredClone(raw);
  normalizedAnchors.opinions[0].start_quote = normalizedAnchors.opinions[0].start_quote.replace("[1]", "[ 1 ]");
  const grounded = validatePrediction(record, normalizedAnchors);
  if (
    !grounded.validation.ok ||
    !grounded.prediction ||
    grounded.prediction.opinions[0].start !== result.prediction.opinions[0].start ||
    grounded.prediction.opinions[0].start_quote !== result.prediction.opinions[0].start_quote
  ) {
    throw new Error(`word-grounded boundary anchors changed the source span: ${json(grounded.validation)}`);
  }
  const oracle = mechanicalReference(record);
  if (oracle.status !== "ready") throw new Error("mechanical reference self-test failed");
  if (JSON.stringify(oracle.spans) !== JSON.stringify(predictionSpans(result.prediction))) {
    throw new Error(`mechanical reference ranges changed: ${json(predictionSpans(result.prediction))}`);
  }
  if (parseDocumentIds("7, 7 9\n11").join(",") !== "7,9,11") throw new Error("case selector self-test failed");
  const randomDraw = drawOffsets(285949255, 20, 100);
  if (
    randomDraw.length !== 20 ||
    new Set(randomDraw).size !== 20 ||
    JSON.stringify(randomDraw) !== JSON.stringify(drawOffsets(285949255, 20, 100)) ||
    JSON.stringify(randomDraw) === JSON.stringify([...randomDraw].sort((left, right) => left - right))
  ) {
    throw new Error(`seeded random order self-test failed: ${randomDraw.join(",")}`);
  }
  if (codexPacket(record).includes("opinion_headers")) throw new Error("Codex packet leaked oracle output");
  let active = 0;
  let peak = 0;
  const pooled = await mapPool(Array.from({ length: 23 }, (_, index) => index), 10, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return value * 2;
  });
  if (peak !== 10 || pooled.join(",") !== Array.from({ length: 23 }, (_, index) => index * 2).join(",")) {
    throw new Error(`parallel dispatch self-test failed: peak=${peak}`);
  }
  if (GPT_RESPONSES_SCHEMA.type !== "json_schema" || GPT_RESPONSES_SCHEMA.strict !== true || GPT_RESPONSES_SCHEMA.name !== RESPONSE_SCHEMA_NAME) {
    throw new Error("Responses schema self-test failed");
  }
  console.log("PASS a2aj_decision_roster_qwen self-test");
}

function parseArgs(argv: string[]) {
  const [command = "help", ...rest] = argv;
  const args: Args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) { args[key] = next; index += 1; }
    else args[key] = true;
  }
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "self-test") await selfTest();
  else if (command === "run") await run(args);
  else if (command === "codex") await run({ ...args, provider: "luna" });
  else if (command === "audit") await deterministicAudit(args);
  else if (command === "revalidate") await revalidateFrozenReceipts(args);
  else if (command === "manifest") await manifest(args);
  else if (command === "annotate") await annotate(args);
  else if (command === "compare") await compareRuns(args);
  else throw new Error("commands: self-test | run | codex | audit | revalidate | manifest | annotate | compare");
}

function startDeterministicScreenWorker() {
  if (!process.send) throw new Error("deterministic screen worker has no IPC channel");
  process.on("message", (message: { kind?: string; items?: DeterministicAuditItem[] }) => {
    if (!Array.isArray(message.items)) return;
    if (message.kind === "audit_batch") {
      const events = hydrateDeterministicItems(message.items).map((item) => {
        try {
          return deterministicAuditReceipt(item);
        } catch (error) {
          return {
            source: {
              document_id: item.documentId,
              dataset: item.candidate?.dataset ?? null,
              citation: item.candidate?.citation ?? null,
            },
            status: "load_failed",
            audit_error: errorMessage(error),
            legacy: item.legacy ?? null,
          };
        }
      });
      process.send!({ kind: "audit_result", events } satisfies ScreenWorkerReply);
      return;
    }
    if (message.kind !== "screen_batch") return;
    const events = hydrateDeterministicItems(message.items).map((item) => {
      try {
        return deterministicScreenEvent(item);
      } catch (error) {
        return {
          kind: "screen_case",
          document: item.documentId,
          source: item.candidate,
          status: "parse_failed",
          source_chars: item.document?.text.length ?? 0,
          parse_error: errorMessage(error),
          needs_llm: true,
        };
      }
    });
    process.send!({ kind: "screen_result", events } satisfies ScreenWorkerReply);
  });
  process.send({ kind: "screen_ready" });
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain && process.argv[2] === "deterministic-screen-worker") {
  startDeterministicScreenWorker();
} else if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
