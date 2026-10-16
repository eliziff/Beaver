// Runs the composed ALR Quote Verifier headless: the Authorities runtime operations the page calls (import,
// sources, quote-check) and the ALR app's "[CHECKED]" workbook, from the ALR repository's beaver_app/runtime.
//   tsx --tsconfig benchmarks/alr-verifier/tsconfig.json benchmarks/alr-verifier/compose.ts \
//     --input <docx> [--input <docx> …] --out <dir> [--no-quotes] [--setting supra_linking=aggressive]
//     [--llm <module whose default export is an llm> --setting run_mode=high_accuracy|economy|ultra_economy]
// A2AJ answers come from the local store, then from the recorded answers in
// benchmarks/local-data/alr-verifier/a2aj-http-cache; new live lookups are off unless --a2aj-live <n>. Nothing else
// leaves the computer, as in the Python app's local-only run: a publisher's page (CanLII, CourtListener) is a miss.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultNativeAddon } from "../../shared/nativeAddonFile.mjs";

const REPO = path.resolve(import.meta.dirname, "../..");
const SUITE = path.join(REPO, "benchmarks/local-data/alr-verifier");
const config = JSON.parse(readFileSync(path.join(SUITE, "config.json"), "utf8")) as { alr_quote_verifier: string };
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const settings: Record<string, string> = Object.fromEntries(args.flatMap((value, index) =>
  value === "--setting" ? [args[index + 1].split(/=(.*)/su, 2)] : []));

// Record/replay every api.a2aj.ca answer; new lookups are capped; any other address fails at once.
const cacheDir = path.join(SUITE, "a2aj-http-cache");
let live = Number(option("--a2aj-live") ?? 0);
const undici = createRequire(path.join(REPO, "backend/package.json"))("undici") as { fetch: typeof fetch };
const realFetch = undici.fetch;
undici.fetch = (async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
  if (!/^https:\/\/api\.a2aj\.ca\//u.test(url)) throw new TypeError(`local only: ${url}`);
  const method = (init?.method ?? "GET").toUpperCase(), file = path.join(cacheDir,
    `${createHash("sha256").update(`${method} ${url}`).digest("hex")}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { status: number; headers: Record<string, string>; body: string };
    return new Response(method === "HEAD" ? null : saved.body, { status: saved.status, headers: saved.headers });
  }
  if (live <= 0) throw new TypeError(`A2AJ lookup not recorded and live lookups are off: ${url}`);
  live--;
  const response = await realFetch(resource, init), body = method === "HEAD" ? "" : await response.text();
  if (response.status !== 429 && response.status < 500) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ url, status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }, body }));
  }
  return new Response(method === "HEAD" ? null : body, { status: response.status, headers: response.headers });
}) as typeof fetch;
globalThis.fetch = undici.fetch;

// Every --input in one process, as the page reads documents once it has loaded: one input writes to --out, several
// each to --out/<its name>.
void (async () => {
  const inputs = args.flatMap((value, index) => value === "--input" ? [args[index + 1]] : []), out = option("--out");
  if (!inputs.length || !out) throw new Error("Use --input <docx> [--input <docx> …] --out <dir>");
  // The runtime, as run.py bundles it once (ALR_RUNTIME_BUNDLE), else its TypeScript, compiled as it is read.
  const runtime = process.env.ALR_RUNTIME_BUNDLE || path.join(config.alr_quote_verifier, "beaver_app/runtime/operations.ts");
  const { createAuthoritiesOperations } = await import(pathToFileURL(runtime).href);
  const ops = createAuthoritiesOperations();
  const native = process.env.LEGAL_STRUCTURE_NATIVE ?? defaultNativeAddon(path.join(REPO, "native/legal-structure-node"));
  const runIdentity = { runtime_sha256: createHash("sha256").update(readFileSync(runtime)).digest("hex"),
    native_sha256: createHash("sha256").update(readFileSync(native)).digest("hex") };
  for (const input of inputs) {
    try {
      await composeOne(ops, input, inputs.length > 1 ? path.join(out, path.parse(input).name) : out, runIdentity);
    } catch (error) {
      console.error(`${path.basename(input)}: ${error instanceof Error ? error.stack : error}`);
      process.exitCode = 1;
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

async function composeOne(ops: any, input: string, out: string, runIdentity: { runtime_sha256: string; native_sha256: string }) {
  const signal = new AbortController().signal, started = performance.now();
  // Seconds each step took, in the run record.
  const steps: Record<string, number> = {};
  let mark = started;
  const step = (name: string) => { const now = performance.now(); steps[name] = Math.round(now - mark) / 1000; mark = now; };
  const file = { filename: path.basename(input), bytes: new Uint8Array(readFileSync(input)), modified: 0 };
  let draft = (await ops.import({ files: [file], settings: { outputMode: "table", sourceText: true },
    ...(settings.supra_linking === "aggressive" ? { supraLinking: "aggressive" } : {}) }, { signal })).data;
  step("import");
  draft = (await ops.sources({ draft }, { signal, progress: () => undefined })).data;
  step("sources");
  const check = args.includes("--no-quotes")
    ? { mode: "mechanical", quotes: [], total: 0, counts: {}, citationUnits: await (await import(pathToFileURL(
      path.join(REPO, "backend/src/lib/quoteCitationSplit.ts")).href)).splitQuoteCitationUnits(
      draft.units.map(({ text }: { text: string }) => text)).then((units: object[]) =>
      units.map((unit, index) => ({ unitId: draft.units[index].id, ...unit }))) }
    : (await ops["quote-check"]({ draft }, { signal })).data;
  step("quotes");
  const options = { exportDetail: "diagnostic-hidden", supraLinking: settings.supra_linking ?? "safe", footnotes: settings.fn_filter ?? "" };
  // An AI run mode: the page's run mode over the given llm (the page gives it a model the person connected).
  let workbook: { filename: string; bytes: Uint8Array }, modelCalls: unknown = null;
  if (option("--llm") && settings.run_mode && settings.run_mode !== "free") {
    const llm = (await import(pathToFileURL(path.resolve(option("--llm")!)).href)).default;
    const module = (name: string) => pathToFileURL(process.env.ALR_RUNTIME_BUNDLE
      ? path.join(path.dirname(process.env.ALR_RUNTIME_BUNDLE), `${name}.mjs`)
      : path.join(REPO, `backend/src/lib/quoteVerification/${name === "ai" ? "runModel" : name}.ts`)).href;
    const { alrModel } = await import(module("ai"));
    const { alrCheckedWorkbook } = await import(module("checkedWorkbook"));
    const run = alrModel(llm.default ?? llm, settings.run_mode, (message: string) => console.error(message));
    const made = await alrCheckedWorkbook(draft.import.filename, draft, check, options, run.model, signal);
    workbook = { filename: made.name, bytes: made.workbook };
    modelCalls = run.stats;
  } else {
    const written = await ops["verify-workbook"]({ draft, check, options }, { signal });
    workbook = written.files.find((item: { role: string }) => item.role === "workbook");
  }
  step("workbook");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, workbook.filename), workbook.bytes);
  // Product state for consumer equivalence; execution identities stay in the
  // separate receipt. Retain all citation/source fields, not only summary counts.
  writeFileSync(path.join(out, workbook.filename.replace(/\.xlsx$/u, ".citations.json")), JSON.stringify({
    units: draft.units, authorities: draft.authorities, occurrences: draft.occurrences,
  }));
  // Save individual checks: workbook row statuses combine several quotations and cannot grade each one.
  const usedUnits = new Set(check.quotes.flatMap((quote: any) =>
    [quote.unitId, ...quote.candidates.map((candidate: any) => candidate.unitId)]));
  const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  const quoteOutput = {
    schema_version: 1, run_id: process.env.ALR_EVAL_LABEL ?? "alr-quote-run", submission_origin: "machine_test",
    historical_input_origin: "unknown", engine: runIdentity,
    document: { filename: file.filename, sha256: digest(file.bytes) },
    units: draft.units.filter((unit: any) => usedUnits.has(unit.id)).map((unit: any) => ({
      id: unit.id, kind: unit.kind, ordinal: unit.ordinal, footnoteId: unit.footnoteId,
      noteNumber: unit.noteNumber, footnoteRefs: unit.footnoteRefs, text: unit.text,
    })),
    quotes: check.quotes.map((quote: any) => ({
      id: quote.id, unitId: quote.unitId, start: quote.start, end: quote.end, quote: quote.quote,
      occurrenceId: quote.occurrenceId, candidates: quote.candidates,
      checks: quote.checks.map((item: any) => ({
        candidateId: item.candidateId, status: item.status, detail: item.detail,
        receipt: item.receipt ? {
          source: item.receipt.source, sourceSha256: item.receipt.sourceSha256,
          passageSha256: item.receipt.passageSha256, locator: item.receipt.locator, link: item.receipt.link,
          errors: item.receipt.errors.map((error: string) => error.split(" source window:")[0]),
          match: (({ text, region, cited, ...match }: any) => ({ ...match,
            region_utf16_length: region.length,
            cited: cited ? (({ region, ...partial }: any) => partial)(cited) : null,
          }))(item.receipt.match),
        } : null,
      })),
    })),
  };
  writeFileSync(path.join(out, workbook.filename.replace(/\.xlsx$/u, ".quotes.json")), JSON.stringify(quoteOutput));
  writeFileSync(path.join(out, workbook.filename.replace(/\.xlsx$/u, ".quotation-results.json")), JSON.stringify({
    units: quoteOutput.units, quotes: quoteOutput.quotes,
  }));
  writeFileSync(path.join(out, workbook.filename.replace(/\.xlsx$/u, ".run.json")), JSON.stringify({
    document: file.filename, settings, seconds: (performance.now() - started) / 1000, steps, summary: check.counts, modelCalls }, null, 2));
  console.log(JSON.stringify({ document: file.filename, seconds: Math.round((performance.now() - started) / 100) / 10, counts: check.counts }));
}
