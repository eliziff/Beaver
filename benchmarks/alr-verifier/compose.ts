// Runs the composed ALR Quote Verifier headless: the Authorities runtime operations the page calls (import,
// sources, quote-check) and the ALR app's "[CHECKED]" workbook, from the ALR repository's beaver_app/runtime.
//   tsx --tsconfig benchmarks/alr-verifier/tsconfig.json benchmarks/alr-verifier/compose.ts \
//     --input <docx> [--input <docx> …] --out <dir> [--no-quotes] [--setting supra_linking=aggressive]
//     [--llm <module whose default export is an llm> --setting run_mode=high_accuracy|economy|ultra_economy]
// A2AJ answers come from the local store, then from the recorded answers in
// benchmarks/local-data/alr-verifier/a2aj-http-cache; new live lookups are off unless --a2aj-live <n>.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = path.resolve(import.meta.dirname, "../..");
const SUITE = path.join(REPO, "benchmarks/local-data/alr-verifier");
const config = JSON.parse(readFileSync(path.join(SUITE, "config.json"), "utf8")) as { alr_quote_verifier: string };
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const settings: Record<string, string> = Object.fromEntries(args.flatMap((value, index) =>
  value === "--setting" ? [args[index + 1].split(/=(.*)/su, 2)] : []));

// Record/replay every api.a2aj.ca answer; new lookups are capped.
const cacheDir = path.join(SUITE, "a2aj-http-cache");
let live = Number(option("--a2aj-live") ?? 0);
const undici = createRequire(path.join(REPO, "backend/package.json"))("undici") as { fetch: typeof fetch };
const realFetch = undici.fetch;
undici.fetch = (async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
  // --local-only: nothing off the computer, as the Python app's local-only run.
  if (args.includes("--local-only") && !/^https:\/\/api\.a2aj\.ca\//u.test(url)) throw new TypeError(`local only: ${url}`);
  if (!/^https:\/\/api\.a2aj\.ca\//u.test(url)) return realFetch(resource, init);
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

// Every --input in one process, as the page reads documents once it has loaded: one input writes to --out, several
// each to --out/<its name>.
void (async () => {
  const inputs = args.flatMap((value, index) => value === "--input" ? [args[index + 1]] : []), out = option("--out");
  if (!inputs.length || !out) throw new Error("Use --input <docx> [--input <docx> …] --out <dir>");
  const { createAuthoritiesOperations } = await import(pathToFileURL(
    path.join(config.alr_quote_verifier, "beaver_app/runtime/operations.ts")).href);
  const ops = createAuthoritiesOperations();
  for (const input of inputs) {
    try {
      await composeOne(ops, input, inputs.length > 1 ? path.join(out, path.parse(input).name) : out);
    } catch (error) {
      console.error(`${path.basename(input)}: ${error instanceof Error ? error.stack : error}`);
      process.exitCode = 1;
    }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

async function composeOne(ops: any, input: string, out: string) {
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
    const { alrModel } = await import(pathToFileURL(path.join(config.alr_quote_verifier, "beaver_app/runtime/ai.ts")).href);
    const { alrCheckedWorkbook } = await import(pathToFileURL(path.join(config.alr_quote_verifier, "beaver_app/runtime/checkedWorkbook.ts")).href);
    const run = alrModel(llm.default ?? llm, settings.run_mode, (message: string) => console.error(message));
    const made = await alrCheckedWorkbook(draft.import.filename, draft, check, options, run.model, signal);
    workbook = { filename: made.name, bytes: made.workbook };
    modelCalls = run.stats;
  } else {
    const written = await ops["alr-workbook"]({ draft, check, options }, { signal });
    workbook = written.files.find((item: { role: string }) => item.role === "workbook");
  }
  step("workbook");
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, workbook.filename), workbook.bytes);
  writeFileSync(path.join(out, workbook.filename.replace(/\.xlsx$/u, ".run.json")), JSON.stringify({
    document: file.filename, settings, seconds: (performance.now() - started) / 1000, steps, summary: check.counts, modelCalls }, null, 2));
  console.log(JSON.stringify({ document: file.filename, seconds: Math.round((performance.now() - started) / 100) / 10, counts: check.counts }));
}
