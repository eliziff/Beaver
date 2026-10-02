// Realistic stress proof of the standalone Authorities.html: real public documents and invented
// ones, every court preset and output setting, long briefs, many authorities, a book of nearly
// 900 pages, scans read at once, edits while sources gather, reloads mid-work and repeated builds.
// Each case drives the built page headless in a fresh profile (from file://, and over http where the
// difference matters), fails on jank (input-to-paint, long tasks, layout shifts, blank or
// flickering frames), screenshots every screen at 1440×900 and 1280×720 and judges it, and opens
// what it delivers as its reader would: PDFs read back and rendered, each .docx in invisible Word.
//
//   node scripts/test-authorities-stress.mjs [--skip-build] [--html=path] [--out=dir] [--only=a,b]
//     [--fixtures=dir] [--no-word] [--keep-outputs] [--headed] [--list]
// No request reaches a live service: A2AJ and the publisher service answer from the stub or a
// recorded HAR. Cases whose local fixture (a gitignored folder, --fixtures, default
// .tmp/authorities-stress-fixtures) is absent are skipped and say so.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { writeFixtures } from "./authorities-html-e2e/fixtures.mjs";
import { writeStressFixtures } from "./authorities-stress/fixtures.mjs";
import { CaseRecord, openApp } from "./authorities-stress/harness.mjs";
import { openInWord, pdfRenderer } from "./authorities-stress/outputs.mjs";
import { CASES } from "./authorities-stress/cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/u, "").split("="); return [key, value ?? true];
}));
if (args.list) { for (const item of CASES) console.log(`${item.name.padEnd(22)} ${item.title}`); process.exit(0); }
const html = path.resolve(args.html ?? path.join(root, "AuthoritiesHelper/modern/out/Authorities.html"));
const out = path.resolve(args.out ?? path.join(root, ".tmp/authorities-stress"));
const localDir = path.resolve(args.fixtures ?? path.join(root, ".tmp/authorities-stress-fixtures"));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const selected = CASES.filter(({ name }) => !only || only.has(name));
if (only && selected.length !== only.size) throw new Error(`Unknown case: ${[...only].filter((name) => !CASES.some((item) => item.name === name)).join(", ")}`);

if (!args["skip-build"] && !args.html) {
  console.log("Building Authorities.html");
  execFileSync(process.execPath, [path.join(root, "AuthoritiesHelper/modern/html/build.mjs"), html], { stdio: "inherit" });
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const started = Date.now();
const browser = await chromium.launch({ headless: !args.headed });

/** The page over http on a free local port, for the cases that run there. */
async function serve(file) {
  const page = await readFile(file);
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}
/** Word's running processes, by id. */
const wordProcesses = () => execFileSync("tasklist", ["/FI", "IMAGENAME eq WINWORD.EXE", "/FO", "CSV", "/NH"], { encoding: "utf8" })
  .split(/\r?\n/u).flatMap((line) => /^"WINWORD\.EXE","(\d+)"/iu.exec(line)?.[1] ?? []).map(Number);
/** Local fixtures that are never committed: a public article with the HAR of its lookups. */
function localFixtures() {
  const article = { pdf: path.join(localDir, "long-article/article.pdf"), har: path.join(localDir, "long-article/lookups.har") };
  return { article: existsSync(article.pdf) && existsSync(article.har) ? article : null };
}

const fixtureDir = path.join(out, "fixtures");
const fixtures = { ...await writeFixtures(browser, fixtureDir), ...await writeStressFixtures(browser, fixtureDir) };
const renderer = await pdfRenderer(browser), word = [], records = [];
const ctx = { browser, html, serve, fixtures, local: localFixtures(), renderer, word, args, root };
// Windows checks a newly written file the first time a browser reads it; that first open is not a case's.
{ const page = await browser.newPage(); await page.goto(`file:///${html.replace(/\\/gu, "/")}`); await page.close(); }

for (const item of selected) {
  console.log(`\n== ${item.name}: ${item.title} ==`);
  const record = new CaseRecord(item.name, path.join(out, item.name));
  await mkdir(record.out, { recursive: true });
  records.push(record);
  const missing = (item.needs ?? []).filter((need) => !ctx.local[need]);
  if (missing.length) { record.skipped = `local fixture absent: ${missing.join(", ")} (see ${localDir})`; console.log(`  SKIPPED ${record.skipped}`); continue; }
  const from = Date.now();
  // Each case opens fresh profiles through `open`, closed whatever happens.
  const apps = [], open = async (options = {}) => { const app = await openApp(record, { browser, html, serve, ...options }); apps.push(app); return app; };
  try { await item.run({ ...ctx, record, open }); }
  catch (error) {
    record.check(false, "the case stopped", error.stack?.split("\n").slice(0, 8).join("\n"));
    // What the page showed when it stopped.
    for (const app of apps) await app.page.screenshot({ path: path.join(record.out, `stopped-${app.label}.png`) }).catch(() => {});
  }
  finally { await Promise.all(apps.map(async (app) => { await app.context.close().catch(() => {}); await app.server?.close(); })); }
  record.seconds = Math.round((Date.now() - from) / 100) / 10;
  console.log(`  ${record.failures.length ? `${record.failures.length} failed` : "passed"} in ${record.seconds} s`);
}

// Every Word document delivered, opened at once in invisible Word, as its reader would.
if (word.length && !args["no-word"]) {
  console.log(`\n== Word: opening ${word.length} documents ==`);
  const from = Date.now();
  for (const { record } of word) await mkdir(path.join(record.out, "word"), { recursive: true });
  const named = (index) => `${String(index + 1).padStart(2, "0")}-${path.basename(word[index].file, ".docx")}`;
  const before = wordProcesses();
  const results = await openInWord(word.map(({ file, record }, index) => ({ file, pdf: path.join(record.out, "word", `${named(index)}.pdf`) })), out);
  const left = wordProcesses().filter((pid) => !before.includes(pid));
  word[0].record.check(!left.length, "Word was left running", left);
  for (const [index, result] of results.entries()) {
    const { record, file, expect } = word[index], where = `Word ${path.relative(record.out, file)}`;
    record.check(result.opened && !result.error, `${where}: opens in Word without repair`, result.error);
    if (!result.opened) continue;
    record.check(!result.errors?.length, `${where}: no field shows an error`, result.errors);
    if (expect.ta !== undefined) record.check(expect.ta ? result.taFields >= expect.ta : !result.taFields, `${where}: ${expect.ta || "no"} citation fields`, result.taFields);
    if (expect.toa !== undefined) record.check(expect.toa ? result.toaFields > 0 && /\S/u.test(result.toaText) : !result.toaFields,
      `${where}: ${expect.toa ? "its table shows as opened" : "no table"}`, { toaFields: result.toaFields, toaText: result.toaText?.slice(0, 200) });
    if (expect.toaHas) for (const name of expect.toaHas) record.check(result.toaText?.includes(name), `${where}: the table lists ${name}`, result.toaText?.slice(0, 300));
    // A table of authorities delivered as its own document is the document's text.
    if (expect.lists) for (const name of expect.lists) record.check(result.text?.includes(name), `${where}: the table lists ${name}`, result.text?.slice(0, 300));
    if (expect.tabs !== undefined) record.check(expect.tabs ? result.tabReferences >= expect.tabs : !result.tabReferences,
      `${where}: ${expect.tabs || "no"} tab references`, result.tabReferences);
    if (expect.text) record.check(expect.text.test(result.text), `${where}: reads ${expect.text}`, result.text?.slice(0, 300));
    record.outputs.push({ file: path.relative(record.out, file), word: { pages: result.pages, ta: result.taFields, toa: result.toaFields,
      tabReferences: result.tabReferences, table: result.toaText?.slice(0, 160) } });
    if (result.pdf && existsSync(result.pdf))
      await renderer.sheet(result.pdf, path.join(record.out, "word", `${named(index)}.jpg`), { first: 2, last: 4 });
    else if (!result.updatesFieldsAtPrint) record.check(false, `${where}: exported as Word lays it out`);
  }
  console.log(`  opened in ${Math.round((Date.now() - from) / 1000)} s`);
}
await renderer.close();
await browser.close();
// What was delivered has been read back and rendered; the books and documents themselves go, so a
// run keeps its report, screenshots and page sheets only (--keep-outputs keeps them all).
if (!args["keep-outputs"]) for (const { out: dir } of records) {
  await rm(path.join(dir, "downloads"), { recursive: true, force: true });
  for (const file of await readdir(path.join(dir, "word")).catch(() => []))
    if (!file.endsWith(".jpg")) await rm(path.join(dir, "word", file), { force: true });
}

const seconds = Math.round((Date.now() - started) / 1000);
const report = { html, seconds, cases: records.map(({ name, seconds, skipped, failures, notes, outputs, judged }) =>
  ({ name, seconds, skipped, passed: !skipped && !failures.length, failures, notes, outputs,
    screenshots: judged.map(({ shot, issues }) => ({ shot, issues })) })) };
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(`\n${"case".padEnd(22)} ${"result".padEnd(9)} seconds`);
for (const { name, seconds, skipped, failures } of records)
  console.log(`${name.padEnd(22)} ${(skipped ? "skipped" : failures.length ? `${failures.length} FAIL` : "pass").padEnd(9)} ${seconds ?? "-"}`);
console.log(`\nWhole run: ${Math.floor(seconds / 60)} min ${seconds % 60} s. Report: ${path.join(out, "report.json")}`);
const failed = records.filter(({ failures }) => failures.length);
if (failed.length) {
  console.error(`\n${failed.length} case(s) failed:`);
  for (const { name, failures } of failed) console.error(`- ${name}:\n    ${failures.slice(0, 12).join("\n    ")}`);
  process.exitCode = 1;
} else console.log("\nAll cases passed.");
// A case that stopped early can leave a page's work pending; the run is over either way.
process.exit();
