import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

type Provider = "courtlistener" | "journal";
type Row = Record<string, unknown>;
type Part = { name: string; rows: number; bytes: number; sha256: string };
type Counts = { attempted: number; pass: number; failure: number; source_bytes: number;
  canonical_bytes: number; modes: Record<"native" | "hybrid" | "flat", number>;
  details: Record<string, number>; last_id: number };
type Summary = { schema_version: string; config_sha256?: string; baseline_commit: string;
  serializer_contract_sha256: string; inventory: Row; scope?: { kind: string };
  workers?: number; providers: Record<"a2aj" | Provider, Counts>; parts?: Part[];
  shards?: Array<{ provider: Provider; shard: number; manifest_root_sha256: string }>;
  manifest_root_sha256: string; complete?: boolean; engine?: { binary_sha256: string };
  harness_sha256?: string; adapter_code_sha256?: string; artifact_bytes?: number };
type NativeDocument = object;
type Addon = { deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  sourceDocSnapshot(document: NativeDocument): { blocks: Array<{ origin: string }> } };

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
const seedRoot = path.resolve(args.get("seed") ?? path.join(__dirname,
  "results/installed-provider-freeze-full"));
const output = path.resolve(args.get("output") ?? path.join(ROOT,
  ".tmp/source-structure-current-other"));
const provider = args.get("provider") as Provider | undefined;
const shard = args.has("shard") ? Number(args.get("shard")) : null;
const nativeFile = path.resolve(process.env.LEGAL_STRUCTURE_NATIVE ?? path.join(ROOT,
  "legal-pdf-parser/target/release/legal_structure_node.dll"));
const providersRoot = path.join(process.env.LOCALAPPDATA ?? "",
  "OpenLegalProducts/LegalData/providers");
const courtlistenerFile = path.resolve(args.get("courtlistener-db") ?? path.join(providersRoot,
  "courtlistener/courtlistener.sqlite"));
const journalSearchFile = path.join(providersRoot, "journals/public_endpoint-search.sqlite");
function journalSource() {
  if (args.has("journal-db")) return path.resolve(args.get("journal-db")!);
  const database = new DatabaseSync(journalSearchFile, { readOnly: true });
  try { return path.resolve(String((database.prepare(
    "SELECT value FROM meta WHERE key='source_path'",
  ).get() as Row).value)); } finally { database.close(); }
}
const journalFile = journalSource();
const journalFinalFile = path.resolve(args.get("journal-final-db") ??
  process.env.MIKE_JOURNAL_FINAL_CONTRACT_DB ?? path.join(providersRoot,
    "journals/journals.db"));
for (const filename of [seedRoot, nativeFile, courtlistenerFile, journalFile, journalFinalFile]) {
  if (!existsSync(filename)) throw new Error(`Required offline input is absent: ${filename}`);
}
const harnessSha = hash(readFileSync(__filename));
const adapterSha = hash(Buffer.concat([
  "courtlistener.ts", "journal.ts",
].map((name) => readFileSync(path.join(ROOT, "backend/src/lib/legalSources", name)))));
const engine = { binary_sha256: hash(readFileSync(nativeFile)) };
const emptyCounts = (): Counts => ({ attempted: 0, pass: 0, failure: 0,
  source_bytes: 0, canonical_bytes: 0, modes: { native: 0, hybrid: 0, flat: 0 },
  details: {}, last_id: 0 });
const atomicJson = (filename: string, value: unknown) => {
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, filename);
};
function readPart(directory: string, part: Part) {
  const compressed = readFileSync(path.join(directory, "parts", part.name));
  if (compressed.length !== part.bytes || hash(compressed) !== part.sha256)
    throw new Error(`Corrupt seed part ${part.name}`);
  return gunzipSync(compressed).toString("utf8").trim().split(/\r?\n/gu)
    .filter(Boolean).map((line) => JSON.parse(line) as Row);
}
function addon() {
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, nativeFile);
  return module.exports as Addon;
}
function first(row: Row, names: string[]) {
  return names.map((name) => row[name]).find((value) =>
    typeof value === "string" && value.trim()) as string | undefined;
}
function publicFields(native: Addon, document: NativeDocument) {
  const source = native.sourceDocSnapshot(document);
  const bytes = Buffer.from(JSON.stringify(source));
  const hasNative = source.blocks.some(({ origin }) => origin === "native");
  const mode = hasNative && source.blocks.some(({ origin }) => origin === "heuristic")
    ? "hybrid" : hasNative ? "native" : "flat";
  return { status: "pass", mode, canonical_bytes: bytes.length,
    canonical_sha256: hash(bytes), blocks: source.blocks.length };
}
const PUBLIC = ["status", "mode", "canonical_bytes", "canonical_sha256", "blocks",
  "failure", "error_sha256", "structure"];
function result(seed: Row, value: Row) {
  return { ...Object.fromEntries(Object.entries(seed).filter(([key]) => !PUBLIC.includes(key))),
    ...value };
}
function unavailable(seed: Row, code = "provider_unavailable") {
  return result(seed, seed.status === "failure"
    ? Object.fromEntries(PUBLIC.flatMap((key) => seed[key] === undefined ? [] : [[key, seed[key]]]))
    : { status: "failure", failure: code, error_sha256: hash(code) });
}
function exception(seed: Row, error: unknown) {
  const message = error instanceof Error ? `${error.name}:${error.message}` : String(error);
  return result(seed, { status: "failure", failure: "compile_exception",
    error_sha256: hash(message) });
}

const MARKUP = ["html_with_citations", "xml_harvard", "html_columbia", "html_lawbox",
  "html_anon_2020", "html"];
async function courtlistenerRows(native: Addon, database: DatabaseSync, seeds: Row[]) {
  const ids = seeds.map(({ source_id }) => Number(source_id));
  const rows = new Map((database.prepare(`SELECT * FROM opinion WHERE id IN
    (${ids.map(() => "?").join(",")})`).all(...ids) as Row[])
    .map((row) => [Number(row.id), row]));
  const out: Row[] = [];
  for (const seed of seeds) {
    const row = rows.get(Number(seed.source_id));
    const markup = row && first(row, MARKUP), text = row && first(row, ["plain_text"]);
    if (!row || (!markup && !text)) { out.push(unavailable(seed)); continue; }
    try {
      const document = await native.deriveDocumentStructure({ kind: "native_markup", input: {
        provider: "courtlistener", id: String(seed.source_id), url: null,
        text: text ?? "", markup: markup ?? null, pageCitations: [],
      } });
      out.push(result(seed, publicFields(native, document)));
    } catch (error) { out.push(exception(seed, error)); }
  }
  return out;
}

function inside(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." && !path.isAbsolute(relative));
}
function registeredPages(sourceDir: unknown) {
  if (typeof sourceDir !== "string" || !sourceDir.trim() || path.isAbsolute(sourceDir) ||
    /^[A-Za-z]:[\\/]/u.test(sourceDir)) return null;
  const relative = sourceDir.trim().replace(/[\\/]+/gu, path.sep);
  const databaseDirectory = path.dirname(journalFinalFile);
  for (const base of [databaseDirectory, path.dirname(databaseDirectory)]) {
    const candidate = path.resolve(base, relative, "pages.jsonl");
    if (!inside(base, candidate) || !existsSync(candidate)) continue;
    try {
      const realBase = realpathSync(base), realCandidate = realpathSync(candidate);
      if (inside(realBase, realCandidate) && statSync(realCandidate).isFile()) return realCandidate;
    } catch { /* unreadable means unavailable */ }
  }
  return null;
}
function trustedUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.hash = ""; return url.toString();
  } catch { return null; }
}
async function journalRows(native: Addon, source: DatabaseSync, final: DatabaseSync, seeds: Row[]) {
  const out: Row[] = [];
  for (const seed of seeds) {
    const id = Number(seed.source_id);
    const row = source.prepare("SELECT * FROM articles WHERE article_id=?").get(id) as Row | undefined;
    if (!row) { out.push(unavailable(seed, "not_applicable_missing_source_row")); continue; }
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const url = trustedUrl(first(row, ["galley_url", "url_en"]));
    if (!text || !url) { out.push(unavailable(seed)); continue; }
    const pageRows = source.prepare(`SELECT page_label, pdf_page FROM article_pages
      WHERE article_id=? ORDER BY page_order`).all(id);
    const registration = final.prepare(
      "SELECT source_dir FROM article_final_contracts WHERE article_id=?",
    ).get(id) as Row | undefined;
    const filename = registeredPages(registration?.source_dir);
    try {
      const document = await native.deriveDocumentStructure({ kind: "journal", article_id: id,
        url, ...(filename ? { filename } : { text }), page_rows: pageRows });
      out.push(result(seed, publicFields(native, document)));
    } catch (error) { out.push(exception(seed, error)); }
  }
  return out;
}

async function runWorker(provider: Provider, shard: number) {
  const seedDirectory = path.join(seedRoot, provider, String(shard));
  const seed = JSON.parse(readFileSync(path.join(seedDirectory, "summary.json"), "utf8")) as Summary;
  const directory = path.join(output, provider, String(shard));
  mkdirSync(path.join(directory, "parts"), { recursive: true });
  const configSha = hash(JSON.stringify({ provider, shard, seed: seed.manifest_root_sha256,
    engine, harnessSha, adapterSha }));
  const summaryFile = path.join(directory, "summary.json");
  const summary: Summary = existsSync(summaryFile)
    ? JSON.parse(readFileSync(summaryFile, "utf8")) as Summary
    : { schema_version: "source-structure-installed-freeze.v1", config_sha256: configSha,
      baseline_commit: "current-worktree", serializer_contract_sha256: seed.serializer_contract_sha256,
      inventory: seed.inventory, providers: { a2aj: emptyCounts(), courtlistener: emptyCounts(),
        journal: emptyCounts() }, parts: [], manifest_root_sha256: hash("[]"), complete: false,
      engine, harness_sha256: harnessSha, adapter_code_sha256: adapterSha };
  if (summary.config_sha256 !== configSha) throw new Error(`${provider}[${shard}] resume drift`);
  if (summary.complete) { console.log(`${provider}[${shard}] already complete`); return; }
  const native = addon();
  const database = new DatabaseSync(provider === "courtlistener" ? courtlistenerFile : journalFile,
    { readOnly: true });
  const final = provider === "journal" ? new DatabaseSync(journalFinalFile, { readOnly: true }) : null;
  try {
    for (let index = summary.parts!.length; index < seed.parts!.length; index += 1) {
      const seedPart = seed.parts![index], seeds = readPart(seedDirectory, seedPart);
      const started = performance.now();
      const records = provider === "courtlistener"
        ? await courtlistenerRows(native, database, seeds)
        : await journalRows(native, database, final!, seeds);
      const compressed = gzipSync(Buffer.from(`${records.map((row) => JSON.stringify(row)).join("\n")}\n`));
      const part = { name: seedPart.name, rows: records.length, bytes: compressed.length,
        sha256: hash(compressed) };
      const temporary = path.join(directory, "parts", `${part.name}.${process.pid}.tmp`);
      writeFileSync(temporary, compressed); renameSync(temporary, path.join(directory, "parts", part.name));
      summary.parts!.push(part); summary.manifest_root_sha256 = hash(JSON.stringify(summary.parts));
      const state = summary.providers[provider];
      for (const row of records) {
        state.attempted += 1; state[String(row.status) as "pass" | "failure"] += 1;
        state.source_bytes += Number(row.source_bytes); state.canonical_bytes += Number(row.canonical_bytes ?? 0);
        if (row.mode) state.modes[row.mode as "native" | "hybrid" | "flat"] += 1;
        state.last_id = Number(row.source_id);
      }
      state.details.elapsed_ms = (state.details.elapsed_ms ?? 0) + performance.now() - started;
      atomicJson(summaryFile, summary);
      console.log(`${provider}[${shard}] ${state.attempted}/${seed.providers[provider].attempted}`);
    }
    summary.complete = summary.parts!.length === seed.parts!.length;
    atomicJson(summaryFile, summary);
  } finally { database.close(); final?.close(); }
}

async function coordinate() {
  mkdirSync(output, { recursive: true });
  const seed = JSON.parse(readFileSync(path.join(seedRoot, "summary.json"), "utf8")) as Summary;
  const selected: Provider[] = (args.get("providers") ?? "courtlistener,journal").split(",")
    .filter((value): value is Provider => value === "courtlistener" || value === "journal");
  const started = performance.now(), children: Array<{ provider: Provider; shard: number;
    summary: Summary }> = [];
  for (const current of selected) {
    const shards = seed.shards!.filter(({ provider }) => provider === current).map(({ shard }) => shard);
    const forwarded = ["courtlistener-db", "journal-db", "journal-final-db"]
      .flatMap((key) => args.has(key) ? [`--${key}`, args.get(key)!] : []);
    await Promise.all(shards.map((number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", __filename, "--provider", current,
        "--shard", String(number), "--seed", seedRoot, "--output", output, ...forwarded], {
        cwd: path.join(ROOT, "backend"), windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve()
        : reject(new Error(`${current}[${number}] exited ${code}`)));
    })));
    children.push(...shards.map((number) => ({ provider: current, shard: number,
      summary: JSON.parse(readFileSync(path.join(output, current, String(number), "summary.json"),
        "utf8")) as Summary })));
  }
  const totals = { a2aj: emptyCounts(), courtlistener: emptyCounts(), journal: emptyCounts() };
  for (const child of children) {
    if (!child.summary.complete || child.summary.engine?.binary_sha256 !== engine.binary_sha256 ||
      child.summary.harness_sha256 !== harnessSha || child.summary.adapter_code_sha256 !== adapterSha)
      throw new Error(`${child.provider}[${child.shard}] incomplete or provenance drift`);
    const source = child.summary.providers[child.provider], target = totals[child.provider];
    for (const key of ["attempted", "pass", "failure", "source_bytes", "canonical_bytes"] as const)
      target[key] += source[key];
    for (const mode of ["native", "hybrid", "flat"] as const) target.modes[mode] += source.modes[mode];
  }
  const shards = children.map(({ provider, shard, summary }) => ({ provider, shard,
    manifest_root_sha256: summary.manifest_root_sha256 }));
  const summary: Summary = { schema_version: "source-structure-installed-freeze.parallel.v1",
    baseline_commit: "current-worktree", serializer_contract_sha256: seed.serializer_contract_sha256,
    inventory: seed.inventory, scope: { kind: "full" }, providers: totals, shards,
    manifest_root_sha256: hash(JSON.stringify(shards.map(({ manifest_root_sha256 }) =>
      manifest_root_sha256))), complete: true, engine, harness_sha256: harnessSha,
    adapter_code_sha256: adapterSha, artifact_bytes: children.reduce((sum, child) => sum +
      child.summary.parts!.reduce((partSum, part) => partSum + part.bytes, 0), 0) };
  totals[selected[0]].details.cold_wall_ms = Math.round(performance.now() - started);
  atomicJson(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

(provider && shard !== null ? runWorker(provider, shard) : coordinate()).catch((error) => {
  console.error(error); process.exitCode = 1;
});
