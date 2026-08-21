import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import {
  a2ajDocumentFromRow, getLocalA2AJSectionMap,
} from "../../src/lib/a2ajLocalBulk";
import {
  journalLegalSourceProvider as journal,
} from "../../src/lib/legalSources/journal";
import {
  a2ajSourceDocsNative, journalSourceDocNative, sourceDocsNative,
  type A2ajNativeInput,
} from "../../src/lib/structureNative";
import type { NativeMarkupSourceInput } from "../../src/lib/sourceDocNativeMarkup";
import type { SourceDoc } from "../../src/lib/sourceDoc";
import {
  deriveSourceStructureGraphs,
  shutdownSourceStructureEngine,
  sourceStructureEngineState,
} from "../../src/lib/sourceStructureEngine";
import { projectSourceStructure, type SourceStructureInput } from "../../src/lib/sourceStructureAdapter";
import {
  setBelowNormalProcessPriority,
  type StructurePriorityReceipt,
} from "../../src/lib/structureEngineClient";
import { structureNativeBinary } from "../../src/lib/structureNative";
import {
  SOURCE_DOC_BYTES_CONTRACT, sourceDocMode, sourceDocPublicBytes,
} from "./canonical";

type JournalPageRow = { page_label: unknown; pdf_page: unknown };
type JournalTextInput = {
  articleId: number;
  url: string;
  text: string;
  pageRows: JournalPageRow[];
};
import {
  STRUCTURE_INPUT_BYTES_CONTRACT,
  structureInputSha256,
} from "./structureInputProof";

type Provider = "a2aj" | "courtlistener" | "journal";
type Row = Record<string, unknown>;
type RecordStatus = "pass" | "failure";
type ManifestRecord = {
  v: 1;
  provider: Provider | "journal-final-contract" | "journal-page-map";
  source_id: string;
  source_kind: string;
  source_bytes: number;
  source_sha256: string;
  structure_input_sha256?: string;
  status: RecordStatus;
  mode?: "native" | "hybrid" | "flat";
  canonical_bytes?: number;
  canonical_sha256?: string;
  blocks?: number;
  failure?: string;
  error_sha256?: string;
  final_contract?: "none" | "applicable" | "invalid" | "unresolved";
  contract_validation?: "applicable" | "invalid" | "unresolved";
  contract_source_bytes?: number;
  contract_source_sha256?: string;
  contract_pages?: number;
  contract_alias?: boolean;
  page_rows?: number;
  structure?: Array<[
    SourceDocBlock["kind"], string, number, number, SourceDocBlock["origin"],
    string | null, string | null, string[],
  ]>;
};
type Counts = {
  attempted: number;
  pass: number;
  failure: number;
  source_bytes: number;
  canonical_bytes: number;
  elapsed_ms: number;
  warmup_rows: number;
  warmup_bytes: number;
  warmup_ms: number;
  modes: Record<"native" | "hybrid" | "flat", number>;
  details: Record<string, number>;
  last_id: number;
};
type Part = { name: string; rows: number; bytes: number; sha256: string };
type Checkpoint = {
  schema_version: "source-structure-installed-freeze.v1";
  config_sha256: string;
  baseline_commit: string;
  serializer_contract_sha256: string;
  inventory: Inventory;
  providers: Record<Provider, Counts>;
  parts: Part[];
  engine: { startup_ms: number; max_documents: number; max_bytes: number;
    batches: number; documents: number; request_bytes: number;
    materialize_ms: number; derive_ms: number; project_ms: number;
    binary_sha256: string; capabilities: string[]; priority: StructurePriorityReceipt | null };
  complete: boolean;
};
type Inventory = {
  a2aj: { total: number; cases: number; laws: number; derivative_cases_search: number };
  courtlistener: { opinions: number };
  journal: {
    articles: number;
    page_rows: number;
    orphan_page_rows: number;
    final_contracts: number;
    orphan_final_contracts: number;
  };
  signatures: Record<Provider | "a2aj-search" | "journal-final", string>;
};

const runPriority = setBelowNormalProcessPriority();
process.env.STRUCTURE_ENGINE_BELOW_NORMAL = "1";
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) args.set(key.slice(2), "1");
  else { args.set(key.slice(2), value); index += 1; }
}
const localProviders = path.join(
  process.env.LOCALAPPDATA ?? "", "OpenLegalProducts", "LegalData", "providers",
);
const output = path.resolve(args.get("output") ?? path.join(
  __dirname, "results", "installed-provider-freeze",
));
const batchSize = Math.max(1, Math.min(5_000, Number(args.get("batch") ?? 1_000)));
const limit = Math.max(0, Number(args.get("limit") ?? 0));
const warmupRows = Math.max(0, Number(args.get("warmup-rows") ?? 25));
const digestOnly = args.has("digest-only");
const retainStructure = args.has("retain-structure");
const requiredMib = Math.max(0, Number(args.get("require-mib-s") ?? 0));
const shardCount = Math.max(1, Number(args.get("shard-count") ?? 1));
const shardIndex = Math.max(0, Number(args.get("shard-index") ?? 0));
const selected = new Set((args.get("providers") ?? "a2aj,courtlistener,journal")
  .split(",").filter((value): value is Provider =>
    ["a2aj", "courtlistener", "journal"].includes(value),
  ));
if (shardIndex >= shardCount || (shardCount > 1 && selected.size !== 1)) {
  throw new Error("A shard requires one provider and 0 <= shard-index < shard-count");
}
const a2ajFile = path.resolve(args.get("a2aj-db") ?? process.env.MIKE_A2AJ_BULK_DB ??
  path.join(localProviders, "a2aj", "a2aj.sqlite"));
const a2ajSearchFile = path.join(path.dirname(a2ajFile), "a2aj-cases-fulltext.sqlite");
const courtlistenerFile = path.resolve(args.get("courtlistener-db") ??
  process.env.MIKE_COURTLISTENER_BULK_DB ??
  path.join(localProviders, "courtlistener", "courtlistener.sqlite"));

function journalSourcePath() {
  const configured = args.get("journal-db") ?? process.env.MIKE_PUBLIC_ENDPOINT_DB;
  if (configured) return path.resolve(configured);
  const direct = path.join(localProviders, "journals", "public_endpoint.db");
  if (existsSync(direct)) return direct;
  const search = path.join(localProviders, "journals", "public_endpoint-search.sqlite");
  const database = new DatabaseSync(search, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key='source_path'").get() as Row;
    return path.resolve(String(row.value));
  } finally { database.close(); }
}
const journalFile = journalSourcePath();
const explicitJournalFinal = args.get("journal-final-db") ??
  process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB;
const explicitJournalRoot = args.get("journal-contract-root") ??
  process.env.MIKE_JOURNAL_FINAL_CONTRACT_ROOT;
if (selected.has("journal") && !limit && (!explicitJournalFinal || !explicitJournalRoot)) {
  throw new Error("A full journal freeze requires explicit read-only contract DB and package roots");
}
const journalFinalFile = path.resolve(explicitJournalFinal ??
  path.join(localProviders, "journals", "journals.db"));
const journalContractRoot = path.resolve(explicitJournalRoot ??
  path.join(path.dirname(path.dirname(journalFinalFile)), "data", "final_contracts"));
for (const filename of [a2ajFile, a2ajSearchFile, courtlistenerFile, journalFile]) {
  if (!existsSync(filename)) throw new Error(`Required provider store is absent: ${path.basename(filename)}`);
}
process.env.MIKE_A2AJ_BULK_DB = a2ajFile;
process.env.MIKE_COURTLISTENER_BULK_DB = courtlistenerFile;
process.env.MIKE_PUBLIC_ENDPOINT_DB = journalFile;
process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB = journalFinalFile;

const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function sourceDigest(values: Array<Buffer | string>) {
  const hash = createHash("sha256");
  const size = Buffer.allocUnsafe(8);
  let bytes = 0;
  for (const value of values) {
    const chunk = typeof value === "string" ? Buffer.from(value) : value;
    size.writeBigUInt64LE(BigInt(chunk.length));
    hash.update(size).update(chunk);
    bytes += chunk.length;
  }
  return { source_bytes: bytes, source_sha256: hash.digest("hex") };
}
function rowDigest(rows: Row[], extra: Buffer[] = []) {
  const chunks: Array<Buffer | string> = [];
  for (const row of rows) for (const [field, value] of Object.entries(row)) {
    chunks.push(field);
    if (value === null || value === undefined) chunks.push("null");
    else if (Buffer.isBuffer(value)) chunks.push("buffer", value);
    else if (typeof value === "string") chunks.push("string", value);
    else chunks.push(typeof value, String(value));
  }
  return sourceDigest([...chunks, ...extra]);
}
function signature(filename: string, rows: number) {
  const stat = statSync(filename);
  return sha(JSON.stringify({ bytes: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), rows }));
}
function count(database: DatabaseSync, sql: string) {
  return Number((database.prepare(sql).get() as { count: number }).count);
}
function emptyCounts(): Counts {
  return {
    attempted: 0, pass: 0, failure: 0, source_bytes: 0, canonical_bytes: 0,
    elapsed_ms: 0, warmup_rows: 0, warmup_bytes: 0, warmup_ms: 0,
    modes: { native: 0, hybrid: 0, flat: 0 }, details: {}, last_id: 0,
  };
}

const a2ajDb = new DatabaseSync(a2ajFile, { readOnly: true });
const a2ajSearchDb = new DatabaseSync(a2ajSearchFile, { readOnly: true });
const courtlistenerDb = new DatabaseSync(courtlistenerFile, { readOnly: true });
const journalDb = new DatabaseSync(journalFile, { readOnly: true });
const finalDb = existsSync(journalFinalFile)
  ? new DatabaseSync(journalFinalFile, { readOnly: true }) : null;
const a2ajTotal = count(a2ajDb, "SELECT COUNT(*) AS count FROM document");
const a2ajCases = count(a2ajDb, "SELECT COUNT(*) AS count FROM document WHERE doc_type='cases'");
const a2ajLaws = count(a2ajDb, "SELECT COUNT(*) AS count FROM document WHERE doc_type='laws'");
const derivativeCases = count(a2ajSearchDb, "SELECT COUNT(*) AS count FROM document");
const courtlistenerTotal = count(courtlistenerDb, "SELECT COUNT(*) AS count FROM opinion");
const journalTotal = count(journalDb, "SELECT COUNT(*) AS count FROM articles");
const journalPages = count(journalDb, "SELECT COUNT(*) AS count FROM article_pages");
const orphanPages = count(journalDb, `SELECT COUNT(*) AS count FROM article_pages AS p
  LEFT JOIN articles AS a ON a.article_id=p.article_id WHERE a.article_id IS NULL`);
const finalRows = finalDb
  ? finalDb.prepare("SELECT * FROM article_final_contracts ORDER BY article_id").all() as Row[]
  : [];
const articleIds = new Set((journalDb.prepare("SELECT article_id FROM articles").all() as Row[])
  .map((row) => Number(row.article_id)));
const orphanContracts = finalRows.filter((row) => !articleIds.has(Number(row.article_id))).length;
if (selected.has("journal") && !limit &&
  (finalRows.length !== 6_937 || orphanContracts !== 227)) {
  throw new Error(`Journal contract denominator drift: ${finalRows.length}/6937, ${orphanContracts}/227 orphan`);
}
const inventory: Inventory = {
  a2aj: { total: a2ajTotal, cases: a2ajCases, laws: a2ajLaws, derivative_cases_search: derivativeCases },
  courtlistener: { opinions: courtlistenerTotal },
  journal: {
    articles: journalTotal, page_rows: journalPages, orphan_page_rows: orphanPages,
    final_contracts: finalRows.length, orphan_final_contracts: orphanContracts,
  },
  signatures: {
    a2aj: signature(a2ajFile, a2ajTotal),
    "a2aj-search": signature(a2ajSearchFile, derivativeCases),
    courtlistener: signature(courtlistenerFile, courtlistenerTotal),
    journal: signature(journalFile, journalTotal + journalPages),
    "journal-final": finalDb ? signature(journalFinalFile, finalRows.length) : sha("absent"),
  },
};
if (args.has("inventory")) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(0);
}

function bounds(
  database: DatabaseSync, table: string, id: string, total: number,
  index = shardIndex, parts = shardCount, where = "", finalEnd: number | null = null,
) {
  const from = Math.floor(total * index / parts);
  const to = Math.floor(total * (index + 1) / parts);
  const at = (offset: number) => offset >= total ? null : Number((database.prepare(
    `SELECT ${id} AS id FROM ${table} ${where} ORDER BY ${id} LIMIT 1 OFFSET ?`,
  ).get(offset) as Row).id);
  return { start: at(from) ?? 1, end: at(to) ?? finalEnd, count: to - from };
}
function a2ajBounds() {
  if (shardCount === 1) return bounds(a2ajDb, "document", "id", a2ajTotal);
  const caseShards = Math.floor(shardCount / 2);
  if (shardIndex < caseShards) {
    const firstLaw = Number((a2ajDb.prepare(
      "SELECT MIN(id) AS id FROM document WHERE doc_type='laws'",
    ).get() as Row).id);
    return bounds(a2ajDb, "document", "id", a2ajCases, shardIndex, caseShards,
      "WHERE doc_type='cases'", firstLaw);
  }
  return bounds(a2ajDb, "document", "id", a2ajLaws,
    shardIndex - caseShards, shardCount - caseShards, "WHERE doc_type='laws'");
}
const providerBounds = {
  a2aj: a2ajBounds(),
  courtlistener: bounds(courtlistenerDb, "opinion", "id", courtlistenerTotal),
  journal: bounds(journalDb, "articles", "article_id", journalTotal),
};

const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: path.resolve(__dirname, "../../.."), encoding: "utf8",
}).trim();
const serializerHash = sha(SOURCE_DOC_BYTES_CONTRACT);
const structureInputContractHash = sha(STRUCTURE_INPUT_BYTES_CONTRACT);
const harnessRevision = "batched-shared-engine-v4-structure-input-proof";
const engineBinaryHash = sha(readFileSync(structureNativeBinary()));
const harnessHash = sha(readFileSync(__filename));
const adapterCodeHash = sourceDigest([
  "../../src/lib/sourceDocA2AJ.ts", "../../src/lib/sourceDocNativeMarkup.ts",
  "../../src/lib/sourceDocStructureHost.ts",
  "../../src/lib/legalSources/journal.ts", "../../src/lib/sourceStructureAdapter.ts",
  "../../src/lib/sourceStructureEngine.ts", "../../src/lib/structureWire.ts",
  "../../src/lib/structureNative.ts", "../../src/lib/sourceDoc.ts",
  "../../src/lib/a2ajLocalBulk.ts", "../../src/lib/hash.ts", "canonical.ts",
].map((filename) => readFileSync(path.resolve(__dirname, filename)))).source_sha256;
const configHash = sha(JSON.stringify({
  baselineCommit, serializerHash, inventory, selected: [...selected].sort(),
  batchSize, limit, warmupRows, shardCount, shardIndex, providerBounds, digestOnly,
  retainStructure,
  harnessRevision, harnessHash, adapterCodeHash, engineBinaryHash, structureInputContractHash,
  priority: "BELOW_NORMAL",
}));
if (!digestOnly) {
  mkdirSync(output, { recursive: true });
  mkdirSync(path.join(output, "parts"), { recursive: true });
}
const checkpointFile = path.join(output, "checkpoint.json");
let peakRssBytes = process.memoryUsage.rss();
const checkpoint: Checkpoint = !digestOnly && existsSync(checkpointFile)
  ? JSON.parse(readFileSync(checkpointFile, "utf8")) as Checkpoint
  : {
      schema_version: "source-structure-installed-freeze.v1",
      config_sha256: configHash,
      baseline_commit: baselineCommit,
      serializer_contract_sha256: serializerHash,
      inventory,
      providers: { a2aj: emptyCounts(), courtlistener: emptyCounts(), journal: emptyCounts() },
      parts: [], complete: false,
      engine: { startup_ms: 0, max_documents: 0, max_bytes: 0,
        batches: 0, documents: 0, request_bytes: 0, materialize_ms: 0,
        derive_ms: 0, project_ms: 0, binary_sha256: engineBinaryHash,
        capabilities: [], priority: null },
    };
if (checkpoint.config_sha256 !== configHash) {
  throw new Error("Resume refused: code, corpus signature, or run configuration changed");
}
if (checkpoint.complete) {
  console.log(readFileSync(path.join(output, "summary.json"), "utf8"));
  process.exit(0);
}

function atomicJson(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, filename);
}
function providerTotal(provider: Provider) {
  const scoped = providerBounds[provider].count;
  return scoped + (provider === "journal" && !limit && shardIndex === shardCount - 1
    ? orphanContracts : 0);
}
function wantedRows(state: Counts) {
  const remaining = limit ? limit - state.attempted : batchSize;
  const warm = Math.max(0, warmupRows - state.attempted);
  return Math.min(remaining, batchSize, warm || batchSize);
}
function addElapsed(state: Counts, key: string, started: number) {
  state.details[key] = (state.details[key] ?? 0) + performance.now() - started;
}
function commitPart(provider: Provider, records: ManifestRecord[], lastId: number, started: number) {
  if (!records.length) return;
  const artifactStarted = performance.now();
  const body = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss());
  const partNumber = checkpoint.parts.length + 1;
  const stem = `${String(partNumber).padStart(6, "0")}-${provider}.jsonl`;
  const compressed = digestOnly ? body : gzipSync(body, { level: 6 });
  const name = digestOnly ? stem : `${stem}.gz`;
  const digest = sha(compressed);
  if (!digestOnly) {
    const filename = path.join(output, "parts", name);
    if (existsSync(filename)) {
      if (sha(readFileSync(filename)) !== digest) throw new Error(`Conflicting resume part: ${name}`);
    } else {
      const temporary = `${filename}.${process.pid}.tmp`;
      writeFileSync(temporary, compressed);
      renameSync(temporary, filename);
    }
  }
  const elapsed = performance.now() - started;
  const state = checkpoint.providers[provider];
  const attemptedBefore = state.attempted;
  for (const record of records) {
    state.attempted += 1;
    state[record.status] += 1;
    state.source_bytes += record.source_bytes;
    state.canonical_bytes += record.canonical_bytes ?? 0;
    if (record.mode) state.modes[record.mode] += 1;
    if (record.page_rows) state.details.page_rows = (state.details.page_rows ?? 0) + record.page_rows;
    if (record.final_contract) {
      const key = `final_${record.final_contract}`;
      state.details[key] = (state.details[key] ?? 0) + 1;
    }
    if (record.contract_validation) {
      state.details.contract_proofs = (state.details.contract_proofs ?? 0) + 1;
      const validation = `contract_${record.contract_validation}`;
      state.details[validation] = (state.details[validation] ?? 0) + 1;
      const role = record.contract_alias ? "contract_aliases" : "contract_standalone";
      state.details[role] = (state.details[role] ?? 0) + 1;
      if (record.contract_source_sha256) {
        state.details.contract_hashed = (state.details.contract_hashed ?? 0) + 1;
      }
      state.details.contract_pages = (state.details.contract_pages ?? 0) +
        (record.contract_pages ?? 0);
    }
    if (record.provider === "journal-final-contract") {
      state.details.orphan_final_contracts = (state.details.orphan_final_contracts ?? 0) + 1;
    }
  }
  state.elapsed_ms += elapsed;
  const artifactElapsed = performance.now() - artifactStarted;
  state.details.artifact_ms = (state.details.artifact_ms ?? 0) + artifactElapsed;
  const warmArtifactRows = Math.min(records.length, Math.max(0, warmupRows - attemptedBefore));
  state.warmup_ms += artifactElapsed * warmArtifactRows / records.length;
  state.last_id = lastId;
  checkpoint.parts.push({ name, rows: records.length, bytes: compressed.length, sha256: digest });
  if (!digestOnly) atomicJson(checkpointFile, checkpoint);
  const seconds = Math.max(state.elapsed_ms - state.warmup_ms, 1) / 1_000;
  const mib = (state.source_bytes - state.warmup_bytes) / 1048576 / seconds;
  const expected = Math.min(limit || Infinity, providerTotal(provider));
  if (state.attempted === expected || state.attempted % 1_000 < records.length) {
    console.log(`${provider} ${state.attempted}/${expected}` +
      ` pass=${state.pass} failure=${state.failure} ${mib.toFixed(1)} MiB/s`);
  }
}
function recordWarmup(state: Counts, records: ManifestRecord[], elapsed: number) {
  const count = Math.min(records.length, Math.max(0, warmupRows - state.attempted));
  if (!count) return;
  state.warmup_rows += count;
  state.warmup_bytes += records.slice(0, count)
    .reduce((sum, record) => sum + record.source_bytes, 0);
  state.warmup_ms += elapsed * count / records.length;
}
async function derivePreparedStructures(structures: readonly SourceStructureInput[]) {
  const graphs = await deriveSourceStructureGraphs(structures);
  return graphs.map(({ materialized, graph }) => ({
    doc: projectSourceStructure(materialized, graph),
    structure_input_sha256: structureInputSha256(materialized.evidence),
  }));
}
function success(provider: Provider, sourceId: string, sourceKind: string,
  digest: ReturnType<typeof sourceDigest>, doc: SourceDoc,
  extra: Partial<ManifestRecord> = {}): ManifestRecord {
  const canonical = sourceDocPublicBytes(doc);
  return {
    v: 1, provider, source_id: sourceId, source_kind: sourceKind, ...digest,
    status: "pass", mode: sourceDocMode(doc), canonical_bytes: canonical.length,
    canonical_sha256: sha(canonical), blocks: doc.blocks.length,
    ...(retainStructure ? { structure: doc.blocks.map((block) => [
      block.kind, block.label, block.start, block.end, block.origin,
      block.parentLabel ?? null, block.anchor ?? null, block.aliases ?? [],
    ]) } : {}),
    ...extra,
  };
}
function failure(provider: ManifestRecord["provider"], sourceId: string, sourceKind: string,
  digest: ReturnType<typeof sourceDigest>, code: string, error?: unknown,
  extra: Partial<ManifestRecord> = {}): ManifestRecord {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error ?? code);
  return {
    v: 1, provider, source_id: sourceId, source_kind: sourceKind, ...digest,
    status: "failure", failure: code, error_sha256: sha(message), ...extra,
  };
}

const A2AJ_COLUMNS = `id, doc_type, dataset, citation_en, citation_fr,
  citation2_en, citation2_fr, name_en, name_fr, document_date_en,
  document_date_fr, url_en, url_fr, unofficial_text_en, unofficial_text_fr,
  unofficial_sections_en, unofficial_sections_fr, upstream_license`;
async function runA2AJ() {
  const state = checkpoint.providers.a2aj;
  const batchesBefore = (await sourceStructureEngineState()).batches;
  const range = providerBounds.a2aj;
  while (!limit || state.attempted < limit) {
    const batchStarted = performance.now();
    const wanted = wantedRows(state);
    const cursor = Math.max(state.last_id, range.start - 1);
    const rows = a2ajDb.prepare(`SELECT ${A2AJ_COLUMNS} FROM document
      WHERE id > ? AND (? IS NULL OR id < ?) ORDER BY id LIMIT ?`)
      .all(cursor, range.end, range.end, wanted) as Row[];
    if (!rows.length) break;
    const available = rows.flatMap((row) => {
      const id = Number(row.id), document = a2ajDocumentFromRow(row, "en");
      if (!document) return [];
      const sectionMap = getLocalA2AJSectionMap(document);
      return [{ id, input: {
        source_kind: document.docType ?? (row.doc_type === "laws" ? "laws" : "cases"),
        dataset: document.dataset,
        citation: document.citation, alternate_citation: document.alternateCitation,
        name: document.name, url: document.url, text: document.text,
        ...(sectionMap ? { section_map: Object.entries(sectionMap) } : {}),
      } satisfies A2ajNativeInput }];
    });
    addElapsed(state, "prepare_ms", batchStarted);
    const deriveStarted = performance.now();
    const derived = a2ajSourceDocsNative(available.map(({ input }) => input));
    addElapsed(state, "derive_wall_ms", deriveStarted);
    const byId = new Map(available.map(({ id }, index) => [id, derived[index]]));
    const recordStarted = performance.now();
    const records = rows.map((row) => {
      const id = Number(row.id), result = byId.get(id), digest = rowDigest([row]);
      return result ? success("a2aj", String(id), String(row.doc_type), digest, result)
        : failure("a2aj", String(id), String(row.doc_type), digest, "provider_unavailable");
    });
    addElapsed(state, "record_ms", recordStarted);
    recordWarmup(state, records, performance.now() - batchStarted);
    commitPart("a2aj", records, Number(rows.at(-1)!.id), batchStarted);
  }
  state.details.sidecar_batches = (await sourceStructureEngineState()).batches - batchesBefore;
}

function decodeHtml(value: string) {
  return value.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) =>
      String.fromCharCode(Number.parseInt(code, 16)));
}
function opinionText(value: string | null) {
  return value ? decodeHtml(value.replace(/<page-number[^>]*>(.*?)<\/page-number>/gis, "$1")
    .replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|section|opinion|blockquote|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n").trim()) : null;
}
const COURT_MARKUP = [
  "html_with_citations", "xml_harvard", "html_columbia", "html_lawbox",
  "html_anon_2020", "html",
];
async function runCourtlistener() {
  const state = checkpoint.providers.courtlistener;
  const batchesBefore = (await sourceStructureEngineState()).batches;
  const range = providerBounds.courtlistener;
  while (!limit || state.attempted < limit) {
    const batchStarted = performance.now();
    const wanted = wantedRows(state);
    const cursor = Math.max(state.last_id, range.start - 1);
    const rows = courtlistenerDb.prepare(`SELECT * FROM opinion
      WHERE id > ? AND (? IS NULL OR id < ?) ORDER BY id LIMIT ?`)
      .all(cursor, range.end, range.end, wanted) as Row[];
    if (!rows.length) break;
    const prepared = rows.map((row) => {
      const id = String(row.id);
      const markup = COURT_MARKUP.map((field) => row[field])
        .find((value) => typeof value === "string" && value.trim()) as string | undefined;
      const plain = typeof row.plain_text === "string" && row.plain_text.trim()
        ? row.plain_text : null;
      const input: NativeMarkupSourceInput | null = markup || plain ? {
        provider: "courtlistener", id, text: markup ? "" : opinionText(plain) ?? "",
        markup: markup ?? null,
      } : null;
      return { row, id, markup, digest: rowDigest([row]), input };
    });
    const available = prepared.filter(
      (item): item is typeof item & { input: NativeMarkupSourceInput } => !!item.input,
    );
    addElapsed(state, "prepare_ms", batchStarted);
    const deriveStarted = performance.now();
    const derived = sourceDocsNative(available.map(({ input }) => ({
      kind: "native_markup" as const, input,
    })));
    const fallback = available.flatMap((item, index) => {
      const text = !derived[index].text && item.markup ? opinionText(item.markup) : null;
      return text ? [{ index, input: { provider: "courtlistener" as const,
        id: item.id, text, markup: item.markup } }] : [];
    });
    if (fallback.length) {
      const retried = sourceDocsNative(fallback.map(({ input }) => ({
        kind: "native_markup" as const, input,
      })));
      fallback.forEach(({ index }, at) => { derived[index] = retried[at]; });
    }
    addElapsed(state, "derive_wall_ms", deriveStarted);
    const byId = new Map(available.map(({ id }, index) => [id, derived[index]]));
    const recordStarted = performance.now();
    const records = prepared.map(({ id, digest }) => {
      const result = byId.get(id);
      return result?.text ? success("courtlistener", id, "opinion", digest, result)
        : failure("courtlistener", id, "opinion", digest, "provider_unavailable");
    });
    addElapsed(state, "record_ms", recordStarted);
    recordWarmup(state, records, performance.now() - batchStarted);
    commitPart("courtlistener", records, Number(rows.at(-1)!.id), batchStarted);
  }
  state.details.sidecar_batches = (await sourceStructureEngineState()).batches - batchesBefore;
}

function inside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." && !path.isAbsolute(relative));
}
function registeredPages(sourceDir: unknown) {
  if (typeof sourceDir !== "string" || !sourceDir || path.isAbsolute(sourceDir) ||
    /^[A-Za-z]:[\\/]/u.test(sourceDir)) return null;
  const relative = sourceDir.replace(/[\\/]+/gu, path.sep);
  const databaseDirectory = path.dirname(journalFinalFile);
  for (const base of [databaseDirectory, path.dirname(databaseDirectory)]) {
    const candidate = path.resolve(base, relative, "pages.jsonl");
    if (!inside(base, candidate) || !existsSync(candidate)) continue;
    try {
      const realBase = realpathSync(base), realCandidate = realpathSync(candidate);
      if (inside(realBase, realCandidate) && statSync(realCandidate).isFile()) return realCandidate;
    } catch { /* Production treats unreadable registrations as unavailable. */ }
  }
  return null;
}
function standalonePages(sourceDir: unknown) {
  const production = registeredPages(sourceDir);
  if (production) return production;
  if (typeof sourceDir !== "string" || !path.isAbsolute(sourceDir)) return null;
  const candidate = path.resolve(sourceDir, "pages.jsonl");
  try {
    const realRoot = realpathSync(journalContractRoot);
    const realCandidate = realpathSync(candidate);
    return inside(realRoot, realCandidate) && statSync(realCandidate).isFile()
      ? realCandidate : null;
  } catch { return null; }
}
function readFinalState(articleId: number, filename: string | null, pageRows: JournalPageRow[]) {
  if (!filename) return { state: "unresolved" as const, raw: null, rawSha: null,
    pages: 0, canonical: null };
  try {
    const raw = readFileSync(filename);
    const rawSha = sha(raw);
    const parsed = journalSourceDocNative(articleId, null, filename, pageRows);
    const pages = raw.toString("utf8").split(/\r?\n/u).filter((line) => line.trim()).length;
    return {
      state: parsed ? "applicable" as const : "invalid" as const,
      raw, rawSha, pages, canonical: parsed,
    };
  } catch { return { state: "invalid" as const, raw: null, rawSha: null,
    pages: 0, canonical: null }; }
}
function finalStates(articleId: number, registration: Row | undefined, pageRows: JournalPageRow[]) {
  if (!registration) return { state: "none" as const, raw: null, rawSha: null,
    pages: 0, canonical: null };
  const productionFile = registeredPages(registration.source_dir);
  const production = readFinalState(articleId, productionFile, pageRows);
  const standaloneFile = productionFile ?? standalonePages(registration.source_dir);
  const standalone = standaloneFile === productionFile
    ? production : readFinalState(articleId, standaloneFile, pageRows);
  return { production, standalone };
}
function contractProof(contract: ReturnType<typeof readFinalState>, alias: boolean) {
  return {
    contract_validation: contract.state,
    contract_source_bytes: contract.raw?.length ?? 0,
    ...(contract.rawSha ? { contract_source_sha256: contract.rawSha } : {}),
    contract_pages: contract.pages,
    contract_alias: alias,
  };
}
function publicUrl(row: Row) {
  for (const candidate of [row.galley_url, row.url_en]) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
    } catch { /* Invalid provider URLs make the source unavailable. */ }
  }
  return null;
}

async function runJournal() {
  const state = checkpoint.providers.journal;
  const batchesBefore = (await sourceStructureEngineState()).batches;
  const range = providerBounds.journal;
  const registrations = new Map(finalRows.map((row) => [Number(row.article_id), row]));
  while (!limit || state.attempted < limit) {
    const batchStarted = performance.now();
    const wanted = wantedRows(state);
    const cursor = Math.max(state.last_id, range.start - 1);
    const rows = journalDb.prepare(`SELECT * FROM articles
      WHERE article_id > ? AND (? IS NULL OR article_id < ?) ORDER BY article_id LIMIT ?`)
      .all(cursor, range.end, range.end, wanted) as Row[];
    if (!rows.length) break;
    const ids = rows.map((row) => Number(row.article_id));
    const marks = ids.map(() => "?").join(",");
    const pageRows = journalDb.prepare(`SELECT * FROM article_pages
      WHERE article_id IN (${marks}) ORDER BY article_id, page_order`).all(...ids) as Row[];
    const byArticle = new Map<number, Row[]>();
    for (const page of pageRows) byArticle.set(Number(page.article_id), [
      ...(byArticle.get(Number(page.article_id)) ?? []), page,
    ]);
    const prepared = rows.map((row) => {
      const id = Number(row.article_id);
      const pageRecords = byArticle.get(id) ?? [];
      const pages = pageRecords.map(({ page_label, pdf_page }) =>
        ({ page_label, pdf_page }) satisfies JournalPageRow);
      const registration = registrations.get(id), final = finalStates(id, registration, pages);
      const production = "production" in final ? final.production! : final;
      const contract = "standalone" in final ? final.standalone! : null;
      const digest = rowDigest([row, ...pageRecords, ...(registration ? [registration] : [])],
        contract?.raw ? [contract.raw] : []);
      const canonical = production.canonical;
      const text = canonical?.text ?? (typeof row.text === "string" ? row.text.trim() : "");
      const url = publicUrl(row);
      const input: JournalTextInput | null = text && url ? {
        articleId: id, url, text, pageRows: pages,
      } : null;
      return { id, pages, production, contract, digest, input, canonical };
    });
    const available = prepared.filter(
      (item): item is typeof item & { input: JournalTextInput } => !!item.input,
    );
    addElapsed(state, "prepare_ms", batchStarted);
    const deriveStarted = performance.now();
    const recovered = available.filter((item) => !item.canonical);
    const derived = sourceDocsNative(recovered.map(({ input }) => ({
      kind: "journal" as const,
      article_id: input.articleId,
      url: input.url,
      text: input.text,
      page_rows: input.pageRows,
    }))).map((doc) => ({ doc }));
    addElapsed(state, "derive_wall_ms", deriveStarted);
    const byId = new Map<number, { doc: SourceDoc; structure_input_sha256?: string }>();
    for (const item of available) {
      if (item.canonical) byId.set(item.id, { doc: item.canonical });
    }
    recovered.forEach(({ id }, index) => byId.set(id, derived[index]));
    const recordStarted = performance.now();
    const records = prepared.map(({ id, pages, production, contract, digest }) => {
      const result = byId.get(id);
      const extra = { final_contract: production.state, page_rows: pages.length,
        ...(contract ? contractProof(contract, true) : {}),
        ...(result ? { structure_input_sha256: result.structure_input_sha256 } : {}) };
      return result ? success("journal", String(id), "article", digest, result.doc, extra)
        : failure("journal", String(id), "article", digest, "provider_unavailable", undefined, extra);
    });
    addElapsed(state, "record_ms", recordStarted);
    recordWarmup(state, records, performance.now() - batchStarted);
    commitPart("journal", records, Number(rows.at(-1)!.article_id), batchStarted);
  }
  if (limit || shardIndex !== shardCount - 1 ||
    (state.details.orphan_final_contracts ?? 0) === orphanContracts) {
    state.details.sidecar_batches = (await sourceStructureEngineState()).batches - batchesBefore;
    return;
  }
  const batchStarted = performance.now();
  const records = finalRows.filter((row) => !articleIds.has(Number(row.article_id))).map((row) => {
    const id = Number(row.article_id);
    const final = finalStates(id, row, []);
    if (!("production" in final)) throw new Error("Registered final contract is missing");
    const standalone = final.standalone!;
    const production = final.production!;
    const digest = rowDigest([row], standalone.raw ? [standalone.raw] : []);
    return failure(
      "journal-final-contract", String(id), "orphan-final-contract", digest,
      "not_applicable_missing_source_row", undefined, {
        final_contract: production.state,
        ...contractProof(standalone, false),
      },
    );
  });
  commitPart("journal", records, state.last_id, batchStarted);
  state.details.sidecar_batches = (await sourceStructureEngineState()).batches - batchesBefore;
}

async function main() {
const startupStarted = performance.now();
const initialEngine = await sourceStructureEngineState();
if (!initialEngine.priority || initialEngine.priority.parent_pid !== runPriority.pid ||
    initialEngine.priority.parent_priority !== runPriority.priority) {
  throw new Error("Structure sidecar did not bind the BELOW_NORMAL harness priority");
}
checkpoint.engine = { startup_ms: performance.now() - startupStarted,
  max_documents: initialEngine.limits.max_documents, max_bytes: initialEngine.limits.max_bytes,
  batches: 0, documents: 0, request_bytes: 0, materialize_ms: 0,
  derive_ms: 0, project_ms: 0, binary_sha256: engineBinaryHash,
  capabilities: [...initialEngine.capabilities], priority: initialEngine.priority };
try {
  if (selected.has("a2aj")) await runA2AJ();
  if (selected.has("courtlistener")) await runCourtlistener();
  if (selected.has("journal")) await runJournal();
  for (const provider of selected) {
    const state = checkpoint.providers[provider];
    if (state.attempted !== state.pass + state.failure) {
      throw new Error(`${provider}: attempted != pass + failure`);
    }
    const expected = Math.min(limit || Infinity, providerTotal(provider));
    if (state.attempted !== expected) throw new Error(`${provider}: incomplete ${state.attempted}/${expected}`);
    const measuredBytes = state.source_bytes - state.warmup_bytes;
    const measuredMs = state.elapsed_ms - state.warmup_ms;
    const measuredDocuments = state.attempted - state.warmup_rows;
    const mib = measuredBytes / 1048576 / Math.max(measuredMs / 1000, 0.001);
    state.details.measured_mib_s_x1000 = Math.round(mib * 1000);
    state.details.measured_docs_s_x1000 = Math.round(
      measuredDocuments / Math.max(measuredMs / 1000, 0.001) * 1000,
    );
    if (requiredMib && mib < requiredMib) {
      throw new Error(`${provider}: ${mib.toFixed(1)} MiB/s is below ${requiredMib}`);
    }
  }
  const finalEngine = await sourceStructureEngineState();
  checkpoint.engine = { ...checkpoint.engine, batches: finalEngine.batches,
    documents: finalEngine.documents, request_bytes: finalEngine.request_bytes,
    materialize_ms: finalEngine.materialize_ms, derive_ms: finalEngine.derive_ms,
    project_ms: finalEngine.project_ms };
  checkpoint.complete = true;
  if (!digestOnly) atomicJson(checkpointFile, checkpoint);
  const summary = {
    ...checkpoint,
    harness_revision: harnessRevision,
    harness_sha256: harnessHash,
    adapter_code_sha256: adapterCodeHash,
    structure_input_contract_sha256: structureInputContractHash,
    artifact_mode: digestOnly ? "digest-only" : "gzip-parts",
    peak_rss_bytes: peakRssBytes,
    manifest_root_sha256: sha(JSON.stringify(checkpoint.parts)),
    artifact_bytes: checkpoint.parts.reduce((sum, part) => sum + part.bytes, 0),
  };
  if (!digestOnly) atomicJson(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await shutdownSourceStructureEngine();
  journal.closeDatabases();
  a2ajDb.close(); a2ajSearchDb.close(); courtlistenerDb.close(); journalDb.close(); finalDb?.close();
}
}

void main();
