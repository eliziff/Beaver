import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { instrumentCorpusFiles, readAgreement, readPdf, ROOT } from "./corpus";

const DIR = path.join(ROOT, ".tmp/instrument-structure-benchmark");
const RECEIPT = path.join(DIR, "receipt.json");
const BASELINE = path.join(import.meta.dirname, "structure-baseline.json");
const TSX = path.join(ROOT, "backend/node_modules/tsx/dist/cli.mjs");
const LIMIT = Number(process.argv.find((value) => value.startsWith("--limit="))?.slice(8) ?? Infinity);
const PROJECT = process.argv.includes("--project-source-doc");
const PARITY = process.argv.includes("--parity");
const WORKER = process.argv.find((value) => value.startsWith("--worker="))?.slice(9);
const GC_CADENCE = 25;

type Document = { id: string; text: string; pages?: number; lines?: number };
type NativeDocument = object;
type Addon = {
  deriveDocumentStructure(request: unknown): Promise<NativeDocument>;
  sourceDocTextBytes(document: NativeDocument): number;
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
    ROOT, "legal-pdf-parser/target/release",
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

function peakSampler() {
  const peak = memory();
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

async function streamCorpus(limit: number, visit: (document: Document, count: number) => Promise<void>) {
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
  const sampler = peakSampler();
  const consume = async (kind: Locator["kind"], index: number, document: Document, loadMs: number) => {
    const bytes = Buffer.byteLength(document.text);
    if (kind === "agreement") { agreementsRead += 1; agreementLoadMs += loadMs; }
    else { pdfsRead += 1; pdfLoadDecompressionMs += loadMs; pages += document.pages!; lines += document.lines!; }
    for (const value of [document.id, document.text]) {
      hash.update(`${Buffer.byteLength(value)}:`).update(value).update("\n");
    }
    inputBytes += bytes;
    locators.push({ kind, index, id: document.id, bytes });
    sampler.sample();
    await visit(document, locators.length);
    sampler.sample();
  };
  for (let index = 0; index < agreements.length && locators.length < limit; index += 1) {
    const started = performance.now();
    const document = await readAgreement(agreements[index]);
    await consume("agreement", index, document, performance.now() - started);
  }
  for (let index = 0; index < pdfs.length && locators.length < limit; index += 1) {
    const started = performance.now();
    const document = await readPdf(pdfs[index]);
    await consume("pdf", index, document, performance.now() - started);
  }
  sampler.stop();
  return { locators, surface: { agreements: agreementsRead, pdfs: pdfsRead, pages, lines,
    inputBytes, inputSha256: hash.digest("hex") }, fixtureLoad: {
    agreementMs: round(agreementLoadMs), pdfReadDecompressionMs: round(pdfLoadDecompressionMs),
    totalMs: round(agreementLoadMs + pdfLoadDecompressionMs) }, peakMemory: sampler.peak };
}

async function readTarget(kind: Locator["kind"], index: number) {
  const files = await instrumentCorpusFiles();
  const file = kind === "agreement" ? files.agreements[index] : files.pdfs[index];
  if (!file) throw new Error(`benchmark target missing: ${kind}:${index}`);
  const started = performance.now();
  const document = kind === "agreement" ? await readAgreement(file) : await readPdf(file);
  return { document, loadMs: round(performance.now() - started) };
}

async function workerMain(mode: string) {
  const baseline = JSON.parse(await fs.readFile(BASELINE, "utf8"));
  const locked = { documents: baseline.denominators.agreements + baseline.denominators.pdfs,
    denominators: baseline.denominators, inputBytes: baseline.inputBytes,
    inputSha256: baseline.inputSha256 };
  await writePartial(mode, { schemaVersion: "beaver.instrument-structure-benchmark-worker.v1",
    mode, complete: false, checked: 0, locked });
  const targetKind = process.argv.find((value) => value.startsWith("--target-kind="))?.slice(14) as Locator["kind"] | undefined;
  const targetIndex = Number(process.argv.find((value) => value.startsWith("--target-index="))?.slice(15));
  const target = targetKind ? await readTarget(targetKind, targetIndex) : null;
  const nativeFile = mode === "corpus" ? null : addonPath();
  const addon = nativeFile ? loadAddon(nativeFile) : null;
  const derive: number[] = [];
  const projection: number[] = [];
  const sampler = peakSampler();
  let live: Memory | undefined;
  let released: Memory | undefined;
  const deriveOne = async (document: Document, count: number) => {
    let native: NativeDocument | undefined;
    const started = performance.now();
    native = await addon!.deriveDocumentStructure({ kind: "instrument", id: document.id,
      text: document.text, reconstruct_lineation: true });
    derive.push(performance.now() - started);
    if (PROJECT || target) {
      const projected = performance.now();
      addon!.sourceDocTextBytes(native);
      projection.push(performance.now() - projected);
    }
    sampler.sample();
    if (target) { global.gc?.(); live = memory(); }
    native = undefined;
    if (target || count % GC_CADENCE === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      global.gc?.();
      sampler.sample();
      if (target) released = memory();
    }
    if (count % 10 === 0) {
      process.stderr.write(`[${mode}] ${count}/${Number.isFinite(LIMIT) ? LIMIT : locked.documents}\n`);
      await writePartial(mode, { complete: false, checked: count,
        deriveTotalMs: round(total(derive)), projectionTotalMs: round(total(projection)),
        fixtureLoadExcluded: true, peakMemory: sampler.peak });
    }
  };

  let streamed;
  if (target) {
    await deriveOne(target.document, 1);
    streamed = { locators: [{ kind: targetKind!, index: targetIndex, id: target.document.id,
      bytes: Buffer.byteLength(target.document.text) }], surface: null,
      fixtureLoad: { targetReadDecompressionMs: target.loadMs }, peakMemory: memory() };
  } else {
    streamed = await streamCorpus(LIMIT, mode === "corpus" ? async (_document, count) => {
      if (count % 10 === 0) {
        process.stderr.write(`[corpus] ${count}/${Number.isFinite(LIMIT) ? LIMIT : locked.documents}\n`);
        await writePartial(mode, { complete: false, checked: count, locked });
      }
    } : deriveOne);
  }
  sampler.stop();
  const full = streamed.locators.length === locked.documents;
  const valid = !full || JSON.stringify(streamed.surface) === JSON.stringify({
    ...locked.denominators, inputBytes: locked.inputBytes, inputSha256: locked.inputSha256,
  });
  if (!valid) throw new Error(`locked corpus receipt drift: ${JSON.stringify(streamed.surface)}`);
  const common = { schemaVersion: "beaver.instrument-structure-benchmark-worker.v1", mode,
    complete: true, selectedDocuments: streamed.locators.length,
    selectedBytes: streamed.locators.reduce((sum, item) => sum + item.bytes, 0), locked,
    corpusValidation: full ? { matches: true, actual: streamed.surface }
      : { skipped: true, reason: target ? "single-document memory probe" : "--limit smoke" },
    fixtureLoad: streamed.fixtureLoad,
    peakMemory: mode === "corpus" ? streamed.peakMemory : sampler.peak };
  if (mode === "corpus") {
    const ordered = [...streamed.locators].sort((left, right) => left.bytes - right.bytes);
    const result = { ...common, selected: ordered.length ? {
      median: ordered[Math.floor((ordered.length - 1) / 2)], largest: ordered.at(-1),
    } : null };
    await writePartial(mode, result);
    return result;
  }
  const warm = derive.slice(1);
  const deriveMs = total(derive);
  const warmMs = total(warm);
  const measuredBytes = streamed.locators.reduce((sum, item) => sum + item.bytes, 0);
  const warmBytes = streamed.locators.slice(1).reduce((sum, item) => sum + item.bytes, 0);
  const result = { ...common, addon: { path: nativeFile, sha256: createHash("sha256")
    .update(await fs.readFile(nativeFile!)).digest("hex") }, gcCadenceDocuments: GC_CADENCE,
    engine: { coldFirstCallMs: derive.length ? round(derive[0]) : null,
      warm: { totalMs: round(warmMs), medianMs: percentile(warm, .5), p95Ms: percentile(warm, .95),
        docsPerSecond: warmMs ? round(warm.length * 1_000 / warmMs) : null,
        mibPerSecond: warmMs ? round(warmBytes / 1_048_576 * 1_000 / warmMs) : null },
      deriveTotalMs: round(deriveMs), docsPerSecond: deriveMs ? round(derive.length * 1_000 / deriveMs) : null,
      mibPerSecond: deriveMs ? round(measuredBytes / 1_048_576 * 1_000 / deriveMs) : null,
      nativeSourceDocProjectionTrigger: PROJECT || target ? { totalMs: round(total(projection)),
        medianMs: percentile(projection, .5), p95Ms: percentile(projection, .95),
        operation: "sourceDocTextBytes (no JSON serialization)" } : null },
    memory: { peak: sampler.peak, ...(target ? { live, released,
      releasedDeltaFromLive: memoryDelta(released!, live!) } : {}) } };
  await writePartial(mode, result);
  return result;
}

function runChild(mode: string, extra: string[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["--expose-gc", TSX, import.meta.filename, `--worker=${mode}`,
      ...(Number.isFinite(LIMIT) ? [`--limit=${LIMIT}`] : []), ...(PROJECT ? ["--project-source-doc"] : []), ...extra];
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
  const corpus = await runChild("corpus");
  const derive = await runChild("derive");
  const probe = (mode: string, target: Locator) => runChild(mode,
    [`--target-kind=${target.kind}`, `--target-index=${target.index}`]);
  const median = corpus.selected && await probe("probe-median", corpus.selected.median);
  const largest = corpus.selected && await probe("probe-largest", corpus.selected.largest);
  const receipt = { schemaVersion: "beaver.instrument-structure-benchmark.v1", complete: true,
    createdAt: new Date().toISOString(), rootGitCommit: gitCommit(ROOT),
    rustGitCommit: gitCommit(path.join(ROOT, "legal-pdf-parser")), corpus, derive,
    memoryProbes: { median, largest },
    enginePeakIncrementOverCorpusOnly: memoryDelta(derive.memory.peak, corpus.peakMemory),
    ...(PARITY ? { parity: await parityGate() } : {}),
    interpretation: "Fixture I/O, projection-trigger, GC, and parity wall time are excluded from native derivation speed." };
  await fs.writeFile(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.parity?.exitCode) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
