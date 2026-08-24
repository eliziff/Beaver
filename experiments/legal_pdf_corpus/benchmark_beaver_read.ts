import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DocumentStore } from "../../backend/src/lib/documentStore";

process.env.AUTH_MODE = "local";
const suppliedDataDirectory = process.env.MIKE_LOCAL_DATA_DIR?.trim();
process.env.MIKE_LOCAL_DATA_DIR = suppliedDataDirectory || path.resolve(
  `.tmp/legal-pdf-beaver-benchmark/${Date.now()}-${process.pid}`);
if (process.argv.includes("--no-phases")) delete process.env.LEGALPDF_PROFILE_PHASES;
else process.env.LEGALPDF_PROFILE_PHASES ||= "1";
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
const CHILD_READY = "BEAVER_PDF_READY";
const LOCAL_USER_ID = process.env.LOCAL_USER_ID?.trim() ||
  "00000000-0000-0000-0000-000000000001";
const COMPILED_BACKEND = process.env.BEAVER_BENCHMARK_COMPILED === "1";
type LifecycleEvent = { phase: string; documentId: string;
  startedAt: number; endedAt: number; elapsedMs: number };
const lifecycleEvents: LifecycleEvent[] = [];
channel("beaver.pdf.lifecycle").subscribe((value) => {
  const event = value as Partial<LifecycleEvent>;
  if (typeof event.phase === "string" && typeof event.documentId === "string" &&
      typeof event.startedAt === "number" && typeof event.endedAt === "number" &&
      typeof event.elapsedMs === "number")
    lifecycleEvents.push({ ...event as LifecycleEvent,
      startedAt: round(event.startedAt), endedAt: round(event.endedAt),
      elapsedMs: round(event.elapsedMs) });
});
const lifecycleFor = (documentId: string, after = 0) =>
  lifecycleEvents.slice(after).filter((event) => event.documentId === documentId);
const phaseTotal = (events: LifecycleEvent[], phase: string) => {
  const values = events.filter((event) => event.phase === phase);
  return values.length ? round(values.reduce((total, event) => total + event.elapsedMs, 0)) : null;
};

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
  if (COMPILED_BACKEND) {
    const { runtime } = require("../../backend/dist/runtime") as
      typeof import("../../backend/src/runtime");
    const { extractDocument } = require("../../backend/dist/lib/chat/assistantTools") as
      typeof import("../../backend/src/lib/chat/assistantTools");
    return { runtime, extractDocument };
  }
  const [{ runtime }, { extractDocument }] = await Promise.all([
    import("../../backend/src/runtime"),
    import("../../backend/src/lib/chat/assistantTools"),
  ]);
  return { runtime, extractDocument };
}

const signature = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

function outputSignature(value: { text: string; pages: { pages: unknown[] } }) {
  return { textBytes: Buffer.byteLength(value.text), pages: value.pages.pages.length,
    textSha256: signature(value.text), pageMapSha256: signature(JSON.stringify(value.pages)) };
}

async function openExisting(
  product: Awaited<ReturnType<typeof loadProduct>>,
  documents: DocumentStore,
  documentId: string,
  versionId: string,
) {
  process.stderr.write(`[beaver-pdf] restarted-open ${documentId}\n`);
  const lifecycleStart = lifecycleEvents.length;
  const opened = await timed(() => product.extractDocument(
    documents, { userId: LOCAL_USER_ID }, documentId, versionId));
  if (!opened.value) throw new Error("benchmark document disappeared");
  return { restartedAssistantStructuredReadMs: opened.elapsedMs,
    peakRssDeltaMiB: opened.peakRssDeltaMiB,
    lifecycle: lifecycleFor(documentId, lifecycleStart), ...outputSignature(opened.value) };
}

async function openBatch(references: { documentId: string; versionId: string }[]) {
  let product: Awaited<ReturnType<typeof loadProduct>> | undefined;
  try {
    const startup = await timed(async () => {
      const loaded = await timed(loadProduct);
      product = loaded.value;
      const initialized = await timed(() => product!.runtime.initialize());
      const documents = await timed(() => product!.runtime.documents());
      return { documents: documents.value, moduleLoadMs: loaded.elapsedMs,
        initializeMs: initialized.elapsedMs, documentStoreMs: documents.elapsedMs };
    });
    process.stdout.write(`${CHILD_READY}\n`);
    const opens = [];
    for (const reference of references)
      opens.push(await openExisting(product!, startup.value.documents,
        reference.documentId, reference.versionId));
    return { applicationStartupMs: startup.elapsedMs,
      startupPeakRssDeltaMiB: startup.peakRssDeltaMiB,
      moduleLoadMs: startup.value.moduleLoadMs,
      initializeMs: startup.value.initializeMs,
      documentStoreMs: startup.value.documentStoreMs, opens };
  } finally { await product?.runtime.shutdown(); }
}

type ParseState = { status?: string; error?: string } | null;
async function waitUntilPrepared(baseUrl: string, documentIds: string[]) {
  const started = performance.now();
  const pending = new Set(documentIds), previous = new Map<string, string>();
  const ready = new Map<string, { state: ParseState; elapsedMs: number; readyAt: number }>();
  while (pending.size) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const response = await fetch(`${baseUrl}/api/single-documents/parse-states`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_ids: [...pending] }),
    });
    if (!response.ok) throw new Error(`readiness poll: ${response.status} ${await response.text()}`);
    const now = performance.now();
    for (const { id, parse_state: state } of await response.json() as Array<{
      id: string; parse_state: ParseState;
    }>) {
      const status = state?.status ?? "queued";
      if (status === "ready" || status === "degraded" || status === "failed" ||
          status === "cancelled") {
        pending.delete(id); ready.set(id, { state, elapsedMs: round(now - started), readyAt: now });
      } else if (status !== previous.get(id)) {
        process.stderr.write(`[beaver-pdf] ${id} ${status}\n`); previous.set(id, status);
      }
    }
    if (now - started > 300_000) throw new Error("PDF preparation timed out");
  }
  return ready;
}

async function uploadPdf(baseUrl: string, filename: string, bytes: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), filename);
  const response = await fetch(`${baseUrl}/api/library/files/documents`, {
    method: "POST", body: form,
  });
  if (!response.ok) throw new Error(`upload: ${response.status} ${await response.text()}`);
  return response.json() as Promise<{ id: string; current_version_id: string }>;
}

async function openPdfOverHttp(baseUrl: string, documentId: string, versionId: string) {
  const response = await fetch(`${baseUrl}/api/single-documents/${encodeURIComponent(documentId)}` +
    `/file?rendition=pdf&version_id=${encodeURIComponent(versionId)}`);
  if (!response.ok) throw new Error(`PDF open: ${response.status} ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

async function restartedOpen(references: { documentId: string; versionId: string }[]) {
  const started = performance.now();
  const args = [path.resolve("backend/node_modules/tsx/dist/cli.mjs"),
    path.resolve(process.argv[1]), "--open-batch"];
  return new Promise<Awaited<ReturnType<typeof openBatch>> & {
    spawnToApplicationReadyMs: number;
    childLifecycleMs: number;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: process.env, stdio: ["pipe", "pipe", "inherit"],
    });
    let output = "";
    let spawnToApplicationReadyMs: number | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (spawnToApplicationReadyMs === undefined && output.includes(CHILD_READY))
        spawnToApplicationReadyMs = round(performance.now() - started);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const result = output.lastIndexOf(CHILD_RESULT);
      if (code === 0 && result >= 0) {
        const childLifecycleMs = round(performance.now() - started);
        resolve({ ...JSON.parse(output.slice(result + CHILD_RESULT.length)),
          spawnToApplicationReadyMs: spawnToApplicationReadyMs ?? childLifecycleMs,
          childLifecycleMs });
      } else reject(new Error(`restarted Beaver open exited ${code}`));
    });
    child.stdin.end(JSON.stringify(references));
  });
}

async function main() {
  if (process.argv.includes("--open-batch")) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(`${CHILD_RESULT}${JSON.stringify(await openBatch(JSON.parse(input)))}`);
    return;
  }
  let piped: string[] = [];
  if (process.argv.includes("--paths-stdin")) {
    let input = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) input += chunk;
    piped = input.split(/\r?\n/u).filter(Boolean);
  }
  const requested = [...piped,
    ...process.argv.slice(2).filter((value) => !value.startsWith("--"))];
  const pdfs = requested.length ? requested : DEFAULT_PDFS;

  const product = await loadProduct();
  await product.runtime.initialize();
  const server = COMPILED_BACKEND
    ? (require("../../backend/dist/server") as typeof import("../../backend/src/server")).server
    : (await import("../../backend/src/server")).server;
  const documents = await product.runtime.documents();
  const listener = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Beaver HTTP listener unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const samples = [], scope = { userId: LOCAL_USER_ID };
  let bulkUploadAndReadyMs = 0;
  try {
    const inputs = pdfs.map((pdf) => ({ pdf: path.resolve(pdf) }));
    const bulkStartedAt = performance.now();
    const lifecycleStart = lifecycleEvents.length;
    const uploadOne = async (input: (typeof inputs)[number]) => {
      const clientRead = await timed(() => readFile(input.pdf));
      const bytes = clientRead.value;
      process.stderr.write(`[beaver-pdf] upload ${input.pdf}\n`);
      const uploaded = await timed(() => uploadPdf(
        baseUrl, path.basename(input.pdf), bytes));
      return { ...input, bytes, clientRead, uploaded, document: uploaded.value };
    };
    const uploads = new Array<Awaited<ReturnType<typeof uploadOne>>>(inputs.length);
    let nextUpload = 0;
    await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (nextUpload < inputs.length) {
        const index = nextUpload++;
        uploads[index] = await uploadOne(inputs[index]);
      }
    }));
    const preparationWaitStartedAt = performance.now();
    const prepared = await timed(() => waitUntilPrepared(
      baseUrl, uploads.map(({ document }) => document.id)));
    const preparedDocuments = uploads.map((entry) => ({ ...entry,
      preparationWaitStartedAt, prepared: prepared.value.get(entry.document.id)!,
      preparationPeakRssDeltaMiB: prepared.peakRssDeltaMiB }));
    bulkUploadAndReadyMs = round(performance.now() - bulkStartedAt);
    for (const entry of preparedDocuments) {
      const { pdf, bytes, clientRead, uploaded, document, prepared,
        preparationWaitStartedAt, preparationPeakRssDeltaMiB } = entry;
      const preparationReadyAt = prepared.readyAt;
      const lifecycle = lifecycleFor(document.id, lifecycleStart);
      const enqueued = lifecycle.find((event) => event.phase === "queue.enqueued");
      const claimed = lifecycle.find((event) => event.phase === "queue.claimed");
      const native = lifecycle.find((event) => event.phase === "prepare.native");
      const nativeDuringWaitMs = native ? Math.max(0,
        Math.min(preparationReadyAt, native.endedAt) -
          Math.max(preparationWaitStartedAt, native.startedAt)) : 0;
      const preparation = {
        preparationReadinessMs: prepared.elapsedMs,
        observedReadyMs: round(preparationReadyAt - bulkStartedAt),
        nativePreparationMs: phaseTotal(lifecycle, "prepare.native"),
        enqueueToHandlerStartMs: enqueued && claimed && claimed.startedAt >= enqueued.endedAt
          ? round(claimed.startedAt - enqueued.endedAt) : null,
        readinessOutsideNativeMs: round(Math.max(0, prepared.elapsedMs - nativeDuringWaitMs)),
        preparationPeakRssDeltaMiB,
      };
      if (prepared.state?.status === "failed" || prepared.state?.status === "cancelled") {
        samples.push({ pdf, inputBytes: bytes.length, clientFileReadMs: clientRead.elapsedMs,
          httpUploadRoundtripMs: uploaded.elapsedMs,
          uploadPeakRssDeltaMiB: uploaded.peakRssDeltaMiB,
          status: prepared.state.status, error: prepared.state.error ?? null,
          lifecycle, documentId: document.id, versionId: document.current_version_id,
          ...preparation });
        process.stderr.write(`[beaver-pdf] ${prepared.state.status} ${pdf}\n`);
        continue;
      }
      const httpOpen = await timed(() => openPdfOverHttp(
        baseUrl, document.id, document.current_version_id));
      const structured = await timed(() => product.extractDocument(
        documents, scope, document.id,
        document.current_version_id));
      if (!structured.value) throw new Error("uploaded benchmark document disappeared");
      const warmOutput = outputSignature(structured.value);
      samples.push({ pdf, inputBytes: bytes.length,
        clientFileReadMs: clientRead.elapsedMs, httpUploadRoundtripMs: uploaded.elapsedMs,
        httpPdfOpenMs: httpOpen.elapsedMs,
        httpPdfBytes: httpOpen.value.length,
        httpPdfMatchesUpload: signature(httpOpen.value) === signature(bytes),
        assistantStructuredReadMs: structured.elapsedMs,
        uploadPeakRssDeltaMiB: uploaded.peakRssDeltaMiB,
        assistantStructuredReadPeakRssDeltaMiB: structured.peakRssDeltaMiB,
        lifecycle, documentId: document.id,
        versionId: document.current_version_id,
        warmOutput, status: prepared.state?.status ?? "ready", ...preparation });
      process.stderr.write(`[beaver-pdf] prepared ${pdf}\n`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => listener.close((error) =>
      error ? reject(error) : resolve()));
    await product.runtime.shutdown();
  }
  let cacheOutputsMatch = true;
  const successful = samples.filter((sample) => sample.warmOutput);
  const restarted = await restartedOpen(successful.map(({ documentId, versionId }) =>
    ({ documentId, versionId })));
  for (const [index, sample] of successful.entries()) {
    const reopened = restarted.opens[index];
    const cacheOutputMatches = reopened.textSha256 === sample.warmOutput.textSha256
      && reopened.pageMapSha256 === sample.warmOutput.pageMapSha256;
    cacheOutputsMatch &&= cacheOutputMatches;
    Object.assign(sample, { restartedOpen: reopened, cacheOutputMatches });
  }
  process.stdout.write(`${JSON.stringify({ dataMode: suppliedDataDirectory ? "supplied" : "isolated",
    dataDirectory: process.env.MIKE_LOCAL_DATA_DIR,
    addon: path.resolve(process.env.LEGAL_STRUCTURE_NATIVE!), cacheOutputsMatch,
    backendRuntime: COMPILED_BACKEND ? "compiled" : "tsx",
    bulkUploadAndReadyMs,
    structuredReadTransport: "internal assistant operation; no production HTTP endpoint",
    restartedInternalProcess: {
      spawnToApplicationReadyMs: restarted.spawnToApplicationReadyMs,
      applicationStartupMs: restarted.applicationStartupMs,
      moduleLoadMs: restarted.moduleLoadMs, initializeMs: restarted.initializeMs,
      documentStoreMs: restarted.documentStoreMs,
      startupPeakRssDeltaMiB: restarted.startupPeakRssDeltaMiB,
      childLifecycleMs: restarted.childLifecycleMs }, samples }, null, 2)}\n`);
  if (!cacheOutputsMatch) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
