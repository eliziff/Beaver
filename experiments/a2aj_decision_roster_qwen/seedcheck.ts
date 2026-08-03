#!/usr/bin/env node

/**
 * Seeded deterministic-arm validation loop.
 *
 * For a seed, draw the same candidates the runner would draw, run the
 * opinion-boundary module, capture a claims snapshot, and let a human
 * annotate each case ok/issue. Re-running --verify on every previously
 * annotated seed checks that ok cases still produce identical claims and
 * reports what changed for issue cases.
 *
 * Speed contract (AGENTS.md "Long-running scripts"): one persistent read-only
 * connection at a time; the deterministic candidate draw is cached per corpus
 * fingerprint (scratch/.drawcache); the selected texts are cached per corpus
 * fingerprint (scratch/.textcache); per-doc claims are cached keyed by text
 * sha under a (corpus, worker-bundle) key (scratch/.drawcache/claims.*), so
 * the module pipeline runs in the worker pool only for documents whose claims
 * are not already cached. Re-capture and verify are therefore sha-only
 * (~0.4s for 1000 cases) once a seed and module version have been computed,
 * and a fresh seed pays the full compute exactly once per module version.
 * Text selection is interleaved with pool processing so the first run hides
 * the DB read behind the compute. Progress prints per result and the ledger
 * persists atomically after every small batch, so a killed run leaves a
 * usable partial state.
 *
 * Run fast (avoids npx's ~3s boot): node --import <tsx-loader-URL> seedcheck.ts
 * where <tsx-loader-URL> is the file:// URL tsx used to launch you
 * (process.execArgv), e.g. file:///.../npm-cache/_npx/<hash>/node_modules/
 * tsx/dist/loader.mjs. Plain `npx tsx seedcheck.ts ...` also works, just
 * slower. Pass --fresh to ignore the claims cache and recompute every
 * document.
 */

import { existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync, closeSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import os from "node:os";

import { a2ajLocalBulkPath } from "../../backend/src/lib/a2ajLocalBulk";
import { candidatePoolIds, drawOffsets } from "./runner";
import type { Claims, WorkerJob, WorkerResult } from "./seedtypes";

type Candidate = {
  documentId: number;
  dataset: string;
  citation: string;
  name: string | null;
  date: string | null;
};

type LedgerRow = {
  seed: number;
  scope: string;
  documentId: number;
  citation: string;
  sourceSha256: string;
  claims: Claims;
  verdict: string | null;
  pipeline?: string;
};

const SEED_DIR = path.join(__dirname, "seeds");
const TEXT_CACHE_DIR = path.join(__dirname, "scratch", ".textcache");
const CLAIM_CACHE_DIR = path.join(__dirname, "scratch", ".drawcache");
// One worker per physical core: 6 beat 7 (2.08s) and 8 (2.28s) on the i3-1315U
// (2 P-cores + 4 E-cores); logical-thread oversubscription loses to the E-core
// deficit and the main thread's own needs.
const WORKERS = Math.min(6, Math.max(2, os.cpus().length));

function flag(args: Record<string, string>, key: string, fallback = "") {
  const value = args[key];
  return value === undefined || value === "true" ? fallback : value;
}

function ledgerPath(seed: number, scope: string) {
  return path.join(SEED_DIR, `${seed}.${scope.toLocaleUpperCase()}.jsonl`);
}

function openCaseDatabase() {
  const filename = a2ajLocalBulkPath();
  if (!existsSync(filename)) throw new Error(`A2AJ bulk db not found: ${filename}`);
  return new DatabaseSync(filename, { readOnly: true });
}

function corpusFingerprint() {
  const stat = statSync(a2ajLocalBulkPath());
  return `${stat.size}:${stat.mtimeMs}`;
}

function sha256Text(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256File(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function jobFromRow(row: Record<string, unknown>): WorkerJob | null {
  const string = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  const documentId = Number(row.id);
  const citation = string(row.citation_en) ?? string(row.citation2_en);
  const text = string(row.unofficial_text_en);
  if (!citation || !text) return null;
  return {
    documentId,
    citation,
    dataset: string(row.dataset) ?? "",
    name: string(row.name_en),
    text,
    url: string(row.url_en),
    alternateCitation: string(row.citation2_en),
  };
}

function libSourceTimes() {
  let latest = 0;
  const scan = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith(".ts")) {
        latest = Math.max(latest, statSync(full).mtimeMs);
      }
    }
  };
  scan(path.join(__dirname, "..", "..", "backend", "src", "lib"));
  return latest;
}

function esbuildFromTsxCache(): unknown {
  const loaderCandidates: string[] = [];
  for (const arg of process.execArgv) {
    if (arg.startsWith("--import=")) {
      loaderCandidates.push(arg.slice("--import=".length));
      continue;
    }
    if (arg === "--import") {
      const value = process.execArgv[process.execArgv.indexOf(arg) + 1];
      if (value && !value.startsWith("--")) loaderCandidates.push(value);
      continue;
    }
    if (arg.startsWith("file://") && arg.includes("tsx")) loaderCandidates.push(arg);
  }
  const candidatePaths = loaderCandidates.map((value) => {
    let loaderPath: string | null = null;
    try {
      if (value.startsWith("file://")) loaderPath = new URL(value).pathname;
    } catch {
      loaderPath = null;
    }
    if (!loaderPath) return null;
    if (process.platform === "win32" && loaderPath.startsWith("/")) {
      loaderPath = loaderPath.slice(1);
    }
    return path.join(path.resolve(path.dirname(loaderPath), "..", ".."), "esbuild", "lib", "main.js");
  });
  const local = path.join(__dirname, "..", "..", "backend", "node_modules", "esbuild", "lib", "main.js");
  for (const candidate of [...candidatePaths, local]) {
    if (!candidate) continue;
    try {
      return require(candidate);
    } catch {
      // Not this esbuild; try the next candidate.
    }
  }
  return null;
}

function ensureWorkerBundle(): string {
  const outfile = path.join(__dirname, "scratch", "worker.bundle.mjs");
  const latest = Math.max(
    statSync(path.join(__dirname, "worker.ts")).mtimeMs,
    statSync(path.join(__dirname, "seedtypes.ts")).mtimeMs,
    libSourceTimes(),
  );
  if (existsSync(outfile) && statSync(outfile).mtimeMs >= latest) return outfile;
  const esbuild = esbuildFromTsxCache();
  if (!esbuild) throw new Error("cannot locate esbuild next to the tsx loader to bundle worker.ts");
  (esbuild as { buildSync: (options: Record<string, unknown>) => void }).buildSync({
    entryPoints: [path.join(__dirname, "worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
  });
  return outfile;
}

function idPoolCachePath(scope: string) {
  const fingerprint = corpusFingerprint();
  return path.join(CLAIM_CACHE_DIR, `ids.${scope}.${fingerprint.replace(/:/g, "_")}.json`);
}

function drawCandidates(seed: number, n: number, scope: string, database: DatabaseSync) {
  const fingerprint = corpusFingerprint();
  const cachePath = path.join(CLAIM_CACHE_DIR, `${seed}.${scope.toLocaleUpperCase()}.${n}.json`);
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fingerprint: string; candidates: Candidate[] };
    if (cached.fingerprint === fingerprint) return cached.candidates;
  } catch {
    // Cache miss or unreadable cache; draw fresh.
  }
  let poolIds: number[];
  const poolPath = idPoolCachePath(scope);
  try {
    const cached = JSON.parse(readFileSync(poolPath, "utf8")) as { fingerprint: string; ids: number[] };
    poolIds = cached.fingerprint === fingerprint ? cached.ids : [];
  } catch {
    poolIds = [];
  }
  if (!poolIds.length) {
    poolIds = candidatePoolIds(scope, database);
    if (!poolIds.length) throw new Error(`no A2AJ cases found for scope ${scope}`);
    mkdirSync(path.dirname(poolPath), { recursive: true });
    writeFileSync(poolPath, JSON.stringify({ fingerprint, ids: poolIds }), "utf8");
  }
  const drawn = drawOffsets(seed, n, poolIds.length).map((offset) => poolIds[offset]);
  const byId = new Map<number, Record<string, unknown>>();
  for (let index = 0; index < drawn.length; index += 500) {
    const chunk = drawn.slice(index, index + 500);
    const marks = chunk.map(() => "?").join(",");
    const rows = database
      .prepare(
        `SELECT id, dataset,
          COALESCE(NULLIF(citation_en, ''), NULLIF(citation2_en, '')) AS citation,
          name_en, document_date_en
        FROM document WHERE id IN (${marks})`,
      )
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) byId.set(Number(row.id), row);
  }
  const candidates = drawn.map((id) => {
    const row = byId.get(id) ?? {};
    return {
      documentId: Number(id),
      dataset: String(row.dataset ?? ""),
      citation: String(row.citation ?? ""),
      name: row.name_en ? String(row.name_en) : null,
      date: row.document_date_en ? String(row.document_date_en) : null,
    } satisfies Candidate;
  });
  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify({ fingerprint, candidates }), "utf8");
  return candidates;
}

type TextCacheEntry = {
  documentId: number;
  citation: string;
  dataset: string;
  name: string | null;
  url: string | null;
  alternateCitation: string | null;
  offset: number;
  length: number;
};

function textCachePaths(fingerprint: string) {
  const base = fingerprint.replace(":", "_");
  return {
    index: path.join(TEXT_CACHE_DIR, `${base}.index.json`),
    bin: path.join(TEXT_CACHE_DIR, `${base}.texts.bin`),
  };
}

function readTextCacheEntries(): { fingerprint: string; entries: TextCacheEntry[]; binLength: number } | null {
  const fingerprint = corpusFingerprint();
  const { index: indexPath, bin: binPath } = textCachePaths(fingerprint);
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { fingerprint: string; entries: TextCacheEntry[] };
    if (parsed.fingerprint !== fingerprint) return null;
    let binLength = 0;
    try {
      binLength = statSync(binPath).size;
    } catch {
      return null;
    }
    return { fingerprint, entries: parsed.entries, binLength };
  } catch {
    return null;
  }
}

function readTextCache(ids: readonly number[]): { jobs: Map<number, WorkerJob>; missing: number[] } | null {
  const cached = readTextCacheEntries();
  if (!cached) return null;
  const { entries } = cached;
  let bin: Buffer;
  try {
    bin = readFileSync(textCachePaths(corpusFingerprint()).bin);
  } catch {
    return null;
  }
  const byId = new Map(entries.map((entry) => [entry.documentId, entry]));
  const jobs = new Map<number, WorkerJob>();
  const missing: number[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    if (entry.offset + entry.length > bin.length) {
      missing.push(id);
      continue;
    }
    const text = bin.toString("utf8", entry.offset, entry.offset + entry.length);
    jobs.set(id, {
      documentId: entry.documentId,
      citation: entry.citation,
      dataset: entry.dataset,
      name: entry.name,
      text,
      url: entry.url,
      alternateCitation: entry.alternateCitation,
    });
  }
  return { jobs, missing };
}

function writeTextCache(extra: Map<number, WorkerJob>) {
  const fingerprint = corpusFingerprint();
  const { index: indexPath, bin: binPath } = textCachePaths(fingerprint);
  mkdirSync(TEXT_CACHE_DIR, { recursive: true });
  const existing = readTextCacheEntries();
  const entries: TextCacheEntry[] = existing?.entries ?? [];
  const known = new Map(entries.map((entry) => [entry.documentId, entry]));
  const added: TextCacheEntry[] = [];
  const parts: string[] = [];
  let offset = existing?.binLength ?? 0;
  for (const job of extra.values()) {
    if (known.has(job.documentId)) continue;
    const length = Buffer.byteLength(job.text, "utf8");
    added.push({
      documentId: job.documentId,
      citation: job.citation,
      dataset: job.dataset,
      name: job.name,
      url: job.url,
      alternateCitation: job.alternateCitation,
      offset,
      length,
    });
    parts.push(job.text);
    offset += length;
  }
  if (!added.length) return;
  if (parts.length) {
    const fd = openSync(binPath, "a");
    try {
      writeSync(fd, parts.join(""), null, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  writeFileSync(`${indexPath}.tmp`, JSON.stringify({ fingerprint, entries: [...entries, ...added] }), "utf8");
  renameSync(`${indexPath}.tmp`, indexPath);
}

function claimsCachePath(key: string) {
  return path.join(CLAIM_CACHE_DIR, `claims.${key.replace(/:/g, "_")}.json`);
}

function loadClaimsCache(key: string): Record<string, Claims> {
  try {
    const parsed = JSON.parse(readFileSync(claimsCachePath(key), "utf8")) as {
      key: string;
      bySha: Record<string, Claims>;
    };
    return parsed.key === key ? parsed.bySha : {};
  } catch {
    return {};
  }
}

function saveClaimsCache(key: string, bySha: Record<string, Claims>) {
  mkdirSync(CLAIM_CACHE_DIR, { recursive: true });
  const target = claimsCachePath(key);
  const temp = `${target}.tmp`;
  writeFileSync(temp, JSON.stringify({ key, bySha }), "utf8");
  renameSync(temp, target);
  for (const file of readdirSync(CLAIM_CACHE_DIR)) {
    const full = path.join(CLAIM_CACHE_DIR, file);
    if (file.startsWith("claims.") && full !== target) {
      try {
        unlinkSync(full);
      } catch {
        // Best-effort prune of stale module-version caches.
      }
    }
  }
}

function runPool(
  feed: () => WorkerJob[] | null,
  workers: number,
  onResult: (result: WorkerResult) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workerBundle = ensureWorkerBundle();
    let active = 0;
    const spawned: Worker[] = [];
    const finished = () => {
      if (active === 0) resolve();
    };
    const spawn = () => {
      const worker = new Worker(workerBundle);
      spawned.push(worker);
      active += 1;
      worker.on("message", (results: WorkerResult[]) => {
        for (const result of results) onResult(result);
        const next = feed();
        if (next?.length) worker.postMessage(next);
        else {
          active -= 1;
          worker.terminate();
          finished();
        }
      });
      worker.on("error", (error) => {
        active -= 1;
        worker.terminate();
        for (const other of spawned) other.terminate();
        reject(error);
      });
      const next = feed();
      if (next?.length) worker.postMessage(next);
      else {
        active -= 1;
        worker.terminate();
        finished();
      }
    };
    for (let index = 0; index < workers; index += 1) spawn();
  });
}

/**
 * Load texts (from the per-fingerprint cache or a chunked DB select),
 * partition jobs into sha-cached claims vs pool work, and run the pool as
 * batches arrive so the first DB read hides behind the compute. Returns the
 * loaded jobs and the claims already known without compute.
 */
async function loadAndRun(
  ids: readonly number[],
  bySha: Record<string, Claims>,
  onResult: (result: WorkerResult) => void,
): Promise<{ jobsById: Map<number, WorkerJob>; fast: Map<number, { sha: string; claims: Claims }> }> {
  const cached = readTextCache(ids);
  const jobsById = cached?.jobs ?? new Map<number, WorkerJob>();
  const missing = cached?.missing ?? [...ids];
  const cacheUsed = cached !== null;
  const dbJobs = new Map<number, WorkerJob>();
  const fast = new Map<number, { sha: string; claims: Claims }>();
  const pending: WorkerJob[] = [];
  let db: DatabaseSync | null = null;
  let chunkIndex = 0;
  let cacheFilled = false;
  const selectStarted = performance.now();

  const fill = () => {
    if (!cacheFilled) {
      cacheFilled = true;
      if (cacheUsed) {
        for (const id of ids) {
          const job = jobsById.get(id);
          if (!job) continue;
          const sha = sha256Text(job.text);
          const cachedClaims = bySha[sha];
          if (cachedClaims) fast.set(id, { sha, claims: cachedClaims });
          else pending.push(job);
        }
        console.log(`texts: ${ids.length - missing.length}/${ids.length} loaded from cache in ${(performance.now() - selectStarted).toFixed(0)}ms`);
        if (missing.length === 0) return;
      }
    }
    if (!db) db = openCaseDatabase();
    while (pending.length < 500 && chunkIndex < missing.length) {
      const chunk = missing.slice(chunkIndex, chunkIndex + 250);
      chunkIndex += 250;
      const marks = chunk.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT id, unofficial_text_en, citation_en, citation2_en, url_en,
                  dataset, name_en, document_date_en, upstream_license
           FROM document WHERE id IN (${marks})`,
        )
        .all(...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const job = jobFromRow(row);
        if (!job) continue;
        jobsById.set(job.documentId, job);
        dbJobs.set(job.documentId, job);
        const sha = sha256Text(job.text);
        const cachedClaims = bySha[sha];
        if (cachedClaims) fast.set(job.documentId, { sha, claims: cachedClaims });
        else pending.push(job);
      }
      console.log(`select texts: ${Math.min(chunkIndex, missing.length)}/${missing.length} in ${(performance.now() - selectStarted).toFixed(0)}ms`);
    }
  };

  const feed = () => {
    fill();
    const batch = pending.splice(0, 50);
    return batch.length ? batch : null;
  };

  await runPool(feed, WORKERS, onResult);
  if (db) db.close();
  if (dbJobs.size > 0) writeTextCache(dbJobs);
  return { jobsById, fast };
}

async function readLedger(seed: number, scope: string): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  try {
    const text = await readFile(ledgerPath(seed, scope), "utf8");
    for (const line of text.split(/\r?\n/u)) {
      if (line.trim()) rows.push(JSON.parse(line) as LedgerRow);
    }
  } catch {
    // No ledger yet.
  }
  return rows;
}

async function writeLedger(seed: number, scope: string, rows: LedgerRow[]) {
  await mkdir(SEED_DIR, { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const target = ledgerPath(seed, scope);
  const temp = `${target}.tmp`;
  await writeFile(temp, body, "utf8");
  await rename(temp, target);
}

function printReport(claims: Claims, citation: string, ordinal: number) {
  console.log(
    `--- ${ordinal} ${citation} status=${claims.status} partition=${claims.partition.status}${claims.partition.note ? ` note="${claims.partition.note}"` : ""}`,
  );
  if (claims.panel.length) console.log(`    panel: ${claims.panel.join(" | ")}`);
  if (claims.pages?.length) console.log(`    pages: ${claims.pages.join(" | ")}`);
  for (const binding of claims.bindings) {
    const range = binding.from !== null ? ` [${binding.from}-${binding.to ?? "?"}${binding.page !== null ? ` p${binding.page}` : ""}]` : "";
    console.log(`    binding ${binding.role}: ${binding.names.join(", ") || "(none)"}${range} :: ${binding.line.slice(0, 90)}`);
  }
  for (const opinion of claims.opinions) {
    const semantic = opinion.paragraphs ? `par ${opinion.paragraphs.from}-${opinion.paragraphs.to}` : "par ?";
    const offset = opinion.offset ? `off ${opinion.offset.start}-${opinion.offset.end}` : "off ?";
    const page = opinion.page ? `p${opinion.page.start}${opinion.page.start !== opinion.page.end ? `-p${opinion.page.end}` : ""}` : "p?";
    console.log(`    opinion ${opinion.role}: ${opinion.names.join(", ") || "(none)"} :: ${semantic} | ${offset} | ${page}`);
  }
  for (const marker of claims.markers.slice(0, 12)) {
    console.log(`    marker [${marker.paragraph}] ${marker.kind} ${marker.name ?? ""} ${marker.role ?? ""} :: ${marker.line.slice(0, 60)}`);
  }
  if (claims.markers.length > 12) console.log(`    ... ${claims.markers.length - 12} more markers`);
  for (const refusal of claims.refusals) console.log(`    refusal: ${refusal.slice(0, 110)}`);
}

async function capture(seed: number, n: number, scope: string, fresh: boolean, verbose: boolean) {
  const startedAt = performance.now();
  const rows = await readLedger(seed, scope);
  const byId = new Map(rows.map((row) => [row.documentId, row]));
  const database = openCaseDatabase();
  const candidates = drawCandidates(seed, n, scope, database);
  database.close();
  const claimsKey = `${corpusFingerprint()}:${sha256File(ensureWorkerBundle())}`;
  const pipelineHash = claimsKey.slice(claimsKey.indexOf(":") + 1);
  const bySha = fresh ? {} : loadClaimsCache(claimsKey);
  const byCandidate = new Map(candidates.map((candidate) => [candidate.documentId, candidate]));
  const poolResults = new Map<number, { sha: string; claims: Claims }>();
  let poolOrdinal = 0;
  const { jobsById, fast } = await loadAndRun(
    candidates.map((candidate) => candidate.documentId),
    bySha,
    (result) => {
      bySha[result.sourceSha256] ??= result.claims;
      poolResults.set(result.documentId, { sha: result.sourceSha256, claims: result.claims });
      poolOrdinal += 1;
      if (verbose || process.stdout.isTTY) {
        const candidate = byCandidate.get(result.documentId);
        printReport(result.claims, candidate?.citation ?? String(result.documentId), poolOrdinal);
      }
      if (poolOrdinal % 50 === 0) {
        console.log(`... pool ${poolOrdinal} computed (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);
      }
    },
  );
  const jobs = candidates.flatMap((candidate) => {
    const job = jobsById.get(candidate.documentId);
    return job ? [job] : [];
  });
  console.log(`draw: ${candidates.length} candidates, texts: ${jobsById.size}, pool computed: ${poolResults.size} (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);

  const drawnIds = new Set(candidates.map((candidate) => candidate.documentId));
  const finalRows = rows.filter((row) => !drawnIds.has(row.documentId));
  let ordinal = 0;
  let skipped = 0;
  let writeChain: Promise<void> = Promise.resolve();
  for (const candidate of candidates) {
    const entry = poolResults.get(candidate.documentId) ?? fast.get(candidate.documentId);
    if (!entry) continue;
    ordinal += 1;
    const existing = byId.get(candidate.documentId);
    if (existing?.sourceSha256 === entry.sha && existing?.pipeline === pipelineHash) {
      skipped += 1;
      finalRows.push(existing);
      continue;
    }
    finalRows.push({
      seed,
      scope: scope.toLocaleUpperCase(),
      documentId: candidate.documentId,
      citation: candidate.citation,
      sourceSha256: entry.sha,
      claims: entry.claims,
      verdict: null,
      pipeline: pipelineHash,
    });
    if (ordinal % 50 === 0) {
      const snapshot = [...finalRows];
      writeChain = writeChain.then(() => writeLedger(seed, scope, snapshot));
      console.log(`... ${ordinal}/${jobs.length} done (${skipped} cached, ${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);
    }
  }
  await writeChain;
  await writeLedger(seed, scope, finalRows);
  if (poolResults.size > 0) saveClaimsCache(claimsKey, bySha);
  console.log(`ledger ${ledgerPath(seed, scope)} (${finalRows.length} rows, ${skipped} cached) in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
}

async function annotate(seed: number, scope: string, documentId: number, verdict: string) {
  const rows = await readLedger(seed, scope);
  const row = rows.find((item) => item.documentId === documentId);
  if (!row) throw new Error(`document ${documentId} not in ledger ${ledgerPath(seed, scope)}`);
  row.verdict = verdict;
  await writeLedger(seed, scope, rows);
  console.log(`annotated ${documentId}: ${verdict}`);
}

async function verify(seeds: number[], scope: string, fresh: boolean) {
  const totals = { annotated: 0, ok: 0, regressed: 0, fixed: 0, changed: 0, rows: 0 };
  const startedAll = performance.now();
  for (const seed of seeds) {
    const startedAt = performance.now();
    const rows = await readLedger(seed, scope);
    const annotated = rows.filter((row) => row.verdict);
    const okRows = annotated.filter((row) => row.verdict === "ok");
    const issueRows = annotated.filter((row) => row.verdict?.startsWith("issue"));
    const ok = okRows.length;
    const total = annotated.length;
    let regressed = 0;
    let fixed = 0;
    let changed = 0;
    let computed = 0;
    const byId = new Map(rows.map((row) => [row.documentId, row]));
    const claimsKey = `${corpusFingerprint()}:${sha256File(ensureWorkerBundle())}`;
    const bySha = fresh ? {} : loadClaimsCache(claimsKey);
    let done = 0;
    const compare = (sha: string, claims: Claims, row: LedgerRow) => {
      done += 1;
      if (sha !== row.sourceSha256) {
        changed += 1;
        return;
      }
      if (JSON.stringify(claims) === JSON.stringify(row.claims)) return;
      changed += 1;
      if (row.verdict === "ok") {
        regressed += 1;
        console.log(`  ! ${row.citation} CLAIMS DIFFER: ${JSON.stringify(claims).slice(0, 400)}`);
      } else if (row.verdict?.startsWith("issue")) {
        fixed += 1;
        console.log(`  ~ ${row.citation} CHANGED: ${JSON.stringify(claims).slice(0, 400)}`);
      } else {
        console.log(`  ? ${row.citation} (unannotated) CHANGED: ${JSON.stringify(claims).slice(0, 400)}`);
      }
      if (done % 250 === 0) {
        console.log(`  ... ${done}/${rows.length} scanned (${((performance.now() - startedAt) / 1000).toFixed(1)}s)`);
      }
    };
    const { fast } = await loadAndRun(
      rows.map((row) => row.documentId),
      bySha,
      (result) => {
        bySha[result.sourceSha256] ??= result.claims;
        computed += 1;
        const row = byId.get(result.documentId);
        if (!row) return;
        compare(result.sourceSha256, result.claims, row);
      },
    );
    for (const row of rows) {
      const entry = fast.get(row.documentId);
      if (!entry) continue;
      compare(entry.sha, entry.claims, row);
    }
    if (computed > 0) saveClaimsCache(claimsKey, bySha);
    const rate = total ? Math.round((ok / total) * 1_000) / 10 : null;
    totals.annotated += total;
    totals.ok += ok;
    totals.regressed += regressed;
    totals.fixed += fixed;
    totals.changed += changed;
    totals.rows += rows.length;
    console.log(
      `seed ${seed} ${scope}: ${ok}/${total} ok (${rate ?? "?"}%) regressed=${regressed} fixed_or_changed=${fixed} changed=${changed}/${rows.length} in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  }
  const rate = totals.annotated ? Math.round((totals.ok / totals.annotated) * 1_000) / 10 : null;
  console.log(
    `TOTAL ${seeds.length} seeds ${scope}: ${totals.ok}/${totals.annotated} ok (${rate ?? "?"}%) regressed=${totals.regressed} fixed_or_changed=${totals.fixed} changed=${totals.changed}/${totals.rows} in ${((performance.now() - startedAll) / 1000).toFixed(1)}s`,
  );
}

async function main() {
  const args: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { args[key] = next; index += 1; }
    else args[key] = "true";
  }
  const mode = argv[0] ?? "help";
  const seed = Number(flag(args, "seed", "0")) || 1;
  const n = Number(flag(args, "n", "1000"));
  const scope = flag(args, "scope", "ALL").toLocaleUpperCase();
  const fresh = argv.includes("--fresh");
  const verbose = argv.includes("--verbose");
  if (mode === "capture") await capture(seed, n, scope, fresh, verbose);
  else if (mode === "annotate") {
    const documentId = Number(flag(args, "doc", "0"));
    const verdict = flag(args, "verdict", "");
    if (!documentId || !verdict) throw new Error("annotate requires --doc and --verdict ok|issue[:note]");
    await annotate(seed, scope, documentId, verdict);
  } else if (mode === "verify") {
    const seedsArg = flag(args, "seeds", "all");
    let seeds: number[];
    if (seedsArg === "all" || !seedsArg) {
      seeds = readdirSync(SEED_DIR)
        .map((name) => /^(\d+)\.\w+\.jsonl$/u.exec(name)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(Number)
        .sort((a, b) => a - b);
      if (!seeds.length) throw new Error(`no ledgers in ${SEED_DIR}`);
    } else {
      seeds = seedsArg.split(",").map(Number).filter((value) => Number.isFinite(value) && value > 0);
    }
    await verify(seeds, scope, fresh);
  } else throw new Error("modes: capture | annotate | verify");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
