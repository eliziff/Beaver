#!/usr/bin/env node

import { createHash, randomInt, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  a2ajLocalBulkPath,
  fetchLocalA2AJDocumentsByIds,
} from "../../src/lib/a2ajLocalBulk";
import type { StreamChatParams } from "../../src/lib/llm";
import type { A2AJDocument } from "../../src/lib/legalSources/a2aj";
import { withReadonlySqlite } from "../../src/lib/legalDataPath";
import { setBelowNormalProcessPriority } from "../../src/lib/processPriority";
import {
  structureNative,
  type NativeDocument,
} from "../../src/lib/structureNative";
import { decisionCitationInventory } from "../a2aj-decision-roster/caseDecisionMvp";
import { modelSourceLines } from "../a2aj-decision-roster/caseTargetMvpReduced";
import { analyzeTextOpinionStructure } from "../a2aj-decision-roster/legalOpinionBoundaries";
import {
  analysisOutputSchema,
  analysisPrompt,
  ANALYSIS_INSTRUCTIONS,
  authorityInventoryOutputSchema,
  authorityInventoryPrompt,
  AUTHORITY_INVENTORY_INSTRUCTIONS,
  CASE_TREATMENT_CONTRACT_VERSION,
  compareStructureMechanics,
  compareDeterministicStructure,
  compileAnalysis,
  compileAuthorityInventory,
  compileStructure,
  compileSubmission,
  oneStagePrompt,
  paragraphCoverageEnd,
  propositionSupport,
  SEMANTIC_JUDGE_SCHEMA,
  semanticJudgePrompt,
  semanticJudgeResultErrors,
  semanticJudgeScore,
  semanticView,
  structureOutputSchema,
  structurePrompt,
  structurePromptWithHints,
  STRUCTURE_INSTRUCTIONS,
  submissionOutputSchema,
  type AnalysisCompilation,
  type AuthorityInventory,
  type AuthorityInventoryCompilation,
  type CaseMaterial,
  type CaseTreatmentSubmission,
  type DecisionAnalysis,
  type DecisionStructure,
  type GoldRecord,
  type StructureCompilation,
  type SubmissionCompilation,
} from "./contract";
import {
  OX_ALPHA_ROUTES,
  assignedOxAlphaRoute,
  oxAlphaCredentials,
  oxAlphaRoutes,
  preflightOxAlpha,
  streamOxAlpha,
  type OxAlphaCredentials,
  type OxAlphaRoute,
} from "./oxAlpha";

let usedCodexAppServer = false;

const COURT_DATASETS = [
  "BCCA", "BCSC", "CMAC", "FC", "FCA", "NSCA", "NSFC", "NSPC", "NSSC",
  "NSSM", "ONCA", "SCC", "TCC", "YKCA",
] as const;

type Flags = Record<string, string | true>;
type Json = Record<string, unknown>;
type ModelCallResult = {
  call_id: string;
  raw: string;
  parsed: unknown;
  error: string | null;
  continuation_id: string | null;
  elapsed_seconds: number;
  usage: unknown;
  output_sha256: string;
};
type StartLimiter = { wait(): Promise<void> };

const now = () => new Date().toISOString();
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function parseFlags(values: string[]) {
  const flags: Flags = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`unexpected argument ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) flags[value.slice(2)] = true;
    else { flags[value.slice(2)] = next; index += 1; }
  }
  return flags;
}

function flag(flags: Flags, name: string, fallback = "") {
  const value = flags[name];
  return typeof value === "string" ? value : fallback;
}

function numberFlag(flags: Flags, name: string, fallback: number, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(flag(flags, name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`--${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function parseIds(value: string) {
  const ids = value.split(/[\s,]+/u).filter(Boolean).map(Number);
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error("case selectors must contain positive A2AJ document IDs");
  }
  return [...new Set(ids)];
}

async function idsFromFile(filename: string) {
  const raw = await readFile(path.resolve(filename), "utf8");
  try {
    const value = JSON.parse(raw) as unknown;
    if (Array.isArray(value)) return parseIds(value.join(","));
    if (value && typeof value === "object") {
      const item = value as { document_ids?: unknown; cases?: Array<{ document_id?: unknown }> };
      if (Array.isArray(item.document_ids)) return parseIds(item.document_ids.join(","));
      if (Array.isArray(item.cases)) return parseIds(item.cases.map(({ document_id }) => document_id).join(","));
    }
  } catch {
    const ids = raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        if (typeof value === "number") return [value];
        if (value && typeof value === "object" && "document_id" in value) {
          return [Number((value as { document_id: unknown }).document_id)];
        }
      } catch { /* Fall through to plain ID parsing. */ }
      return [];
    });
    if (ids.length) return parseIds(ids.join(","));
  }
  return parseIds(raw);
}

async function selectedIds(flags: Flags) {
  const direct = flag(flags, "document-ids");
  const file = flag(flags, "case-file");
  if (Boolean(direct) === Boolean(file)) throw new Error("use exactly one of --document-ids or --case-file");
  return direct ? parseIds(direct) : idsFromFile(file);
}

async function readJsonl<T>(filename: string) {
  if (!existsSync(filename)) return [];
  const text = await readFile(filename, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as T; }
    catch { throw new Error(`${filename}:${index + 1}: invalid JSON`); }
  });
}

async function forEachJsonl<T>(filename: string, visit: (value: T) => void) {
  if (!existsSync(filename)) return;
  let lineNumber = 0;
  const lines = createInterface({ input: createReadStream(filename, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    lineNumber += 1;
    if (!line) continue;
    try { visit(JSON.parse(line) as T); }
    catch { throw new Error(`${filename}:${lineNumber}: invalid JSON`); }
  }
}

class JsonlWriter {
  private tail = Promise.resolve();
  private readonly handle: ReturnType<typeof open>;
  constructor(private readonly filename: string) {
    this.handle = open(this.filename, "a");
  }
  append(value: unknown) {
    this.tail = this.tail.then(async () => {
      await (await this.handle).appendFile(`${JSON.stringify(value)}\n`, "utf8");
    });
    return this.tail;
  }
  flush() { return this.tail; }
  async close() {
    await this.tail;
    await (await this.handle).close();
  }
}

class EvenStartLimiter implements StartLimiter {
  private queue = Promise.resolve();
  private nextStart = 0;

  constructor(requestsPerMinute: number) {
    const interval = Math.ceil(60_000 / requestsPerMinute);
    this.wait = () => {
      const turn = this.queue.then(async () => {
        const delay = Math.max(0, this.nextStart - Date.now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        this.nextStart = Date.now() + interval;
      });
      this.queue = turn.catch(() => undefined);
      return turn;
    };
  }

  wait: () => Promise<void>;
}

function substantiveParagraph(text: string) {
  const compact = text.replace(/\s+/gu, " ").trim();
  if ((compact.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0) < 8) return false;
  if (/^(?:reasons?|judgment|decision)(?:\s+of|\s+for|\s+by)?\b[^.!?]{0,160}$/iu.test(compact)) return false;
  if (/^(?:the\s+honourable\s+)?[\p{L}\p{M}.'’\-]+(?:\s+[\p{L}\p{M}.'’\-]+){0,5}\s+(?:C\.?J\.?|J\.?A\.?|J\.?)$/iu.test(compact)) return false;
  if (/^(?:solicitors?|counsel|appearances?|coram|present|heard|released|date|docket|file\s+no\.?|citation)\b/iu.test(compact)) return false;
  return true;
}

function coverage(
  source: NativeDocument,
  deterministic: NonNullable<CaseMaterial["deterministic_structure"]>,
): CaseMaterial["coverage"] {
  if (deterministic.status !== "ready") return { status: "not_asserted", spans: [] };
  const sourceText = structureNative().documentText(source);
  const spans = structureNative().documentAnchors(source).filter(({ kind }) => kind === "paragraph").flatMap((block) => {
    const text = sourceText.slice(block.start, block.end);
    const start = block.start + (text.match(/^\s*/u)?.[0].length ?? 0);
    const trimmedEnd = block.start + paragraphCoverageEnd(text);
    const insideKnownOpinion = deterministic.opinions.some((opinion) =>
      start >= opinion.start && trimmedEnd <= opinion.end
    );
    return insideKnownOpinion && substantiveParagraph(text)
      ? [{ start, end: trimmedEnd, label: block.label }]
      : [];
  });
  return { status: spans.length ? "asserted" : "not_asserted", spans };
}

async function sourceFor(document: A2AJDocument) {
  return structureNative().deriveDocumentStructure({
    kind: "a2aj",
    input: {
      citation: document.citation,
      source_kind: document.docType ?? "cases",
      text: document.sectionMap ? "" : document.text,
      url: document.url,
      alternate_citation: document.alternateCitation,
      dataset: document.dataset,
      name: document.name,
      section_map: document.sectionMap ? Object.entries(document.sectionMap) : undefined,
    },
  });
}

function materialFromSource(documentId: number, document: A2AJDocument, source: NativeDocument): CaseMaterial {
  const text = structureNative().documentText(source);
  const paragraphs = structureNative().documentAnchors(source).filter(({ kind }) => kind === "paragraph");
  const deterministic = analyzeTextOpinionStructure({
    text,
    paragraphs: paragraphs.map(({ label, start, end }) => ({ label, start, end })),
    firstParagraphStart: paragraphs[0]?.start,
  }).deterministic;
  const deterministicStructure: NonNullable<CaseMaterial["deterministic_structure"]> = {
    status: deterministic.status,
    panel: deterministic.panel,
    nonparticipants: deterministic.nonparticipants,
    opinions: deterministic.opinions.map((opinion) => ({
      id: opinion.id,
      authors: opinion.authors,
      joiners: opinion.joiners ?? [],
      alignment: opinion.alignment,
      start: opinion.start,
      end: opinion.end,
      start_quote: opinion.startQuote,
      end_quote: opinion.endQuote,
      substantive_words: opinion.substantiveWords,
    })),
    judges: deterministic.judges.map((judge) => ({
      name: judge.name,
      result_side: judge.resultSide,
      relationship: judge.relationship,
      opinion_ids: judge.opinionIds,
    })),
    refusals: deterministic.refusals,
  };
  return {
    document_id: documentId,
    citation: document.citation,
    name: document.name,
    date: document.date,
    dataset: document.dataset,
    language: document.language,
    url: document.url,
    text,
    source_lines: modelSourceLines(text),
    citation_inventory: decisionCitationInventory(
      text,
      document.citation,
      paragraphs.at(-1)?.end ?? text.length,
      { extendedUsFallback: false },
    ),
    deterministic_structure: deterministicStructure,
    coverage: coverage(source, deterministicStructure),
  };
}

async function materialFor(documentId: number, document: A2AJDocument) {
  return materialFromSource(documentId, document, await sourceFor(document));
}

async function materialsFor(ids: readonly number[], documents: Map<number, A2AJDocument>) {
  const selected = ids.map((id) => documents.get(id)!);
  const sources = await Promise.all(selected.map(sourceFor));
  return new Map(ids.map((id, index) => [id, materialFromSource(id, selected[index], sources[index])]));
}

async function forEachMaterial(
  ids: readonly number[],
  workers: number,
  work: (material: CaseMaterial, index: number, worker: number) => Promise<void>,
) {
  for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256);
    const materials = await materialsFor(batch, documentsFor(batch));
    await workerPool(batch, workers, (id, index, worker) => work(materials.get(id)!, offset + index, worker));
  }
}

function materialLoader(ids: readonly number[], batchSize: number) {
  type Entry = { remaining: number; promise: Promise<Map<number, CaseMaterial>> };
  const batches = new Map<number, Entry>();
  return async (index: number) => {
    const batchIndex = Math.floor(index / batchSize);
    let entry = batches.get(batchIndex);
    if (!entry) {
      const batch = ids.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
      entry = {
        remaining: batch.length,
        promise: Promise.resolve().then(() => materialsFor(batch, documentsFor(batch))),
      };
      batches.set(batchIndex, entry);
    }
    const release = () => {
      if (--entry!.remaining === 0) batches.delete(batchIndex);
    };
    try {
      const materials = await entry.promise;
      return { material: materials.get(ids[index])!, release };
    } catch (error) {
      release();
      throw error;
    }
  };
}

function documentsFor(ids: number[]) {
  const documents = fetchLocalA2AJDocumentsByIds({ ids, docType: "cases", language: "en", maxChars: Number.MAX_SAFE_INTEGER });
  const missing = ids.filter((id) => !documents.has(id));
  if (missing.length) throw new Error(`A2AJ decisions unavailable: ${missing.join(", ")}`);
  return documents;
}

function drawOffsets(seed: number, count: number, length: number) {
  const wanted = Math.min(count, length);
  let state = (seed >>> 0) || 1;
  const next = () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const offsets = new Set<number>();
  while (offsets.size < wanted) offsets.add(Math.floor(next() * length));
  return [...offsets];
}

function datasetSeed(seed: number, dataset: string) {
  let value = seed >>> 0;
  for (const character of dataset.toLocaleUpperCase()) value = Math.imul(value ^ character.codePointAt(0)!, 16_777_619) >>> 0;
  return value || 1;
}

type SelectionRow = {
  id: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
};

function eligibleSelectionRows(
  database: import("node:sqlite").DatabaseSync,
  ids: readonly number[],
) {
  if (!ids.length) return new Map<number, SelectionRow>();
  const rows = database.prepare(`
    SELECT id, dataset,
      COALESCE(NULLIF(citation_en,''),NULLIF(citation2_en,'')) AS citation,
      name_en AS name, document_date_en AS date
    FROM document
    WHERE id IN (${ids.map(() => "?").join(",")})
      AND unofficial_text_en IS NOT NULL
      AND COALESCE(NULLIF(citation_en,''),NULLIF(citation2_en,'')) IS NOT NULL
  `).all(...ids) as SelectionRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function randomEligibleSelection(
  database: import("node:sqlite").DatabaseSync,
  pool: readonly number[],
  seed: number,
  count: number,
) {
  if (!count) return [];
  let probed = Math.min(pool.length, Math.max(count + 32, count * 2));
  while (probed) {
    const drawn = drawOffsets(seed, probed, pool.length).map((offset) => pool[offset]);
    const eligible = eligibleSelectionRows(database, drawn);
    const selected = drawn.flatMap((id) => eligible.get(id) ?? []).slice(0, count);
    if (selected.length === count || probed === pool.length) return selected;
    probed = Math.min(pool.length, probed * 2);
  }
  return [];
}

async function selectCases(flags: Flags) {
  const count = Math.floor(numberFlag(flags, "count", 30, 1, 100_000));
  const seed = Math.floor(numberFlag(flags, "seed", randomInt(1, 2 ** 31), 1, 2 ** 32 - 1));
  const scope = flag(flags, "scope", "ALL").toLocaleUpperCase();
  const courtOnly = flags["all-sources"] !== true;
  const stratified = flags.random !== true && scope === "ALL";
  const excluded = new Set<number>([
    ...(flag(flags, "exclude-document-ids") ? parseIds(flag(flags, "exclude-document-ids")) : []),
    ...(flag(flags, "exclude-file") ? await idsFromFile(flag(flags, "exclude-file")) : []),
  ]);
  const selection = withReadonlySqlite(a2ajLocalBulkPath(), (database) => {
    const filters = ["doc_type='cases'"];
    const values: string[] = [];
    if (scope !== "ALL") { filters.push("UPPER(dataset)=?"); values.push(scope); }
    else if (courtOnly) {
      filters.push(`UPPER(dataset) IN (${COURT_DATASETS.map(() => "?").join(",")})`);
      values.push(...COURT_DATASETS);
    }
    const poolRows = database.prepare(`
      SELECT id, dataset
      FROM document INDEXED BY document_dataset_idx
      WHERE ${filters.join(" AND ")} ORDER BY dataset, id
    `).all(...values) as Array<{ id: number; dataset: string }>;
    const usablePool = poolRows.filter(({ id }) => !excluded.has(id));
    if (!usablePool.length) return { poolRows, selected: [] as SelectionRow[] };
    if (!stratified) {
      return {
        poolRows,
        selected: randomEligibleSelection(database, usablePool.map(({ id }) => id), seed, count),
      };
    }
    const buckets = new Map<string, number[]>();
    for (const row of usablePool) {
      const bucket = buckets.get(row.dataset) ?? [];
      bucket.push(row.id);
      buckets.set(row.dataset, bucket);
    }
    const ordered = [...buckets].sort(([left], [right]) => left.localeCompare(right));
    const quotas = new Map(ordered.map(([dataset], index) => [
      dataset,
      Math.floor(count / ordered.length) + (index < count % ordered.length ? 1 : 0),
    ]));
    const selectedBuckets = ordered.map(([dataset, ids]) =>
      randomEligibleSelection(database, ids, datasetSeed(seed, dataset), quotas.get(dataset)!)
    );
    const selected: SelectionRow[] = [];
    for (let index = 0; selected.length < count && selectedBuckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of selectedBuckets) {
        if (bucket[index]) selected.push(bucket[index]);
        if (selected.length === count) break;
      }
    }
    return { poolRows, selected };
  });
  if (!selection) throw new Error("the local A2AJ database is unavailable");
  const { poolRows, selected } = selection;
  if (selected.length < count) throw new Error(`only ${selected.length} eligible A2AJ decisions found for a ${count}-case selection`);
  const output = path.resolve(flag(flags, "out", "selection.json"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({
    format: `${CASE_TREATMENT_CONTRACT_VERSION}-selection`,
    seed,
    requested: count,
    selected: selected.length,
    court_only: courtOnly,
    scope,
    sampling: stratified ? "seeded_random_within_dataset_round_robin" : "seeded_random",
    candidate_pool_before_exclusions: poolRows.length,
    excluded_document_ids: [...excluded].sort((left, right) => left - right),
    court_datasets: courtOnly ? COURT_DATASETS : null,
    document_ids: selected.map(({ id }) => id),
    cases: selected.map(({ id: document_id, ...item }) => ({ document_id, ...item })),
  }, null, 2)}\n`, "utf8");
  console.log(`${output}\nseed=${seed} cases=${selected.length}`);
}

function candidatePacket(material: CaseMaterial) {
  const lineRange = (start: number, end: number) => {
    const hits = material.source_lines.filter((line) => line.end > start && line.start < end);
    return hits.length ? [hits[0].line, hits.at(-1)!.line] : [null, null];
  };
  return [
    JSON.stringify({
      document_id: material.document_id,
      citation: material.citation,
      name: material.name,
      date: material.date,
      dataset: material.dataset,
      source_sha256: sha256(material.text),
      coverage: { status: material.coverage.status, substantive_spans: material.coverage.spans.length },
      detector_candidates: material.citation_inventory.occurrences.map((occurrence) => ({
        id: occurrence.id,
        lines: lineRange(occurrence.start, occurrence.end),
        exact_text: occurrence.quote,
      })),
      deterministic_structure: material.deterministic_structure ? {
        status: material.deterministic_structure.status,
        opinions: material.deterministic_structure.opinions.length,
        panel_members: material.deterministic_structure.panel.length,
        refusals: material.deterministic_structure.refusals,
      } : null,
    }, null, 2),
    "",
    ...material.source_lines.map((line) => `${String(line.line).padStart(5, "0")} | ${material.text.slice(line.start, line.end)}`),
  ].join("\n");
}

async function showCase(flags: Flags) {
  const [id] = await selectedIds(flags);
  const document = documentsFor([id]).get(id)!;
  console.log(candidatePacket(await materialFor(id, document)));
}

async function writePackets(flags: Flags) {
  const ids = await selectedIds(flags);
  const out = path.resolve(flag(flags, "out-dir"));
  if (!flag(flags, "out-dir")) throw new Error("packets requires --out-dir");
  await mkdir(out, { recursive: true });
  const report = progressLine("packets", ids.length);
  let completed = 0;
  await forEachMaterial(ids, Math.floor(numberFlag(flags, "workers", 8, 1, 32)), async (material) => {
    await writeFile(path.join(out, `${material.document_id}.txt`), `${candidatePacket(material)}\n`, "utf8");
    report(++completed);
  });
}

async function readGold(filename: string) {
  const rows = await readJsonl<GoldRecord>(path.resolve(filename));
  if (!rows.length) throw new Error("gold JSONL is empty");
  const ids = rows.map(({ document_id }) => document_id);
  if (new Set(ids).size !== ids.length) throw new Error("gold contains duplicate document IDs");
  return rows;
}

async function validateGold(flags: Flags) {
  const goldFile = flag(flags, "gold");
  if (!goldFile) throw new Error("validate-gold requires --gold");
  const rows = await readGold(goldFile);
  const results = new Array<Json>(rows.length);
  const byId = new Map(rows.map((row) => [row.document_id, row]));
  const report = progressLine("validated", rows.length);
  let completed = 0;
  await forEachMaterial(rows.map(({ document_id }) => document_id), Math.floor(numberFlag(flags, "workers", 8, 1, 32)), async (material, index) => {
    const row = byId.get(material.document_id)!;
    const errors = row.citation !== material.citation ? [`citation mismatch: ${row.citation} != ${material.citation}`] : [];
    if (row.source_sha256 !== sha256(material.text)) errors.push("source_sha256 does not match the exact source text");
    const compilation = compileSubmission(row.annotation, material);
    errors.push(...compilation.errors);
    results[index] = {
      document_id: row.document_id,
      citation: row.citation,
      ok: errors.length === 0,
      errors: [...new Set(errors)],
      coverage: compilation.structure.coverage,
      citation_coverage: compilation.analysis?.citation_coverage ?? null,
    };
    report(++completed);
  });
  const summary = { cases: rows.length, valid: results.filter(({ ok }) => ok).length, results };
  const output = flag(flags, "out");
  if (output) await writeFile(path.resolve(output), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    cases: summary.cases,
    valid: summary.valid,
    invalid: summary.cases - summary.valid,
    output: output ? path.resolve(output) : null,
    ...(!output && summary.valid !== summary.cases ? { failures: results.filter(({ ok }) => !ok) } : {}),
  }, null, 2));
  if (summary.valid !== rows.length) process.exitCode = 1;
}

async function workerPool<T>(items: readonly T[], size: number, work: (item: T, index: number, worker: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async (_, worker) => {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index, worker);
    }
  }));
}

/**
 * Repairs one specific recurring defect: copied source text containing
 * unescaped double quotation marks inside JSON string values (for example
 * "start_quote": ""Ball J.""). A quote inside a string terminates it only
 * when the next significant character is a JSON structure character;
 * anything else must have been an escaped content quote.
 */
function repairUnescapedQuotes(text: string) {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!inString) {
      if (character === '"') inString = true;
      out += character;
      continue;
    }
    if (character === "\\") {
      out += character + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (character !== '"') {
      out += character;
      continue;
    }
    let lookahead = index + 1;
    while (lookahead < text.length && /\s/u.test(text[lookahead])) lookahead += 1;
    const next = text[lookahead];
    if (next === undefined || /[,}\]:]/u.test(next)) {
      inString = false;
      out += character;
    } else {
      out += '\\"';
    }
  }
  return out;
}

export function parseJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Deterministic salvage only: raw bytes stay verbatim in the raw ledger.
  // Only the outermost value is eligible; a silently extracted nested
  // fragment would corrupt the draft worse than an explicit parse failure.
  const unfenced = trimmed.replace(/^```(?:json)?\s*/u, "").replace(/```\s*$/u, "");
  try { return JSON.parse(unfenced) as unknown; }
  catch { /* Fall through to targeted repairs. */ }
  try { return JSON.parse(repairUnescapedQuotes(unfenced)) as unknown; }
  catch { /* Fall through to balanced-value extraction. */ }
  const start = unfenced.search(/[{[]/u);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(unfenced.slice(start, index + 1)) as unknown; }
        catch { return null; }
      }
    }
  }
  return null;
}

/** Stateless gateways ignore structured-output fields; hand them the schema in prose. */
export function embedSchemaInPrompt(prompt: string, schema: Record<string, unknown>) {
  return `${prompt}\n\n[OUTPUT JSON SCHEMA]\n${JSON.stringify(schema)}`;
}

function progressLine(label: string, total: number) {
  let last = 0;
  return (completed: number) => {
    const current = performance.now();
    if (completed !== total && current - last < 100) return;
    last = current;
    process.stderr.write(`\r${label} ${completed}/${total}${completed === total ? "\n" : ""}`);
  };
}

async function callCount(filename: string) {
  let count = 0;
  await forEachJsonl<{ kind?: string }>(filename, ({ kind }) => {
    if (kind === "model_call_started") count += 1;
  });
  return count;
}

async function callStats(filename: string) {
  let total = 0;
  const byRoute = new Map<string, number>();
  await forEachJsonl<{ kind?: string; route?: unknown }>(filename, ({ kind, route }) => {
    if (kind !== "model_call_started") return;
    total += 1;
    const key = String(route ?? "");
    byRoute.set(key, (byRoute.get(key) ?? 0) + 1);
  });
  return { total, byRoute };
}

function relevantGrounding(errors: string[], grounding: Array<{ path: string; exact_text: string; start: number; end: number }>) {
  const indexedPaths = errors.flatMap((error) => {
    const match = /((?:structure|analysis)\.[a-z_]+\[\d+\])/u.exec(error);
    return match ? [match[1]] : [];
  });
  return grounding.filter(({ path }) => indexedPaths.some((prefix) => path.startsWith(prefix))).slice(0, 20).map((receipt) => ({
    path: receipt.path,
    start: receipt.start,
    end: receipt.end,
    exact_text: receipt.exact_text.length > 4_000 ? `${receipt.exact_text.slice(0, 4_000)}…` : receipt.exact_text,
  }));
}

function correctionPrompt(errors: string[], grounding: Array<{ path: string; exact_text: string; start: number; end: number }>) {
  return [
    "Return only an RFC 6902 JSON Patch array that corrects your previous JSON.",
    "Every operation path is an RFC 6902 pointer into that previous JSON. Prefer targeted operations on the fields implicated by the validation errors; do not repeat unchanged content.",
    "Use only add, replace, or remove operations.",
    "Validation errors:",
    ...errors.slice(0, 60).map((error) => `- ${error}`),
    "Exact source receipts for affected fields:",
    JSON.stringify(relevantGrounding(errors, grounding)),
  ].join("\n");
}

function statelessCorrectionPrompt(
  originalPrompt: string,
  previousDraft: unknown,
  errors: string[],
  grounding: Array<{ path: string; exact_text: string; start: number; end: number }>,
) {
  return [
    originalPrompt,
    "[PREVIOUS JSON DRAFT]",
    JSON.stringify(previousDraft),
    correctionPrompt(errors, grounding),
  ].join("\n\n");
}

type JsonPatchOperation = { op: "add" | "replace" | "remove"; path: string; value?: unknown };

function jsonPointerParts(pointer: string) {
  if (!pointer.startsWith("/") || pointer === "/") throw new Error(`unsupported JSON Pointer ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?:[^01]|$)/u.test(part)) throw new Error(`invalid JSON Pointer escape in ${JSON.stringify(pointer)}`);
    const decoded = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (["__proto__", "prototype", "constructor"].includes(decoded)) throw new Error(`unsafe JSON Pointer ${JSON.stringify(pointer)}`);
    return decoded;
  });
}

export function applyJsonPatch(document: unknown, rawPatch: unknown) {
  if (!Array.isArray(rawPatch)) return { value: document, errors: ["correction: expected a JSON Patch array"] };
  if (rawPatch.length > 60) return { value: document, errors: ["correction: patch exceeds 60 operations"] };
  let value = structuredClone(document);
  try {
    for (const [index, raw] of rawPatch.entries()) {
      const operation = raw as Partial<JsonPatchOperation> | null;
      if (!operation || typeof operation !== "object" || !["add", "replace", "remove"].includes(String(operation.op)) || typeof operation.path !== "string") {
        throw new Error(`operation ${index + 1} is invalid`);
      }
      // RFC 6902: the empty pointer addresses the whole document.
      if (operation.path === "") {
        if (operation.op === "remove") throw new Error(`operation ${index + 1} cannot remove the root document`);
        if (!Object.hasOwn(operation, "value")) throw new Error(`operation ${index + 1} requires value`);
        value = structuredClone(operation.value);
        continue;
      }
      const parts = jsonPointerParts(operation.path);
      let parent: unknown = value;
      for (const part of parts.slice(0, -1)) {
        if (Array.isArray(parent)) {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(part) || Number(part) >= parent.length) throw new Error(`operation ${index + 1} path does not exist`);
          parent = parent[Number(part)];
        } else if (parent && typeof parent === "object" && Object.hasOwn(parent, part)) {
          parent = (parent as Record<string, unknown>)[part];
        } else throw new Error(`operation ${index + 1} path does not exist`);
      }
      const key = parts.at(-1)!;
      const op = operation.op as JsonPatchOperation["op"];
      if (op !== "remove" && !Object.hasOwn(operation, "value")) throw new Error(`operation ${index + 1} requires value`);
      if (Array.isArray(parent)) {
        if (op === "add" && key === "-") parent.push(operation.value);
        else {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) throw new Error(`operation ${index + 1} has an invalid array index`);
          const position = Number(key);
          if (op === "add") {
            if (position > parent.length) throw new Error(`operation ${index + 1} path does not exist`);
            parent.splice(position, 0, operation.value);
          } else {
            if (position >= parent.length) throw new Error(`operation ${index + 1} path does not exist`);
            if (op === "remove") parent.splice(position, 1);
            else parent[position] = operation.value;
          }
        }
      } else if (parent && typeof parent === "object") {
        const target = parent as Record<string, unknown>;
        if (op !== "add" && !Object.hasOwn(target, key)) throw new Error(`operation ${index + 1} path does not exist`);
        if (op === "remove") delete target[key];
        else target[key] = operation.value;
      } else throw new Error(`operation ${index + 1} parent is not a container`);
    }
    return { value, errors: [] as string[] };
  } catch (error) {
    return { value: document, errors: [`correction: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

async function modelCall(args: {
  prompt: string;
  schema?: Record<string, unknown>;
  model: string;
  effort: string;
  max_output_tokens: number;
  timeout_seconds: number;
  continuation_id?: string;
  ox_route?: OxAlphaRoute;
  ox_credentials?: OxAlphaCredentials;
  start_limiter?: StartLimiter;
  raw: JsonlWriter;
  ledger: JsonlWriter;
  document_id: number;
  stage: string;
  attempt: number;
}): Promise<ModelCallResult> {
  await args.start_limiter?.wait();
  const callId = randomUUID();
  const started = performance.now();
  const promptHash = sha256(args.prompt);
  await args.ledger.append({
    utc: now(), kind: "model_call_started", call_id: callId, document_id: args.document_id,
    stage: args.stage, attempt: args.attempt, model: args.model, effort: args.effort,
    route: args.ox_route ?? "codex-app-server",
    prompt_sha256: promptHash, prompt_chars: args.prompt.length,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeout_seconds * 1_000);
  let pending = "";
  let pendingReasoning = "";
  let streamed = "";
  const flush = () => {
    if (!pending) return;
    const text = pending;
    pending = "";
    void args.raw.append({ utc: now(), kind: "raw_delta", call_id: callId, document_id: args.document_id, stage: args.stage, attempt: args.attempt, text });
  };
  const flushReasoning = () => {
    if (!pendingReasoning) return;
    const text = pendingReasoning;
    pendingReasoning = "";
    void args.raw.append({ utc: now(), kind: "raw_reasoning_delta", call_id: callId, document_id: args.document_id, stage: args.stage, attempt: args.attempt, text });
  };
  try {
    const params: StreamChatParams = {
      model: args.ox_route ? args.model : args.model.startsWith("codex:") ? args.model : `codex:${args.model}`,
      reasoningEffort: args.effort,
      systemPrompt: "Use only the supplied decision. Return exactly the requested JSON object without commentary. Encode copied text as valid JSON, escaping quotation marks inside it.",
      messages: [{
        role: "user",
        content: args.schema && args.ox_route
          ? embedSchemaInPrompt(args.prompt, args.schema)
          : args.prompt,
      }],
      maxTokens: args.max_output_tokens,
      ...(args.schema ? { outputSchema: args.schema } : {}),
      abortSignal: controller.signal,
      callbacks: {
        onContentDelta(text) {
          streamed += text;
          pending += text;
          if (pending.length >= 4_096) flush();
        },
        onReasoningDelta(text: string) {
          pendingReasoning += text;
          if (pendingReasoning.length >= 4_096) flushReasoning();
        },
      },
    };
    let result;
    if (args.ox_route) result = await streamOxAlpha(params, args.ox_route, args.ox_credentials!);
    else {
      usedCodexAppServer = true;
      const { streamChatWithTools } = await import("../../src/lib/llm");
      result = await streamChatWithTools({
        ...params,
        providerSession: { persist: true, ...(args.continuation_id ? { continuationId: args.continuation_id } : {}) },
      });
    }
    flush();
    flushReasoning();
    await args.raw.flush();
    if (streamed !== result.fullText) {
      await args.raw.append({ utc: now(), kind: "raw_snapshot", call_id: callId, document_id: args.document_id, stage: args.stage, attempt: args.attempt, text: result.fullText });
    }
    const elapsed = Math.round((performance.now() - started) / 10) / 100;
    const outputHash = sha256(result.fullText);
    await args.raw.append({ utc: now(), kind: "raw_complete", call_id: callId, document_id: args.document_id, stage: args.stage, attempt: args.attempt, output_sha256: outputHash });
    await args.ledger.append({
      utc: now(), kind: "model_call_finished", call_id: callId, document_id: args.document_id,
      stage: args.stage, attempt: args.attempt, status: "completed", elapsed_seconds: elapsed,
      usage: result.usage ?? null, output_sha256: outputHash,
    });
    return {
      call_id: callId,
      raw: result.fullText,
      parsed: parseJson(result.fullText),
      error: null,
      continuation_id: result.continuationId ?? null,
      elapsed_seconds: elapsed,
      usage: result.usage ?? null,
      output_sha256: outputHash,
    };
  } catch (error) {
    flush();
    flushReasoning();
    await args.raw.flush();
    const message = error instanceof Error ? error.message : String(error);
    const elapsed = Math.round((performance.now() - started) / 10) / 100;
    await args.ledger.append({
      utc: now(), kind: "model_call_finished", call_id: callId, document_id: args.document_id,
      stage: args.stage, attempt: args.attempt, status: "failed", elapsed_seconds: elapsed, error: message,
    });
    return {
      call_id: callId,
      raw: "",
      parsed: null,
      error: message,
      continuation_id: null,
      elapsed_seconds: elapsed,
      usage: null,
      output_sha256: sha256(""),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runStage<T, C extends { ok: boolean; errors: string[]; value: T | null; grounding: Array<{ path: string; exact_text: string; start: number; end: number }> }>(args: {
  prompt: string;
  schema: Record<string, unknown>;
  compile: (raw: unknown) => C;
  max_corrections: number;
  stateless_corrections: boolean;
  model_call: (prompt: string, continuationId: string | undefined, attempt: number, schema?: Record<string, unknown>) => Promise<ModelCallResult>;
}) {
  const attempts: Json[] = [];
  let prompt = args.prompt;
  let continuationId: string | undefined;
  let finalRaw: unknown = null;
  let compilation: C | null = null;
  let errors: string[] = [];
  const originalPrompt = args.prompt;
  let correction = false;
  for (let attempt = 0; attempt <= args.max_corrections; attempt += 1) {
    const result = await args.model_call(prompt, continuationId, attempt + 1, correction ? undefined : args.schema);
    if (!result.error && correction) {
      const patched = applyJsonPatch(finalRaw, result.parsed);
      if (patched.errors.length) {
        errors = [...patched.errors, ...(compilation?.errors ?? [])];
      } else {
        finalRaw = patched.value;
        compilation = args.compile(finalRaw);
        errors = compilation.errors;
      }
    } else if (!result.error) {
      finalRaw = result.parsed;
      compilation = result.parsed === null ? null : args.compile(result.parsed);
      errors = compilation?.errors ?? ["response was not parseable JSON"];
    } else errors = [result.error];
    attempts.push({
      attempt: attempt + 1,
      call_id: result.call_id,
      output_sha256: result.output_sha256,
      elapsed_seconds: result.elapsed_seconds,
      usage: result.usage,
      errors,
    });
    if (compilation?.ok && compilation.value) {
      return { accepted: true, value: compilation.value, compilation, errors, attempts, final_raw: finalRaw };
    }
    if (attempt === args.max_corrections) break;
    if (result.error) {
      continuationId = undefined;
      if (correction) prompt = statelessCorrectionPrompt(originalPrompt, finalRaw, errors, compilation?.grounding ?? []);
    } else if (result.parsed === null && !correction) {
      // Only a provider-owned session can resolve "the original task" from memory.
      continuationId = result.continuation_id ?? undefined;
      prompt = result.continuation_id
        ? "Return the complete JSON object requested in the original task. Your previous response was not parseable JSON."
        : originalPrompt;
    } else if (result.continuation_id) {
      continuationId = result.continuation_id;
      correction = true;
      prompt = correctionPrompt(errors, compilation?.grounding ?? []);
    } else if (args.stateless_corrections) {
      continuationId = undefined;
      correction = true;
      prompt = statelessCorrectionPrompt(originalPrompt, finalRaw, errors, compilation?.grounding ?? []);
    } else break;
  }
  return { accepted: false, value: null, compilation, errors, attempts, final_raw: finalRaw };
}

function stageCheckpointKey(prompt: string, schema: Record<string, unknown>) {
  return sha256(JSON.stringify({
    contract: CASE_TREATMENT_CONTRACT_VERSION,
    prompt: sha256(prompt),
    schema: sha256(JSON.stringify(schema)),
  }));
}

async function saveStageCheckpoint(filename: string, key: string, value: unknown, attempts: Json[]) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ key, value, attempts })}\n`, "utf8");
  await rename(temporary, filename);
}

export async function runCheckpointedStage<T, C extends { ok: boolean; errors: string[]; value: T | null; grounding: Array<{ path: string; exact_text: string; start: number; end: number }> }>(args: Parameters<typeof runStage<T, C>>[0] & {
  checkpoint_file: string;
}) {
  const key = stageCheckpointKey(args.prompt, args.schema);
  if (existsSync(args.checkpoint_file)) {
    try {
      const saved = JSON.parse(await readFile(args.checkpoint_file, "utf8")) as { key?: unknown; value?: unknown; attempts?: Json[] };
      if (saved.key === key) {
        const compilation = args.compile(saved.value);
        if (compilation.ok && compilation.value) return {
          accepted: true,
          value: compilation.value,
          compilation,
          errors: [],
          attempts: [{ checkpoint_reused: true, source_attempts: saved.attempts ?? [] }],
          final_raw: saved.value,
        };
      }
    } catch { /* A torn or stale checkpoint is simply recomputed. */ }
  }
  const result = await runStage(args);
  if (result.accepted && result.value) {
    await saveStageCheckpoint(args.checkpoint_file, key, result.value, result.attempts);
  }
  return result;
}

function compactReceipt(compilation: SubmissionCompilation, material: CaseMaterial) {
  const structure = compilation.structure.compiled;
  const analysis = compilation.analysis?.compiled;
  const detected = new Map(material.citation_inventory.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  return {
    coverage: compilation.structure.coverage,
    boundary_adjustments: compilation.structure.boundary_adjustments,
    no_oracle_structure_check: compareDeterministicStructure(compilation.structure, material),
    citation_coverage: compilation.analysis?.citation_coverage ?? null,
    opinions: structure?.opinions.map((opinion) => ({
      opinion_id: opinion.opinion_id,
      start: opinion.boundary.start,
      end: opinion.boundary.end,
      text_sha256: opinion.boundary.text_sha256,
      writers: opinion.writers,
      collective_author: opinion.collective_author,
      full_joiners: opinion.full_joiners,
      partial_joiners: opinion.partial_joiners,
      result_position: opinion.result_position,
    })) ?? [],
    references: analysis?.references.map((reference) => {
      const occurrence = reference.detected_occurrence_id ? detected.get(reference.detected_occurrence_id) : null;
      return {
        reference_id: reference.reference_id,
        detected_occurrence_id: reference.detected_occurrence_id,
        detected_authority_id: occurrence?.authority_id ?? null,
        detected_citation_key: occurrence?.citation_key ?? null,
        reference_status: reference.reference_status,
        voice: reference.voice,
        start: reference.span.start,
        end: reference.span.end,
        text_sha256: reference.span.text_sha256,
      };
    }) ?? [],
    reference_uses: analysis?.reference_uses ?? [],
    treatments: analysis?.treatments.map((treatment) => ({
      treatment_id: treatment.treatment_id,
      opinion_id: treatment.opinion_id,
      reference_ids: treatment.reference_ids,
      signals: treatment.signals,
      evidence: treatment.evidence_spans.map(({ start, end, text_sha256 }) => ({ start, end, text_sha256 })),
      proposition_support: structure ? propositionSupport(structure, treatment) : null,
    })) ?? [],
    deterministic_quote_candidates: compilation.analysis?.deterministic_quote_candidates ?? [],
    attributed_passages: analysis?.attributed_passages.map((passage) => ({
      passage_id: passage.passage_id,
      reference_ids: passage.reference_ids,
      start: passage.span.start,
      end: passage.span.end,
      text_sha256: passage.span.text_sha256,
      deterministic_quote_ids: passage.deterministic_quote_ids,
    })) ?? [],
    evidence_receipts: [
      ...compilation.structure.evidence_receipts,
      ...(compilation.analysis?.evidence_receipts ?? []),
    ],
  };
}

async function completedCases(receiptDir: string, compact = false) {
  if (!existsSync(receiptDir)) return new Map<number, Json>();
  const files = await readdir(receiptDir);
  const rows = new Map<number, Json>();
  await Promise.all(files.filter((name) => name.endsWith(".jsonl")).map((name) =>
    forEachJsonl<Json>(path.join(receiptDir, name), (row) => {
      if (row.kind !== "case_receipt") return;
      const id = Number(row.document_id);
      const prior = rows.get(id);
      if (prior && String(prior.utc ?? "").localeCompare(String(row.utc ?? "")) > 0) return;
      rows.set(id, compact ? {
        utc: row.utc, kind: row.kind, document_id: row.document_id,
        citation: row.citation, route: row.route, model: row.model,
        status: row.status, errors: row.errors, error: row.error,
      } : row);
    })
  ));
  return rows;
}

async function runInference(flags: Flags) {
  setBelowNormalProcessPriority();
  const ids = await selectedIds(flags);
  const mode = flag(flags, "mode", "two-stage");
  if (!["one-stage", "two-stage"].includes(mode)) throw new Error("--mode must be one-stage or two-stage");
  const authorityPass = flags["authority-pass"] === true;
  if (authorityPass && mode !== "two-stage") throw new Error("--authority-pass requires --mode two-stage");
  const outDir = path.resolve(flag(flags, "out-dir"));
  if (!flag(flags, "out-dir")) throw new Error("run requires --out-dir");
  const workers = Math.floor(numberFlag(flags, "workers", 8, 1, 32));
  const maxCorrections = Math.floor(numberFlag(flags, "max-corrections", 2, 0, 5));
  const includeStructureHints = flags["structure-hints"] === true;
  const timeoutSeconds = numberFlag(flags, "timeout-seconds", 1_800, 1, 7_200);
  const provider = flag(flags, "provider", "codex");
  if (!["codex", "ox-alpha"].includes(provider)) throw new Error("--provider must be codex or ox-alpha");
  const oxRouteName = flag(flags, "ox-route");
  const oxRouteNames = flag(flags, "ox-routes");
  if (provider === "ox-alpha" && Boolean(oxRouteName) === Boolean(oxRouteNames)) {
    throw new Error("Ox Alpha requires exactly one of --ox-route or --ox-routes");
  }
  if (provider !== "ox-alpha" && (oxRouteName || oxRouteNames)) {
    throw new Error("--ox-route and --ox-routes require --provider ox-alpha");
  }
  const selectedOxRoutes = provider === "ox-alpha"
    ? oxAlphaRoutes(oxRouteNames || oxRouteName)
    : [];
  if (provider === "ox-alpha" && flag(flags, "model")) {
    throw new Error("Ox Alpha models are fixed by their routes; omit --model");
  }
  const codexModel = flag(flags, "model", "gpt-5.6-luna");
  const effort = flag(flags, "effort", selectedOxRoutes.length ? "high" : "max");
  const maxOutputTokens = Math.floor(numberFlag(flags, "max-output-tokens", 32_768, 1, 131_072));
  const routeByDocument = new Map(ids.map((id, index) => [
    id,
    selectedOxRoutes.length ? assignedOxAlphaRoute(selectedOxRoutes, index) : undefined,
  ]));
  const requestsPerMinuteOverride = flags["requests-per-minute"] === undefined
    ? null
    : numberFlag(flags, "requests-per-minute", 0, 1, 60);
  type OxRuntime = {
    credentials: OxAlphaCredentials;
    limiter: StartLimiter;
    requests_per_minute: number;
    preflight: Awaited<ReturnType<typeof preflightOxAlpha>>;
  };
  const oxRuntimes = new Map<OxAlphaRoute, OxRuntime>(await Promise.all(selectedOxRoutes.map(async (route) => {
    const config = OX_ALPHA_ROUTES[route];
    const requestsPerMinute = requestsPerMinuteOverride ?? config.default_requests_per_minute;
    if (config.maximum_requests_per_minute !== null && requestsPerMinute > config.maximum_requests_per_minute) {
      throw new Error(`${route} Ox Alpha is capped at ${config.maximum_requests_per_minute} requests per minute`);
    }
    const credentials = oxAlphaCredentials(route);
    return [route, {
      credentials,
      limiter: new EvenStartLimiter(requestsPerMinute),
      requests_per_minute: requestsPerMinute,
      preflight: await preflightOxAlpha(route, credentials),
    }] as const;
  })));
  const providerPreflight = selectedOxRoutes.length
    ? Object.fromEntries([...oxRuntimes].map(([route, runtime]) => [route, runtime.preflight]))
    : null;
  const requestsPerMinute = selectedOxRoutes.length
    ? Object.fromEntries([...oxRuntimes].map(([route, runtime]) => [route, runtime.requests_per_minute]))
    : null;
  const callBudget = Math.floor(numberFlag(flags, "call-budget", 0, 0));
  if (flags["daily-request-cap"] !== undefined && !selectedOxRoutes.includes("openrouter")) {
    throw new Error("--daily-request-cap applies only when --ox-route(s) includes openrouter");
  }
  const dailyRequestCaps = new Map<OxAlphaRoute, number | null>(selectedOxRoutes.map((route) => [
    route,
    route === "openrouter"
      ? Math.floor(numberFlag(
          flags,
          "daily-request-cap",
          OX_ALPHA_ROUTES.openrouter.published_daily_request_cap,
          1,
          OX_ALPHA_ROUTES.openrouter.published_daily_request_cap,
        ))
      : OX_ALPHA_ROUTES[route].published_daily_request_cap,
  ]));
  const routeNames = selectedOxRoutes.length ? selectedOxRoutes : ["codex-app-server"];
  const models = selectedOxRoutes.length
    ? Object.fromEntries(selectedOxRoutes.map((route) => [route, OX_ALPHA_ROUTES[route].model]))
    : { "codex-app-server": codexModel };
  const rawDir = path.join(outDir, "raw");
  const receiptDir = path.join(outDir, "receipts");
  const checkpointDir = path.join(outDir, "checkpoints");
  await Promise.all([outDir, rawDir, receiptDir, checkpointDir].map((directory) => mkdir(directory, { recursive: true })));
  const manifestFile = path.join(outDir, "manifest.json");
  const manifestContract = {
    format: `${CASE_TREATMENT_CONTRACT_VERSION}-run`,
    contract_version: CASE_TREATMENT_CONTRACT_VERSION,
    public_source: "A2AJ court decisions",
    mode,
    provider,
    routes: routeNames,
    models,
    route_assignment: selectedOxRoutes.length > 1 ? "requested_ids_round_robin" : "single",
    effort,
    workers,
    max_corrections: maxCorrections,
    max_output_tokens: maxOutputTokens,
    structure_hints: includeStructureHints,
    authority_pass: authorityPass,
    requests_per_minute: requestsPerMinute,
    daily_request_caps: selectedOxRoutes.length ? Object.fromEntries(dailyRequestCaps) : null,
    requested_ids: ids,
    structure_instructions: STRUCTURE_INSTRUCTIONS,
    authority_inventory_instructions: authorityPass ? AUTHORITY_INVENTORY_INSTRUCTIONS : null,
    analysis_instructions: ANALYSIS_INSTRUCTIONS,
  };
  if (existsSync(manifestFile)) {
    const prior = JSON.parse(await readFile(manifestFile, "utf8")) as { contract?: unknown };
    if (JSON.stringify(prior.contract) !== JSON.stringify(manifestContract)) {
      throw new Error("run directory belongs to a different contract or invocation; choose a new --out-dir");
    }
  } else {
    await writeFile(manifestFile, `${JSON.stringify({ created_at: now(), contract: manifestContract }, null, 2)}\n`, "utf8");
  }
  const callLedgerFile = path.join(outDir, "calls.jsonl");
  const progressFile = path.join(outDir, "progress.jsonl");
  const priorReceipts = await completedCases(receiptDir, true);
  const existing = new Map([...priorReceipts].filter(([, receipt]) => receipt.status === "accepted"));
  const retry = flags["retry-finished"] === true;
  const pending = ids.filter((id) => retry || !existing.has(id));
  const stages = mode === "one-stage" ? 1 : authorityPass ? 3 : 2;
  const startedCalls = await callStats(callLedgerFile);
  const used = startedCalls.total;
  const ceiling = pending.length * stages * (1 + maxCorrections);
  if (pending.length && callBudget < used + ceiling) {
    throw new Error(`--call-budget must cover ${used + ceiling} total attempts`);
  }
  for (const route of selectedOxRoutes) {
    const cap = dailyRequestCaps.get(route);
    if (cap === null || cap === undefined) continue;
    const usedByRoute = startedCalls.byRoute.get(route) ?? 0;
    const routeCeiling = pending.filter((id) => routeByDocument.get(id) === route).length * stages * (1 + maxCorrections);
    if (usedByRoute + routeCeiling > cap) {
      throw new Error(`${route} needs up to ${usedByRoute + routeCeiling} calls, above its ${cap}-request run cap`);
    }
  }
  let reservedCalls = used;
  const reservedByRoute = new Map(startedCalls.byRoute);
  const reserveCall = (route: string) => {
    if (reservedCalls >= callBudget) throw new Error(`run exhausted its ${callBudget}-call budget`);
    const oxRoute = selectedOxRoutes.find((candidate) => candidate === route);
    const cap = oxRoute ? dailyRequestCaps.get(oxRoute) : null;
    const routeUsed = reservedByRoute.get(route) ?? 0;
    if (cap !== null && cap !== undefined && routeUsed >= cap) throw new Error(`${route} exhausted its ${cap}-request run cap`);
    reservedCalls += 1;
    reservedByRoute.set(route, routeUsed + 1);
  };
  const ledger = new JsonlWriter(callLedgerFile);
  const progress = new JsonlWriter(progressFile);
  await progress.append({
    utc: now(), kind: "run_started", contract_version: CASE_TREATMENT_CONTRACT_VERSION,
    mode, provider, routes: routeNames, models, effort,
    route_assignment: selectedOxRoutes.length > 1 ? "requested_ids_round_robin" : "single",
    structure_hints: includeStructureHints, authority_pass: authorityPass,
    max_output_tokens: maxOutputTokens, requests_per_minute: requestsPerMinute,
    daily_request_caps: selectedOxRoutes.length ? Object.fromEntries(dailyRequestCaps) : null,
    provider_preflights: providerPreflight, workers, requested_ids: ids, pending_ids: pending,
  });
  const outcomes = new Array<Json>(pending.length);
  const activeWorkers = Math.min(workers, pending.length);
  const loadMaterial = materialLoader(pending, Math.max(16, activeWorkers * 2));
  const rawWriters = Array.from({ length: activeWorkers }, (_, worker) =>
    new JsonlWriter(path.join(rawDir, `worker-${worker + 1}.jsonl`)));
  const receiptWriters = Array.from({ length: activeWorkers }, (_, worker) =>
    new JsonlWriter(path.join(receiptDir, `worker-${worker + 1}.jsonl`)));
  await workerPool(pending, workers, async (documentId, index, worker) => {
    const raw = rawWriters[worker];
    const receipts = receiptWriters[worker];
    const oxRoute = routeByDocument.get(documentId);
    const route = oxRoute ?? "codex-app-server";
    const model = oxRoute ? OX_ALPHA_ROUTES[oxRoute].model : codexModel;
    const oxRuntime = oxRoute ? oxRuntimes.get(oxRoute)! : undefined;
    let releaseMaterial = () => undefined;
    await progress.append({ utc: now(), kind: "case_started", document_id: documentId, route, model, worker: worker + 1 });
    try {
      const loaded = await loadMaterial(index);
      const material = loaded.material;
      releaseMaterial = loaded.release;
      const caseCheckpointDir = path.join(checkpointDir, String(documentId));
      const call = (stage: string, schema: Record<string, unknown>) => (prompt: string, continuationId: string | undefined, attempt: number, responseSchema = schema) => {
        reserveCall(route);
        return modelCall({
          prompt, schema: responseSchema, model, effort, max_output_tokens: maxOutputTokens,
          timeout_seconds: timeoutSeconds, continuation_id: continuationId,
          ox_route: oxRoute, ox_credentials: oxRuntime?.credentials, start_limiter: oxRuntime?.limiter,
          raw, ledger, document_id: documentId, stage, attempt,
        });
      };
      let submission: CaseTreatmentSubmission | null = null;
      let compilation: SubmissionCompilation | null = null;
      let stageAttempts: Json = {};
      let lastErrors: string[] = [];
      let finalRaw: unknown = null;
      if (mode === "one-stage") {
        const schema = submissionOutputSchema(material.citation_inventory, material.source_lines.length);
        const result = await runCheckpointedStage<CaseTreatmentSubmission, SubmissionCompilation>({
          prompt: oneStagePrompt(material, includeStructureHints), schema,
          compile: (value) => compileSubmission(value, material),
          max_corrections: maxCorrections,
          stateless_corrections: Boolean(oxRoute),
          model_call: call("one_stage", schema),
          checkpoint_file: path.join(caseCheckpointDir, "one-stage.json"),
        });
        submission = result.value;
        if (result.accepted) compilation = result.compilation;
        stageAttempts = { one_stage: result.attempts };
        lastErrors = result.errors;
        finalRaw = result.final_raw;
      } else {
        const structureSchema = structureOutputSchema(material.source_lines.length);
        const structureResult = await runCheckpointedStage<DecisionStructure, StructureCompilation>({
          prompt: includeStructureHints ? structurePromptWithHints(material) : structurePrompt(material), schema: structureSchema,
          compile: (value) => compileStructure(value, material),
          max_corrections: maxCorrections,
          stateless_corrections: Boolean(oxRoute),
          model_call: call("structure", structureSchema),
          checkpoint_file: path.join(caseCheckpointDir, "structure.json"),
        });
        stageAttempts = { structure: structureResult.attempts };
        lastErrors = structureResult.errors;
        finalRaw = { structure: structureResult.final_raw };
        if (structureResult.accepted && structureResult.value && structureResult.compilation?.compiled) {
          const opinionIds = structureResult.value.opinions.map(({ opinion_id }) => opinion_id);
          let authorityInventory: AuthorityInventory | undefined;
          if (authorityPass) {
            const inventorySchema = authorityInventoryOutputSchema(material.source_lines.length);
            const inventoryResult = await runCheckpointedStage<AuthorityInventory, AuthorityInventoryCompilation>({
              prompt: authorityInventoryPrompt(material), schema: inventorySchema,
              compile: (value) => compileAuthorityInventory(value, material),
              max_corrections: maxCorrections,
              stateless_corrections: Boolean(oxRoute),
              model_call: call("authority_inventory", inventorySchema),
              checkpoint_file: path.join(caseCheckpointDir, "authorities.json"),
            });
            stageAttempts = { ...stageAttempts, authority_inventory: inventoryResult.attempts };
            lastErrors = inventoryResult.errors;
            finalRaw = { structure: structureResult.final_raw, authority_inventory: inventoryResult.final_raw };
            if (inventoryResult.accepted && inventoryResult.value) authorityInventory = inventoryResult.value;
          }
          if (!authorityPass || authorityInventory) {
            const analysisSchema = analysisOutputSchema(material.citation_inventory, material.source_lines.length, opinionIds);
            const analysisResult = await runCheckpointedStage<DecisionAnalysis, AnalysisCompilation>({
              prompt: analysisPrompt(material, structureResult.value, authorityInventory), schema: analysisSchema,
              compile: (value) => compileAnalysis(value, structureResult.value!, structureResult.compilation!.compiled!, material),
              max_corrections: maxCorrections,
              stateless_corrections: Boolean(oxRoute),
              model_call: call("analysis", analysisSchema),
              checkpoint_file: path.join(caseCheckpointDir, "analysis.json"),
            });
            stageAttempts = { ...stageAttempts, analysis: analysisResult.attempts };
            lastErrors = analysisResult.errors;
            finalRaw = { structure: structureResult.final_raw, ...(authorityInventory ? { authority_inventory: authorityInventory } : {}), analysis: analysisResult.final_raw };
            if (analysisResult.accepted && analysisResult.value && analysisResult.compilation) {
              submission = { structure: structureResult.value, analysis: analysisResult.value };
              compilation = {
                ok: true,
                errors: [],
                value: submission,
                grounding: [...structureResult.compilation.grounding, ...analysisResult.compilation.grounding],
                structure: structureResult.compilation,
                analysis: analysisResult.compilation,
              };
            }
          }
        }
      }
      const accepted = compilation?.ok === true;
      const receipt: Json = {
        utc: now(), kind: "case_receipt", contract_version: CASE_TREATMENT_CONTRACT_VERSION,
        document_id: documentId, citation: material.citation, dataset: material.dataset,
        source_sha256: sha256(material.text), mode, model, effort,
        provider, route,
        structure_hints: includeStructureHints, authority_pass: authorityPass,
        status: accepted ? "accepted" : "rejected",
        errors: accepted ? [] : lastErrors,
        attempts: stageAttempts,
        submission,
        final_parsed_draft: accepted ? null : finalRaw,
        compiled_receipt: compilation ? compactReceipt(compilation, material) : null,
      };
      outcomes[index] = {
        document_id: documentId, citation: material.citation, route, model,
        status: receipt.status, errors: receipt.errors,
      };
      await receipts.append(receipt);
      await progress.append({ utc: now(), kind: "case_finished", document_id: documentId, route, status: receipt.status, worker: worker + 1 });
    } catch (error) {
      const receipt = {
        utc: now(), kind: "case_receipt", contract_version: CASE_TREATMENT_CONTRACT_VERSION,
        document_id: documentId, mode, model, effort, status: "failed",
        provider, route,
        error: error instanceof Error ? error.message : String(error),
      };
      outcomes[index] = {
        document_id: documentId, route, model, status: "failed", error: receipt.error,
      };
      await receipts.append(receipt);
      await progress.append({ utc: now(), kind: "case_finished", document_id: documentId, route, status: "failed", worker: worker + 1 });
    } finally { releaseMaterial(); }
  });
  await Promise.all([
    ledger.close(), progress.close(),
    ...rawWriters.map((writer) => writer.close()),
    ...receiptWriters.map((writer) => writer.close()),
  ]);
  const requested = new Set(ids);
  const attempted = new Set(pending);
  const all = [...existing.values()]
    .filter(({ document_id }) => requested.has(Number(document_id)) && !attempted.has(Number(document_id)))
    .concat(outcomes.filter(Boolean));
  const summary = {
    contract_version: CASE_TREATMENT_CONTRACT_VERSION,
    mode, provider, routes: routeNames, models, effort,
    structure_hints: includeStructureHints,
    provider_preflights: providerPreflight,
    requested: ids.length,
    resumed: ids.filter((id) => existing.has(id) && !attempted.has(id)).length,
    attempted: pending.length,
    accepted: all.filter(({ status }) => status === "accepted").length,
    rejected: all.filter(({ status }) => status === "rejected").length,
    failed: all.filter(({ status }) => status === "failed").length,
    cases: all.map(({ document_id, citation, route, model, status, errors, error }) => ({ document_id, citation, route, model, status, errors, error })),
  };
  const summaryFile = path.join(outDir, "summary.json");
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    contract_version: summary.contract_version,
    requested: summary.requested,
    resumed: summary.resumed,
    attempted: summary.attempted,
    accepted: summary.accepted,
    rejected: summary.rejected,
    failed: summary.failed,
    summary_file: summaryFile,
  }, null, 2));
}

async function runReceipts(runDir: string) {
  return completedCases(path.join(path.resolve(runDir), "receipts"));
}

async function requestedRunIds(runDir: string, receipts: Map<number, Json>) {
  const manifestFile = path.join(path.resolve(runDir), "manifest.json");
  if (!existsSync(manifestFile)) return new Set(receipts.keys());
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { contract?: { requested_ids?: unknown } };
  const ids = manifest.contract?.requested_ids;
  return Array.isArray(ids)
    ? new Set(ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))
    : new Set(receipts.keys());
}

async function rawOutput(flags: Flags) {
  const runDir = flag(flags, "run-dir");
  const callId = flag(flags, "call-id");
  if (!runDir || !callId) throw new Error("raw-output requires --run-dir and --call-id");
  const rawDir = path.join(path.resolve(runDir), "raw");
  const files = existsSync(rawDir) ? (await readdir(rawDir)).filter((name) => name.endsWith(".jsonl")) : [];
  const events: Json[] = [];
  await Promise.all(files.map((name) => forEachJsonl<Json>(path.join(rawDir, name), (event) => {
    if (event.call_id === callId) events.push(event);
  })));
  if (!events.length) throw new Error(`raw output not found for ${callId}`);
  const snapshot = events.filter(({ kind }) => kind === "raw_snapshot").at(-1)?.text;
  const output = typeof snapshot === "string"
    ? snapshot
    : events.filter(({ kind }) => kind === "raw_delta").map(({ text }) => String(text ?? "")).join("");
  const expectedHash = events.find(({ kind }) => kind === "raw_complete")?.output_sha256;
  if (typeof expectedHash === "string" && sha256(output) !== expectedHash) {
    throw new Error(`raw output hash mismatch for ${callId}`);
  }
  const filename = flag(flags, "out");
  if (filename) await writeFile(path.resolve(filename), output, "utf8");
  else process.stdout.write(output);
}

async function benchmarkCases(goldFile: string, runDir: string) {
  const gold = await readGold(goldFile);
  const receipts = await runReceipts(runDir);
  const requested = await requestedRunIds(runDir, receipts);
  const rows = gold.filter(({ document_id }) => requested.has(document_id));
  const byId = new Map(rows.map((row) => [row.document_id, row]));
  const values = new Array<{
    document_id: number;
    citation: string;
    expected: SubmissionCompilation;
    candidate: SubmissionCompilation | null;
    receipt_status: string;
    structure: ReturnType<typeof compareStructureMechanics> | null;
    deterministic_structure: ReturnType<typeof compareDeterministicStructure>;
    semantic_exact: boolean;
  }>(rows.length);
  await forEachMaterial(rows.map(({ document_id }) => document_id), 8, async (material, index) => {
    const reference = byId.get(material.document_id)!;
    const expected = compileSubmission(reference.annotation, material);
    if (!expected.ok) throw new Error(`${reference.document_id}: invalid gold: ${expected.errors.join("; ")}`);
    const candidateRow = receipts.get(reference.document_id) ?? null;
    const candidateRaw = candidateRow?.submission ?? candidateRow?.final_parsed_draft ?? null;
    const candidate = candidateRaw === null ? null : compileSubmission(candidateRaw, material);
    const expectedView = semanticView(expected);
    const candidateView = candidate ? semanticView(candidate) : null;
    values[index] = {
      document_id: reference.document_id,
      citation: reference.citation,
      expected,
      candidate,
      receipt_status: String(candidateRow?.status ?? "missing"),
      structure: candidate ? compareStructureMechanics(expected.structure, candidate.structure, material) : null,
      deterministic_structure: compareDeterministicStructure(expected.structure, material),
      semantic_exact: candidate?.ok === true && JSON.stringify(expectedView) === JSON.stringify(candidateView),
    };
  });
  return values;
}

function aggregateStructureScore(values: Array<{
  document_id: number;
  citation: string;
  structure: ReturnType<typeof compareStructureMechanics> | null;
}>) {
  const receipts = values.flatMap(({ document_id, citation, structure }) =>
    structure ? [{ document_id, citation, ...structure }] : []);
  const categoryNames = [...new Set(receipts.flatMap(({ categories }) => Object.keys(categories)))];
  const categories = Object.fromEntries(categoryNames.map((name) => {
    const passed = receipts.filter((receipt) => receipt.categories[name as keyof typeof receipt.categories]).length;
    return [name, { passed, total: receipts.length, score: receipts.length ? passed / receipts.length : 0 }];
  }));
  const passed = receipts.reduce((total, receipt) => total + receipt.category_score.passed, 0);
  const checks = receipts.reduce((total, receipt) => total + receipt.category_score.total, 0);
  return {
    cases: receipts.length,
    accepted_cases: receipts.filter(({ accepted }) => accepted).length,
    accepted_rate: receipts.length ? receipts.filter(({ accepted }) => accepted).length / receipts.length : 0,
    category_score: { passed, total: checks, score: checks ? passed / checks : 0 },
    mean_boundary_overlap: receipts.length
      ? receipts.reduce((total, receipt) => total + receipt.metrics.mean_boundary_overlap, 0) / receipts.length
      : 0,
    categories,
    receipts,
  };
}

async function benchmark(flags: Flags) {
  const gold = flag(flags, "gold");
  const runDir = flag(flags, "run-dir");
  if (!gold || !runDir) throw new Error("benchmark requires --gold and --run-dir");
  const values = await benchmarkCases(gold, runDir);
  const rows = values.map(({ expected: _expected, candidate, ...value }) => ({
    ...value,
    candidate_valid: candidate?.ok === true,
    candidate_errors: candidate?.errors ?? [],
    judge_required: candidate?.ok === true && !value.semantic_exact,
  }));
  const summary = {
    cases: rows.length,
    accepted_receipts: rows.filter(({ receipt_status }) => receipt_status === "accepted").length,
    rejected_receipts: rows.filter(({ receipt_status }) => receipt_status === "rejected").length,
    failed_receipts: rows.filter(({ receipt_status }) => receipt_status === "failed").length,
    missing_receipts: rows.filter(({ receipt_status }) => receipt_status === "missing").length,
    valid_candidates: rows.filter(({ candidate_valid }) => candidate_valid).length,
    structurally_accepted: rows.filter(({ structure }) => structure?.accepted).length,
    deterministic_structurally_exact: rows.filter(({ deterministic_structure }) => deterministic_structure?.exact).length,
    semantically_exact: rows.filter(({ semantic_exact }) => semantic_exact).length,
    judge_required: rows.filter(({ judge_required }) => judge_required).length,
    structure_score: aggregateStructureScore(rows),
    rows,
  };
  const output = path.resolve(flag(flags, "out", path.join(runDir, "benchmark.json")));
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    cases: summary.cases,
    accepted_receipts: summary.accepted_receipts,
    rejected_receipts: summary.rejected_receipts,
    failed_receipts: summary.failed_receipts,
    missing_receipts: summary.missing_receipts,
    valid_candidates: summary.valid_candidates,
    structurally_accepted: summary.structurally_accepted,
    deterministic_structurally_exact: summary.deterministic_structurally_exact,
    semantically_exact: summary.semantically_exact,
    judge_required: summary.judge_required,
    output,
  }, null, 2));
}

async function judge(flags: Flags) {
  setBelowNormalProcessPriority();
  const gold = flag(flags, "gold");
  const runDir = flag(flags, "run-dir");
  if (!gold || !runDir) throw new Error("judge requires --gold and --run-dir");
  const requestedIds = flag(flags, "document-ids");
  const requested = requestedIds ? new Set(parseIds(requestedIds)) : null;
  const eligible = (await benchmarkCases(gold, runDir)).filter(({ document_id, candidate }) =>
    candidate?.ok === true && (!requested || requested.has(document_id)));
  const values = eligible.filter(({ semantic_exact }) => !semantic_exact);
  const provider = flag(flags, "provider", "codex");
  if (!["codex", "ox-alpha"].includes(provider)) throw new Error("--provider must be codex or ox-alpha");
  const oxRouteName = flag(flags, "ox-route");
  if (provider === "ox-alpha" && !oxRouteName) throw new Error("Ox Alpha judging requires --ox-route");
  if (provider !== "ox-alpha" && oxRouteName) throw new Error("--ox-route requires --provider ox-alpha");
  const selectedOxRoute = provider === "ox-alpha" ? oxAlphaRoute(oxRouteName!) : null;
  let oxRuntime: {
    credentials: OxAlphaCredentials;
    limiter: StartLimiter;
    preflight: Awaited<ReturnType<typeof preflightOxAlpha>>;
  } | null = null;
  if (selectedOxRoute) {
    oxRuntime = {
      credentials: oxAlphaCredentials(selectedOxRoute),
      limiter: new EvenStartLimiter(OX_ALPHA_ROUTES[selectedOxRoute].default_requests_per_minute),
      preflight: await preflightOxAlpha(selectedOxRoute, oxAlphaCredentials(selectedOxRoute)),
    };
  }
  const model = provider === "ox-alpha"
    ? OX_ALPHA_ROUTES[selectedOxRoute!].model
    : flag(flags, "model", "gpt-5.6-sol");
  const effort = flag(flags, "effort", provider === "ox-alpha" ? "low" : "low");
  const workers = Math.floor(numberFlag(flags, "workers", 10, 1, 32));
  const timeoutSeconds = numberFlag(flags, "timeout-seconds", 1_800, 1, 7_200);
  const judgeDir = path.resolve(flag(flags, "judge-dir", path.join(runDir, "judge")));
  const rawDir = path.join(judgeDir, "raw");
  const promptDir = path.join(judgeDir, "prompts");
  await Promise.all([judgeDir, rawDir, promptDir].map((directory) => mkdir(directory, { recursive: true })));
  const ledgerFile = path.join(judgeDir, "calls.jsonl");
  const used = await callCount(ledgerFile);
  const budget = Math.floor(numberFlag(flags, "call-budget", 0, 0));
  if (budget < used + values.length) throw new Error(`--call-budget must cover ${used + values.length} total attempts`);
  const ledger = new JsonlWriter(ledgerFile);
  const output = new JsonlWriter(path.join(judgeDir, "results.jsonl"));
  const grades = new Array<Json>(values.length);
  const report = progressLine("judged", values.length);
  let completed = 0;
  const rawWriters = Array.from({ length: Math.min(workers, values.length) }, (_, worker) =>
    new JsonlWriter(path.join(rawDir, `worker-${worker + 1}.jsonl`)));
  await workerPool(values, workers, async (value, index, worker) => {
    const raw = rawWriters[worker];
    const prompt = semanticJudgePrompt(value.expected, value.candidate!);
    await writeFile(path.join(promptDir, `${value.document_id}.txt`), prompt, "utf8");
    const result = await modelCall({
      prompt, schema: SEMANTIC_JUDGE_SCHEMA, model, effort, max_output_tokens: 16_384,
      timeout_seconds: timeoutSeconds,
      ox_route: selectedOxRoute ?? undefined,
      ox_credentials: oxRuntime?.credentials,
      start_limiter: oxRuntime?.limiter,
      raw, ledger, document_id: value.document_id, stage: "semantic_judge", attempt: 1,
    });
    const resultErrors = result.error ? [] : semanticJudgeResultErrors(value.expected, value.candidate!, result.parsed);
    const error = result.error ?? (resultErrors.length ? `Invalid semantic grade: ${resultErrors.join("; ")}` : null);
    const grade = {
      utc: now(), document_id: value.document_id, citation: value.citation,
      structure: value.structure,
      parsed: error ? null : result.parsed, error, output_sha256: result.output_sha256,
      score: error ? null : semanticJudgeScore(result.parsed),
      elapsed_seconds: result.elapsed_seconds, usage: result.usage,
    };
    grades[index] = grade;
    await output.append(grade);
    report(++completed);
  });
  await Promise.all([ledger.close(), output.close(), ...rawWriters.map((writer) => writer.close())]);
  const parsed = grades.flatMap(({ parsed }) => parsed ? [parsed as {
    treatment_grades: Array<{ verdict: string }>;
    extra_candidate_treatments: Array<{ severity: string }>;
    procedural_history_grades: Array<{ verdict: string }>;
    extra_candidate_history: Array<{ severity: string }>;
  }] : []);
  const treatmentGrades = parsed.flatMap(({ treatment_grades }) => treatment_grades);
  const extraTreatments = parsed.flatMap(({ extra_candidate_treatments }) => extra_candidate_treatments);
  const historyGrades = parsed.flatMap(({ procedural_history_grades }) => procedural_history_grades);
  const extraHistory = parsed.flatMap(({ extra_candidate_history }) => extra_candidate_history);
  const aggregateScore = semanticJudgeScore({
    treatment_grades: treatmentGrades,
    extra_candidate_treatments: extraTreatments,
    procedural_history_grades: historyGrades,
    extra_candidate_history: extraHistory,
  });
  const summary = {
    cases: grades.length,
    failed_cases: grades.filter(({ error }) => error).length,
    score: aggregateScore,
    treatment_propositions: treatmentGrades.length,
    treatment_pass: treatmentGrades.filter(({ verdict }) => verdict === "pass").length,
    treatment_minor_error: treatmentGrades.filter(({ verdict }) => verdict === "minor_error").length,
    treatment_major_error: treatmentGrades.filter(({ verdict }) => verdict === "major_error").length,
    extra_candidate_treatments: extraTreatments.length,
    extra_treatment_minor_error: extraTreatments.filter(({ severity }) => severity === "minor").length,
    extra_treatment_major_error: extraTreatments.filter(({ severity }) => severity === "major").length,
    procedural_history_items: historyGrades.length,
    procedural_history_pass: historyGrades.filter(({ verdict }) => verdict === "pass").length,
    procedural_history_minor_error: historyGrades.filter(({ verdict }) => verdict === "minor_error").length,
    procedural_history_major_error: historyGrades.filter(({ verdict }) => verdict === "major_error").length,
    extra_candidate_history: extraHistory.length,
    structure_score: aggregateStructureScore(eligible),
  };
  await writeFile(path.join(judgeDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function exportGold(flags: Flags) {
  const goldFile = flag(flags, "gold");
  const outputFile = path.resolve(flag(flags, "out"));
  if (!goldFile || !flag(flags, "out")) throw new Error("export requires --gold and --out");
  const gold = await readGold(goldFile);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, "", "utf8");
  const output = new JsonlWriter(outputFile);
  await forEachMaterial(gold.map(({ document_id }) => document_id), 1, async (material, index) => {
    const row = gold[index];
    const compilation = compileSubmission(row.annotation, material);
    if (!compilation.ok || !compilation.structure.compiled || !compilation.analysis?.compiled) {
      throw new Error(`${row.document_id}: invalid gold: ${compilation.errors.join("; ")}`);
    }
    const structure = compilation.structure.compiled;
    const analysis = compilation.analysis.compiled;
    const references = new Map(analysis.references.map((reference) => [reference.reference_id, reference]));
    const detected = new Map(material.citation_inventory.occurrences.map((occurrence) => [occurrence.id, occurrence]));
    const citedReference = (id: string) => {
      const reference = references.get(id)!;
      const occurrence = reference.detected_occurrence_id ? detected.get(reference.detected_occurrence_id) : null;
      return {
        reference_id: id,
        exact_text: reference.span.exact_text,
        start: reference.span.start,
        end: reference.span.end,
        detected_occurrence_id: reference.detected_occurrence_id,
        detected_authority_id: occurrence?.authority_id ?? null,
        detected_citation_key: occurrence?.citation_key ?? null,
      };
    };
    for (const treatment of analysis.treatments) {
      const opinion = structure.opinions.find(({ opinion_id }) => opinion_id === treatment.opinion_id)!;
      await output.append({
        kind: "treatment",
        containing_document_id: row.document_id,
        containing_citation: row.citation,
        containing_opinion: {
          writers: opinion.writers,
          collective_author: opinion.collective_author,
          result_position: opinion.result_position,
        },
        cited_references: treatment.reference_ids.map(citedReference),
        signals: treatment.signals,
        other_signal: treatment.other_signal,
        cited_proposition: treatment.cited_proposition,
        treatment_summary: treatment.treatment_summary,
        proposition_support: propositionSupport(structure, treatment),
        attributed_passages: treatment.attributed_passage_ids.map((id) => {
          const passage = analysis.attributed_passages.find(({ passage_id }) => passage_id === id)!;
          return {
            start: passage.span.start,
            end: passage.span.end,
            exact_text: passage.span.exact_text,
            deterministic_quote_ids: passage.deterministic_quote_ids,
          };
        }),
        evidence: treatment.evidence_spans.map(({ start, end, text_sha256 }) => ({ start, end, text_sha256 })),
      });
    }
    for (const history of analysis.procedural_history) await output.append({
      kind: "procedural_history",
      containing_document_id: row.document_id,
      containing_citation: row.citation,
      cited_references: history.reference_ids.map(citedReference),
      stage_relation: history.stage_relation,
      current_decision_action: history.current_decision_action,
      other_action: history.other_action,
      summary: history.summary,
      evidence: history.evidence_spans.map(({ start, end, text_sha256 }) => ({ start, end, text_sha256 })),
    });
  });
  await output.close();
  console.log(outputFile);
}

async function showPrompt(flags: Flags) {
  const [id] = await selectedIds(flags);
  const material = await materialFor(id, documentsFor([id]).get(id)!);
  const stage = flag(flags, "stage", "structure");
  const includeStructureHints = flags["structure-hints"] === true;
  if (stage === "structure") console.log(includeStructureHints ? structurePromptWithHints(material) : structurePrompt(material));
  else if (stage === "authority-inventory") console.log(authorityInventoryPrompt(material));
  else if (stage === "one-stage") console.log(oneStagePrompt(material, includeStructureHints));
  else if (stage === "analysis") {
    const goldFile = flag(flags, "gold");
    if (!goldFile) throw new Error("analysis prompt requires --gold");
    const gold = (await readGold(goldFile)).find(({ document_id }) => document_id === id);
    if (!gold) throw new Error(`gold has no record for ${id}`);
    console.log(analysisPrompt(material, gold.annotation.structure));
  } else throw new Error("--stage must be structure, authority-inventory, analysis, or one-stage");
}

async function showSchema(flags: Flags) {
  const [id] = await selectedIds(flags);
  const material = await materialFor(id, documentsFor([id]).get(id)!);
  const stage = flag(flags, "stage", "one-stage");
  if (stage === "structure") console.log(JSON.stringify(structureOutputSchema(material.source_lines.length), null, 2));
  else if (stage === "authority-inventory") console.log(JSON.stringify(authorityInventoryOutputSchema(material.source_lines.length), null, 2));
  else if (stage === "analysis") console.log(JSON.stringify(analysisOutputSchema(material.citation_inventory, material.source_lines.length), null, 2));
  else if (stage === "one-stage") console.log(JSON.stringify(submissionOutputSchema(material.citation_inventory, material.source_lines.length), null, 2));
  else throw new Error("--stage must be structure, authority-inventory, analysis, or one-stage");
}

async function main() {
  const command = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  if (command === "select") await selectCases(flags);
  else if (command === "show") await showCase(flags);
  else if (command === "packets") await writePackets(flags);
  else if (command === "validate-gold") await validateGold(flags);
  else if (command === "run") await runInference(flags);
  else if (command === "benchmark") await benchmark(flags);
  else if (command === "judge") await judge(flags);
  else if (command === "raw-output") await rawOutput(flags);
  else if (command === "export") await exportGold(flags);
  else if (command === "show-prompt") await showPrompt(flags);
  else if (command === "show-schema") await showSchema(flags);
  else throw new Error("commands: select | show | packets | validate-gold | run | benchmark | judge | raw-output | export | show-prompt | show-schema");
}

if (require.main === module) void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (usedCodexAppServer) {
      const { shutdownCodexAppServers } = await import("../../src/lib/llm/codexAppServer");
      await shutdownCodexAppServers();
    }
  });
