import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpus } from "node:os";
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import {
  fetchLocalA2AJDocumentsByIds,
} from "../../src/lib/a2ajLocalBulk";

type NativeDocument = object;
type StructureAddon = {
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  sourceDocSnapshot(document: NativeDocument): Buffer;
};
type SourceSnapshot = { blocks: Array<{ origin: "native" | "heuristic" }> };

type Row = Record<string, unknown>;
type Part = { name: string; rows: number; bytes: number; sha256: string };
type RecordRow = {
  v: 1; provider: "a2aj"; source_id: string; source_kind: string;
  source_bytes: number; source_sha256: string; status: "pass" | "failure";
  mode?: "native" | "hybrid" | "flat"; canonical_bytes?: number;
  canonical_sha256?: string; blocks?: number; failure?: string; error_sha256?: string;
};
type Counts = {
  attempted: number; pass: number; failure: number; source_bytes: number;
  canonical_bytes: number; modes: Record<"native" | "hybrid" | "flat", number>;
  details: Record<string, number>; last_id: number;
};
type Summary = {
  schema_version: string; config_sha256: string; baseline_commit: string;
  serializer_contract_sha256: string; inventory: Inventory;
  scope?: { kind: string; rows?: number }; workers?: number;
  providers: Record<"a2aj" | "courtlistener" | "journal", Counts>;
  parts?: Part[]; shards?: Array<{ provider: "a2aj"; shard: number;
    manifest_root_sha256: string }>; manifest_root_sha256: string; complete?: boolean;
  engine: { binary_sha256: string }; harness_sha256: string; adapter_code_sha256: string;
  artifact_bytes?: number;
};
type Inventory = {
  a2aj: { total: number; cases: number; laws: number; derivative_cases_search: number };
  courtlistener: { opinions: number };
  journal: { articles: number; page_rows: number; orphan_page_rows: number;
    final_contracts: number; orphan_final_contracts: number };
  signatures: Record<string, string>;
};

const ROOT = path.resolve(__dirname, "../../..");
const args = new Map<string, string>();
for (let at = 2; at < process.argv.length; at += 1) {
  const key = process.argv[at];
  if (!key?.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) args.set(key.slice(2), "1");
  else { args.set(key.slice(2), value); at += 1; }
}
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const output = path.resolve(args.get("output") ?? path.join(__dirname, "results", "a2aj-current"));
const onlyId = args.get("only-id");
const workers = onlyId ? 1
  : Math.max(1, Math.min(Number(args.get("workers") ?? cpus().length - 1), 16));
const worker = args.has("worker") ? Number(args.get("worker")) : null;
const limit = Math.max(0, Number(args.get("limit") ?? 0));
const batch = Math.max(1, Math.min(Number(args.get("batch") ?? 250), 1_000));
const localProviders = path.join(
  process.env.LOCALAPPDATA ?? "", "OpenLegalProducts", "LegalData", "providers",
);
const databaseFile = path.resolve(args.get("a2aj-db") ?? process.env.MIKE_A2AJ_BULK_DB ??
  path.join(localProviders, "a2aj", "a2aj.sqlite"));
const searchFile = path.join(path.dirname(databaseFile), "a2aj-cases-fulltext.sqlite");
const nativeFile = path.resolve(process.env.LEGAL_STRUCTURE_NATIVE ?? path.join(
  ROOT, "legal-pdf-parser", "target", "release",
  process.platform === "win32" ? "legal_structure_node.dll"
    : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so",
));
for (const filename of [databaseFile, searchFile, nativeFile]) {
  if (!existsSync(filename)) throw new Error(`Required input is absent: ${filename}`);
}
process.env.MIKE_A2AJ_BULK_DB = databaseFile;
process.env.LEGAL_STRUCTURE_NATIVE = nativeFile;
const module = { exports: {} } as NodeModule;
process.dlopen(module, nativeFile);
const native = module.exports as StructureAddon;

const expected = JSON.parse(readFileSync(path.join(
  __dirname, "installed-provider-baseline.json",
), "utf8")) as { serializer_contract_sha256: string; inventory: Inventory };
const serializerContract = JSON.stringify({
  schema: "source-doc-public-bytes.v1",
  serialization: "UTF-8 JSON.stringify(SourceDoc)",
  fields: ["provider", "id", "url", "docType", "status", "revision", "text", "blocks", "ranges"],
});
if (hash(serializerContract) !== expected.serializer_contract_sha256) {
  throw new Error("SourceDoc serializer contract drift");
}
const harnessSha = hash(readFileSync(__filename));
const adapterSha = hash([
  "a2ajLocalBulk.ts",
].map((name) => readFileSync(path.join(ROOT, "backend", "src", "lib", name)))
  .reduce((all, value) => Buffer.concat([all, value]), Buffer.alloc(0)));
const engine = { binary_sha256: hash(readFileSync(nativeFile)) };

function atomicJson(filename: string, value: unknown) {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, filename);
}
function emptyCounts(): Counts {
  return { attempted: 0, pass: 0, failure: 0, source_bytes: 0,
    canonical_bytes: 0, modes: { native: 0, hybrid: 0, flat: 0 }, details: {}, last_id: 0 };
}
function signature(filename: string, rows: number) {
  const stat = statSync(filename);
  return hash(JSON.stringify({ bytes: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), rows }));
}
function sourceDigest(row: Row) {
  const digest = createHash("sha256");
  let bytes = 0;
  const chunks: Array<Buffer | string> = [];
  for (const [field, raw] of Object.entries(row)) {
    chunks.push(field);
    if (raw === null || raw === undefined) chunks.push("null");
    else if (Buffer.isBuffer(raw)) chunks.push("buffer", raw);
    else if (typeof raw === "string") chunks.push("string", raw);
    else chunks.push(typeof raw, String(raw));
  }
  for (const value of chunks) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const size = Buffer.allocUnsafe(8); size.writeBigUInt64LE(BigInt(chunk.length));
    digest.update(size).update(chunk); bytes += chunk.length;
  }
  return { source_bytes: bytes, source_sha256: digest.digest("hex") };
}
function mode(source: SourceSnapshot): "native" | "hybrid" | "flat" {
  const nativeBlocks = source.blocks.some(({ origin }) => origin === "native");
  return nativeBlocks && source.blocks.some(({ origin }) => origin === "heuristic")
    ? "hybrid" : nativeBlocks ? "native" : "flat";
}

function bounds(database: DatabaseSync, total: number, shard: number) {
  const from = Math.floor(total * shard / workers), to = Math.floor(total * (shard + 1) / workers);
  const idAt = (offset: number) => offset >= total ? null : Number((database.prepare(
    "SELECT id FROM document ORDER BY id LIMIT 1 OFFSET ?",
  ).get(offset) as { id: number }).id);
  return { start: idAt(from) ?? 1, end: idAt(to), count: to - from };
}

const COLUMNS = `id, doc_type, dataset, citation_en, citation_fr,
  citation2_en, citation2_fr, name_en, name_fr, document_date_en,
  document_date_fr, url_en, url_fr, unofficial_text_en, unofficial_text_fr,
  unofficial_sections_en, unofficial_sections_fr, upstream_license`;

async function runWorker(shard: number) {
  if (!Number.isInteger(shard) || shard < 0 || shard >= workers) throw new Error("Invalid worker");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const search = new DatabaseSync(searchFile, { readOnly: true });
  try {
    const total = Number((database.prepare("SELECT COUNT(*) count FROM document").get() as Row).count);
    const cases = Number((database.prepare(
      "SELECT COUNT(*) count FROM document WHERE doc_type='cases'",
    ).get() as Row).count);
    const laws = total - cases;
    const derivative = Number((search.prepare("SELECT COUNT(*) count FROM document").get() as Row).count);
    const inventory = structuredClone(expected.inventory);
    Object.assign(inventory.a2aj, { total, cases, laws, derivative_cases_search: derivative });
    inventory.signatures.a2aj = signature(databaseFile, total);
    inventory.signatures["a2aj-search"] = signature(searchFile, derivative);
    for (const name of ["a2aj", "a2aj-search"]) {
      if (inventory.signatures[name] !== expected.inventory.signatures[name]) {
        throw new Error(`${name} inventory drift`);
      }
    }
    const range = onlyId
      ? { start: Number(onlyId), end: Number(onlyId) + 1, count: 1 }
      : bounds(database, total, shard);
    if (onlyId && (!Number.isSafeInteger(range.start) || !database.prepare(
      "SELECT 1 FROM document WHERE id=?",
    ).get(range.start))) throw new Error(`Unknown A2AJ document id: ${onlyId}`);
    const wanted = onlyId ? 1 : limit ? Math.min(limit, range.count) : range.count;
    const directory = path.join(output, "a2aj", String(shard));
    mkdirSync(path.join(directory, "parts"), { recursive: true });
    const configSha = hash(JSON.stringify({ inventory: inventory.a2aj, signatures: inventory.signatures,
      engine, harnessSha, adapterSha, workers, shard, wanted, batch, range }));
    const summaryFile = path.join(directory, "summary.json");
    let summary: Summary = existsSync(summaryFile)
      ? JSON.parse(readFileSync(summaryFile, "utf8")) as Summary
      : { schema_version: "source-structure-installed-freeze.v1", config_sha256: configSha,
        baseline_commit: "current-worktree", serializer_contract_sha256: expected.serializer_contract_sha256,
        inventory, providers: { a2aj: emptyCounts(), courtlistener: emptyCounts(), journal: emptyCounts() },
        parts: [], manifest_root_sha256: hash("[]"), complete: false,
        engine, harness_sha256: harnessSha, adapter_code_sha256: adapterSha };
    if (summary.config_sha256 !== configSha) throw new Error(`Shard ${shard} resume contract drift`);
    if (summary.complete) { console.log(`a2aj ${shard} already complete`); return; }
    const state = summary.providers.a2aj;
    while (state.attempted < wanted) {
      const started = performance.now();
      const remaining = Math.min(batch, wanted - state.attempted);
      const cursor = Math.max(state.last_id, range.start - 1);
      const rows = database.prepare(`SELECT ${COLUMNS} FROM document
        WHERE id > ? AND (? IS NULL OR id < ?) ORDER BY id LIMIT ?`)
        .all(cursor, range.end, range.end, remaining) as Row[];
      if (!rows.length) break;
      const documents = new Map<number, ReturnType<typeof fetchLocalA2AJDocumentsByIds> extends Map<number, infer D> ? D : never>();
      for (const docType of ["cases", "laws"] as const) {
        const ids = rows.filter((row) => row.doc_type === docType).map((row) => Number(row.id));
        if (ids.length) for (const entry of fetchLocalA2AJDocumentsByIds({
          ids, docType, maxChars: Number.MAX_SAFE_INTEGER,
        })) documents.set(...entry);
      }
      const records: RecordRow[] = [];
      for (const row of rows) {
        const proof = sourceDigest(row), id = Number(row.id), document = documents.get(id);
        let record: RecordRow;
        if (!document) {
          record = { v: 1, provider: "a2aj", source_id: String(id),
            source_kind: String(row.doc_type), ...proof, status: "failure",
            failure: "provider_unavailable", error_sha256: hash("provider_unavailable") };
        } else try {
          const doc = await native.deriveDocumentStructure({
            kind: "a2aj", source_doc: true, input: { citation: document.citation,
              source_kind: document.docType ?? "cases",
              text: document.sectionMap ? "" : document.text, url: document.url,
              alternate_citation: document.alternateCitation, dataset: document.dataset,
              name: document.name,
              ...(document.sectionMap
                ? { section_map: Object.entries(document.sectionMap) } : {}) } });
          const bytes = native.sourceDocSnapshot(doc);
          const source = JSON.parse(bytes.toString("utf8")) as SourceSnapshot;
          record = { v: 1, provider: "a2aj", source_id: String(id),
            source_kind: String(row.doc_type), ...proof, status: "pass", mode: mode(source),
            canonical_bytes: bytes.length, canonical_sha256: hash(bytes),
            blocks: source.blocks.length };
        } catch (error) {
          const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
          record = { v: 1, provider: "a2aj", source_id: String(id),
            source_kind: String(row.doc_type), ...proof, status: "failure",
            failure: "engine_error", error_sha256: hash(message) };
        }
        records.push(record); state.attempted += 1; state[record.status] += 1;
        state.source_bytes += record.source_bytes;
        if (record.status === "pass") {
          state.canonical_bytes += record.canonical_bytes!; state.modes[record.mode!] += 1;
        }
      }
      state.last_id = Number(rows.at(-1)!.id);
      state.details.elapsed_ms = (state.details.elapsed_ms ?? 0) + performance.now() - started;
      const compressed = gzipSync(Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n"));
      const name = `${String(summary.parts!.length + 1).padStart(6, "0")}-a2aj.jsonl.gz`;
      const temporary = path.join(directory, "parts", `${name}.${process.pid}.tmp`);
      const final = path.join(directory, "parts", name); writeFileSync(temporary, compressed);
      renameSync(temporary, final);
      summary.parts!.push({ name, rows: records.length, bytes: compressed.length, sha256: hash(compressed) });
      summary.manifest_root_sha256 = hash(JSON.stringify(summary.parts));
      atomicJson(summaryFile, summary);
      console.log(`a2aj ${shard} ${state.attempted}/${wanted}`);
    }
    summary.complete = state.attempted === wanted;
    atomicJson(summaryFile, summary);
    if (!summary.complete) throw new Error(`Shard ${shard} incomplete ${state.attempted}/${wanted}`);
  } finally { database.close(); search.close(); }
}

async function coordinate() {
  mkdirSync(output, { recursive: true });
  const started = performance.now();
  const forwarded = ["a2aj-db", "batch", "limit", "only-id"].flatMap((key) =>
    args.has(key) ? [`--${key}`, args.get(key)!] : []);
  await Promise.all(Array.from({ length: workers }, (_, shard) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", __filename, "--worker", String(shard),
      "--workers", String(workers), "--output", output, ...forwarded], {
      cwd: path.join(ROOT, "backend"), windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve()
      : reject(new Error(`A2AJ shard ${shard} exited ${code}`)));
  })));
  const children = Array.from({ length: workers }, (_, shard) => ({ shard,
    summary: JSON.parse(readFileSync(path.join(output, "a2aj", String(shard), "summary.json"), "utf8")) as Summary }));
  const counts = emptyCounts();
  for (const { summary } of children) {
    if (!summary.complete || summary.engine.binary_sha256 !== engine.binary_sha256 ||
        summary.harness_sha256 !== harnessSha || summary.adapter_code_sha256 !== adapterSha) {
      throw new Error("Shard provenance or completion drift");
    }
    const value = summary.providers.a2aj;
    for (const key of ["attempted", "pass", "failure", "source_bytes", "canonical_bytes"] as const)
      counts[key] += value[key];
    for (const name of ["native", "hybrid", "flat"] as const) counts.modes[name] += value.modes[name];
  }
  counts.details.cold_wall_ms = Math.round(performance.now() - started);
  const artifactBytes = children.reduce((sum, { summary }) =>
    sum + summary.parts!.reduce((partSum, part) => partSum + part.bytes, 0), 0);
  if (artifactBytes > 40 * 1024 * 1024) throw new Error("Compressed receipt exceeds 40 MiB");
  const summary: Summary = { schema_version: "source-structure-installed-freeze.parallel.v1",
    config_sha256: hash(JSON.stringify({ engine, harnessSha, adapterSha, workers, limit, batch })),
    baseline_commit: "current-worktree", serializer_contract_sha256: expected.serializer_contract_sha256,
    inventory: children[0].summary.inventory,
    scope: onlyId ? { kind: "selected-id", rows: 1 }
      : limit ? { kind: "prefix-sample", rows: counts.attempted } : { kind: "full" }, workers,
    providers: { a2aj: counts, courtlistener: emptyCounts(), journal: emptyCounts() },
    shards: children.map(({ shard, summary: value }) => ({ provider: "a2aj", shard,
      manifest_root_sha256: value.manifest_root_sha256 })),
    manifest_root_sha256: hash(JSON.stringify(children.map(({ summary: value }) => value.manifest_root_sha256))),
    complete: true, engine, harness_sha256: harnessSha, adapter_code_sha256: adapterSha,
    artifact_bytes: artifactBytes };
  if (Buffer.byteLength(JSON.stringify(summary)) > 64 * 1024) throw new Error("Summary exceeds 64 KiB");
  atomicJson(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

(worker === null ? coordinate() : runWorker(worker)).catch((error) => {
  console.error(error); process.exitCode = 1;
});
