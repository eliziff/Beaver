// End-to-end proof of the standalone Authorities.html: builds it, then drives it in Chromium
// from file:// and over http with invented inputs (scripts/authorities-html-e2e/fixtures.mjs)
// and a stubbed A2AJ, so the default run needs no network. It imports a PDF and a Word brief,
// edits the citations, provides and recognizes sources, highlights, builds every output and
// reads the downloads back, asserting performance budgets and layout invariants throughout.
//
//   npm run test:authorities-html-e2e -- [--skip-build] [--mode=file|http] [--only=pdf|docx|first] [--headed] [--live]
//     [--html=path] [--out=dir] [--slow-a2aj=ms]
// --live lets A2AJ and publishers answer for real instead of the stub (not deterministic); a lookup
// reported unchecked then fails the run unless A2AJ, asked once directly, is not answering either.
// --slow-a2aj makes the stub answer that many ms late, as the live service can, so sources are still
// being gathered while the review edits and moves on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { A2AJ_CASES, a2ajRecord, BRIEF, writeFixtures } from "./authorities-html-e2e/fixtures.mjs";
import { instrument } from "./authorities-html-e2e/instrument.mjs";
import { flatOutline, readDocx, readPdf } from "./authorities-html-e2e/outputs.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/u, "").split("="); return [key, value ?? true];
}));
const html = path.resolve(args.html ?? path.join(root, "AuthoritiesHelper/modern/out/Authorities.html"));
const out = path.resolve(args.out ?? path.join(root, ".tmp/authorities-html-e2e"));
const modes = args.mode ? [args.mode] : ["file", "http"];

/** Budgets in milliseconds, each set from measured runs (shown after it, on a laptop CPU)
 *  with modest headroom. Interactions are timed in the page with Event Timing and rAF. */
export const BUDGETS = {
  coldLoad: 1200,     // navigation start to an enabled "Add file"; 470–860
  importPdf: 3000,    // "Import and review" to the citations marked in the PDF; 1400–2430
  importDocx: 1500,   // the same for the Word brief; 130–920 (920 when it is the first import)
  firstImport: 5000,  // either brief as a new profile's first import, nothing warmed; 1390–4660
  inputToPaint: 50,   // every key, click or drag in the review, to the frame that shows it; max 24–40
  longTask: 50,       // no main-thread task longer than this while reviewing; none seen
  stepSwitch: 300,    // a step tab or Next to the step's content; 60–150
  ocr: 6000,          // one scanned page recognized; 2800–4300
  build: 2500,        // Build to current outputs, for the fixture book; 250–1740
};
const failures = [];
/** A failed check is recorded with its context, and the run goes on to find the others. */
function check(condition, message, detail) {
  if (condition) return true;
  failures.push(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
  console.error(`  FAIL ${message}${detail === undefined ? "" : ` ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400)}`}`);
  return false;
}
const metrics = {};
const note = (mode, key, value) => { (metrics[mode] ??= {})[key] = value; console.log(`  ${mode} ${key}: ${typeof value === "number" ? `${Math.round(value)} ms` : JSON.stringify(value)}`); };

if (!args["skip-build"] && !args.html) {
  console.log("Building Authorities.html");
  execFileSync(process.execPath, [path.join(root, "AuthoritiesHelper/modern/html/build.mjs"), html], { stdio: "inherit" });
}
await rm(out, { recursive: true, force: true });
const browser = await chromium.launch({ headless: !args.headed });
const fixtures = await writeFixtures(browser, path.join(out, "fixtures"));
// Windows checks a newly written file the first time a browser reads it (about 5 s for this page,
// once per build). That first open is reported; the budget is for every open after it.
{
  const page = await browser.newPage(), started = performance.now();
  await page.goto(pathToFileURL(html).href); await page.getByRole("button", { name: "Add file" }).waitFor();
  note("build", "firstOpen", performance.now() - started); await page.close();
}

/** The stubbed A2AJ: the three SCC cases answer with placeholder text; anything else is unknown. */
async function routeNetwork(context, requests) {
  await context.route(/^https?:\/\//u, async (route) => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
    requests.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    if (args.live) return route.continue();
    if (url.hostname !== "api.a2aj.ca") return route.abort("blockedbyclient");
    const citation = url.searchParams.get("citation"), cases = url.searchParams.get("doc_type") === "cases";
    const hit = cases && url.pathname === "/fetch" && A2AJ_CASES.find((item) => [item.citation, item.alternate].includes(citation));
    if (args["slow-a2aj"]) await new Promise((resolve) => setTimeout(resolve, Number(args["slow-a2aj"])));
    return route.fulfill({ json: { results: hit ? [a2ajRecord(hit)] : [] } });
  });
}

async function serve(file) {
  const page = await readFile(file);
  const server = createServer((request, response) => {
    if (new URL(request.url, "http://localhost").pathname !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

for (const mode of args.only === "first" ? [] : modes) {
  console.log(`\n== ${mode} ==`);
  const server = mode === "http" ? await serve(html) : null;
  const url = server?.url ?? pathToFileURL(html).href;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const requests = [];
  await routeNetwork(context, requests);
  await context.addInitScript(instrument);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Leptonica, inside the bundled OCR engine, prints its own diagnostics to the console as errors.
  page.on("console", (message) => { if (message.type() === "error" && !/^Error in (?:pix|bmf)\w+:/u.test(message.text())) errors.push(message.text()); });
  const run = new Run(page, mode);
  try {
    await run.coldLoad(url);
    if (args.only !== "docx") await run.pdfBrief();
    if (args.only !== "pdf") await run.docxBrief();
  } catch (error) {
    check(false, `${mode}: the workflow stopped`, error.stack?.split("\n").slice(0, 6).join("\n"));
    await page.screenshot({ path: path.join(out, "screenshots", `${mode}-stopped.png`) }).catch(() => {});
  } finally {
    note(mode, "interactions", run.summary());
    check(!errors.length, `${mode}: the page reported errors`, errors.slice(0, 10));
    const unexpected = requests.filter((request) => !request.includes("https://api.a2aj.ca/"));
    check(args.live || !unexpected.length, `${mode}: requests left the page other than to A2AJ`, unexpected);
    note(mode, "network", { a2aj: requests.length - unexpected.length, other: unexpected.length });
    await context.close(); await server?.close();
  }
}
// A brief of either kind as the first thing a brand-new profile does: no stored drafts, no warmed engine.
for (const mode of !args.only || args.only === "first" ? modes : []) for (const kind of ["docx", "pdf"]) {
  console.log(`\n== ${mode}, ${kind} first in a new profile ==`);
  const server = mode === "http" ? await serve(html) : null;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), requests = [], errors = [];
  await routeNetwork(context, requests);
  await context.addInitScript(instrument);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/^Error in (?:pix|bmf)\w+:/u.test(message.text())) errors.push(message.text()); });
  try { const run = new Run(page, mode); await run.coldLoad(server?.url ?? pathToFileURL(html).href); await run.firstImport(kind); }
  catch (error) {
    check(false, `${mode}: ${kind} as the first import stopped`, error.stack?.split("\n").slice(0, 6).join("\n"));
    await page.screenshot({ path: path.join(out, "screenshots", `${mode}-${kind}-first-stopped.png`) }).catch(() => {});
  } finally {
    check(!errors.length, `${mode}: ${kind} as the first import reported errors`, errors.slice(0, 10));
    await context.close(); await server?.close();
  }
}
if (!args.live && modes.includes("file") && !args.only) {
  console.log("\n== file, A2AJ limiting requests ==");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), requests = [];
  await context.route(/^https?:\/\//u, (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== "api.a2aj.ca") return route.abort("blockedbyclient");
    requests.push(`${request.method()} ${url.pathname}${url.search}`);
    // The lookup fails as the CORS-less 429 makes it fail; the opaque request gets the 429.
    return request.method() === "HEAD" ? route.fulfill({ status: 429 }) : route.abort("failed");
  });
  await context.addInitScript(instrument);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  try { await new Run(page, "file").limitedLookups(pathToFileURL(html).href, requests); }
  catch (error) { check(false, "file: the limited-lookups run stopped", error.stack?.split("\n").slice(0, 6).join("\n")); }
  finally { await context.close(); }
}
await browser.close();
await writeFile(path.join(out, "report.json"), JSON.stringify({ budgets: BUDGETS, metrics, failures }, null, 2));
console.log(`\nReport: ${path.join(out, "report.json")}\nScreenshots: ${path.join(out, "screenshots")}`);
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else console.log("\nAll checks passed.");

/** One browser session's walk through the workflow. */
function Run(page, mode) {
  const shotNames = new Set();
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const now = () => page.evaluate(() => window.__e2e.now());
  const idle = async () => {
    // Saving edits and background work report through the status line; wait for it to rest.
    await page.waitForFunction(() => !document.querySelector("[role=status][aria-busy=true]"), null, { timeout: 30000 });
    await settle();
  };
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });

  // The test's own window resizes move everything; shifts while it resizes are not the page's.
  const resized = [];
  const resizing = async (work) => { const from = await now(); await work(); resized.push([from, await now() + 50]); };
  const ownShifts = (shifts) => shifts.filter(({ start }) => !resized.some(([from, to]) => start >= from && start <= to));
  /** Full-window screenshots at both review sizes, then back to 1440×900. */
  const shots = (name) => resizing(() => takeShots(name));
  async function takeShots(name) {
    assert(!shotNames.has(name), `duplicate screenshot ${name}`); shotNames.add(name);
    for (const [width, height] of [[1440, 900], [1280, 720]]) {
      await page.setViewportSize({ width, height }); await settle();
      await page.screenshot({ path: path.join(out, "screenshots", `${mode}-${name}-${width}x${height}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
  }
  /** No horizontal scroll at any width the page supports. */
  const noHorizontalScroll = (label) => resizing(() => checkWidths(label));
  async function checkWidths(label) {
    for (const width of [1440, 1280, 1024, 768, 480]) {
      await page.setViewportSize({ width, height: 900 }); await settle();
      const overflow = await page.evaluate(() => {
        const scrolling = document.scrollingElement, wide = scrolling.scrollWidth - scrolling.clientWidth;
        const clipped = [...document.querySelectorAll("main *")].filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width && box.right > document.documentElement.clientWidth + 1 && getComputedStyle(element).position !== "fixed";
        }).slice(0, 3).map((element) => `${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join(".")}`);
        return { wide, clipped };
      });
      check(overflow.wide <= 0 && !overflow.clipped.length, `${mode} ${label}: horizontal overflow at ${width}px`, overflow);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
  }
  /** Each row's tab label (its first cell) shows whole inside its row and list, in one column shared by every row. */
  const tabColumn = (label, rows) => resizing(async () => {
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 }); await settle();
      const cells = await rows.evaluateAll((rows) => rows.map((row) => {
        const cell = row.firstElementChild, text = document.createRange(), box = cell.getBoundingClientRect();
        text.selectNodeContents(cell);
        const right = Math.max(box.right, ...[...text.getClientRects()].map((rect) => rect.right));
        return { label: cell.innerText, column: `${Math.round(box.left)}+${Math.round(box.width)}`, past: Math.max(cell.scrollWidth - cell.clientWidth,
          right - row.getBoundingClientRect().right, right - row.parentElement.getBoundingClientRect().right) };
      }));
      check(cells.length && cells.every(({ past }) => past <= 0) && new Set(cells.map(({ column }) => column)).size === 1,
        `${mode} ${label}: tab labels sit whole in one column inside their rows at ${width}px`, cells);
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await settle();
  });
  const bookRows = () => page.getByRole("heading", { name: "Cover, index and other PDFs" }).locator("xpath=..").locator(":scope > .divide-y > div");
  /** Runs `action` and returns what the page measured meanwhile, once its effects have painted. */
  async function measure(label, action, { rest = 250, listChanges = false } = {}) {
    const from = await now();
    await action();
    await settle(); await page.waitForTimeout(rest); await idle();
    const to = await now();
    const seen = await page.evaluate(([from, to]) => window.__e2e.window(from, to), [from, to]);
    const input = seen.events.filter(({ name }) => /^(?:key|pointer|click|mouse)/u.test(name));
    // An edit that adds or removes a citation moves the list rows after it; nothing else may move.
    const shifts = ownShifts(seen.shifts).filter(({ sources }) => !listChanges || sources.some(({ list }) => !list));
    return { label, inputToPaint: Math.max(0, ...input.map(({ duration }) => duration)),
      longTasks: seen.longTasks.map(({ duration }) => Math.round(duration)), shift: shifts.reduce((sum, { value }) => sum + value, 0),
      shiftSources: [...new Set(shifts.flatMap(({ sources }) => sources.map(({ node, moved }) => `${node} ${moved}`)))] };
  }
  const interactions = [];
  this.summary = () => {
    const worst = interactions.reduce((top, item) => item.inputToPaint > (top?.inputToPaint ?? -1) ? item : top, undefined);
    return { count: interactions.length, maxInputToPaint: worst?.inputToPaint, slowest: worst?.label,
      longTasks: interactions.flatMap(({ label, longTasks = [] }) => longTasks.map((duration) => `${label}: ${duration}`)),
      shifts: interactions.filter(({ shift }) => shift > 0).map(({ label, shift }) => `${label}: ${shift.toFixed(4)}`) };
  };
  /** An interaction in the review: painted within the input budget, no long task, no shift. */
  async function interact(label, action, options) {
    const result = await measure(label, action, options);
    interactions.push(result);
    check(result.inputToPaint < BUDGETS.inputToPaint, `${mode} ${label}: input-to-paint ${result.inputToPaint} ms`);
    check(!result.longTasks.some((duration) => duration > BUDGETS.longTask), `${mode} ${label}: long tasks`, result.longTasks);
    check(result.shift === 0, `${mode} ${label}: layout shift ${result.shift.toFixed(4)}`, result.shiftSources);
    return result;
  }
  /** Answers the page's file picker with `files`. */
  async function pick(trigger, files) {
    if (mode === "file") {
      const chooser = page.waitForEvent("filechooser");
      chooser.catch(() => {});
      await trigger();
      await (await chooser).setFiles(files);
      return;
    }
    const staged = await Promise.all(files.map(async (file) => ({ name: path.basename(file), base64: (await readFile(file)).toString("base64") })));
    await page.evaluate((staged) => { window.__e2ePick = staged; }, staged);
    await trigger();
  }
  /** Boxes that must not move: the header, the step row and, in the review, its bottom bar. */
  const frame = () => page.evaluate(() => Object.fromEntries([["header", "header[data-workspace-header]"],
    ["steps", "[data-tabs-rail]:has(> [role=tablist][aria-label='Book steps'])"], ["bar", ".citation-panel"]].map(([key, selector]) => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return [key, box ? [box.x, box.y, box.width, box.height].map(Math.round).join(",") : null];
  })));
  /** Selects a phrase in the review's document with the pointer, as a reader would. */
  async function dragSelect(phrase, nth) {
    const { first, last } = await page.evaluate(([phrase, nth]) => window.__e2e.ends(phrase, nth), [phrase, nth]);
    await page.mouse.move(first.left + 0.5, (first.top + first.bottom) / 2);
    await page.mouse.down();
    await page.mouse.move(last.right - 0.5, (last.top + last.bottom) / 2, { steps: 4 });
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection().toString().replace(/\s+/gu, " ").trim());
    check(selected === phrase, `${mode}: the pointer selects "${phrase}"`, selected);
  }
  /** Selects a phrase that starts or ends at a citation's edge, where a pointer would take the
   *  edge's handle instead: the review keeps focus, as a pointer down in the document leaves it. */
  async function selectAtEdge(phrase) {
    await page.locator(".citation-review").evaluate((review) => review.focus({ preventScroll: true }));
    await page.evaluate((phrase) => window.__e2e.select(phrase), phrase);
  }
  const rows = () => page.locator(".citation-outline [role=option]").allInnerTexts();
  const selectedRow = () => page.locator(".citation-outline [role=option][aria-selected=true]").innerText();
  const accessPrompts = () => page.getByRole("button", { name: "Allow file access" }).or(page.getByRole("button", { name: "Allow access" })).count();

  this.coldLoad = async (url) => {
    await page.goto(url);
    await page.getByRole("button", { name: "Add file" }).waitFor();
    await page.waitForFunction(() => !document.querySelector("button:disabled[aria-label='Add file'], [aria-busy=true]"));
    const interactive = await now();
    note(mode, "coldLoad", interactive);
    check(interactive < BUDGETS.coldLoad, `${mode}: cold load to interactive ${Math.round(interactive)} ms`);
    await shots("01-start");
    await noHorizontalScroll("start");
  };

  /** Import: the court, the source handling and the passage marking, so marks are prepared as the
   *  sources arrive; then the review. The outputs are chosen at Build. */
  async function importBrief(file, label) {
    await pick(() => button("Add file").click(), [file]);
    const setup = page.getByRole("dialog", { name: "Import options" });
    await setup.waitFor();
    check(await setup.getByRole("group").evaluateAll((groups) => groups.map((group) => group.querySelector("legend")?.textContent)
      .filter(Boolean).join()) === "Source handling,Passage marking" && !await button("Next", setup).count(),
    `${mode} ${label}: the import asks the court, the source handling and the passage marking`);
    await shots(`${label}-02-import-options`);
    const started = await now();
    await button("Import and review").click();
    await page.locator(".citation-document .citation-band").first().waitFor({ timeout: 60000 });
    await page.locator(".citation-document .citation-band[data-active]").first().waitFor();
    const imported = await now() - started;
    note(mode, `import-${label}`, imported);
    const budget = label.endsWith("-first") ? BUDGETS.firstImport : label === "pdf" ? BUDGETS.importPdf : BUDGETS.importDocx;
    check(imported < budget, `${mode}: ${label} import ${Math.round(imported)} ms`);
  }

  const EXPECTED_ROWS = ["Canada (Minister of Citizenship and Immigration) v Vavilov, 2019 SCC 65 at para 10",
    "Ibid at paras 99-101", "R v Oakes, [1986] 1 SCR 103 at 138-139", "Ibid at 140",
    "Waterways Licensing Act, SA 2031, c W-4, s 12", "R v Jordan, 2016 SCC 27 at paras 46-48", "supra note 2 at 135",
    "Lakeshore Rowing Club v Marsh Harbour Board, 2030 ABKB 417 at para 22"];
  async function chooseRow(text) {
    await page.locator(".citation-outline [role=option]", { hasText: text }).first().click();
    await page.waitForFunction((text) => document.querySelector(".citation-outline [role=option][aria-selected=true]")?.textContent.includes(text), text);
  }
  /** The pinpoint chips as the bar shows them, each its kind's symbol and value: "¶10 p.12". */
  const pinpoint = () => page.locator(".citation-pins .citation-chip").allInnerTexts()
    .then((chips) => chips.map((chip) => chip.replace(/\s+/gu, "")).join(" "));
  /** Only the selected citation shows yellow pinpoints, each over the words `near` in the document. */
  async function onlySelectedYellow(label, near) {
    await settle();
    const seen = await page.evaluate((near) => {
      const pins = [...document.querySelectorAll(".citation-document .citation-pinpoint")];
      const place = near && window.__e2e.rect(near), over = (box) => place && box.right > place.left &&
        box.left < place.left + place.width && box.bottom > place.top && box.top < place.top + place.height;
      return { ids: [...new Set(pins.map((pin) => pin.dataset.id))], color: pins[0] && getComputedStyle(pins[0]).backgroundColor,
        selected: document.querySelector(".citation-outline [role=option][aria-selected=true]")?.dataset.id,
        placed: pins.every((pin) => over(pin.getBoundingClientRect())) };
    }, near);
    check(seen.ids.length === 1 && seen.ids[0] === seen.selected && seen.color === "rgb(253, 230, 138)" && seen.placed,
      `${mode} ${label}: only the selected citation's pinpoints are yellow, over "${near}"`, seen);
  }
  const refersTo = () => page.locator("#citation-authority-name").innerText();

  /** The review: the list as printed, navigation, every edit, and what must never move. */
  async function review(label, full) {
    await page.waitForTimeout(500); await idle();
    const listed = await rows();
    check(JSON.stringify(listed) === JSON.stringify(EXPECTED_ROWS), `${mode} ${label}: the list shows each citation as printed`, listed);
    const groups = await page.locator(".citation-outline > [role=group] > h3").allInnerTexts();
    check(JSON.stringify(groups) === JSON.stringify(["In-text", "Footnotes"]), `${mode} ${label}: In-text and Footnotes parents`, groups);
    const notes = await page.locator(".citation-outline .citation-note-number").allInnerTexts();
    check(JSON.stringify(notes) === JSON.stringify(["1", "2", "3", "4", "5", "6"]), `${mode} ${label}: footnotes numbered as printed after the starred note`, notes);
    // Inactive citations are outlined rectangles, never underlines or fills.
    const bands = await page.evaluate(() => [...document.querySelectorAll(".citation-band:not([data-active])")].slice(0, 4).map((band) => {
      const style = getComputedStyle(band);
      return { border: style.borderTopWidth, fill: style.backgroundColor, radius: parseFloat(style.borderTopLeftRadius) };
    }));
    check(bands.length && bands.every(({ border, fill, radius }) => border === "1px" && /rgba\(0, 0, 0, 0\)|transparent/u.test(fill) && radius <= 4),
      `${mode} ${label}: inactive citations are thin rectangles`, bands);
    const underline = await page.evaluate(() => [...document.querySelectorAll(".citation-mark")].some((mark) => getComputedStyle(mark).textDecorationLine !== "none"));
    check(!underline, `${mode} ${label}: citations are not underlined`);
    const fixed = await frame();
    await shots(`${label}-04-review`);
    await noHorizontalScroll(`${label} review`);

    // Navigation: the list, the keys, the bar's arrows; the frame never moves.
    await interact(`${label} click first row`, () => page.locator(".citation-outline [role=option]").first().click());
    for (let index = 1; index < EXPECTED_ROWS.length; index += 1)
      await interact(`${label} ArrowDown ${index}`, () => page.keyboard.press("ArrowDown"), { rest: 60 });
    check(await selectedRow() === EXPECTED_ROWS.at(-1), `${mode} ${label}: ArrowDown reaches the last citation`, await selectedRow());
    await interact(`${label} ArrowUp`, () => page.keyboard.press("ArrowUp"), { rest: 60 });
    await interact(`${label} previous button`, () => button("Previous citation").click(), { rest: 60 });
    await interact(`${label} next button`, () => button("Next citation").click(), { rest: 60 });
    check(JSON.stringify(await frame()) === JSON.stringify(fixed), `${mode} ${label}: header, steps and bar keep their boxes across citations`, [fixed, await frame()]);

    // A click on another citation in the document selects it where the view already is.
    await chooseRow(EXPECTED_ROWS[2]);
    const scroller = page.locator(".citation-document .docx-view-scroll, .citation-document .beaver-pdf-scroll").first();
    const target = page.locator(".citation-document .citation-mark[data-citation-id]:not([data-active])").filter({ hasText: "Jordan" }).first();
    await target.scrollIntoViewIfNeeded(); await settle();
    const before = await scroller.evaluate((element) => element.scrollTop);
    await interact(`${label} click a citation in the document`, () => target.click());
    check(await scroller.evaluate((element) => element.scrollTop) === before, `${mode} ${label}: a document click keeps the view`, before);
    check((await selectedRow()).includes("Jordan"), `${mode} ${label}: a document click selects that citation`, await selectedRow());
    check(!await page.locator("[role=tooltip], [role=toolbar], [data-radix-popper-content-wrapper]").count(), `${mode} ${label}: no popup or floating toolbar`);

    // Each pinpoint found is a yellow highlight on the selected citation alone and a chip naming
    // its kind; the bar's edits are Add citation and Remove.
    for (const [row, chips, near] of [["Vavilov", "¶10", "para 10"], [EXPECTED_ROWS[1], "¶99-101", "paras 99-101"],
      [EXPECTED_ROWS[4], "s12", "s 12"], [EXPECTED_ROWS[5], "¶46-48", "paras 46-48"], [EXPECTED_ROWS[2], "p.138-139", "at 138-139"]]) {
      await chooseRow(row);
      check(await pinpoint() === chips, `${mode} ${label}: ${row} shows its pinpoint as ${chips}`, await pinpoint());
      await onlySelectedYellow(label, near);
    }
    check(!await page.locator(".citation-panel select, .citation-panel input").count(), `${mode} ${label}: no dropdown or text field in the bar`);
    check(JSON.stringify(await frame()) === JSON.stringify(fixed), `${mode} ${label}: the bar keeps its box whatever the chips hold`, [fixed, await frame()]);
    const edits = await page.getByRole("group", { name: "Edit citation" }).getByRole("button").allInnerTexts();
    check(JSON.stringify(edits) === JSON.stringify(["Add citation", "Remove"]), `${mode} ${label}: the bar edits by Add citation and Remove`, edits);
    check(!await page.locator(".citation-grip[data-grip^=pin], .citation-split").count(), `${mode} ${label}: no pinpoint handles or split marker`);

    // Enter: the selection becomes the citation's range, and back.
    await selectAtEdge("[1986] 1 SCR 103 at 138-139");
    await interact(`${label} Enter sets range`, () => page.keyboard.press("Enter"));
    check(await selectedRow() === "[1986] 1 SCR 103 at 138-139", `${mode} ${label}: Enter narrows the range`, await selectedRow());
    await selectAtEdge("R v Oakes, [1986] 1 SCR 103 at 138-139");
    await interact(`${label} Enter restores range`, () => page.keyboard.press("Enter"));
    check(await selectedRow() === EXPECTED_ROWS[2], `${mode} ${label}: Enter restores the range`, await selectedRow());

    if (full) {
      // A grip drags the end a word at a time; Shift+→ extends it again.
      const grip = page.locator(".citation-grip[data-grip=end]").first();
      const handle = await grip.boundingBox(), word = await page.evaluate(() => window.__e2e.rect("138-139"));
      await interact(`${label} drag the end handle`, async () => {
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(word.left - 12, word.top + word.height / 2, { steps: 6 });
        await page.mouse.up();
      });
      const dragged = await selectedRow();
      check(dragged === "R v Oakes, [1986] 1 SCR 103 at" || dragged === "R v Oakes, [1986] 1 SCR 103", `${mode} ${label}: the handle drags the end`, dragged);
      // A pinpoint can lie outside its citation: the range left it out, and it stays the citation's.
      check(await pinpoint() === "p.138-139", `${mode} ${label}: a range that leaves its pinpoint out keeps it`, await pinpoint());
      await onlySelectedYellow(label, "138-139");
      await page.evaluate(() => window.__e2e.clear());
      await page.locator(".citation-review").focus();
      for (let step = 0; step < (dragged.endsWith(" at") ? 1 : 2); step += 1)
        await interact(`${label} Shift+ArrowRight`, () => page.keyboard.press("Shift+ArrowRight"), { rest: 750 });
      check(await selectedRow() === EXPECTED_ROWS[2], `${mode} ${label}: Shift+→ extends the end back`, await selectedRow());
      check(await pinpoint() === "p.138-139", `${mode} ${label}: the pinpoint is the same again`, await pinpoint());

      // A chip's symbol steps through the kinds at once; × removes it; "+ Pinpoint" (or P) adds the
      // selected text, its kind read from the words before it. None of it moves the citation's range.
      const kind = () => page.locator(".citation-chip > button").first();
      for (const next of ["s138-139", "¶138-139", "p.138-139"]) {
        await interact(`${label} cycle the kind to ${next}`, () => kind().click());
        check(await pinpoint() === next, `${mode} ${label}: the symbol steps the kind to ${next}`, await pinpoint());
      }
      await interact(`${label} remove a pinpoint`, () => page.getByRole("button", { name: "Remove pinpoint p. 138-139" }).click());
      check(await pinpoint() === "" && await selectedRow() === EXPECTED_ROWS[2], `${mode} ${label}: × removes the pinpoint, not the citation's text`, await pinpoint());
      check(await button("+ Pinpoint").isDisabled(), `${mode} ${label}: + Pinpoint waits for a selection`);
      await selectAtEdge("138-139");
      check(await page.waitForFunction(() => !document.querySelector(".citation-add-pin").disabled).then(() => true, () => false),
        `${mode} ${label}: a selection enables + Pinpoint`);
      await interact(`${label} + Pinpoint`, () => button("+ Pinpoint").click());
      await page.waitForFunction(() => document.querySelectorAll(".citation-chip").length === 1);
      check(await pinpoint() === "p.138-139" && await selectedRow() === EXPECTED_ROWS[2], `${mode} ${label}: + Pinpoint adds the selection with its kind`, await pinpoint());
      // A pinpoint written away from its citation: "supra note 2 at 135" also takes "46-48" from the note's other citation.
      await chooseRow(EXPECTED_ROWS[6]);
      await selectAtEdge("46-48");
      await interact(`${label} P adds a pinpoint away from the citation`, () => page.keyboard.press("p"));
      await page.waitForFunction(() => document.querySelectorAll(".citation-chip").length === 2);
      check(await pinpoint() === "¶46-48 p.135" && await selectedRow() === EXPECTED_ROWS[6], `${mode} ${label}: a pinpoint outside the citation is added, the range unchanged`, [await pinpoint(), await selectedRow()]);
      await onlySelectedYellow(label, "paras 46-48; Oakes, supra note 2 at 135");
      await shots(`${label}-04b-pinpoint-chips`);
      await interact(`${label} remove the added pinpoint`, () => page.getByRole("button", { name: "Remove pinpoint ¶ 46-48" }).click());
      check(await pinpoint() === "p.135", `${mode} ${label}: the added pinpoint goes again`, await pinpoint());

      // Add citation finds the pinpoint the text goes on to write, outside the selection.
      await chooseRow(EXPECTED_ROWS[7]);
      await page.locator(".citation-review").focus();
      await interact(`${label} Delete Lakeshore`, () => page.keyboard.press("Delete"), { listChanges: true });
      await dragSelect("Lakeshore Rowing Club v Marsh Harbour Board, 2030 ABKB 417");
      await interact(`${label} Add citation without its pinpoint`, () => button("Add citation").click(), { listChanges: true });
      await page.waitForFunction(() => document.querySelectorAll(".citation-chip").length === 1);
      check(await pinpoint() === "¶22", `${mode} ${label}: Add citation finds the pinpoint after the selection`, await pinpoint());
      await selectAtEdge(EXPECTED_ROWS[7]);
      await interact(`${label} Enter widens it back`, () => page.keyboard.press("Enter"));
      check(await selectedRow() === EXPECTED_ROWS[7] && await pinpoint() === "¶22", `${mode} ${label}: the range widens back with its pinpoint`, [await selectedRow(), await pinpoint()]);

      // C19: the selected citation chosen again after scrolling away comes back into view at once.
      await chooseRow(EXPECTED_ROWS[2]);
      const view = page.locator(".citation-document .docx-view-scroll, .citation-document .beaver-pdf-scroll").first();
      await view.evaluate((element) => { element.scrollTop = element.scrollHeight; }); await settle();
      const inView = () => page.evaluate(() => {
        const mark = document.querySelector(".pdf-text-layer .citation-mark[data-active], .docx-view-container .citation-mark[data-active]")?.getBoundingClientRect();
        const box = document.querySelector(".citation-document .docx-view-scroll, .citation-document .beaver-pdf-scroll").getBoundingClientRect();
        return !!mark && mark.top >= box.top && mark.bottom <= box.bottom;
      });
      check(!await inView(), `${mode} ${label}: scrolled away from the selected citation`);
      await interact(`${label} choose the selected citation again`, () => page.locator(".citation-outline [role=option][aria-selected=true]").click());
      check(await inView(), `${mode} ${label}: choosing the selected citation again brings it back into view`);
    }

    // A supra's pinpoint follows its reference, as written.
    await chooseRow(EXPECTED_ROWS[6]);
    check(await pinpoint() === "p.135", `${mode} ${label}: the supra's pinpoint follows its reference`, await pinpoint());
    await onlySelectedYellow(label, "note 2 at 135");

    // The authority dropup: In-text, then each footnote's authorities under its number.
    await interact(`${label} open the dropup`, () => page.locator(".citation-authority-trigger").click());
    const menu = page.locator(".citation-authority-menu");
    const above = await page.evaluate(() => document.querySelector(".citation-authority-menu").getBoundingClientRect().bottom <=
      document.querySelector(".citation-authority-trigger").getBoundingClientRect().top);
    check(above, `${mode} ${label}: the authorities open upward`);
    const sections = await menu.locator("h4").allInnerTexts();
    check(sections[0] === "In-text" && sections[1] === "Footnotes", `${mode} ${label}: the dropup groups In-text then Footnotes`, sections);
    const footnoteGroups = await menu.locator("[role=group][aria-label^='Footnote ']").evaluateAll((groups) =>
      groups.map((group) => [group.getAttribute("aria-label"), [...group.querySelectorAll("[role=option] > span")].map((span) => span.textContent)]));
    check(footnoteGroups.length >= 3 && footnoteGroups.every(([, options]) => options.length >= 1), `${mode} ${label}: each footnote is a parent of its authorities`, footnoteGroups);
    await shots(`${label}-05-dropup`);
    await interact(`${label} relink to Jordan`, () => menu.getByRole("option", { name: /Jordan/u }).first().click());
    check((await refersTo()).includes("Jordan"), `${mode} ${label}: the dropup relinks`, await refersTo());
    await page.locator(".citation-authority-trigger").click();
    await interact(`${label} relink back to Oakes`, () => menu.getByRole("option", { name: /Oakes/u }).first().click());
    check((await refersTo()).includes("Oakes"), `${mode} ${label}: the dropup relinks back`, await refersTo());

    // Delete marks "Not a citation"; Ctrl+Z takes it back.
    await chooseRow(EXPECTED_ROWS[3]);
    await page.locator(".citation-review").focus();
    // The full review has already set one citation aside (Lakeshore, added again without its pinpoint).
    await interact(`${label} Delete (not a citation)`, () => page.keyboard.press("Delete"), { listChanges: true });
    check(!(await rows()).includes(EXPECTED_ROWS[3]) && await page.getByText(`Not citations (${full ? 2 : 1})`).count() === 1, `${mode} ${label}: Delete removes the citation`, await rows());
    await interact(`${label} Ctrl+Z restores`, () => page.keyboard.press("Control+z"), { listChanges: true });
    check((await rows()).includes(EXPECTED_ROWS[3]), `${mode} ${label}: Ctrl+Z restores it`, await rows());

    // Add: a reference the parser does not know becomes a citation, then goes again.
    await dragSelect("Launch Guidance Note 7");
    await interact(`${label} Add citation`, () => button("Add citation").click(), { listChanges: true });
    check((await rows()).includes("Launch Guidance Note 7") && await selectedRow() === "Launch Guidance Note 7", `${mode} ${label}: Add makes the selection a citation`, await rows());
    check(await pinpoint() === "", `${mode} ${label}: an added citation without a pinpoint shows no chip`, await pinpoint());
    await shots(`${label}-06-added`);
    await page.locator(".citation-review").focus();
    await interact(`${label} Delete the added citation`, () => page.keyboard.press("Delete"), { listChanges: true });
    check(JSON.stringify(await rows()) === JSON.stringify(EXPECTED_ROWS), `${mode} ${label}: the list is back as imported`, await rows());
    check(JSON.stringify(await frame()) === JSON.stringify(fixed), `${mode} ${label}: header, steps and bar keep their boxes through edits`, [fixed, await frame()]);
    check(!await accessPrompts(), `${mode} ${label}: no file-access prompt`);
    return fixed;
  }

  /** Next from the review: the sources the stub answered are rebuilt; the rest are uploaded. */
  async function sources(label, fixed, scan = true) {
    const started = await now();
    await button("Next").click();
    await page.getByRole("list", { name: "Authority tab slots" }).waitFor({ timeout: 60000 });
    note(mode, `${label}-step-sources`, await now() - started);
    check(await now() - started < BUDGETS.stepSwitch, `${mode} ${label}: Next to Sources in ${Math.round(await now() - started)} ms`);
    const steps = await frame();
    check(steps.header === fixed.header && steps.steps === fixed.steps, `${mode} ${label}: header and steps keep their boxes on Sources`, [fixed, steps]);
    const row = (name) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: false }) });
    for (const name of ["Vavilov", "Oakes", "Jordan"])
      check(await row(name).getByRole("img", { name: "Built from source text" }).count() === 1, `${mode} ${label}: ${name} is provided from A2AJ text`);
    await noFalseOutage(label);
    await tabColumn(`${label} sources`, page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem"));
    // The statute through the row's upload menu, the scan through the CanLII row's Upload.
    await pick(async () => {
      await row("Waterways Licensing Act").getByRole("button", { name: /^Upload for/u }).click();
      await page.getByRole("menuitem", { name: "Upload from computer" }).click();
    }, [fixtures.statute]);
    await row("Waterways Licensing Act").getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30000 });
    if (!scan) {
      await shots(`${label}-08-sources`);
      check(!await accessPrompts(), `${mode} ${label}: no file-access prompt on Sources`);
      return;
    }
    const progress = row("Lakeshore").getByRole("status"), shiftFrom = await now();
    await pick(() => row("Lakeshore").locator("button[aria-label^='Upload PDF for']").click(), [fixtures.scan]);
    const ocrStarted = await now();
    await progress.filter({ hasText: /Recognizing text|Waiting to recognize|recognition complete/u }).waitFor({ timeout: 30000 });
    const progressText = await progress.innerText();
    note(mode, `${label}-ocr-progress`, progressText);
    check(/Recognizing text · \d\/1 pages|Waiting to recognize|complete/u.test(progressText), `${mode} ${label}: OCR shows its progress`, progressText);
    await shots(`${label}-07-sources-ocr`);
    await progress.filter({ hasText: "Text recognition complete" }).waitFor({ timeout: BUDGETS.ocr * 3 });
    const recognized = await now() - ocrStarted;
    note(mode, `${label}-ocr`, recognized);
    check(recognized < BUDGETS.ocr, `${mode} ${label}: one scanned page recognized in ${Math.round(recognized)} ms`);
    // Attaching the scan and its recognition running to completion move nothing on the page.
    const sourceShifts = ownShifts(await page.evaluate(([from, to]) => window.__e2e.window(from, to).shifts, [shiftFrom, await now()]));
    check(!sourceShifts.length, `${mode} ${label}: attaching a scan and recognizing it shift nothing`,
      sourceShifts.map(({ value, sources }) => [value.toFixed(4), sources.map(({ node, moved }) => `${node} ${moved}`)]));
    await shots(`${label}-08-sources`);
    await noHorizontalScroll(`${label} sources`);
    check(!await accessPrompts(), `${mode} ${label}: no file-access prompt on Sources`);
  }

  /** A lookup A2AJ answered is never reported unchecked. Live, A2AJ is asked once from here when one
   *  is: an outage reported while it answers fails, and its limit is never called unreachable. */
  async function noFalseOutage(label) {
    const reported = (await page.getByRole("status").filter({ hasText: /\b(?:wasn't|weren't) checked\b/u }).allInnerTexts()).join(" ");
    if (!reported) return;
    if (!args.live) return check(false, `${mode} ${label}: lookups the stub answered are reported unchecked`, reported);
    const direct = await fetch("https://api.a2aj.ca/fetch?citation=2016+SCC+27&doc_type=cases&output_language=en",
      { headers: { Accept: "application/json" } }).then(({ status }) => status, (error) => `${error.name}: ${error.message}`);
    note(mode, `${label}-a2aj-direct`, { reported, direct });
    check(direct !== 200, `${mode} ${label}: lookups are reported unchecked while A2AJ answers`, reported);
    check(typeof direct !== "number" || !/couldn't be reached/u.test(reported), `${mode} ${label}: A2AJ answered ${direct} but is reported unreachable`, reported);
  }

  /** A2AJ's rate limit answers a page with a 429 that carries no CORS header, so the page's fetch
   *  fails as if nothing had answered. The lookups name it A2AJ's limit and hold off: none says
   *  A2AJ couldn't be reached, and A2AJ is not asked again until the limit passes. */
  this.limitedLookups = async (url, requests) => {
    await page.goto(url);
    await pick(() => button("Add file").click(), [fixtures.briefPdf]);
    await page.getByRole("dialog").waitFor();
    // Through the import dialog's steps with their defaults.
    const importing = button("Import and review");
    for (let step = 0; step < 3 && !await importing.isVisible(); step += 1) {
      await button("Next", page.getByRole("dialog")).click(); await settle();
    }
    await importing.click();
    await page.locator(".citation-document .citation-band").first().waitFor({ timeout: 60000 });
    await idle();
    await button("Next").click();
    await page.getByRole("list", { name: "Authority tab slots" }).waitFor({ timeout: 60000 });
    await idle();
    const reported = (await page.getByRole("status").filter({ hasText: /\b(?:wasn't|weren't) checked\b/u }).allInnerTexts()).join(" ");
    note(mode, "limited", { reported, requests: requests.length });
    check(/^A2AJ is limiting requests, so \d+ authorities weren't checked/u.test(reported) && !/couldn't be reached/u.test(reported),
      `${mode}: A2AJ's limit is named for what it is`, reported);
    // One lookup, refused, and one opaque request that finds A2AJ answering; then nothing until the limit passes.
    check(requests.length <= 2, `${mode}: A2AJ is not asked again while it is limiting requests`, requests);
    await shots("limited-sources");
  };

  /** Highlights: the automatic marks are there; a selected passage becomes another. */
  async function highlights(label, scan = true) {
    const started = await now();
    await button("Next").click();
    const recognize = page.getByRole("dialog").filter({ hasText: "Recognize text" });
    if (await recognize.count()) check(false, `${mode} ${label}: Next asked to recognize text after recognition finished`);
    await button("Edit in PDF").waitFor();
    note(mode, `${label}-step-highlights`, await now() - started);
    // The marking chosen at import is on the step as well, with nothing to get past.
    check(await page.getByRole("group", { name: "Passage marking" }).isVisible() && !await button("Continue").count(),
      `${mode} ${label}: Highlights shows the passage marking and holds nothing back`);
    await shots(`${label}-09-highlights`);
    await noHorizontalScroll(`${label} highlights`);
    await button("Edit in PDF").click();
    const editor = page.getByRole("dialog", { name: "Highlights" });
    const choice = await editor.getByRole("combobox", { name: "Authority PDF" }).evaluate((select) =>
      [...select.options].find((option) => option.text.includes("Waterways"))?.value);
    await editor.getByRole("combobox", { name: "Authority PDF" }).selectOption(choice);
    // Until the chosen source opens, the panel still shows the previous one and says it is busy.
    const opened = () => page.waitForFunction(() => document.querySelector("aside[aria-label=Highlights]")?.getAttribute("aria-busy") === "false", null, { timeout: 30000 });
    await opened();
    await editor.locator(".textLayer, .pdf-text-layer").first().waitFor({ timeout: 30000 });
    await editor.getByText("Preparing highlights").waitFor({ state: "detached", timeout: 30000 });
    const marks = editor.locator("aside ul > li");
    const automatic = await marks.count();
    check((await marks.allInnerTexts()).some((mark) => mark.startsWith("s 12")), `${mode} ${label}: the statute marks s 12`, await marks.allInnerTexts());
    // Select a passage in the PDF, then Highlight text marks it.
    await page.waitForFunction((phrase) => {
      for (const layer of document.querySelectorAll("dialog .pdf-text-layer, [role=dialog] .pdf-text-layer")) {
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(phrase);
          if (at < 0) continue;
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + phrase.length);
          getSelection().removeAllRanges(); getSelection().addRange(range);
          return true;
        }
      }
      return false;
    }, "shall not refuse", { timeout: 30000 });
    await editor.getByRole("button", { name: "Highlight text" }).click();
    await page.waitForFunction((count) => document.querySelectorAll("dialog aside ul > li, [role=dialog] aside ul > li").length > count, automatic);
    await editor.getByText("Saving…").waitFor({ state: "detached" });
    await shots(`${label}-10-highlight-editor`);
    if (!scan) {
      await editor.getByRole("button", { name: "Close highlights" }).click();
      await editor.waitFor({ state: "detached" });
      await remark(label);
      return;
    }
    const scanChoice = await editor.getByRole("combobox", { name: "Authority PDF" }).evaluate((select) =>
      [...select.options].find((option) => option.text.includes("Lakeshore"))?.value);
    await editor.getByRole("combobox", { name: "Authority PDF" }).selectOption(scanChoice);
    await opened();
    // The scan's marks (or the note that one fell back to its page) and its recognized text layer.
    await page.waitForFunction(() => document.querySelector("dialog aside ul > li, dialog aside [role=alert]") &&
      [...document.querySelectorAll("dialog .pdf-text-layer")].some((layer) => layer.textContent.trim()), null, { timeout: 30000 }).catch(() => {});
    const recognized = await page.evaluate(() => [...document.querySelectorAll("dialog .pdf-text-layer")].map((layer) => layer.textContent).join(" ").replace(/\s+/gu, " "));
    check(/\[22\] A board that departs/u.test(recognized), `${mode} ${label}: the scan's recognized text is in the editor`, recognized.slice(0, 300));
    const scanMarks = await marks.allInnerTexts();
    check(scanMarks.some((mark) => mark.startsWith("para 22")), `${mode} ${label}: the recognized scan marks para 22`,
      [scanMarks, await editor.locator("aside [role=alert]").allInnerTexts()]);
    await shots(`${label}-10b-highlight-scan`);
    // Moving from PDF to PDF is steady: every frame shows pages, the page area keeps its height
    // (the scrollbar never drops out), the marks swap without the list emptying, the tools and page
    // fields never dim, nothing shifts and no task blocks a frame. Sampled every frame, two switches.
    const switchFrom = await now();
    await page.evaluate(() => {
      const frames = window.__switchFrames = [];
      const tick = () => {
        const aside = document.querySelector("aside[aria-label=Highlights]"), scroll = aside?.closest("dialog, [role=dialog]")?.querySelector(".beaver-pdf-scroll");
        if (scroll) {
          const bounds = scroll.getBoundingClientRect(), shown = (canvas) => { const rect = canvas.getBoundingClientRect();
            return canvas.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom; };
          frames.push({ painted: [...scroll.parentElement.querySelectorAll("canvas")].filter(shown).length, height: scroll.scrollHeight,
            cards: aside.querySelectorAll("ul > li").length, dimmed: aside.querySelectorAll("[role=group] button:disabled").length +
              scroll.parentElement.querySelectorAll("input:disabled").length, note: [...aside.querySelectorAll("ul ~ p, [role=alert]")].map((node) => node.textContent).join("") });
        }
        if (!window.__stopSwitchFrames) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const settledHeights = [await page.evaluate(() => document.querySelector("[role=dialog] .beaver-pdf-scroll, dialog .beaver-pdf-scroll").scrollHeight)];
    for (let index = 0; index < 2; index += 1) {
      await editor.getByRole("button", { name: /^Next authority/u }).click();
      await opened();
      await page.waitForFunction(() => !document.querySelector("[data-pdf-preview]") && !document.querySelector("aside[aria-label=Highlights]")?.textContent.includes("Preparing"), null, { timeout: 30000 });
      await page.waitForTimeout(500);
      settledHeights.push(await page.evaluate(() => document.querySelector("[role=dialog] .beaver-pdf-scroll, dialog .beaver-pdf-scroll").scrollHeight));
    }
    const switchFrames = await page.evaluate(() => { window.__stopSwitchFrames = true; return window.__switchFrames; });
    const switched = await page.evaluate(([from, to]) => window.__e2e.window(from, to), [switchFrom, await now()]);
    const unsteady = { blank: switchFrames.filter(({ painted }) => !painted).length,
      collapsed: switchFrames.filter(({ height }) => height < Math.min(...settledHeights)).map(({ height }) => `${height} < ${Math.min(...settledHeights)}`),
      emptied: switchFrames.filter(({ cards, note }) => !cards && !note).length,
      dimmed: switchFrames.filter(({ dimmed }) => dimmed).length,
      shifts: switched.shifts.map(({ value, sources }) => [value.toFixed(4), sources.map(({ node, moved }) => `${node} ${moved}`)]),
      longTasks: switched.longTasks.map(({ duration }) => Math.round(duration)).filter((duration) => duration > BUDGETS.longTask) };
    note(mode, `${label}-source-switch`, { frames: switchFrames.length, ...unsteady });
    check(switchFrames.length > 10 && !unsteady.blank && !unsteady.collapsed.length && !unsteady.emptied && !unsteady.dimmed && !unsteady.shifts.length && !unsteady.longTasks.length,
      `${mode} ${label}: switching source PDFs in Highlights is steady`, unsteady);
    await editor.getByRole("button", { name: "Close highlights" }).click();
    await editor.waitFor({ state: "detached" });
    await remark(label);
  }

  /** The marking can be changed on the step at any time. A new one prepares the reviewed
   *  highlights again and keeps the passage the reviewer added; the first marking is then put back. */
  async function remark(label) {
    const step = page.getByRole("region", { name: "Highlights" }), marking = step.getByRole("group", { name: "Passage marking" });
    await marking.waitFor();
    await shots(`${label}-10c-passage-marking`);
    const first = await marking.locator("input:checked").evaluate((input) => input.closest("label").querySelector("[id]").textContent);
    const mark = async (name) => {
      const option = marking.getByRole("radio", { name, exact: true });
      await marking.locator("label", { has: page.getByRole("radio", { name, exact: true }) }).click();
      // The choice shows once saved, and the cards come back once its highlights are prepared.
      await page.waitForFunction(([fieldset, input]) => input.checked && !fieldset.disabled,
        [await marking.elementHandle(), await option.elementHandle()], { timeout: 30000 });
    };
    await mark("No passage marks");
    await button("Edit in PDF").click();
    const editor = page.getByRole("dialog", { name: "Highlights" });
    const choice = await editor.getByRole("combobox", { name: "Authority PDF" }).evaluate((select) =>
      [...select.options].find((option) => option.text.includes("Waterways"))?.value);
    await editor.getByRole("combobox", { name: "Authority PDF" }).selectOption(choice);
    await page.waitForFunction(() => document.querySelector("aside[aria-label=Highlights]")?.getAttribute("aria-busy") === "false", null, { timeout: 30000 });
    await editor.getByText("Preparing highlights").waitFor({ state: "detached", timeout: 30000 });
    const kept = await editor.locator("aside ul > li").allInnerTexts();
    check(kept.length === 1 && kept[0].startsWith("Custom highlight"),
      `${mode} ${label}: a new marking prepares the reviewed highlights again and keeps the one added`, kept);
    await editor.getByRole("button", { name: "Close highlights" }).click();
    await editor.waitFor({ state: "detached" });
    await mark(first);
  }

  async function downloadOutputs(label) {
    const saved = {};
    for (const output of await page.getByRole("button", { name: /^Download / }).all()) {
      const name = (await output.getAttribute("aria-label")).replace(/^Download /u, "");
      const download = page.waitForEvent("download");
      await output.click();
      const file = path.join(out, "downloads", mode, label, (await download).suggestedFilename());
      await mkdir(path.dirname(file), { recursive: true });
      await (await download).saveAs(file);
      saved[name] = file;
    }
    return saved;
  }
  /** Build (or `start`, another way in), through the Missing PDFs warning when a source is still
   *  missing; the outputs are current (not "previous") once it finishes. */
  async function build(label, missing, start = () => button("Build").click()) {
    let started = await now();
    await start();
    const warning = page.getByRole("dialog").filter({ hasText: "Missing PDFs" });
    if (missing) {
      await warning.waitFor({ timeout: 30000 });
      const listed = await warning.locator("li").allInnerTexts();
      check(listed.length === 1 && missing.test(listed[0]), `${mode} ${label}: Build warns about the one missing PDF`, listed);
      await shots(`${label}-missing-pdfs`);
      started = await now();
      await button("Build", warning).click();
    }
    await page.waitForFunction(() => {
      const outputs = [...document.querySelectorAll("button[aria-label^='Download ']")];
      return outputs.length && outputs.every((button) => !button.getAttribute("aria-label").startsWith("Download previous")) &&
        ![...document.querySelectorAll("button, [role=dialog]")].some((element) => /^Cancel$|Missing PDFs/u.test(element.textContent.trim()));
    }, null, { timeout: BUDGETS.build * 3, polling: 50 });
    const built = await now() - started;
    note(mode, `${label}-build`, built);
    check(built < BUDGETS.build, `${mode} ${label}: build ${Math.round(built)} ms`);
    const status = await page.locator("[role=tablist][aria-label='Book steps'] ~ [data-tabs-actions] [role=status]").innerText();
    check(/^Outputs ready|incomplete/iu.test(status), `${mode} ${label}: the build reports its outputs`, status);
    return downloadOutputs(label);
  }

  /** The first thing a brand-new profile does: import a brief of `kind`, with nothing stored or warmed. */
  this.firstImport = (kind) => importBrief(kind === "pdf" ? fixtures.briefPdf : fixtures.briefDocx, `${kind}-first`);

  this.pdfBrief = async () => {
    await importBrief(fixtures.briefPdf, "pdf");
    const fixed = await review("pdf", true);
    await sources("pdf", fixed);
    await highlights("pdf");
    await button("Next").click();
    await dock().waitFor();
    await page.getByLabel("Create").selectOption("both");
    // A PDF brief has no Word copy; its final PDF is set up in its own dialog, the brief already a PDF.
    check(!await page.getByRole("group", { name: "Word copy" }).count(), `${mode}: a PDF brief has no Word copy choice`);
    await shots("pdf-11-build");
    await noHorizontalScroll("pdf build");
    await tabColumn("pdf build", bookRows());
    // The dock keeps each output's place and size through its first build: its download's line is reserved.
    const rows = () => page.getByRole("complementary", { name: "Outputs" }).locator("[data-output=book], [data-output=table]")
      .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().height)).join());
    const unbuilt = await rows();
    await button("Set up", dock()).click();
    const final = page.getByRole("dialog", { name: "Final PDF" });
    await choose(final.getByRole("checkbox", { name: "Citations to their tabs" }));
    await choose(final.getByRole("checkbox", { name: "Pinpoints to the passage" }));
    await shots("pdf-11b-final-pdf");
    const files = await build("pdf", undefined, () => button("Build final PDF", final).click());
    check(await rows() === unbuilt, `${mode}: the outputs dock's rows keep their size when built`, [unbuilt, await rows()]);
    await shots("pdf-12-built");
    // Every step tab switches at once and leaves the header and the steps where they are.
    // A reader reaches the step tabs at the top of the page; downloading the outputs scrolled it.
    await page.locator(".authorities-workspace").evaluate((element) => element.scrollTo(0, 0));
    const frameAtBuild = await frame();
    for (const step of ["Citations", "Sources", "Highlights", "Build book"]) {
      // The click's own input-to-paint is the switch: the new step is drawn in that frame.
      await interact(`step ${step}`, () => page.getByRole("tab", { name: step, exact: true }).click());
      check(await page.getByRole("tab", { name: step, exact: true }).getAttribute("aria-selected") === "true", `${mode}: the ${step} step opens`);
      const boxes = await frame();
      check(boxes.header === frameAtBuild.header && boxes.steps === frameAtBuild.steps, `${mode}: the ${step} step keeps the header and steps in place`, [frameAtBuild, boxes]);
      if (step === "Citations") await page.locator(".citation-band[data-active]").first().waitFor();
    }
    await verifyPdfOutputs(files);
  };

  /** Clicks an option and times it to the frame that shows it chosen. */
  async function choose(option) {
    // A checkbox the last draft's choices already ticked stays ticked.
    if (await option.isChecked()) return;
    // From the click to the first frame that draws the option chosen, timed in the page.
    const painted = option.evaluate((element) => new Promise((resolve) => {
      element.closest("label").addEventListener("click", (event) => {
        const frame = (time) => element.checked ? resolve(time - event.timeStamp) : requestAnimationFrame(frame);
        requestAnimationFrame(frame);
      }, { once: true, capture: true });
    }));
    // The option's card is its label, and what a reader clicks.
    // Its corner, clear of anything else inside it (a card can hold a text box).
    await option.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } });
    const shown = await painted, name = await option.evaluate((element) => element.labels?.[0]?.textContent?.trim() ?? element.name);
    interactions.push({ label: `choose ${name}`, inputToPaint: shown });
    check(shown < BUDGETS.inputToPaint, `${mode}: "${name}" shows as chosen in ${Math.round(shown)} ms`);
  }

  const dock = () => page.getByRole("complementary", { name: "Outputs" });
  // Where the dock's column is: it stays put while it scrolls with the page.
  const dockBox = () => dock().evaluate((element) => { const box = element.getBoundingClientRect();
    return [box.x, box.width].map(Math.round).join(","); });
  this.docxBrief = async () => {
    if (await button("New").isEnabled()) await button("New").click();
    await importBrief(fixtures.briefDocx, "docx");
    const fixed = await review("docx", false);
    // The scan stays missing here, so the Word brief builds through the Missing PDFs warning.
    await sources("docx", fixed, false);
    await highlights("docx", false);
    await button("Next").click();
    await dock().waitFor();
    // The Word copy and its tab references are two choices; the final PDF is a third, off until chosen.
    const copy = page.getByRole("group", { name: "Word copy" }), references = page.getByRole("group", { name: "Tab references" });
    const names = (group) => group.getByRole("radio").evaluateAll((radios) => radios.map((radio) =>
      document.getElementById(radio.getAttribute("aria-labelledby"))?.textContent));
    check(JSON.stringify(await names(copy)) === JSON.stringify(["No marks", "Marked copy", "Marked copy and table"]) &&
      JSON.stringify(await names(references)) === JSON.stringify(["None", "[Tab 1]", "Your wording"]),
    `${mode}: the Word copy and the tab references are separate choices`, [await names(copy), await names(references)]);
    // The final PDF is an occasional path: a row in the dock, its choices in a dialog of their own.
    check(!await page.getByRole("checkbox", { name: /to their tabs/u }).count() && await button("Set up", dock()).isVisible(),
      `${mode}: the final PDF is off until set up, and its choices stay out of the step`);
    await shots("docx-11-build");
    await tabColumn("docx build", bookRows());
    // Typed wording shows as it goes in: the app adds the tab number and the brackets.
    const words = references.getByRole("textbox", { name: "Words before the tab number" });
    const custom = "Appellant's Book of Authorities, Tab";
    await words.fill(` ${custom} `);
    check(await references.getByText(`[${custom} 1]`, { exact: true }).isVisible(), `${mode}: the custom wording previews what is inserted`);
    await words.press("Enter"); await idle();
    // Each combination builds the Word copy it names: Word's citation fields, its table, the tab reference as worded.
    await page.getByLabel("Create").selectOption("table"); await idle();
    for (const [mark, fields, toa] of [["No marks", false, false], ["Marked copy", true, false], ["Marked copy and table", true, true]])
      for (const [reference, text] of [["None", null], ["[Tab 1]", /\[Tab \d\]/gu], [/Your wording/u, /\[Appellant's Book of Authorities, Tab \d\]/gu]]) {
        await choose(copy.getByRole("radio", { name: mark, exact: true }));
        await choose(references.getByRole("radio", { name: reference, exact: typeof reference === "string" }));
        await idle();
        const label = `docx-${mark.split(" ").at(-1)}-${String(reference).replace(/\W+/gu, "").slice(0, 8) || "tab"}`.toLowerCase();
        const files = await build(label), word = Object.keys(files).find((name) => name.endsWith(".docx") && !/\.table-of-authorities\.docx$/u.test(name));
        if (!fields && !text) { check(!word, `${mode} ${label}: no marks and no tab references make no Word copy`, Object.keys(files)); continue; }
        check(!!word, `${mode} ${label}: builds a Word copy`, Object.keys(files));
        if (!word) continue;
        const docx = await readDocx(files[word]), all = `${docx.xml}${docx.notes}`, visible = `${docx.text}${docx.noteText}`.replace(/&apos;/gu, "'");
        const inserted = text ? visible.match(text) ?? [] : visible.match(/\[[^\]]*Tab \d\]/gu) ?? [];
        check(/TA \\l/u.test(all) === fields && /TOA \\h/u.test(all) === toa && (text ? inserted.length >= 5 : !inserted.length),
          `${mode} ${label}: TA fields ${fields}, table ${toa}, tab references ${text ?? "none"}`,
          { word, fields: /TA \\l/u.test(all), toa: /TOA \\h/u.test(all), inserted: inserted.slice(0, 3) });
      }
    await page.getByLabel("Create").selectOption("both");
    await choose(copy.getByRole("radio", { name: "Marked copy and table", exact: true }));
    await choose(references.getByRole("radio", { name: "[Tab 1]", exact: true }));
    // The final PDF, set up in its dialog: opening it and choosing its links moves nothing beneath.
    const options = await frame(), docked = await dockBox();
    await button("Set up", dock()).click();
    const final = page.getByRole("dialog", { name: "Final PDF" });
    await choose(final.getByRole("checkbox", { name: "Citations to their tabs" }));
    check(JSON.stringify(await frame()) === JSON.stringify(options), `${mode}: the final PDF's dialog keeps the frame still`, [options, await frame()]);
    // A Word brief needs the brief saved as PDF; until it is added the dialog says so, calmly.
    check(await button("Build final PDF", final).isDisabled() && /Add your brief as PDF to build it/u.test(await final.innerText()) &&
      !await final.locator(".text-red-800").count(), `${mode}: the final PDF waits for the brief PDF without an error`);
    await shots("docx-12-final-pdf");
    await pick(() => button("Upload the brief PDF", final).click(), [fixtures.briefPdf]);
    await button("Replace the brief PDF", final).waitFor();
    const tabs = await build("docx-tabs", /Lakeshore/u, () => button("Build final PDF", final).click());
    await shots("docx-13-built");
    check(await dock().locator("[data-output=final][data-ready]").count() === 1 && await dockBox() === docked,
      `${mode}: the built final PDF is a download in the dock, which has not moved`);
    check(Object.keys(tabs).some((name) => /book-of-authorities\.pdf$/u.test(name)) && Object.keys(tabs).some((name) => /table-of-authorities\.docx$/u.test(name)),
      `${mode}: the book and the table build with the final PDF`, Object.keys(tabs));
    await verifyWordOutputs(tabs, true);
    // A Word copy choice changed after the build, then the brief PDF replaced while the choice is
    // still saving (a long brief's saves take a while; here each is held for a second): each is
    // saved in turn, to the draft the one before it made, and neither meets the other as a conflict.
    const marks = page.getByRole("radio", { name: "Marked copy", exact: true });
    const revised = path.join(path.dirname(fixtures.briefPdf), "harbourside-brief-revised.pdf");
    await writeFile(revised, await readFile(fixtures.briefPdf));
    await page.evaluate(() => {
      const send = window.fetch; window.__e2eFetch = send;
      window.fetch = async (input, init) => {
        if (String(input?.url ?? input).includes("/authorities-runtime/action")) await new Promise((resolve) => setTimeout(resolve, 1000));
        return send(input, init);
      };
    });
    await page.locator("label", { has: marks }).click();
    await button("Final PDF options", dock()).click();
    const replace = () => button("Replace the brief PDF", final).click();
    if (mode === "file") {
      // The reader takes a moment in the file dialog, while the choice's first save lands.
      const chooser = page.waitForEvent("filechooser");
      await replace(); await page.waitForTimeout(1500); await (await chooser).setFiles([revised]);
    } else await pick(replace, [revised]);
    const replaced = page.getByText("harbourside-brief-revised.pdf", { exact: true });
    await replaced.waitFor({ timeout: 15_000 }).catch(() => {});
    await idle(); await page.evaluate(() => { window.fetch = window.__e2eFetch; });
    check(await replaced.isVisible(), `${mode}: the brief PDF replaced while a Word copy choice saves is saved after it`,
      (await page.locator("body").innerText()).match(/[^\n]*(?:draft changed|brief PDF)[^\n]*\n?[^\n]*/giu));
    check(await marks.isChecked(), `${mode}: the Word copy choice outlasts the brief PDF replaced after it`);
  };

  async function verifyPdfOutputs(files) {
    const names = Object.keys(files);
    note(mode, "pdf-outputs", names);
    const book = files[names.find((name) => /book/iu.test(name) && name.endsWith(".pdf"))];
    const final = files[names.find((name) => /final/iu.test(name))];
    const report = files[names.find((name) => /unlinked/iu.test(name))];
    check(book && final, `${mode}: the PDF brief built a book and a final PDF`, names);
    if (!book || !final) return;
    const bookPdf = await readPdf(book), finalPdf = await readPdf(final);
    const tabs = flatOutline(bookPdf.outline).filter(({ title }) => /^Tab\b/u.test(title));
    check(tabs.length === 5, `${mode}: the book bookmarks five tabs`, flatOutline(bookPdf.outline).map(({ title, page }) => [title, page]));
    // A tab's bookmark names its authority once: the source's "R. v. Oakes" is the brief's "R v Oakes".
    check(tabs.every(({ title }) => ["Vavilov", "Oakes", "Jordan", "Lakeshore", "Waterways"].every((name) =>
      title.split(name).length <= 2)), `${mode}: each tab bookmark names its authority once`, tabs.map(({ title }) => title));
    check(tabs.some(({ children }) => children.length), `${mode}: the book nests each authority's own structure or pinpoints under its tab`,
      tabs.map(({ title, children }) => [title.slice(0, 30), children.map(({ title }) => title)]));
    check(bookPdf.pages.some(({ annotations }) => annotations.some(({ subtype }) => subtype === "Highlight")), `${mode}: the book carries highlight annotations`);
    // A mark is its colour and place: nothing for a viewer to show beside it.
    const notes = [bookPdf, finalPdf].flatMap(({ pages }) => pages.flatMap(({ annotations }) => annotations.filter(({ note }) => note)));
    check(!notes.length, `${mode}: no mark in the book or the final PDF carries an author or a comment`, notes.slice(0, 3));
    // The final PDF is the brief and then the book, with each tab bookmarked where it starts.
    check(finalPdf.pageCount === 2 + bookPdf.pageCount, `${mode}: final PDF = 2 brief pages + the book`, [finalPdf.pageCount, bookPdf.pageCount]);
    const finalTabs = flatOutline(finalPdf.outline).filter(({ title }) => /^Tab\b/u.test(title));
    check(finalTabs.length === 5 && finalTabs.every(({ page }, index) => page === tabs[index].page + 2), `${mode}: the final PDF's tab bookmarks follow the brief`, finalTabs.map(({ title, page }) => [title, page]));
    const all = finalPdf.pages.slice(0, 2).flatMap(({ number, annotations }) => annotations
      .filter(({ subtype }) => subtype === "Link").map((link) => ({ ...link, from: number })));
    // The brief's own web link is kept as it was; every link the final PDF adds jumps inside it.
    const web = all.filter(({ url }) => url), links = all.filter(({ url }) => !url);
    check(web.length === 1 && web[0].url === BRIEF.webLink && web[0].from === 1, `${mode}: the brief's own web link is kept`, web);
    check(links.length >= 4, `${mode}: the brief's citations link into the book`, links.length);
    const starts = new Set(finalTabs.map(({ page }) => page)), inBook = (page) => page > 2 && page <= finalPdf.pageCount;
    check(links.every(({ destinationPage }) => inBook(destinationPage)), `${mode}: every link lands in the book`, links.map(({ destinationPage }) => destinationPage));
    check(links.some(({ destinationPage }) => starts.has(destinationPage)), `${mode}: tab links land on their tab's first page`, links.map(({ destinationPage }) => destinationPage));
    // The statute's s 12 and the scan's para 22 are pinpoints into PDFs the user uploaded: each
    // opens the place on the page that prints it, not just its tab.
    const places = links.filter(({ destination }) => destination?.[0] === "XYZ");
    note(mode, "final-pdf-links", links.map(({ destinationPage, destination }) => [destinationPage, ...(destination ?? [])]));
    const statuteTab = finalTabs.find(({ title }) => /Waterways/u.test(title)), scanTab = finalTabs.find(({ title }) => /Lakeshore/u.test(title));
    const pinpointIn = (tab, text) => places.find(({ destinationPage }) => tab && destinationPage >= tab.page &&
      text.test(finalPdf.pages[destinationPage - 1].text));
    check(!!pinpointIn(statuteTab, /12\(1\) The board shall not refuse/u), `${mode}: the s 12 pinpoint opens s 12 in the uploaded statute`, places.map(({ destinationPage }) => destinationPage));
    check(!!pinpointIn(scanTab, /\[22\]/u), `${mode}: the para 22 pinpoint opens para 22 in the recognized scan`, places.map(({ destinationPage }) => destinationPage));
    // What could not be linked is listed for a PDF editor: citation, pinpoint, tab and why.
    if (report) {
      const lines = (await readFile(report, "utf8")).split(/\r?\n/u), text = lines.join("\n");
      const entries = lines.filter((line) => / — \S.* \[Tab \d+\](?:, source PDF page \d+)?: /u.test(line));
      note(mode, "unlinked-report", lines.filter(Boolean));
      const count = Number(/^(\d+) links? (?:was|were)n?(?:'t| not) added/mu.exec(text)?.[1]);
      check(count === entries.length && /^1 link wasn't added|^\d+ links weren't added/mu.test(text), `${mode}: the unlinked report counts its entries in plain English`, text.slice(0, 200));
      check(!entries.some((line) => /Waterways|Lakeshore/u.test(line)), `${mode}: the unlinked report holds only what could not be linked`, entries);
    } else check(links.length > 0, `${mode}: a final PDF that linked everything needs no unlinked report`, names);
    const table = names.find((name) => /table/iu.test(name));
    check(!!table, `${mode}: the PDF brief built a table of authorities`, names);
  }

  async function verifyWordOutputs(files, tabsAndFinal) {
    const names = Object.keys(files);
    note(mode, `docx-outputs-${tabsAndFinal ? "tabs" : "marks"}`, names);
    const word = files[names.find((name) => name.endsWith(".docx") && !name.endsWith(".table-of-authorities.docx"))];
    check(!!word, `${mode}: the Word brief has a Word copy`, names);
    if (!word) return;
    const docx = await readDocx(word), all = `${docx.xml}${docx.notes}`;
    const fields = [...all.matchAll(/TA \\l &quot;([^&]*)&quot;|TA \\l "([^"]*)"/gu)].map((match) => match[1] ?? match[2]);
    check(fields.length >= 5, `${mode}: the Word copy marks each authority with a TA field`, fields);
    check(/TOA \\h/u.test(all), `${mode}: the Word copy has a table of authorities field`);
    const references = [...`${docx.text}${docx.noteText}`.matchAll(/\[Tab \d+\]/gu)].map(([value]) => value);
    if (tabsAndFinal) {
      check(references.length >= 5, `${mode}: tab references follow the citations`, references);
      const final = files[names.find((name) => /final/iu.test(name))];
      check(!!final, `${mode}: the Word brief built a final PDF from the brief PDF`, names);
      const book = files[names.find((name) => /book-of-authorities\.pdf$/u.test(name))];
      if (final && book) {
        const pdf = await readPdf(final), bookPdf = await readPdf(book);
        const tabs = flatOutline(pdf.outline).filter(({ title }) => /^Tab\b/u.test(title));
        const bookTabs = flatOutline(bookPdf.outline).filter(({ title }) => /^Tab\b/u.test(title));
        check(pdf.pageCount === 2 + bookPdf.pageCount && tabs.length === 5 && tabs.every(({ page }, index) => page === bookTabs[index]?.page + 2),
          `${mode}: the final PDF is the brief PDF and then the book`, tabs.map(({ title, page }) => [title, page]));
        const all = pdf.pages.slice(0, 2).flatMap(({ annotations }) => annotations.filter(({ subtype }) => subtype === "Link"));
        // The brief's own web link stays; every other link is one the final PDF added inside it.
        const links = all.filter(({ url }) => !url);
        check(all.filter(({ url }) => url).map(({ url }) => url).join() === BRIEF.webLink, `${mode}: the brief PDF's own web link is kept`, all.map(({ url }) => url));
        check(links.length >= 5 && links.every(({ destinationPage }) => tabs.some(({ page }) => page === destinationPage)),
          `${mode}: the brief's tab references open their tabs`, links.map(({ destinationPage }) => destinationPage));
        // Built through Missing PDFs, the book is a draft finished elsewhere: no stamp, no draft title
        // or file name, no author or comment on a mark, and the missing PDF's tab keeps a page that
        // only names its authority.
        const stamped = [...bookPdf.pages, ...pdf.pages].filter(({ text }) => /INCOMPLETE|NOT FOR FILING|unavailable/iu.test(text))
          .map(({ number }) => number);
        check(!stamped.length && ![bookPdf.title, pdf.title, ...names].some((value) => /incomplete/iu.test(value)),
          `${mode}: the incomplete book carries no draft stamp, title or file name`, { stamped, titles: [bookPdf.title, pdf.title], names });
        const missing = bookTabs.find(({ title }) => /Lakeshore/u.test(title));
        check(/Lakeshore Rowing Club/u.test(bookPdf.pages[(missing?.page ?? 0) - 1]?.text ?? ""),
          `${mode}: the missing PDF's tab keeps a page naming its authority`, missing);
        const notes = [bookPdf, pdf].flatMap(({ pages }) => pages.flatMap(({ annotations }) => annotations.filter(({ note }) => note)));
        check(!notes.length, `${mode}: no mark in the Word brief's book carries an author or a comment`, notes.slice(0, 3));
      }
    } else check(!references.length, `${mode}: no tab references when only marking`, references);
  }
}
