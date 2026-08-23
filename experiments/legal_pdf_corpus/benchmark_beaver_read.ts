import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentStore } from "../../backend/src/lib/documentStore";

process.env.AUTH_MODE = "local";
const suppliedDataDirectory = process.env.MIKE_LOCAL_DATA_DIR?.trim();
process.env.MIKE_LOCAL_DATA_DIR = suppliedDataDirectory || path.resolve(
  `.tmp/legal-pdf-beaver-benchmark/${Date.now()}-${process.pid}`);
process.env.LEGALPDF_PROFILE_PHASES ||= "1";
if (process.argv.includes("--alloc")) process.env.LEGALPDF_PROFILE_ALLOC = "1";
process.env.LEGAL_STRUCTURE_NATIVE = process.env.LEGAL_STRUCTURE_NATIVE?.trim() || path.resolve(
  "legal-pdf-parser/target/iterate",
  process.platform === "win32" ? "legal_structure_node.dll"
    : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so",
);

const corpus = "legal-pdf-parser/experiments/kraken-lite/kraken-lite-native/court-scan-corpus";
const DEFAULT_PDFS = [
  path.resolve(corpus, "NSCA-2003-NSCA-6/source.pdf"),
  path.resolve("benchmarks/legal-generalization-corpus/raw/ca-case-2021-scc-wastech-services.pdf"),
  path.resolve(corpus, "LEG-FED-E-18/source.pdf"),
];
const CHILD_RESULT = "BEAVER_PDF_BENCHMARK=";

const round = (value: number) => Number(value.toFixed(3));
async function timed<T>(operation: () => Promise<T>) {
  const started = performance.now(), baseline = process.memoryUsage.rss();
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage.rss()); }, 5);
  const value = await operation().finally(() => clearInterval(sampler));
  peak = Math.max(peak, process.memoryUsage.rss());
  return { value, elapsedMs: round(performance.now() - started),
    peakRssDeltaMiB: round((peak - baseline) / 1_048_576) };
}

async function loadProduct() {
  const [{ runtime }, { extractDocument }] = await Promise.all([
    import("../../backend/src/runtime"),
    import("../../backend/src/lib/chat/assistantTools"),
  ]);
  return { runtime, extractDocument };
}

const signature = (text: string) => createHash("sha256").update(text).digest("hex");

async function openExisting(documentId: string, versionId: string) {
  let product: Awaited<ReturnType<typeof loadProduct>> | undefined;
  try {
    const opened = await timed(async () => {
      const loaded = product = await loadProduct();
      await loaded.runtime.initialize();
      return loaded.extractDocument(
        await loaded.runtime.documents(), { userId: "production-benchmark" },
        documentId, versionId);
    });
    if (!opened.value) throw new Error("benchmark document disappeared");
    return { restartedProcessOpenMs: opened.elapsedMs,
      peakRssDeltaMiB: opened.peakRssDeltaMiB,
      textBytes: Buffer.byteLength(opened.value.text), pages: opened.value.pages.pages.length,
      textSha256: signature(opened.value.text),
      pageMapSha256: signature(JSON.stringify(opened.value.pages)) };
  } finally { await product?.runtime.shutdown(); }
}

async function waitUntilPrepared(
  documents: DocumentStore,
  documentId: string,
) {
  const started = performance.now();
  let lastReport = started;
  for (;;) {
    const state = (await documents.metadata(
      { userId: "production-benchmark" }, documentId))?.parse_state;
    if (state?.status === "ready" || state?.status === "degraded") return state;
    if (state?.status === "failed" || state?.status === "cancelled")
      throw new Error(`PDF preparation ${state.status}: ${state.error ?? "unknown error"}`);
    if (performance.now() - started > 300_000) throw new Error("PDF preparation timed out");
    if (performance.now() - lastReport >= 5_000) {
      process.stderr.write(`[beaver-pdf] ${documentId} ${state?.status ?? "queued"}\n`);
      lastReport = performance.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function restartedOpen(documentId: string, versionId: string) {
  const started = performance.now();
  const args = [path.resolve("backend/node_modules/tsx/dist/cli.mjs"),
    path.resolve(process.argv[1]), `--open=${documentId}`, `--version=${versionId}`];
  return new Promise<Awaited<ReturnType<typeof openExisting>> & {
    childLifecycleMs: number;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: process.env, stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      const result = output.lastIndexOf(CHILD_RESULT);
      if (code === 0 && result >= 0)
        resolve({ ...JSON.parse(output.slice(result + CHILD_RESULT.length)),
          childLifecycleMs: round(performance.now() - started) });
      else reject(new Error(`restarted Beaver open exited ${code}`));
    });
  });
}

async function main() {
  const openId = process.argv.find((value) => value.startsWith("--open="))?.slice(7);
  const versionId = process.argv.find((value) => value.startsWith("--version="))?.slice(10);
  if (openId) {
    if (!versionId) throw new Error("--version is required with --open");
    process.stdout.write(`${CHILD_RESULT}${JSON.stringify(await openExisting(openId, versionId))}`);
    return;
  }
  const requested = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const pdfs = requested.length ? requested : DEFAULT_PDFS;

  const product = await loadProduct();
  await product.runtime.initialize();
  const documents = await product.runtime.documents(), samples = [];
  try {
    for (const pdf of pdfs) {
      const bytes = await readFile(path.resolve(pdf));
      const readyStarted = performance.now();
      const uploaded = await timed(() => documents.create(
        { userId: "production-benchmark" },
        { filename: path.basename(pdf), fileType: "pdf", bytes, libraryKind: "file" }));
      const document = uploaded.value;
      const prepared = await timed(() => waitUntilPrepared(documents, document.id));
      const timeToReadyMs = round(performance.now() - readyStarted);
      const warm = await timed(() => product.extractDocument(
        documents, { userId: "production-benchmark" }, document.id,
        document.current_version_id));
      if (!warm.value) throw new Error("uploaded benchmark document disappeared");
      samples.push({ pdf: path.resolve(pdf), inputBytes: bytes.length,
        applicationUploadMs: uploaded.elapsedMs, preparationWaitMs: prepared.elapsedMs,
        timeToReadyMs,
        warmOpenMs: warm.elapsedMs, uploadPeakRssDeltaMiB: uploaded.peakRssDeltaMiB,
        preparationPeakRssDeltaMiB: prepared.peakRssDeltaMiB,
        warmOpenPeakRssDeltaMiB: warm.peakRssDeltaMiB, documentId: document.id,
        versionId: document.current_version_id,
        warmOutput: { textBytes: Buffer.byteLength(warm.value.text),
          pages: warm.value.pages.pages.length, textSha256: signature(warm.value.text),
          pageMapSha256: signature(JSON.stringify(warm.value.pages)) } });
    }
  } finally { await product.runtime.shutdown(); }
  let cacheOutputsMatch = true;
  for (const sample of samples) {
    const restarted = await restartedOpen(sample.documentId, sample.versionId);
    const cacheOutputMatches = restarted.textSha256 === sample.warmOutput.textSha256
      && restarted.pageMapSha256 === sample.warmOutput.pageMapSha256;
    cacheOutputsMatch &&= cacheOutputMatches;
    Object.assign(sample, { restartedOpen: restarted,
      cacheOutputMatches });
  }
  process.stdout.write(`${JSON.stringify({ dataMode: suppliedDataDirectory ? "supplied" : "isolated",
    dataDirectory: process.env.MIKE_LOCAL_DATA_DIR,
    addon: path.resolve(process.env.LEGAL_STRUCTURE_NATIVE!), cacheOutputsMatch, samples }, null, 2)}\n`);
  if (!cacheOutputsMatch) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
