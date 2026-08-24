import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { instrumentCorpusFiles, readAgreement, readPdf, ROOT } from "./corpus";
import type { NativeDocument } from "../../backend/src/lib/structureNative";

const DIR = path.join(ROOT, ".tmp/instrument-structure-benchmark");
const RECEIPT = path.join(DIR, "receipt.json");
const BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const TSX = path.join(ROOT, "backend/node_modules/tsx/dist/cli.mjs");
const LIMIT = Number(process.argv.find((value) => value.startsWith("--limit="))?.slice(8) ?? Infinity);
const PARITY = process.argv.includes("--parity");
const MEASURE_MEMORY = process.argv.includes("--memory");
const WORKER = process.argv.find((value) => value.startsWith("--worker="))?.slice(9);
const RECONSTRUCT_LINEATION = !process.argv.includes("--no-reconstruct-lineation");
const GC_CADENCE = 25;

type Document = { id: string; text: string; pages?: number; lines?: number };
type Addon = {
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  derivePdfDocument(bytes: Buffer, request: unknown): Promise<NativeDocument>;
};
type Memory = ReturnType<typeof process.memoryUsage>;
type Locator = { kind: "agreement" | "pdf"; index: number; id: string; bytes: number };

const round = (value: number) => Number(value.toFixed(3));
const total = (values: number[]) => values.reduce((sum, value) => sum + value, 0);
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return round(sorted[Math.ceil(fraction * sorted.length) - 1]);
};
const memory = (): Memory => process.memoryUsage();
const memoryDelta = (after: Memory, before: Memory) => Object.fromEntries(
  Object.keys(after).map((key) => [key, after[key as keyof Memory] - before[key as keyof Memory]]),
);
const gitCommit = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], {
  cwd, encoding: "utf8",
}).trim();

function addonPath() {
  return path.resolve(process.env.LEGAL_STRUCTURE_NATIVE?.trim() || path.join(
    ROOT, "native/legal-structure-node/target/release",
    process.platform === "win32" ? "legal_structure_node.dll"
      : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so",
  ));
}

function loadAddon(filename: string): Addon {
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, filename);
  return module.exports as Addon;
}

function peakSampler(initial: Memory) {
  const peak = { ...initial };
  const sample = () => {
    const current = memory();
    for (const key of Object.keys(current) as Array<keyof Memory>) {
      peak[key] = Math.max(peak[key], current[key]);
    }
  };
  const timer = setInterval(sample, 5);
  return { peak, sample, stop: () => { clearInterval(timer); sample(); } };
}

async function writePartial(mode: string, value: object) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(path.join(DIR, `${mode}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function streamCorpus(addon: Addon, limit: number,
  visit: (document: Document, count: number) => Promise<void>) {
  const { agreements, pdfs } = await instrumentCorpusFiles();
  const hash = createHash("sha256");
  const locators: Locator[] = [];
  let agreementsRead = 0;
  let pdfsRead = 0;
  let pages = 0;
  let lines = 0;
  let inputBytes = 0;
  let agreementLoadMs = 0;
  let pdfLoadDecompressionMs = 0;
  const consume = async (kind: Locator["kind"], index: number, document: Document, loadMs: number) => {
    const bytes = Buffer.byteLength(document.text);
    if (kind === "agreement") { agreementsRead += 1; agreementLoadMs += loadMs; }
    else { pdfsRead += 1; pdfLoadDecompressionMs += loadMs; pages += document.pages!; lines += document.lines!; }
    for (const value of [document.id, document.text]) {
      hash.update(`${Buffer.byteLength(value)}:`).update(value).update("\n");
    }
    inputBytes += bytes;
    locators.push({ kind, index, id: document.id, bytes });
    await visit(document, locators.length);
  };
  for (let index = 0; index < agreements.length && locators.length < limit; index += 1) {
    const started = performance.now();
    const document = await readAgreement(agreements[index]);
    await consume("agreement", index, document, performance.now() - started);
  }
  for (let index = 0; index < pdfs.length && locators.length < limit; index += 1) {
    const started = performance.now();
    const document = await readPdf(pdfs[index], addon);
    await consume("pdf", index, document, performance.now() - started);
  }
  return { locators, surface: { agreements: agreementsRead, pdfs: pdfsRead, pages, lines,
    inputBytes, inputSha256: hash.digest("hex") }, fixtureLoad: {
    agreementMs: round(agreementLoadMs), pdfReadDecompressionMs: round(pdfLoadDecompressionMs),
    totalMs: round(agreementLoadMs + pdfLoadDecompressionMs) } };
}

async function readTarget(addon: Addon, kind: Locator["kind"], index: number) {
  const files = await instrumentCorpusFiles();
  const file = kind === "agreement" ? files.agreements[index] : files.pdfs[index];
  if (!file) throw new Error(`benchmark target missing: ${kind}:${index}`);
  const started = performance.now();
  const document = kind === "agreement" ? await readAgreement(file as string)
    : await readPdf(file as (typeof files.pdfs)[number], addon);
  return { document, loadMs: round(performance.now() - started) };
}

async function workerMain(mode: string) {
  const baseline = JSON.parse(await fs.readFile(BASELINE, "utf8"));
  const locked = { documents: baseline.denominators.agreements + baseline.denominators.pdfs,
    denominators: baseline.denominators, inputBytes: baseline.inputBytes,
    inputSha256: baseline.inputSha256 };
  await writePartial(mode, { schemaVersion: "beaver.instrument-structure-benchmark-worker.v2",
    mode, complete: false, checked: 0, locked });
  const targetKind = process.argv.find((value) => value.startsWith("--target-kind="))?.slice(14) as Locator["kind"] | undefined;
  const targetIndex = Number(process.argv.find((value) => value.startsWith("--target-index="))?.slice(15));
  const nativeFile = addonPath();
  const addon = loadAddon(nativeFile);
  const target = targetKind ? await readTarget(addon, targetKind, targetIndex) : null;
  const timed = mode === "derive";
  const measuredMemory = mode === "memory" || target !== null;
  if (measuredMemory) global.gc?.();
  const memoryBaseline = measuredMemory ? memory() : undefined;
  const sampler = memoryBaseline ? peakSampler(memoryBaseline) : undefined;
  const derive: number[] = [];
  let live: Memory | undefined;
  let released: Memory | undefined;
  const deriveOne = async (document: Document, count: number) => {
    let native: NativeDocument | undefined;
    const started = timed ? performance.now() : 0;
    native = await addon.deriveDocumentStructure({ kind: "instrument", id: document.id,
      text: document.text, reconstruct_lineation: RECONSTRUCT_LINEATION });
    if (timed) derive.push(performance.now() - started);
    sampler?.sample();
    if (target) { global.gc?.(); live = memory(); }
    native = undefined;
    if (measuredMemory && (target || count % GC_CADENCE === 0)) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc?.();
      sampler?.sample();
      if (target) released = memory();
    }
    if (count % 100 === 0) {
      process.stderr.write(`[${mode}] ${count}/${Number.isFinite(LIMIT) ? LIMIT : locked.documents}\n`);
      await writePartial(mode, { complete: false, checked: count,
        ...(timed ? { deriveTotalMs: round(total(derive)) } : {}),
        fixtureLoadExcluded: true, ...(sampler ? { peakMemory: sampler.peak } : {}) });
    }
  };

  const streamed = target ? (await deriveOne(target.document, 1), {
    locators: [{ kind: targetKind!, index: targetIndex, id: target.document.id,
      bytes: Buffer.byteLength(target.document.text) }], surface: null,
    fixtureLoad: { targetReadDecompressionMs: target.loadMs },
  }) : await streamCorpus(addon, LIMIT, deriveOne);
  sampler?.stop();
  if (measuredMemory && !target) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc?.();
    released = memory();
  }
  const full = streamed.locators.length === locked.documents;
  const valid = !full || JSON.stringify(streamed.surface) === JSON.stringify({
    ...locked.denominators, inputBytes: locked.inputBytes, inputSha256: locked.inputSha256,
  });
  if (!valid) throw new Error(`locked corpus receipt drift: ${JSON.stringify(streamed.surface)}`);
  const common = { schemaVersion: "beaver.instrument-structure-benchmark-worker.v2", mode,
    complete: true, selectedDocuments: streamed.locators.length,
    selectedBytes: streamed.locators.reduce((sum, item) => sum + item.bytes, 0), locked,
    corpusValidation: full ? { matches: true, actual: streamed.surface }
      : { skipped: true, reason: target ? "single-document memory probe" : "--limit smoke" },
    fixtureLoad: streamed.fixtureLoad,
    addon: { path: nativeFile, sha256: createHash("sha256")
      .update(await fs.readFile(nativeFile)).digest("hex") } };
  if (timed) {
    const deriveMs = total(derive);
    const measuredBytes = streamed.locators.reduce((sum, item) => sum + item.bytes, 0);
    const result = { ...common,
      engine: { totalMs: round(deriveMs), medianMs: percentile(derive, .5),
        p95Ms: percentile(derive, .95),
        docsPerSecond: deriveMs ? round(derive.length * 1_000 / deriveMs) : null,
        mibPerSecond: deriveMs ? round(measuredBytes / 1_048_576 * 1_000 / deriveMs) : null } };
    await writePartial(mode, result);
    return result;
  }
  const ordered = [...streamed.locators].sort((left, right) => left.bytes - right.bytes);
  const result = { ...common, gcCadenceDocuments: GC_CADENCE,
    selected: target || !ordered.length ? null : {
      median: ordered[Math.floor((ordered.length - 1) / 2)], largest: ordered.at(-1),
    }, memory: { baseline: memoryBaseline, peak: sampler!.peak, released,
      peakDeltaFromBaseline: memoryDelta(sampler!.peak, memoryBaseline!),
      releasedDeltaFromBaseline: memoryDelta(released!, memoryBaseline!),
      ...(live ? { live, liveDeltaFromBaseline: memoryDelta(live, memoryBaseline!),
      } : {}) } };
  await writePartial(mode, result);
  return result;
}

function runChild(mode: string, extra: string[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["--expose-gc", TSX, import.meta.filename, `--worker=${mode}`,
      ...(Number.isFinite(LIMIT) ? [`--limit=${LIMIT}`] : []), ...extra];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env,
      stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout))
      : reject(new Error(`${mode} worker exited ${code}`)));
  });
}

async function parityGate() {
  const started = performance.now();
  const args = [TSX, path.join(import.meta.dirname, "structure_gate.ts"),
    ...(Number.isFinite(LIMIT) ? [`--limit=${LIMIT}`] : [])];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (value) => resolve(value ?? 1));
  });
  return { gate: "structure_gate.ts", report: path.join(ROOT, ".tmp/instrument-structure-gate.json"),
    verificationWallMs: round(performance.now() - started), exitCode: code,
    excludedFromEngineMetrics: true };
}

async function main() {
  if (WORKER) { process.stdout.write(JSON.stringify(await workerMain(WORKER))); return; }
  await fs.mkdir(DIR, { recursive: true });
  const derive = await runChild("derive");
  let memoryReceipt;
  if (MEASURE_MEMORY) {
    const corpus = await runChild("memory");
    const probe = (mode: string, target: Locator) => runChild(mode,
      [`--target-kind=${target.kind}`, `--target-index=${target.index}`]);
    const median = corpus.selected && await probe("probe-median", corpus.selected.median);
    const sameTarget = corpus.selected?.median.kind === corpus.selected?.largest.kind &&
      corpus.selected?.median.index === corpus.selected?.largest.index;
    memoryReceipt = { corpus, median,
      largest: sameTarget ? median : corpus.selected && await probe("probe-largest", corpus.selected.largest) };
  }
  const receipt = { schemaVersion: "beaver.instrument-structure-benchmark.v2", complete: true,
    createdAt: new Date().toISOString(), rootGitCommit: gitCommit(ROOT),
    rustGitCommit: gitCommit(path.join(ROOT, "legal-pdf-parser")), derive,
    ...(memoryReceipt ? { memory: memoryReceipt } : {}),
    ...(PARITY ? { parity: await parityGate() } : {}),
    interpretation: "Fixture I/O, forced GC, memory sampling, and parity wall time are excluded from production N-API latency." };
  await fs.writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.parity?.exitCode) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
