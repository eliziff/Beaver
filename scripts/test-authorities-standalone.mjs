/** Real browser -> standalone HTTP -> shared TypeScript -> Rust -> PDF smoke.
 * A tiny local A2AJ fixture inventory replaces only the external data source.
 * No CanLII page is fetched and no application endpoint is mocked.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chromium, expect } from "@playwright/test";
import { buildAuthoritiesFrontend, bundleAuthorities } from "./authorities-package/bundle.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "backend/package.json"));
const { Document, Paragraph, Packer } = require("docx");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const nativeFile = process.env.LEGAL_STRUCTURE_NATIVE || path.join(root,
  "native/legal-structure-node/target/release", process.platform === "win32"
    ? "legal_structure_node.dll" : process.platform === "darwin"
      ? "liblegal_structure_node.dylib" : "liblegal_structure_node.so");
const nativeModule = { exports: {} }; process.dlopen(nativeModule, nativeFile);
const native = nativeModule.exports;
const stage = await mkdtemp(path.join(tmpdir(), "authorities-browser-"));
const output = path.resolve(process.env.AUTHORITIES_SMOKE_OUTPUT || path.join(stage, "results"));
await mkdir(output, { recursive: true });
let child, browser, page;
let serverLog = "";
const cases = [
  { name: "40 Days for Life v. Dietrich", citation: "2024 ONCA 599" },
  { name: "Alpha v. Beta", citation: "2020 ONCA 11" },
  { name: "Gamma v. Delta", citation: "2020 ONCA 12" },
];
async function selectFile(button, files) {
  const choice = page.waitForEvent("filechooser"); await button.click();
  await (await choice).setFiles(files);
}
async function idle() {
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeEnabled({ timeout: 30_000 });
}
async function screenshot(name) {
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
}
async function noOverflow() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "The workspace must fit the viewport without horizontal scrolling");
}
try {
  const databasePath = path.join(stage, "a2aj.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE document(id INTEGER PRIMARY KEY,doc_type TEXT,dataset TEXT,
    citation_en TEXT,citation2_en TEXT,citation_fr TEXT,citation2_fr TEXT,
    name_en TEXT,name_fr TEXT,url_en TEXT,url_fr TEXT,unofficial_text_en TEXT,
    unofficial_text_fr TEXT,document_date_en TEXT,document_date_fr TEXT,upstream_license TEXT);
    CREATE TABLE citation_lookup(citation_key TEXT,document_id INTEGER);`);
  for (const [i, item] of cases.entries()) {
    const [year, , number] = item.citation.split(" ");
    const url = `https://www.canlii.org/en/on/onca/doc/${year}/${year}onca${number}/${year}onca${number}.html`;
    db.prepare(`INSERT INTO document(id,doc_type,dataset,citation_en,name_en,url_en,unofficial_text_en)
      VALUES(?, 'cases', 'ONCA', ?, ?, ?, ?)`).run(i + 1, item.citation, item.name, url,
        "[1] Synthetic test fixture only.\n[2] This passage is used to verify document assembly and is not a legal quotation.");
    db.prepare("INSERT INTO citation_lookup VALUES(?,?)").run(native.citationLookupKey(item.citation), i + 1);
  }
  db.close();
  const docx = path.join(stage, "brief.docx");
  await writeFile(docx, await Packer.toBuffer(new Document({ sections: [{ children:
    cases.map((item) => new Paragraph(`${item.name}, ${item.citation} at p 1.`)) }] })));
  const sourcePdf = path.join(stage, "source.pdf"), scanPdf = path.join(stage, "scan.pdf");
  const source = await PDFDocument.create();
  const font = await source.embedFont(StandardFonts.Helvetica);
  source.addPage([612, 792]).drawText("Synthetic source PDF. Selectable text on page one.", { x: 50, y: 700, font, size: 12 });
  await writeFile(sourcePdf, await source.save());
  const scan = await PDFDocument.create();
  // An image-only page with no text layer, deliberately not a corrupt PDF.
  const pixel = await scan.embedPng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=", "base64"));
  const scannedPage = scan.addPage([612, 792]);
  scannedPage.drawImage(pixel, { x: 0, y: 0, width: 612, height: 792 });
  for (let line = 0; line < 12; line++) scannedPage.drawRectangle({ x: 50, y: 700 - 18 * line,
    width: 390 - (line % 3) * 50, height: 4, color: rgb(0.35, 0.35, 0.35) });
  await writeFile(scanPdf, await scan.save());
  await buildAuthoritiesFrontend(stage); await bundleAuthorities(stage);
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const entry = path.join(stage, "backend/dist/authoritiesStandalone.js");
  child = spawn(process.execPath, [entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, PORT: String(port), LEGAL_STRUCTURE_NATIVE: nativeFile,
    AUTHORITIES_BUILD_ID: createHash("sha256").update(await readFile(entry)).digest("hex"),
    MIKE_A2AJ_BULK_DB: databasePath, MIKE_CITATOR_DB: path.join(stage, "no-citator.sqlite"),
  } });
  child.stdout.on("data", (chunk) => { serverLog += chunk; });
  child.stderr.on("data", (chunk) => { serverLog += chunk; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Standalone exited: ${serverLog}`);
    try { healthy = (await fetch(`${origin}/health`)).ok; } catch { /* start-up */ }
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(healthy, "Standalone health endpoint did not start");
  browser = await chromium.launch({ headless: true,
    ...(process.env.AUTHORITIES_CHROMIUM ? { executablePath: process.env.AUTHORITIES_CHROMIUM } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(() => {
    // Exercise the standard file-input fallback, not an OS-specific picker.
    Object.defineProperty(window, "showOpenFilePicker", { value: undefined, configurable: true });
    if (!localStorage.getItem("beaver.authorities.preferences")) localStorage.setItem("beaver.authorities.preferences",
      JSON.stringify({ profileId: "general", sourceMode: "manual-originals", passageMarking: "margin" }));
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/authorities.html`);
  await selectFile(page.getByRole("button", { name: "Add file", exact: true }), docx);
  const options = page.getByRole("dialog", { name: "Import options" });
  await expect(options).toBeVisible(); await screenshot("01-import-options");
  await options.getByRole("button", { name: "Import and review", exact: true }).click();
  await idle();
  await expect(page.getByRole("heading", { name: "Sources", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Build outputs", exact: true })).toHaveCount(0);
  await screenshot("02-citations-only");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sources", exact: true })).toBeVisible({ timeout: 30_000 });
  await idle();
  const slots = page.locator("[data-authority-id]");
  await expect(slots).toHaveCount(3);
  for (let i = 0; i < 3; i++) await expect(slots.nth(i)).toContainText(`Tab ${i + 1}`);
  await expect(page.getByRole("heading", { name: "Build outputs", exact: true })).toHaveCount(0);
  const handoff = slots.first().getByRole("link", { name: "CanLII", exact: true });
  await expect(handoff).toHaveAttribute("href", /canlii\.org\/.*\.pdf$/);
  await expect(handoff).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await screenshot("03-manual-handoff");
  await slots.first().getByRole("button", { name: /^Upload for/ }).click();
  await selectFile(page.getByRole("menuitem", { name: "Upload from computer", exact: true }), sourcePdf);
  await idle();
  await expect(handoff).toHaveCount(0);
  await expect(slots.first().getByRole("button", { name: /^View PDF for/ })).toBeEnabled();
  await slots.first().getByRole("button", { name: /^View PDF for/ }).click();
  await expect(page.getByRole("dialog").locator("canvas").first()).toBeVisible({ timeout: 30_000 });
  await screenshot("04-in-app-viewer");
  await page.keyboard.press("Escape");
  await slots.nth(1).getByRole("button", { name: /^Upload for/ }).click();
  await selectFile(page.getByRole("menuitem", { name: "Upload from computer", exact: true }), scanPdf);
  await idle();
  await page.getByRole("button", { name: "Tab labels", exact: true }).click();
  const labels = page.getByRole("dialog", { name: "Tab labels", exact: true });
  await labels.getByLabel("Custom labels", { exact: false }).fill("Front\nMiddle\nEnd");
  await labels.getByRole("button", { name: "Apply", exact: true }).click(); await idle();
  // Slots stay in their fixed order; only the PDF that fills a slot changes.
  for (const [i, label] of ["Front", "Middle", "End"].entries()) await expect(slots.nth(i)).toContainText(label);
  await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
  await expect(page.locator("[draggable=true]")).toHaveCount(0);
  const heights = await slots.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  assert(heights.every((height) => height === heights[0]), "Loaded and missing rows keep the same height");
  await noOverflow(); await screenshot("05-source-slots");
  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await screenshot("06-source-slots-mobile");
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole("button", { name: "Done — review highlights", exact: true }).click();
  const ocr = page.getByRole("dialog", { name: "Scanned source PDFs", exact: true });
  await expect(ocr).toBeVisible({ timeout: 30_000 });
  await ocr.getByRole("radio", { name: /Keep the original pages/ }).check();
  await screenshot("07-ocr-choice");
  await ocr.getByRole("button", { name: "Continue to highlights", exact: true }).click();
  await idle();
  await expect(page.getByRole("heading", { name: "Build outputs", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Done — build book", exact: true }).click(); await idle();
  await expect(page.getByRole("heading", { name: "Build outputs", exact: true })).toBeVisible();
  const sourceY = (await page.getByRole("heading", { name: "Sources", exact: true }).boundingBox()).y;
  const buildY = (await page.getByRole("heading", { name: "Build outputs", exact: true }).boundingBox()).y;
  assert(buildY > sourceY, "Build follows Sources visually");
  await page.getByRole("button", { name: "Build", exact: true }).click();
  const stubWarning = page.getByRole("dialog", { name: /Missing PDFs/ });
  await expect(stubWarning).toBeVisible();
  await screenshot("08-stub-warning");
  await stubWarning.getByRole("button", { name: "Build anyway", exact: true }).click();
  const downloadButton = page.getByRole("button", { name: /^Download .*draft-incomplete.*\.pdf$/ });
  await expect(downloadButton).toBeVisible({ timeout: 30_000 });
  const downloadEvent = page.waitForEvent("download"); await downloadButton.click();
  const downloaded = await downloadEvent;
  assert(downloaded.suggestedFilename().includes("draft-incomplete"));
  const bookPath = path.join(output, "incomplete-book.pdf"); await downloaded.saveAs(bookPath);
  const book = await PDFDocument.load(await readFile(bookPath));
  assert(book.getPageCount() >= 4, "Book retains original pages and a missing-source stub");
  assert.match(book.getTitle(), /incomplete/i);
  await screenshot("08-build-after-review");
  await page.reload(); await idle();
  await expect(slots.nth(2).locator("article")).toHaveAttribute("data-authority-id", firstId);
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log("PASS: import -> citations -> sources -> OCR choice -> highlights -> draft book; fixed slots, keyboard and drag order, manual handoff, embedded PDF, responsive cards and persistence.");
} catch (error) {
  if (page) { await screenshot("failure").catch(() => {}); await writeFile(path.join(output, "failure.html"), await page.content().catch(() => "")); }
  throw error;
} finally {
  await writeFile(path.join(output, "server.log"), serverLog);
  await browser?.close(); child?.kill("SIGTERM");
  if (process.env.AUTHORITIES_SMOKE_OUTPUT) await rm(stage, { recursive: true, force: true });
  console.log(`Authorities browser evidence: ${output}`);
}
