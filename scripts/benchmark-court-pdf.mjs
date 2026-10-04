// node scripts/benchmark-court-pdf.mjs freeze OUTPUT_ROOT
// node scripts/benchmark-court-pdf.mjs profile OUTPUT_ROOT RUN_DIR
// node scripts/benchmark-court-pdf.mjs compare OUTPUT_ROOT RUN_DIR [PAIRS=10] [WARM=3]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, access, appendFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import { chromium } from "@playwright/test";
import { pairedScore } from "./court-pdf-score.mjs";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const frontendRequire = createRequire(path.join(repo, "frontend/package.json"));
const { PDFDocument, StandardFonts } = frontendRequire("pdf-lib");
const [mode, rootArg, runArg, pairArg = "10", warmArg = "3"] = process.argv.slice(2);
assert.ok(["freeze", "profile", "compare", "noise", "confirm", "_build"].includes(mode) && rootArg,
  "Usage: benchmark-court-pdf.mjs freeze|profile|compare OUTPUT_ROOT [RUN_DIR] [PAIRS] [WARM]");
const root = path.resolve(rootArg), runDir = runArg && path.resolve(runArg);
const pairs = Number(pairArg), warm = Number(warmArg);
assert.ok(Number.isSafeInteger(pairs) && pairs > 0 && Number.isSafeInteger(warm) && warm > 0);
const hash = value => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`,
  "-C", repo, ...args], { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const source = "frontend/src/app/court-records/pdfText.ts";
const dependencies = Object.fromEntries(["pdf-lib", "vite"].map(name =>
  [name, frontendRequire(`${name}/package.json`).version]));
const shaFile = async filename => hash(await readFile(filename));
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const median = values => { const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; };
async function newDirectory(directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory); // Never overwrite a frozen baseline or an existing receipt.
}
async function hashes(directory, relative = "") {
  const result = {};
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(directory, name));
    else result[name.replaceAll("\\", "/")] = await shaFile(path.join(directory, name));
  }
  return result;
}
async function build(directory) {
  // Compilation exits before sampling, so its retained heap/threads do not pollute process-tree memory.
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "_build", directory], { stdio: "inherit" });
}
async function compile(directory) {
  const { build } = await import(pathToFileURL(frontendRequire.resolve("vite")).href);
  await build({ configFile: false, root: path.join(repo, "scripts/fixtures"), publicDir: false,
    logLevel: "warn", resolve: { alias: { "@": path.join(repo, "frontend/src") } },
    build: { outDir: directory, emptyOutDir: false, minify: false, sourcemap: true,
      rolldownOptions: { input: path.join(repo, "scripts/fixtures/court-pdf-benchmark.html") } } });
}
if (mode === "_build") { await compile(root); process.exit(0); }
async function fixtures() {
  const directory = path.join(root, "fixtures");
  await newDirectory(directory);
  const fixedDate = new Date("2026-01-02T12:00:00Z");
  const manifests = [];
  for (let index = 0; index < 340; index++) {
    const id = `inventory-${String(index + 1).padStart(3, "0")}`;
    const document = await PDFDocument.create();
    document.setCreationDate(fixedDate); document.setModificationDate(fixedDate);
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
      const page = document.addPage([612, 792]);
      page.drawText(`Invented inventory inspection ${index + 1}, page ${pageIndex + 1}`,
        { x: 72, y: 720, size: 12, font });
      for (let row = 0; row < 18; row++) page.drawText(
        `Shelf ${row + 1}: sample containers examined; condition and count recorded.`,
        { x: 72, y: 680 - row * 25, size: 10, font });
    }
    const bytes = await document.save();
    await writeFile(path.join(directory, `${id}.pdf`), bytes);
    const title = index >= 180 ? `Supplementary shelf audit ${index + 1} comparing sealed-box counts and delivery-round observations from alternate storage section ${index % 9 + 1}`
      : index < 2 ? ["Notice of inventory inspection motion", "Written inventory inspection representations"][index]
      : `Inventory inspection log ${index + 1} for storage section ${index % 12 + 1}, including container counts, shelf condition photographs and follow-up maintenance observations`;
    manifests.push({ id, title, kindId: index === 0 ? "notice-motion" : index === 1
      ? "written-representations" : "other-filed-material", path: `${id}.pdf`, pages: 2, sha256: hash(bytes) });
  }
  for (const [name, count] of [["medium", 60], ["large", 180]])
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(manifests.slice(0, count), null, 2));
  for (const [name, count] of [["holdout-medium", 37], ["holdout-large", 123]])
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(manifests.slice(180, 180 + count)
      .map((entry, index) => ({ ...entry, kindId: index === 0 ? "notice-motion" : index === 1 ? "written-representations" : "other-filed-material" })), null, 2));
  return hashes(directory);
}
if (mode === "freeze") {
  await newDirectory(root);
  const inputs = await fixtures();
  const baseline = path.join(root, "baseline");
  await newDirectory(baseline); await build(baseline);
  const owner = { kind: "beaver.court-pdf-tournament.v2", head, source, sourceSha256: await shaFile(path.join(repo, source)),
    node: process.version, dependencies, inputs, baselineAssets: await hashes(baseline),
    workload: "Federal motion record; 60/180 independently invented two-page sources; repeat complete assembly",
    oracle: "Exact PDF byte SHA-256, full receipt and progress, with Date fixed; performance.now remains real",
    objective: "Geometric mean of four cold/warm normalized paired median ratios, minimized against current incumbent",
    gates: { pairedWinFraction: 0.8, p95MaximumRatio: 1.0, bootstrapRepeats: 5000, bootstrapSeed: 60493,
      memoryMaximumRatio: 1.10, memoryAllowanceMiB: 8, backgroundLoadDifferencePercentagePoints: 3,
      maximumBackgroundCpuPercent: 20, pairs: 10, warm: 3 },
  };
  await writeFile(path.join(root, "owner.json"), JSON.stringify(owner, null, 2));
  console.log(JSON.stringify({ frozen: root, head, sourceSha256: owner.sourceSha256 }));
  process.exit(0);
}
assert.ok(runDir, "Provide a fresh RUN_DIR");
await newDirectory(runDir);
const owner = JSON.parse(await readFile(path.join(root, "owner.json"), "utf8"));
assert.equal(owner.kind, "beaver.court-pdf-tournament.v2", "Evaluator changed: use a fresh versioned root and rebaseline");
if (mode !== "profile") { assert.equal(pairs, owner.gates.pairs); assert.equal(warm, owner.gates.warm); }
assert.deepEqual(await hashes(path.join(root, "fixtures")), owner.inputs, "Frozen inputs changed");
assert.deepEqual(await hashes(path.join(root, "baseline")), owner.baselineAssets, "Frozen build changed");
assert.deepEqual(dependencies, owner.dependencies, "Dependency versions differ");
if (mode !== "profile") { await newDirectory(path.join(runDir, "candidate")); await build(path.join(runDir, "candidate")); }
const incumbent = mode === "profile" ? { commit: owner.head, assets: "baseline", assetHashes: owner.baselineAssets }
  : JSON.parse(await readFile(path.join(root, "best.json"), "utf8"));
const baselineDirectory = path.resolve(root, mode === "confirm" ? "baseline" : incumbent.assets);
assert.ok(baselineDirectory.startsWith(root + path.sep));
assert.deepEqual(await hashes(baselineDirectory), mode === "confirm" ? owner.baselineAssets : incumbent.assetHashes, "Incumbent assets changed");
let oracle;
if (mode !== "profile") oracle = JSON.parse(await readFile(path.join(root, "oracle.json"), "utf8"));
else {
  await assert.rejects(access(path.join(root, "oracle.json")), "Profile and freeze the oracle once");
  oracle = {};
}
const report = { kind: owner.kind, runId: path.basename(runDir), submission: { origin: "machine_test", run_id: path.basename(runDir) },
  baselineRevision: mode === "confirm" ? owner.head : incumbent.commit, candidateRevision: head, candidateDiffSha256: hash(git("diff", "HEAD")),
  sourceSha256: await shaFile(path.join(repo, source)), ownerSha256: await shaFile(path.join(root, "owner.json")),
  environment: { node: process.version, platform: os.platform(), cpu: os.cpus()[0].model, cpus: os.cpus().length,
    totalMemory: os.totalmem(), dependencies }, method: "Fresh headless Chromium per trial; cold=first assembly after modules/inputs loaded; warm=repeated complete assembly; setup/build/profile excluded from reported operation timings",
  pairs: mode === "profile" ? 1 : pairs, warm, samples: [], summary: {}, failures: [] };
const requests = [], external = [], operationRequestCounts = [];
const mime = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".pdf": "application/pdf", ".ttf": "font/ttf" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    requests.push(pathname);
    const [label, ...parts] = pathname.slice(1).split("/");
    const base = label === "fixtures" ? path.join(root, "fixtures") : label === "court-fonts"
      ? path.join(repo, "frontend/public/court-fonts") : label === "baseline" ? baselineDirectory
        : label === "candidate" ? path.join(runDir, "candidate") : null;
    if (!base) { res.writeHead(404).end(); return; }
    const filename = path.resolve(base, parts.join("/") || "court-pdf-benchmark.html");
    if (!filename.startsWith(path.resolve(base) + path.sep)) { res.writeHead(403).end(); return; }
    res.writeHead(200, { "Content-Type": mime[path.extname(filename)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    let body = await readFile(filename);
    if (path.extname(filename) === ".html") body = Buffer.from(body.toString().replaceAll('="/assets/', `="/${label}/assets/`));
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profileTotals = {};
async function trial(label, workload, pair) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }) });
  report.environment.chromium = browser.version();
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [], startRequests = requests.length;
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  try {
    const navigationStart = performance.now();
    await page.goto(`${origin}/${label}/court-pdf-benchmark.html`);
    await page.waitForFunction(() => !!window.courtPdfBenchmark);
    const input = await page.evaluate(workload => window.courtPdfBenchmark.prepare(workload), workload);
    const setupMs = performance.now() - navigationStart;
    const setupRequests = requests.length - startRequests, operationStartRequests = requests.length;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    if (mode === "profile") { await cdp.send("Profiler.enable"); await cdp.send("Profiler.start"); }
    console.log(`BENCH_PHASE ${JSON.stringify({ event: "start", label, workload, pair })}`);
    for (let repetition = 0; repetition <= warm; repetition++) {
      const beforeCpu = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
      const result = await page.evaluate(() => window.courtPdfBenchmark.run());
      const afterCpu = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
      if ((mode === "profile" || mode === "confirm" && label === "baseline") && !oracle[workload]) oracle[workload] = result.oracle;
      assert.deepEqual(result.oracle, oracle[workload], `${label}/${workload}/${repetition}: output differs from frozen oracle`);
      const metrics = await cdp.send("Runtime.getHeapUsage");
      report.samples.push({ label, workload, pair, repetition, state: repetition ? "warm" : "cold",
        wallMs: result.wallMs, threadCpuMs: 1000 * (afterCpu.TaskDuration - beforeCpu.TaskDuration),
        jsHeapUsed: metrics.usedSize, input, setupMs, setupRequests });
      await appendFile(path.join(runDir, "samples.jsonl"), JSON.stringify(report.samples.at(-1)) + "\n");
    }
    const operationRequests = requests.length - operationStartRequests;
    operationRequestCounts.push(operationRequests);
    assert.equal(operationRequests, 0, "Assembly unexpectedly fetched assets or called an API");
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log(`BENCH_PHASE ${JSON.stringify({ event: "stop", label, workload, pair, operationRequests })}`);
    if (mode === "profile") {
      const { profile } = await cdp.send("Profiler.stop");
      await writeFile(path.join(runDir, `${workload}.cpuprofile`), JSON.stringify(profile));
      const nodes = new Map(profile.nodes.map(node => [node.id, node]));
      const self = new Map();
      profile.samples?.forEach((id, index) => self.set(id, (self.get(id) ?? 0) + profile.timeDeltas[index]));
      const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, micros]) => ({
        function: nodes.get(id).callFrame.functionName, url: nodes.get(id).callFrame.url,
        line: nodes.get(id).callFrame.lineNumber + 1, selfMs: micros / 1000 }));
      profileTotals[workload] = top;
    }
  } catch (error) {
    report.browserErrors = errors;
    report.lastRequests = requests.slice(-12);
    throw error;
  } finally { await context.close(); await browser.close(); }
}
try {
  const workloadNames = mode === "confirm" ? ["holdout-medium", "holdout-large"] : ["medium", "large"];
  for (let pair = 0; pair < report.pairs; pair++) {
    for (const workload of pair % 2 ? [...workloadNames].reverse() : workloadNames) {
      for (const label of mode === "profile" ? ["baseline"] : pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"])
        await trial(label, workload, pair);
    }
  }
  if (mode === "profile") {
    await writeFile(path.join(root, "oracle.json"), JSON.stringify(oracle, null, 2), { flag: "wx" });
    await writeFile(path.join(runDir, "profile-summary.json"), JSON.stringify(profileTotals, null, 2));
  } else {
    const cells = {};
    for (const workload of workloadNames) {
      const summary = report.summary[workload] = {};
      for (const state of ["cold", "warm"]) {
        const selected = label => report.samples.filter(s => s.workload === workload && s.state === state && s.label === label);
        const baseline = selected("baseline"), candidate = selected("candidate");
        const stats = samples => ({ count: samples.length, p50Ms: median(samples.map(s => s.wallMs)),
          p95Ms: percentile(samples.map(s => s.wallMs), 0.95),
          p50ThreadCpuMs: median(samples.map(s => s.threadCpuMs)), maxJsHeapUsed: Math.max(...samples.map(s => s.jsHeapUsed)) });
        const before = stats(baseline), after = stats(candidate);
        const reductions = Array.from({ length: pairs }, (_, pair) => {
          const group = samples => median(samples.filter(s => s.pair === pair).map(s => s.wallMs));
          return 1 - group(candidate) / group(baseline);
        });
        summary[state] = { baseline: before, candidate: after,
          p50Reduction: 1 - after.p50Ms / before.p50Ms,
          pairedMedianReduction: median(reductions), pairedWins: reductions.filter(value => value > 0).length, pairedReductions: reductions };
        cells[`${workload}/${state}`] = reductions.map(value => 1 - value);
        if (mode !== "noise" && after.p95Ms > before.p95Ms * owner.gates.p95MaximumRatio)
          report.failures.push(`${workload}/${state}: p95 regression`);
      }
    }
    report.score = pairedScore(cells, owner.gates);
    if (mode === "compare" && !report.score.repeatablyBetter) report.failures.push("No repeatable strict geometric-mean improvement");
    report.candidateAssetHashes = await hashes(path.join(runDir, "candidate"));
  }
} catch (error) { report.failures.push(error.stack); }
finally {
  await new Promise(done => server.close(done));
  report.outputEquivalent = report.samples.length === report.pairs * 2 * (mode === "profile" ? 1 : 2) * (warm + 1)
    && !report.failures.some(failure => failure.includes("output differs"));
  report.network = { externalRequests: external.length, totalLoopbackRequests: requests.length,
    operationRequests: operationRequestCounts.reduce((sum, count) => sum + count, 0), operationRequestCounts };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ runDir, summary: report.summary, failures: report.failures, outputEquivalent: report.outputEquivalent }));
}
if (report.failures.length) process.exitCode = 1;
