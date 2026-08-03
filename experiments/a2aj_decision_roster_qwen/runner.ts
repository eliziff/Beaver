#!/usr/bin/env node

/**
 * Random A2AJ decision-roster sidecar experiment.
 *
 * Paragraph structure is deliberately not implemented here. The runner uses
 * the backend's SourceDoc/A2AJ compiler and lookup/evidence contracts, then
 * adds only the experiment-specific opinion-role extraction task.
 */

import { createHash, randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocument,
  getLocalA2AJStructure,
} from "../../backend/src/lib/a2ajLocalBulk";
import {
  getA2AJDocumentSourceDoc,
  lookupA2AJLocator,
  type A2AJDocument,
} from "../../backend/src/lib/a2aj";
import {
  A2AJ_TOOLS,
  executeA2AJTool,
} from "../../backend/src/lib/chat/tools/a2ajTools";
import {
  createA2AJDocumentEvidence,
  createA2AJLookupEvidence,
  type LegalEvidenceReceipt,
} from "../../backend/src/lib/chat/legalEvidenceExperiment";
import {
  withReadonlySqlite,
} from "../../backend/src/lib/legalDataPath";
import {
  type SourceDoc,
  type SourceDocBlock,
} from "../../backend/src/lib/sourceDoc";
import {
  analyzeOpinionStructure,
  partitionOpinionStructure,
  type OpinionStructure,
} from "../../backend/src/lib/legalOpinionBoundaries";

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
  hints: MechanicalHints;
  preflight: Preflight;
};

type Prediction = {
  judges: Array<{ name: string; role: Role }>;
  spans: Record<Role, Range[]>;
};

type Reference = {
  source: "mechanical" | "human";
  status: "ready" | "unresolved";
  judges: Array<{ name: string; role: Role }>;
  spans: Record<Role, Range[]>;
  note?: string;
};

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
const DEFAULT_BASE_URL = process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const DEFAULT_SIDECAR = path.join(RUN_DIR, "decision-roster.sqlite");
const DEFAULT_NUM_CTX = 32_768;
const DEFAULT_NUM_PREDICT = 4_096;
const PROMPT_VERSION = "a2aj-roster-v2";
const MAX_LOOKUP_PARAGRAPHS = 12;
const MAX_ATTEMPTS = 20;

const ROLE_KEYS: Role[] = ["majority", "minority", "concurring", "unknown"];
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const SUBMIT_TOOL = {
  type: "function",
  function: {
    name: "submit_roster",
    description:
      "Submit one source-grounded judge roster and paragraph-role partition.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        judges: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              role: {
                type: "string",
                enum: ["majority", "minority", "concurring", "unknown"],
              },
            },
            required: ["name", "role"],
          },
        },
        spans: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(
            ROLE_KEYS.map((role) => [
              role,
              {
                type: "array",
                items: {
                  type: "array",
                  minItems: 2,
                  maxItems: 2,
                  items: { type: "integer", minimum: 1 },
                },
              },
            ]),
          ),
          required: ROLE_KEYS,
        },
      },
      required: ["judges", "spans"],
    },
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

const SYSTEM_PROMPT = `YOU=QWEN. ONE A2AJ DECISION. DO NOT ASK A QUESTION.
Use deterministic preflight only as a search hint; it does not prove an opinion role.
Read exact source paragraphs with a2aj_lookup. Prefer one contiguous range up to 12 paragraphs when checking a block; avoid one-paragraph-at-a-time reading when a range will do. Then call submit_roster.
Every judge name must occur in the source. role=majority, minority, concurring, or unknown.
spans partition every source paragraph exactly once. Use unknown when the source does not establish a role; do not guess.
Ranges are inclusive [first_paragraph_number,last_paragraph_number]. NO PROSE AFTER THE TOOL CALL.`;

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
  const ignored = new Set(["c", "j", "cj", "ja", "jj", "jca", "justice"]);
  const tokens = words(value).filter((token) => !ignored.has(token));
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

function mechanicalReference(record: CaseRecord): Reference {
  const partition = partitionOpinionStructure(
    record.structure,
    paragraphNumbers(record.paragraphs),
  );
  const spans = roleMap();
  for (const [role, ranges] of Object.entries(partition.spans)) {
    const key = role === "separate" ? "unknown" : (role as Role);
    spans[key].push(...ranges);
  }
  for (const role of ROLE_KEYS) spans[role] = compressNumbers(spans[role].flatMap((range) => [range.from, range.to]));
  return {
    source: "mechanical",
    status: partition.status,
    judges: partition.judges.map(({ name, role }) => ({ name, role: runnerRole(role) })),
    spans,
    note: partition.note,
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
    "Identify every judge and assign each an opinion role. Partition every source paragraph into majority, minority, concurring, or unknown. Read exact paragraphs with a2aj_lookup before submitting.",
  ].join("\n\n");
}

function parseRanges(value: unknown, role: Role, available: number[], errors: string[]) {
  if (!Array.isArray(value)) {
    errors.push(`${role} spans must be an array of [first,last] ranges`);
    return [];
  }
  const output: Range[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !item.every((v) => Number.isInteger(v))) {
      errors.push(`${role} contains a malformed range`);
      continue;
    }
    const from = Number(item[0]);
    const to = Number(item[1]);
    if (from < 1 || to < from) {
      errors.push(`${role} contains an invalid range [${from},${to}]`);
      continue;
    }
    const values = numbersInRange({ from, to }, available);
    if (!values.length || values[0] !== from || values.at(-1) !== to) {
      errors.push(`${role} range [${from},${to}] is not an exact SourceDoc paragraph range`);
      continue;
    }
    output.push({ from, to });
  }
  const expanded = output.flatMap((range) => numbersInRange(range, available));
  if (new Set(expanded).size !== expanded.length) errors.push(`${role} ranges overlap`);
  return output;
}

function normalizeRole(value: unknown): Role | null {
  if (value === "M" || value === "majority") return "majority";
  if (value === "m" || value === "minority" || value === "dissent") return "minority";
  if (value === "c" || value === "concurring" || value === "concurrence") return "concurring";
  if (value === "u" || value === "unknown" || value === "separate") return "unknown";
  return null;
}

function validatePrediction(record: CaseRecord, raw: unknown): { prediction: Prediction | null; validation: Validation } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { prediction: null, validation: { ok: false, error: "roster must be an object", next: "Call submit_roster with judges and spans." } };
  }
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  const rawJudges = value.judges ?? value.j;
  if (!Array.isArray(rawJudges) || !rawJudges.length) errors.push("judges must list every judge");
  const judges: Array<{ name: string; role: Role }> = [];
  const seen = new Set<string>();
  for (const item of (Array.isArray(rawJudges) ? rawJudges : [])) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("each judge needs name and role");
      continue;
    }
    const row = item as Record<string, unknown>;
    const name = typeof (row.name ?? row.n) === "string" ? String(row.name ?? row.n).trim() : "";
    const role = normalizeRole(row.role ?? row.r);
    if (!name || !role) {
      errors.push("each judge needs a source name and valid role");
      continue;
    }
    const key = nameKey(name);
    if (!key || seen.has(key)) {
      errors.push(`duplicate or empty judge: ${name}`);
      continue;
    }
    if (!sourceNameMatches(record.hints.header, name)) {
      errors.push(`judge name not found in source header: ${name}`);
      continue;
    }
    seen.add(key);
    const canonical = record.hints.judgeCandidates.find((candidate) => nameKey(candidate) === key) ?? name;
    judges.push({ name: canonical, role });
  }

  const rawSpans = (value.spans && typeof value.spans === "object" ? value.spans : value) as Record<string, unknown>;
  const available = paragraphNumbers(record.paragraphs);
  const spans = roleMap();
  for (const role of ROLE_KEYS) {
    const legacy = role === "majority" ? value.M : role === "minority" ? value.m : role === "concurring" ? value.c : undefined;
    spans[role] = parseRanges(rawSpans[role] ?? legacy ?? [], role, available, errors);
  }
  const ownership = new Map<number, Role>();
  for (const role of ROLE_KEYS) {
    for (const range of spans[role]) {
      for (const number of numbersInRange(range, available)) {
        if (ownership.has(number)) errors.push(`paragraph ${number} is assigned to multiple roles`);
        ownership.set(number, role);
      }
    }
  }
  const missing = available.filter((number) => !ownership.has(number));
  if (missing.length) errors.push(`unassigned source paragraphs: ${missing.slice(0, 16).join(", ")}`);
  if (errors.length) {
    return {
      prediction: null,
      validation: {
        ok: false,
        error: "roster_invalid",
        errors,
        next: "Correct only the named errors, then call submit_roster again. Do not ask a question.",
      },
    };
  }
  return { prediction: { judges, spans }, validation: { ok: true } };
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

function runLuna(prompt: string) {
  const command = process.env.CODEX_CMD?.trim() || path.join(process.env.APPDATA || "", "npm", "codex.cmd");
  const result = spawnSync(
    command,
    ["exec", "-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="low"', "-s", "read-only", "-"],
    { input: prompt, encoding: "utf8", timeout: 900_000, maxBuffer: 8 * 1024 * 1024, shell: true },
  );
  const output = `${result.stdout ?? ""}`;
  return {
    raw: output,
    stderr: `${result.stderr ?? ""}`.slice(-4_000),
    returnCode: result.status,
    parsed: extractJsonObject(output),
  };
}

async function hydratePrediction(record: CaseRecord, prediction: Prediction) {
  const ranges = ROLE_KEYS.flatMap((role) => prediction.spans[role].map((range) => ({ role, range })));
  const evidence: Array<{ role: Role; from: string; to: string; evidence_id: string | null }> = [];
  for (const item of ranges) {
    const lookup = await lookupA2AJLocator({
      citation: record.candidate.citation,
      docType: "cases",
      language: "en",
      dataset: record.candidate.dataset,
      kind: "paragraph",
      locator: String(item.range.from),
      ...(item.range.from === item.range.to ? {} : { endLocator: String(item.range.to) }),
      contextBlocks: 0,
    });
    const receipt = lookup ? createA2AJLookupEvidence(lookup) : null;
    evidence.push({
      role: item.role,
      from: `par${item.range.from}`,
      to: `par${item.range.to}`,
      evidence_id: receipt?.evidence_id ?? null,
    });
  }
  return evidence;
}

function score(prediction: Prediction, reference: Reference | null, available: number[]) {
  if (!reference || reference.status !== "ready") return { reference: null };
  const exact = ROLE_KEYS.every((role) => JSON.stringify(prediction.spans[role]) === JSON.stringify(reference.spans[role]));
  const gold = new Map<number, Role>();
  const predicted = new Map<number, Role>();
  for (const role of ROLE_KEYS) {
    for (const range of reference.spans[role]) for (const number of numbersInRange(range, available)) gold.set(number, role);
    for (const range of prediction.spans[role]) for (const number of numbersInRange(range, available)) predicted.set(number, role);
  }
  const matches = available.filter((number) => gold.get(number) === predicted.get(number)).length;
  const judgeExact = reference.judges.length > 0 && JSON.stringify(prediction.judges) === JSON.stringify(reference.judges);
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
    CREATE TABLE IF NOT EXISTS roster_run (
      run_id TEXT PRIMARY KEY, created_utc TEXT NOT NULL, seed INTEGER NOT NULL,
      sample_size INTEGER NOT NULL, scope TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, effort TEXT NOT NULL, num_ctx INTEGER NOT NULL,
      num_predict INTEGER NOT NULL, prompt_version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS roster_decision (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, source_sha256 TEXT NOT NULL,
      dataset TEXT NOT NULL, citation TEXT NOT NULL, name TEXT, decision_date TEXT,
      structure_status TEXT NOT NULL, paragraph_count INTEGER NOT NULL,
      result_status TEXT NOT NULL, source_evidence_id TEXT, prediction_json TEXT,
      reference_json TEXT, validation_json TEXT NOT NULL, metrics_json TEXT,
      PRIMARY KEY (run_id, document_id)
    );
    CREATE TABLE IF NOT EXISTS roster_judge (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS roster_span (
      run_id TEXT NOT NULL, document_id INTEGER NOT NULL, role TEXT NOT NULL,
      start_label TEXT NOT NULL, end_label TEXT NOT NULL, evidence_id TEXT,
      provenance TEXT NOT NULL,
      PRIMARY KEY (run_id, document_id, role, start_label, end_label)
    );
    CREATE TABLE IF NOT EXISTS roster_reference (
      document_id INTEGER PRIMARY KEY, source_sha256 TEXT NOT NULL,
      source TEXT NOT NULL, reference_json TEXT NOT NULL, created_utc TEXT NOT NULL
    );
  `);
  return database;
}

function saveCase(
  database: InstanceType<typeof import("node:sqlite").DatabaseSync>,
  runId: string,
  record: CaseRecord,
  prediction: Prediction | null,
  evidence: Array<{ role: Role; from: string; to: string; evidence_id: string | null }>,
  reference: Reference,
  validation: Validation,
  metrics: Record<string, unknown>,
  resultStatus: string,
) {
  database.prepare("DELETE FROM roster_judge WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare("DELETE FROM roster_span WHERE run_id=? AND document_id=?").run(runId, record.candidate.documentId);
  database.prepare(`
    INSERT OR REPLACE INTO roster_decision
    (run_id,document_id,source_sha256,dataset,citation,name,decision_date,structure_status,paragraph_count,result_status,source_evidence_id,prediction_json,reference_json,validation_json,metrics_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    resultStatus,
    record.sourceEvidence.evidence_id,
    prediction ? JSON.stringify(prediction) : null,
    JSON.stringify(reference),
    JSON.stringify(validation),
    JSON.stringify(metrics),
  );
  for (const [ordinal, judge] of (prediction?.judges ?? []).entries()) {
    database.prepare("INSERT INTO roster_judge VALUES (?,?,?,?,?,?)").run(runId, record.candidate.documentId, ordinal, judge.name, judge.role, "model");
  }
  for (const item of evidence) {
    database.prepare("INSERT INTO roster_span VALUES (?,?,?,?,?,?,?)").run(
      runId,
      record.candidate.documentId,
      item.role,
      item.from,
      item.to,
      item.evidence_id,
      "model",
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
  return [...offsets].sort((a, b) => a - b);
}

export function selectedCandidates(
  seed: number,
  size: number,
  scope: string,
  database?: import("node:sqlite").DatabaseSync,
) {
  const own = !database;
  const open = database ?? withReadonlySqlite(a2ajLocalBulkPath(), (db) => db);
  if (!open) return [];
  try {
    const allIds = candidatePoolIds(scope, open);
    if (!allIds.length) throw new Error(`no A2AJ cases found for scope ${scope}`);
    const drawn = drawOffsets(seed, size, allIds.length).map((offset) => allIds[offset]);
    const byId = new Map<number, Record<string, unknown>>();
    for (let index = 0; index < drawn.length; index += 500) {
      const chunk = drawn.slice(index, index + 500);
      const marks = chunk.map(() => "?").join(",");
      const rows = open
        .prepare(
          `SELECT id, dataset,
            COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) AS citation,
            name_en, document_date_en
          FROM document WHERE id IN (${marks})`,
        )
        .all(...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) byId.set(Number(row.id), row);
    }
    return drawn.map((id) => {
      const row = byId.get(id) ?? {};
      return {
        documentId: Number(id),
        dataset: String(row.dataset ?? ""),
        citation: String(row.citation ?? ""),
        name: row.name_en ? String(row.name_en) : null,
        date: row.document_date_en ? String(row.document_date_en) : null,
      } satisfies Candidate;
    });
  } finally {
    if (own) open.close();
  }
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
  const source = getLocalA2AJStructure(document) ?? getA2AJDocumentSourceDoc(document);
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const sourceEvidence = createA2AJDocumentEvidence(document);
  const structure = analyzeOpinionStructure({
    text: source.text,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  return {
    candidate,
    document,
    source,
    paragraphs,
    sourceEvidence,
    sourceSha256: sha256(source.text),
    structure,
    hints: extractMechanicalHints(source, paragraphs, structure),
    preflight: extractPreflight(source, paragraphs),
  };
}

async function humanReference(database: InstanceType<typeof import("node:sqlite").DatabaseSync>, record: CaseRecord) {
  const row = database.prepare("SELECT source, reference_json FROM roster_reference WHERE document_id=? AND source_sha256=?").get(record.candidate.documentId, record.sourceSha256) as Record<string, unknown> | undefined;
  if (!row) return null;
  const parsed = JSON.parse(String(row.reference_json)) as Prediction;
  return { source: String(row.source) === "human" ? "human" : "mechanical", status: "ready", ...parsed } satisfies Reference;
}

async function runCase(args: {
  record: CaseRecord;
  provider: Provider;
  model: string;
  baseUrl: string;
  hostHeader?: string;
  numCtx: number;
  numPredict: number;
  temperature: number;
  packetChars: number;
  progress: string;
  maxAttempts: number;
  referenceOverride?: Reference | null;
}) {
  const { record } = args;
  const mechanical = mechanicalReference(record);
  const reference = args.referenceOverride ?? mechanical;
  if (!record.paragraphs.length) {
    return {
      status: "structure_unavailable",
      prediction: null,
      evidence: [],
      reference: mechanical,
      validation: { ok: false, error: "A2AJ SourceDoc has no paragraph spine" } satisfies Validation,
      metrics: { reference: null },
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
    });
    return {
      status: "dry",
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
  if (args.provider === "luna") {
    const prompt = `${SYSTEM_PROMPT}\n\nReturn JSON only; do not call tools. The JSON shape is {"judges":[{"name":"...","role":"majority|minority|concurring|unknown"}],"spans":{"majority":[[1,2]],"minority":[],"concurring":[],"unknown":[]}}.\n\n${messages[1].content}`;
    const teacher = runLuna(prompt);
    teacherRaw = teacher.parsed;
    const result = validatePrediction(record, teacherRaw);
    prediction = result.prediction;
    validation = result.validation;
    attempts.push({ provider: "luna", validation, return_code: teacher.returnCode, stderr: teacher.stderr });
    await appendJsonl(args.progress, {
      kind: "model_call",
      phase: "roster",
      provider: "luna",
      tool_calls: [],
      assistant_text_preview: teacher.raw.slice(-1_200),
      validation,
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
    prediction,
    evidence,
    reference,
    validation,
    metrics,
    attempts,
    ...(teacherRaw ? { teacher_raw: teacherRaw } : {}),
  };
}

async function run(args: Args) {
  const seed = Number.isFinite(Number(args.seed)) ? Number(args.seed) : randomInt(0, 2 ** 31 - 1);
  const sampleSize = Math.max(1, parseIntFlag(args, "sample-size", 1));
  const scope = flag(args, "scope", "ALL");
  const provider = flag(args, "provider", "ollama") as Provider;
  if (provider !== "ollama" && provider !== "luna" && provider !== "dry")
    throw new Error("--provider must be ollama, luna, or dry");
  const model = flag(args, "model", DEFAULT_MODEL);
  const runId = flag(args, "run-id", provider === "dry" ? `a2aj-roster-dry-${seed}` : `a2aj-roster-${provider}-${model.replaceAll(":", "-")}-${seed}`);
  const output = flag(args, "out", path.join(RUN_DIR, `${runId}.json`));
  const progress = output.replace(/\.json$/u, ".progress.jsonl");
  const sidecar = flag(args, "sidecar-db", DEFAULT_SIDECAR);
  const numCtx = parseIntFlag(args, "num-ctx", DEFAULT_NUM_CTX);
  const numPredict = parseIntFlag(args, "num-predict", DEFAULT_NUM_PREDICT);
  const packetChars = parseIntFlag(args, "packet-chars", 24_000);
  const temperature = Number(args.temperature ?? 0);
  const baseUrl = flag(args, "base-url", DEFAULT_BASE_URL);
  const hostHeader = flag(args, "host-header", process.env.OLLAMA_HOST_HEADER?.trim() || "");
  const maxAttempts = Math.max(1, parseIntFlag(args, "max-attempts", MAX_ATTEMPTS));
  const database = await initSidecar(sidecar);
  const receipts: unknown[] = [];
  try {
    database.prepare("INSERT OR REPLACE INTO roster_run VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      runId, now(), seed, sampleSize, scope, provider, model,
      provider === "luna" ? "low" : "none", numCtx, numPredict, PROMPT_VERSION,
    );
    await appendJsonl(progress, {
      kind: "run_started",
      run_id: runId,
      arm: "a2aj_decision_roster",
      provider,
      model,
      effort: provider === "luna" ? "low" : "none",
      num_ctx: numCtx,
      sample_size: sampleSize,
      seed,
      scope,
    });
    const candidates = selectedCandidates(seed, sampleSize, scope);
    for (const candidate of candidates) {
      await appendJsonl(progress, { kind: "case_started", document: candidate.documentId, citation: candidate.citation });
      const record = await loadCase(candidate);
      if (!record) {
        receipts.push({ source: candidate, status: "load_failed" });
        continue;
      }
      await appendJsonl(progress, {
        kind: "case_loaded",
        document: candidate.documentId,
        citation: candidate.citation,
        structure_status: record.source.status,
        paragraph_count: record.paragraphs.length,
        source_sha256: record.sourceSha256,
        judge_candidates: record.hints.judgeCandidates,
        opinion_candidates: record.hints.opinions.map(({ role, from, to }) => ({ role, from, to })),
        preflight: record.preflight,
      });
      const result = await runCase({
        record,
        provider,
        model,
        baseUrl,
        hostHeader,
        numCtx,
        numPredict,
        temperature,
        packetChars,
        progress,
        maxAttempts,
        referenceOverride: await humanReference(database, record),
      });
      saveCase(database, runId, record, result.prediction, result.evidence, result.reference, result.validation, result.metrics, result.status);
      receipts.push({
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
        },
        mechanical: record.hints,
        preflight: record.preflight,
        ...result,
      });
      await appendJsonl(progress, { kind: "case_finished", document: candidate.documentId, status: result.status, metrics: result.metrics });
    }
    const receipt = {
      run_id: runId,
      created_utc: now(),
      status: "finished",
      seed,
      sample_size: sampleSize,
      scope,
      provider,
      model,
      effort: provider === "luna" ? "low" : "none",
      num_ctx: numCtx,
      num_predict: numPredict,
      prompt_version: PROMPT_VERSION,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: true, cases: receipts.length, output });
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
      sample_size: sampleSize,
      scope,
      provider,
      model,
      effort: provider === "luna" ? "low" : "none",
      num_ctx: numCtx,
      num_predict: numPredict,
      prompt_version: PROMPT_VERSION,
      sidecar_db: sidecar,
      base_url: baseUrl,
      host_header: hostHeader || null,
      receipts,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await appendJsonl(progress, { kind: "run_finished", run_id: runId, ok: false, error: message, output });
    throw error;
  }
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
  database.prepare("INSERT OR REPLACE INTO roster_reference VALUES (?,?,?,?,?)").run(
    documentId,
    record.sourceSha256,
    "human",
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

function predictionFromReceipt(value: unknown): Prediction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prediction = (value as Record<string, unknown>).prediction;
  if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) return null;
  return prediction as Prediction;
}

function judgeKeySet(prediction: Prediction | null) {
  return new Set(
    (prediction?.judges ?? []).map((judge) => `${compact(judge.name).toLocaleLowerCase()}|${judge.role}`),
  );
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

function predictionRoleMap(prediction: Prediction | null, available: number[]) {
  const roles = new Map<number, Role>();
  if (!prediction) return roles;
  for (const role of ROLE_KEYS) {
    for (const range of prediction.spans?.[role] ?? []) {
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
      span_exact: Boolean(lunaPrediction && qwenPrediction && JSON.stringify(lunaPrediction.spans) === JSON.stringify(qwenPrediction.spans)),
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
    "[1] Majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler without any experiment-local paragraph parsing.\n",
    "[2] More majority reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler without any experiment-local paragraph parsing.\n",
    "[3] Dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler without any experiment-local paragraph parsing.\n",
    "[4] More dissent reasoning contains enough ordinary substantive source text to establish a reliable paragraph block for this structural self test and to exercise the canonical A2AJ paragraph compiler without any experiment-local paragraph parsing.\n",
  ].join("");
  const { compileA2AJSourceDoc } = await import("../../backend/src/lib/sourceDocA2AJ");
  const source = compileA2AJSourceDoc({ citation: "2099 SCC 1", dataset: "SCC", docType: "cases", text: recordText });
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  if (paragraphs.map((block) => block.label).join(",") !== "par1,par2,par3,par4") throw new Error(`SourceDoc self-test failed: ${paragraphs.map((block) => block.label).join(",")}`);
  const candidate: Candidate = { documentId: 1, dataset: "SCC", citation: "2099 SCC 1", name: "Example", date: "2099" };
  const document = { docType: "cases", dataset: "SCC", citation: candidate.citation, alternateCitation: null, name: candidate.name, date: candidate.date, url: null, text: recordText, language: "en", upstreamLicense: null, structure: { status: "usable", source: "flat_text", counts: { paragraph: 4, page: 0, section: 0 } } } satisfies A2AJDocument;
  const structure = analyzeOpinionStructure({ text: source.text, firstParagraphStart: paragraphs[0]?.start ?? 0 });
  const record: CaseRecord = { candidate, document, source, paragraphs, sourceEvidence: createA2AJDocumentEvidence(document), sourceSha256: sha256(recordText), structure, hints: extractMechanicalHints(source, paragraphs, structure), preflight: extractPreflight(source, paragraphs) };
  const result = validatePrediction(record, { judges: [{ name: "Alpha", role: "majority" }, { name: "Beta", role: "majority" }, { name: "Gamma", role: "minority" }], spans: { majority: [[1, 2]], minority: [[3, 4]], concurring: [], unknown: [] } });
  if (!result.validation.ok || !result.prediction) throw new Error(json(result.validation));
  if (mechanicalReference(record).status !== "ready") throw new Error("mechanical reference self-test failed");
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
  else if (command === "annotate") await annotate(args);
  else if (command === "compare") await compareRuns(args);
  else throw new Error("commands: self-test | run | annotate | compare");
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
