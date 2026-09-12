// Run with tsx, in a fresh process whose native module and data directory are explicit.
// Preparation timing covers the app service; product inspection is timed separately.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { availableParallelism, totalmem } from "node:os";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { jobLaneConcurrency, sizeNativeThreadPool } from "../src/jobLanes";

async function main() {
  const [manifestPath, sourceRoot, outputRoot, label] = process.argv.slice(2);
  if (!manifestPath || !sourceRoot || !outputRoot || !["baseline", "candidate"].includes(label))
    throw new Error("Usage: tsx scripts/pdf-corpus.ts manifest.json source-root output-root baseline|candidate");
  if (!process.env.LEGAL_STRUCTURE_NATIVE)
    throw new Error("Set LEGAL_STRUCTURE_NATIVE to the exact build being measured");
  if (!process.env.UV_THREADPOOL_SIZE) {
    sizeNativeThreadPool();
    const child = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)],
      { stdio: "inherit", env: process.env });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    return;
  }
  const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    documents: Array<{ path: string; sha256: string; pages: number }>;
  };
  if (!manifest.documents.length || new Set(manifest.documents.map(d => d.sha256)).size !== manifest.documents.length)
    throw new Error("Manifest must contain distinct source identities");
  const root = await realpath(sourceRoot);
  await mkdir(outputRoot, { recursive: true });
  const output = await realpath(outputRoot);
  const directory = path.join(output, label);
  const marker = path.join(directory, "owner.json");
  const owner = { kind: "beaver.pdf-corpus.v1", manifestSha256: hash(manifestBytes) };
  const lanes = jobLaneConcurrency();
  const environment = {
    lanes, cpus: availableParallelism(), memoryBytes: totalmem(),
    platform: process.platform, architecture: process.arch, node: process.version,
    threadPoolSize: process.env.UV_THREADPOOL_SIZE,
    profile: "native-without-ocr-or-layout", cache: "empty-at-start",
  };
  let baselineProducts = new Map<string, string>();
  let baselineSeconds: number | undefined;
  if (label === "candidate") {
    const baseline = JSON.parse(await readFile(path.join(output, "baseline", "summary.json"), "utf8"));
    if (baseline.manifestSha256 !== owner.manifestSha256 ||
        JSON.stringify(baseline.environment) !== JSON.stringify(environment))
      throw new Error("Baseline comparison conditions differ");
    baselineProducts = new Map(baseline.receipts.map((r: { sha256: string; productSha256?: string }) =>
      [r.sha256, r.productSha256 ?? ""]));
    baselineSeconds = baseline.preparationSeconds;
    if (!Number.isFinite(baselineSeconds) || baselineSeconds! <= 0)
      throw new Error("Baseline preparation time is invalid");
  }
  let existing: typeof owner | undefined;
  try { existing = JSON.parse(await readFile(marker, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    if (label === "baseline") throw new Error("Baseline is frozen; it cannot be overwritten");
    if (JSON.stringify(existing) !== JSON.stringify(owner) || await realpath(directory) !== directory)
      throw new Error("Refusing to replace an unrecognized candidate directory");
    // Only this runner's verified, fixed-name child directory may be replaced.
    await rm(directory, { recursive: true });
  }
  await mkdir(directory);
  await writeFile(marker, JSON.stringify(owner));
  process.env.MIKE_LOCAL_DATA_DIR = path.join(directory, "cache");
  const { documentProjectionService: service } = await import("../src/lib/documentProjectionService");
  const { structureNative } = await import("../src/lib/structureNative");
  const native = structureNative();
  const receipts: Array<Record<string, unknown>> = [];
  let next = 0;
  const started = performance.now();
  const preparationCpuStart = process.cpuUsage();
  await Promise.all(Array.from({ length: lanes.preparation }, async () => {
    while (next < manifest.documents.length) {
      const entry = manifest.documents[next++];
      const filename = await realpath(path.resolve(root, entry.path));
      const relative = path.relative(root, filename);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Source escapes corpus root");
      const bytes = await readFile(filename);
      if (hash(bytes) !== entry.sha256) throw new Error(`Source identity mismatch: ${entry.path}`);
      const begin = performance.now();
      try {
        const summary = await service.preparePdf({
          documentId: entry.sha256, versionId: "corpus", sourceSha256: entry.sha256,
          bytes, ocrProvider: null, layout: false,
        });
        if (summary.pageCount !== entry.pages) throw new Error(`Expected ${entry.pages} pages, received ${summary.pageCount}`);
        receipts.push({ ...entry, summary, preparationMs: performance.now() - begin });
      } catch (error) {
        receipts.push({ ...entry, error: String(error), preparationMs: performance.now() - begin });
      }
      console.log(`Prepared ${receipts.length}/${manifest.documents.length}`);
    }
  }));
  const preparationSeconds = (performance.now() - started) / 1000;
  const preparationCpu = process.cpuUsage(preparationCpuStart);
  const inspectStarted = performance.now();
  for (const receipt of receipts) {
    if (receipt.error) continue;
    const sha = receipt.sha256 as string;
    const summary = receipt.summary as Awaited<ReturnType<typeof service.preparePdf>>;
    const document = await service.read({
      documentId: sha, versionId: "corpus", fileType: "pdf", sourceSha256: sha,
      pdfProfile: { cacheKey: summary.cacheKey, profile: summary.profile, status: summary.status },
      readBytes: () => readFile(path.resolve(root, receipt.path as string)),
    });
    const product = JSON.stringify({ text: native.documentText(document),
      anchors: native.documentAnchors(document), authorityTextUnits: native.pdfAuthorityTextUnits(document) });
    receipt.productSha256 = hash(product);
    receipt.outcome = label === "baseline" ? "baseline" :
      baselineProducts.get(sha) === receipt.productSha256 ? "identical" :
      baselineProducts.get(sha) ? "changed" : "recovered";
    if (receipt.outcome !== "identical")
      await writeFile(path.join(directory, `${sha}.json.gz`), gzipSync(product));
  }
  const throughputPassed = baselineSeconds === undefined || preparationSeconds <= baselineSeconds;
  const result = { ...owner, environment, baselineSeconds, throughputPassed,
    nativeSha256: hash(await readFile(process.env.LEGAL_STRUCTURE_NATIVE)),
    preparationSeconds, preparationCpuSeconds: (preparationCpu.user + preparationCpu.system) / 1_000_000,
    inspectionSeconds: (performance.now() - inspectStarted) / 1000,
    documents: receipts.length, pages: manifest.documents.reduce((n, d) => n + d.pages, 0),
    failures: receipts.filter(r => r.error).length, receipts };
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(result, null, 2));
  const cache = path.join(directory, "cache");
  if (await realpath(cache) !== cache) throw new Error("Unexpected cache path");
  await rm(cache, { recursive: true });
  console.log(JSON.stringify({ preparationSeconds, documents: result.documents, failures: result.failures }));
  if (!throughputPassed)
    console.error(`Candidate preparation took ${preparationSeconds.toFixed(3)}s; frozen baseline limit is ${baselineSeconds!.toFixed(3)}s`);
  if (label === "candidate" && (result.failures || !throughputPassed)) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
