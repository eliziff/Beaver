import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

process.env.AUTH_MODE = "local";
const suppliedDataDirectory = process.env.MIKE_LOCAL_DATA_DIR?.trim();
process.env.MIKE_LOCAL_DATA_DIR = suppliedDataDirectory || path.resolve(
  `.tmp/legal-pdf-beaver-benchmark/${Date.now()}-${process.pid}`);
const childOpen = process.argv.includes("--open-batch");
const stressRun = process.argv.includes("--stress");
const requestedAllocationProfile = process.argv.includes("--alloc");
const requestedPhaseProfile = process.argv.includes("--phases") || requestedAllocationProfile;
if (!childOpen) {
  if (requestedPhaseProfile) process.env.LEGALPDF_PROFILE_PHASES = "1";
  else delete process.env.LEGALPDF_PROFILE_PHASES;
  if (requestedAllocationProfile) process.env.LEGALPDF_PROFILE_ALLOC = "1";
  else delete process.env.LEGALPDF_PROFILE_ALLOC;
}
const addonProfile = (childOpen
  ? process.env.LEGALPDF_PROFILE_PHASES === "1"
  : requestedPhaseProfile) ? "profiling" : "release";
const addonPath = path.resolve("native/legal-structure-node/target", addonProfile,
  process.platform === "win32" ? "legal_structure_node.dll"
    : process.platform === "darwin" ? "liblegal_structure_node.dylib"
      : "liblegal_structure_node.so");
process.env.LEGAL_STRUCTURE_NATIVE = addonPath;

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
const phaseOverlap = (events: LifecycleEvent[], phase: string, start: number, end: number) => {
  const intervals = events.filter((event) => event.phase === phase &&
    event.endedAt > start && event.startedAt < end)
    .map((event) => [Math.max(start, event.startedAt), Math.min(end, event.endedAt)] as const)
    .sort((left, right) => left[0] - right[0]);
  let total = 0, cursor = start;
  for (const [from, to] of intervals) {
    if (to > cursor) total += to - Math.max(from, cursor);
    cursor = Math.max(cursor, to);
  }
  return round(total);
};

const round = (value: number) => Number(value.toFixed(3));
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
async function timed<T>(operation: () => Promise<T>) {
  const started = performance.now();
  return { value: await operation(), elapsedMs: round(performance.now() - started) };
}

function sameProcessMemory() {
  return {
    scope: "parent Node process only (client and Beaver server); child and OCR processes excluded",
    maxRssSinceProcessStartMiB: round(process.resourceUsage().maxRSS / 1024),
    endingRssMiB: round(process.memoryUsage.rss() / 1_048_576),
  };
}

async function loadProduct() {
  if (COMPILED_BACKEND) {
    const { runtime } = require("../../backend/dist/runtime") as
      typeof import("../../backend/src/runtime");
    const { structureNative: nativeApi } = require("../../backend/dist/lib/structureNative") as
      typeof import("../../backend/src/lib/structureNative");
    const { createChatToolRunner } = require("../../backend/dist/lib/chat/chatToolRunner") as
      typeof import("../../backend/src/lib/chat/chatToolRunner");
    const { TurnToolRegistry } = require("../../backend/dist/lib/chat/toolRegistry") as
      typeof import("../../backend/src/lib/chat/toolRegistry");
    const { createLegalEvidenceTurnState } =
      require("../../backend/dist/lib/chat/legalEvidence") as
        typeof import("../../backend/src/lib/chat/legalEvidence");
    const { documentProjectionService } =
      require("../../backend/dist/lib/documentProjectionService") as
        typeof import("../../backend/src/lib/documentProjectionService");
    return { runtime, nativeApi, createChatToolRunner, TurnToolRegistry,
      createLegalEvidenceTurnState, documentProjectionService };
  }
  const [
    { runtime },
    { structureNative: nativeApi },
    { createChatToolRunner },
    { TurnToolRegistry },
    { createLegalEvidenceTurnState },
    { documentProjectionService },
  ] = await Promise.all([
    import("../../backend/src/runtime"),
    import("../../backend/src/lib/structureNative"),
    import("../../backend/src/lib/chat/chatToolRunner"),
    import("../../backend/src/lib/chat/toolRegistry"),
    import("../../backend/src/lib/chat/legalEvidence"),
    import("../../backend/src/lib/documentProjectionService"),
  ]);
  return { runtime, nativeApi, createChatToolRunner, TurnToolRegistry,
    createLegalEvidenceTurnState, documentProjectionService };
}
type Product = Awaited<ReturnType<typeof loadProduct>>;
type ProductStores = {
  documents: Awaited<ReturnType<Product["runtime"]["documents"]>>;
  library: Awaited<ReturnType<Product["runtime"]["library"]>>;
  projects: Awaited<ReturnType<Product["runtime"]["projects"]>>;
};

const signature = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
async function fileSignature(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function addonIdentity(product: Product) {
  try {
    const [details, sha256] = await Promise.all([stat(addonPath), fileSignature(addonPath)]);
    if (!details.isFile()) throw new Error("path is not a file");
    const features = product.nativeApi().nativeBuildFeatures().split(",").filter(Boolean);
    if (!features.includes("legalpdf") ||
        (requestedPhaseProfile && !features.includes("diagnostics")) ||
        (requestedAllocationProfile && !features.includes("allocation-diagnostics")))
      throw new Error(`addon features do not match requested mode: ${features.join(",")}`);
    return { path: addonPath, profile: addonProfile, sizeBytes: details.size,
      mtime: details.mtime.toISOString(), sha256,
      features,
      requested: { phases: requestedPhaseProfile, allocations: requestedAllocationProfile } };
  } catch (error) {
    throw new Error(`Cannot use canonical ${addonProfile} legal-structure addon: ${addonPath}`, {
      cause: error,
    });
  }
}

async function productionRead(
  product: Product,
  stores: ProductStores,
  documentId: string,
  versionId: string,
) {
  const evidence = product.createLegalEvidenceTurnState();
  const runner = product.createChatToolRunner({
    userId: LOCAL_USER_ID,
    projectId: null,
    allowedDocumentIds: new Set([documentId]),
    documents: stores.documents,
    library: stores.library,
    projects: stores.projects,
    includeResearchTools: false,
    onMutationCommitted: () => undefined,
  });
  const registry = new product.TurnToolRegistry(runner.createTools(evidence, "main"));
  const output = await registry.run([{
    id: "benchmark-read",
    name: "Read",
    input: { file_path: `document://${documentId}/version/${versionId}` },
  }], { evidence, addEvent: () => undefined });
  const visible = output.results[0];
  if (!visible || output.outcomes[0]?.result.isError)
    throw new Error(`production Read failed: ${visible?.content ?? "no result"}`);
  return visible.content;
}

async function outputSignature(
  product: Product,
  stores: ProductStores,
  documentId: string,
  versionId: string,
  visibleContent: string,
) {
  const source = await stores.documents.projectionSource(
    { userId: LOCAL_USER_ID }, documentId, versionId);
  if (!source) throw new Error("document projection source missing");
  const document = await product.documentProjectionService.read(source);
  const native = product.nativeApi();
  const fingerprint = native.documentFingerprint(document);
  const summary = native.pdfDocumentSummary(document);
  return {
    readOutputBytes: Buffer.byteLength(visibleContent),
    readOutputSha256: signature(visibleContent),
    documentTextBytes: native.documentTextBytes(document),
    documentFingerprintSha256: fingerprint.resultSha256,
    documentFingerprintComponents: fingerprint.components,
    pdfSummary: {
      cacheKey: summary.cacheKey,
      status: summary.status,
      pageCount: summary.pageCount,
      projectionPageCount: summary.projectionPageCount,
      pagesNeedingOcr: summary.pagesNeedingOcr,
      ocrRoutedPages: summary.ocrRoutedPages,
    },
  };
}

async function openExisting(
  product: Product,
  stores: ProductStores,
  documentId: string,
  versionId: string,
) {
  process.stderr.write(`[beaver-pdf] restarted-open ${documentId}\n`);
  const lifecycleStart = lifecycleEvents.length;
  try {
    const opened = await timed(() => productionRead(
      product, stores, documentId, versionId));
    const diagnostics = await timed(() => outputSignature(
      product, stores, documentId, versionId, opened.value));
    return { failures: [], restartedAssistantReadMs: opened.elapsedMs,
      nativeDiagnosticsMs: diagnostics.elapsedMs,
      lifecycle: lifecycleFor(documentId, lifecycleStart), ...diagnostics.value };
  } catch (error) {
    return { failures: [`restarted production Read failed: ${errorMessage(error)}`],
      lifecycle: lifecycleFor(documentId, lifecycleStart) };
  }
}

async function openBatch(references: { documentId: string; versionId: string }[]) {
  let product: Product | undefined;
  try {
    const startup = await timed(async () => {
      const loaded = await timed(loadProduct);
      product = loaded.value;
      const initialized = await timed(() => product!.runtime.initialize());
      const documents = await timed(() => product!.runtime.documents());
      const support = await timed(async () => {
        const [library, projects] = await Promise.all([
          product!.runtime.library(), product!.runtime.projects(),
        ]);
        return { library, projects };
      });
      return { stores: { documents: documents.value, ...support.value },
        moduleLoadMs: loaded.elapsedMs, initializeMs: initialized.elapsedMs,
        documentStoreMs: documents.elapsedMs, readSupportStoresMs: support.elapsedMs };
    });
    process.stdout.write(`${CHILD_READY}\n`);
    const opens = [];
    for (const reference of references)
      opens.push(await openExisting(product!, startup.value.stores,
        reference.documentId, reference.versionId));
    return { applicationStartupMs: startup.elapsedMs,
      moduleLoadMs: startup.value.moduleLoadMs,
      initializeMs: startup.value.initializeMs,
      documentStoreMs: startup.value.documentStoreMs,
      readSupportStoresMs: startup.value.readSupportStoresMs, opens };
  } finally { await product?.runtime.shutdown(); }
}

type ParseState = { status?: string; error?: string } | null;
async function waitUntilPrepared(baseUrl: string, documentIds: string[]) {
  const started = performance.now();
  const pending = new Set(documentIds), previous = new Map<string, string>();
  const ready = new Map<string, { state: ParseState; elapsedMs: number; readyAt: number }>();
  while (pending.size) {
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
    if (now - started > 300_000) {
      for (const id of pending) ready.set(id, { state: { status: "failed",
        error: "preparation timed out" }, elapsedMs: round(now - started), readyAt: now });
      pending.clear();
    }
    if (pending.size) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return ready;
}

async function uploadPdf(baseUrl: string, filename: string, bytes: Buffer) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), filename);
  const response = await fetch(`${baseUrl}/api/single-documents`, {
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
  const addon = await addonIdentity(product);
  await product.runtime.initialize();
  const server = COMPILED_BACKEND
    ? (require("../../backend/dist/server") as typeof import("../../backend/src/server")).server
    : (await import("../../backend/src/server")).server;
  const [documents, library, projects] = await Promise.all([
    product.runtime.documents(), product.runtime.library(), product.runtime.projects(),
  ]);
  const stores = { documents, library, projects };
  const listener = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Beaver HTTP listener unavailable");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const samples = [];
  let memory: ReturnType<typeof sameProcessMemory> | undefined;
  let bulkInputReadUploadAndReadyMs = 0;
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
      return { ...input, inputBytes: bytes.length, inputSha256: signature(bytes),
        clientFileReadMs: clientRead.elapsedMs, uploaded, document: uploaded.value };
    };
    const uploads = new Array<Awaited<ReturnType<typeof uploadOne>>>(inputs.length);
    let nextUpload = 0;
    await Promise.all(Array.from({ length: Math.min(4, inputs.length) }, async () => {
      while (nextUpload < inputs.length) {
        const index = nextUpload++;
        uploads[index] = await uploadOne(inputs[index]);
      }
    }));
    const prepared = await timed(() => waitUntilPrepared(
      baseUrl, uploads.map(({ document }) => document.id)));
    const preparedDocuments = uploads.map((entry) => ({ ...entry,
      prepared: prepared.value.get(entry.document.id) }));
    bulkInputReadUploadAndReadyMs = round(performance.now() - bulkStartedAt);
    for (const entry of preparedDocuments) {
      const { pdf, inputBytes, inputSha256, clientFileReadMs, uploaded, document,
        prepared } = entry;
      const lifecycle = lifecycleFor(document.id, lifecycleStart);
      if (!prepared) {
        samples.push({ pdf, inputBytes, clientFileReadMs,
          httpUploadRoundtripMs: uploaded.elapsedMs,
          status: "missing", failures: ["preparation output missing"], lifecycle,
          documentId: document.id, versionId: document.current_version_id });
        continue;
      }
      const preparationReadyAt = prepared.readyAt;
      const enqueued = lifecycle.find((event) => event.phase === "queue.enqueued");
      const claimed = lifecycle.find((event) => event.phase === "queue.claimed");
      const nativePreparationMs = phaseTotal(lifecycle, "prepare.native");
      const lifecycleFailures = [!enqueued && "queue.enqueued lifecycle event missing",
        !claimed && "queue.claimed lifecycle event missing",
        nativePreparationMs === null && "prepare.native lifecycle event missing"]
        .filter(Boolean) as string[];
      const enqueueToObservedReadyMs = enqueued
        ? round(Math.max(0, preparationReadyAt - enqueued.endedAt)) : null;
      const nativeOverlapMs = enqueued
        ? phaseOverlap(lifecycle, "prepare.native", enqueued.endedAt, preparationReadyAt) : null;
      const preparation = {
        postBulkUploadPollToObservedReadyMs: prepared.elapsedMs,
        bulkStartToObservedReadyMs: round(preparationReadyAt - bulkStartedAt),
        nativePreparationMs,
        enqueueToHandlerStartMs: enqueued && claimed && claimed.startedAt >= enqueued.endedAt
          ? round(claimed.startedAt - enqueued.endedAt) : null,
        enqueueToObservedReadyMs,
        nativeOverlapWithinEnqueueToReadyMs: nativeOverlapMs,
        enqueueToObservedReadyOutsideNativeMs: enqueueToObservedReadyMs === null ||
          nativeOverlapMs === null ? null : round(Math.max(0,
            enqueueToObservedReadyMs - nativeOverlapMs)),
      };
      if (prepared.state?.status === "failed" || prepared.state?.status === "cancelled") {
        samples.push({ pdf, inputBytes, clientFileReadMs,
          httpUploadRoundtripMs: uploaded.elapsedMs,
          status: prepared.state.status, error: prepared.state.error ?? null,
          failures: [`${prepared.state.status}: ${prepared.state.error ?? "unknown error"}`],
          lifecycle, documentId: document.id, versionId: document.current_version_id,
          ...preparation });
        process.stderr.write(`[beaver-pdf] ${prepared.state.status} ${pdf}\n`);
        continue;
      }
      let httpOpen;
      try {
        httpOpen = await timed(() => openPdfOverHttp(
          baseUrl, document.id, document.current_version_id));
      } catch (error) {
        samples.push({ pdf, inputBytes, clientFileReadMs,
          httpUploadRoundtripMs: uploaded.elapsedMs,
          status: prepared.state?.status ?? "ready",
          failures: [`HTTP PDF output missing: ${errorMessage(error)}`],
          lifecycle, documentId: document.id, versionId: document.current_version_id,
          ...preparation });
        continue;
      }
      const httpPdfMatchesUpload = signature(httpOpen.value) === inputSha256;
      let measured;
      try {
        const read = await timed(() => productionRead(
          product, stores, document.id, document.current_version_id));
        const diagnostics = await timed(() => outputSignature(
          product, stores, document.id, document.current_version_id, read.value));
        measured = { read, diagnostics };
      } catch (error) {
        samples.push({ pdf, inputBytes, clientFileReadMs,
          httpUploadRoundtripMs: uploaded.elapsedMs,
          httpPdfOpenMs: httpOpen.elapsedMs,
          httpPdfBytes: httpOpen.value.length,
          httpPdfMatchesUpload,
          status: prepared.state?.status ?? "ready",
          failures: [...lifecycleFailures,
            ...(httpPdfMatchesUpload ? [] : ["HTTP PDF source mismatch"]),
            `production Read or native diagnostics failed: ${errorMessage(error)}`],
          lifecycle, documentId: document.id, versionId: document.current_version_id,
          ...preparation });
        continue;
      }
      const failures = [...lifecycleFailures];
      if (!httpPdfMatchesUpload) failures.push("HTTP PDF source mismatch");
      const warmOutput = measured.diagnostics.value;
      samples.push({ pdf, inputBytes,
        clientFileReadMs, httpUploadRoundtripMs: uploaded.elapsedMs,
        httpPdfOpenMs: httpOpen.elapsedMs,
        httpPdfBytes: httpOpen.value.length,
        httpPdfMatchesUpload,
        assistantReadMs: measured.read.elapsedMs,
        nativeDiagnosticsMs: measured.diagnostics.elapsedMs,
        lifecycle, documentId: document.id,
        versionId: document.current_version_id,
        warmOutput, failures, status: prepared.state?.status ?? "ready", ...preparation });
      process.stderr.write(`[beaver-pdf] prepared ${pdf}\n`);
    }
  } finally {
    try {
      await new Promise<void>((resolve, reject) => listener.close((error) =>
        error ? reject(error) : resolve()));
    } finally {
      try { await product.runtime.shutdown(); }
      finally { memory = sameProcessMemory(); }
    }
  }
  let cacheOutputsMatch = true;
  const withOutput = samples.filter((sample) => sample.warmOutput);
  let restarted: Awaited<ReturnType<typeof restartedOpen>> | null = null;
  if (withOutput.length) try {
    restarted = await restartedOpen(withOutput.map(({ documentId, versionId }) =>
      ({ documentId, versionId })));
    for (const [index, sample] of withOutput.entries()) {
      const reopened = restarted.opens[index];
      const cacheOutputMatches = reopened !== undefined && !reopened.failures.length &&
        "readOutputSha256" in reopened &&
        reopened.readOutputSha256 === sample.warmOutput.readOutputSha256 &&
        reopened.documentFingerprintSha256 ===
          sample.warmOutput.documentFingerprintSha256;
      cacheOutputsMatch &&= cacheOutputMatches;
      if (reopened?.failures.length) sample.failures.push(...reopened.failures);
      else if (!cacheOutputMatches) sample.failures.push("restarted cache output mismatch");
      Object.assign(sample, { restartedOpen: reopened, cacheOutputMatches });
    }
  } catch (error) {
    cacheOutputsMatch = false;
    for (const sample of withOutput)
      sample.failures.push(`restarted cache read failed: ${errorMessage(error)}`);
  }
  const succeeded = samples.filter((sample) => !sample.failures.length).length;
  const documentCounts = { requested: pdfs.length, succeeded,
    failed: pdfs.length - succeeded };
  const ocrRoutedDocuments = samples.filter((sample) =>
    sample.warmOutput?.pdfSummary.ocrRoutedPages.length).length;
  const stressPassed = !stressRun || pdfs.length === 100;
  process.stdout.write(`${JSON.stringify({ dataMode: suppliedDataDirectory ? "supplied" : "isolated",
    dataDirectory: process.env.MIKE_LOCAL_DATA_DIR,
    addon, cacheOutputsMatch,
    backendRuntime: COMPILED_BACKEND ? "compiled" : "tsx",
    bulkInputReadUploadAndReadyMs,
    sameProcessMemory: memory,
    documentCounts,
    routing: { withoutOcr: samples.filter((sample) =>
      sample.warmOutput && !sample.warmOutput.pdfSummary.ocrRoutedPages.length).length,
    withOcr: ocrRoutedDocuments },
    stressGate: stressRun ? { expectedDocuments: 100,
      actualDocuments: pdfs.length, passed: stressPassed } : null,
    structuredReadTransport: "production TurnToolRegistry Read; no HTTP tool endpoint",
    restartedInternalProcess: restarted ? {
      spawnToApplicationReadyMs: restarted.spawnToApplicationReadyMs,
      applicationStartupMs: restarted.applicationStartupMs,
      moduleLoadMs: restarted.moduleLoadMs, initializeMs: restarted.initializeMs,
      documentStoreMs: restarted.documentStoreMs,
      readSupportStoresMs: restarted.readSupportStoresMs,
      childLifecycleMs: restarted.childLifecycleMs } : null, samples }, null, 2)}\n`);
  if (!cacheOutputsMatch || documentCounts.failed || !stressPassed) process.exitCode = 1;
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
