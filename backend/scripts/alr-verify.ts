// Headless ALR Quote Verifier: .docx files in, "[CHECKED] <stem>.xlsx" workbooks out.
//   tsx scripts/alr-verify.ts --input <docx|folder> --out <dir> --mode <run_mode>
//     [--llm <module exporting a default AlrLlmClient>] [--a2aj-live <n>] [--setting key=value ...]
// A2AJ answers are recorded once and replayed from benchmarks/local-data/alr-verifier/a2aj-http-cache;
// --a2aj-live caps how many new lookups may go to api.a2aj.ca (default 0).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAlrVerifierOperations } from "../src/lib/alrVerifier/operations";
import type { AlrLlmClient } from "../src/lib/alrVerifier/llm";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const input = option("--input"), out = option("--out");
if (!input || !out) throw new Error("Use --input <docx|folder> --out <dir> [--mode free] [--llm module] [--a2aj-live n]");
const settings: Record<string, unknown> = { run_mode: option("--mode") ?? "free" };
args.forEach((value, index) => {
  if (value !== "--setting") return;
  const [key, raw] = args[index + 1].split(/=(.*)/su);
  settings[key] = raw === "true" ? true : raw === "false" ? false : /^\d+$/u.test(raw) ? Number(raw) : raw;
});

// Record/replay every api.a2aj.ca answer; new lookups are capped.
const cacheDir = path.resolve(__dirname, "../../benchmarks/local-data/alr-verifier/a2aj-http-cache");
let live = Number(option("--a2aj-live") ?? 0), liveUsed = 0, replayed = 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const undici = require("undici") as { fetch: typeof fetch };
const realFetch = undici.fetch;
undici.fetch = (async (resource: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof resource === "string" ? resource : resource instanceof URL ? resource.toString() : resource.url;
  if (!/^https:\/\/api\.a2aj\.ca\//u.test(url)) return realFetch(resource, init);
  const method = (init?.method ?? "GET").toUpperCase(), file = path.join(cacheDir,
    `${createHash("sha256").update(`${method} ${url}`).digest("hex")}.json`);
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { status: number; headers: Record<string, string>; body: string };
    replayed++;
    return new Response(method === "HEAD" ? null : saved.body, { status: saved.status, headers: saved.headers });
  }
  if (live <= 0) throw new TypeError(`A2AJ lookup not recorded and live lookups are off: ${url}`);
  live--; liveUsed++;
  const response = await realFetch(resource, init);
  const body = method === "HEAD" ? "" : await response.text();
  console.error(`A2AJ live ${method} ${response.status} ${url}`);
  if (response.status !== 429 && response.status < 500) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ url, status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" }, body }));
  }
  return new Response(method === "HEAD" ? null : body, { status: response.status, headers: response.headers });
}) as typeof fetch;

void (async () => {
  const llmModule = option("--llm");
  const llm = llmModule ? (await import(pathToFileURL(path.resolve(llmModule)).href)).default as AlrLlmClient : undefined;
  const files = statSync(input).isDirectory()
    ? readdirSync(input).filter((name) => /\.docx$/iu.test(name) && !name.startsWith("~$")).map((name) => path.join(input, name))
    : [input];
  mkdirSync(out, { recursive: true });
  const operations = createAlrVerifierOperations();
  for (const file of files) {
    const started = performance.now();
    const { documents: [result] } = await operations.run({ documents: [{ name: path.basename(file), bytes: readFileSync(file) }],
      settings, llm }, (event) => { if (event.done === event.total && event.phase) process.stderr.write(`${event.document}: ${event.phase} ${event.done ?? ""}/${event.total ?? ""}\n`); });
    writeFileSync(path.join(out, result.workbookName), result.workbook);
    if (result.sidecar) writeFileSync(path.join(out, result.sidecarName), JSON.stringify(result.sidecar, null, 2));
    writeFileSync(path.join(out, `${result.workbookName.replace(/\.xlsx$/u, "")}.run.json`), JSON.stringify({
      document: result.name, settings, seconds: (performance.now() - started) / 1000, summary: result.summary,
      missingSources: result.missingSources, usage: result.usage, modelCalls: result.modelCalls,
      sourceFailures: result.sourceFailures }, null, 2));
    console.log(JSON.stringify({ document: result.name, seconds: Math.round((performance.now() - started) / 100) / 10,
      ...result.summary, missingSources: result.missingSources.length, modelCalls: result.modelCalls }));
  }
  console.error(`A2AJ: ${replayed} replayed, ${liveUsed} live`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
