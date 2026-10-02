// Stress: a long real article replayed from its recorded lookups, a book of nearly 900 pages
// rebuilt from a statute's text, a brief with more than a hundred authorities, several scans read
// at once and a reload while they are read, edits made while slow sources are still gathering, and
// builds repeated, cancelled and rebuilt.
import path from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { briefHtml, fixtureA2aj, longBrief } from "../fixtures.mjs";
import { attach, build, dock, downloads, importBrief, row, setOption, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf } from "../outputs.mjs";
import { loadHar } from "../network.mjs";
import { addAndRemove, REVIEW_REGIONS, rows, walkReview } from "../review.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
const SOURCES_REGIONS = { list: "[aria-label='Authority tab slots']", steps: "[role=tablist][aria-label='Book steps']" };
/** A delivered file too big to keep once it has been read back. */
const discard = async (record, file) => { if (file && (await stat(file)).size > 5_000_000) { record.note(`discarded ${path.basename(file)}`, `${((await stat(file)).size / 1e6).toFixed(1)} MB`); await rm(file); } };
/** Frames sampled while the editor moves through `count` sources. */
async function switchSources(app, count) {
  const editor = app.page.getByRole("dialog", { name: "Highlights" });
  const ready = () => app.page.waitForFunction(() => document.querySelector("aside[aria-label=Highlights]")?.getAttribute("aria-busy") === "false",
    null, { timeout: 60_000 });
  for (let index = 0; index < count; index += 1)
    await app.interact(`editor: next source ${index + 1}`, () => editor.getByRole("button", { name: /^Next authority/u }).click(),
      { regions: { pdf: ["dialog section[aria-label='Authority PDF editor']", "paint"], heading: "aside[aria-label=Highlights] h2" }, wait: ready, rest: 300 });
}

export const STRESS_CASES = [{
  name: "long-article",
  needs: ["article"],
  title: "A long real article (393 citations, 108 authorities), A2AJ and publishers replayed from its recorded lookups",
  async run({ open, local, record, renderer }) {
    const har = await loadHar(local.article.har);
    const app = await open({ network: { har } });
    await app.load();
    await importBrief(app, local.article.pdf, { budget: 8000 });
    await app.shots("review");
    await walkReview(app, "review", { arrows: 15, clicks: 6 });
    await addAndRemove(app, "review", "Standing Committee on Justice and Human Rights");
    const sources = await app.now();
    await step(app, "Sources", { via: "next", budget: 3000 });
    await app.idle(180_000);
    record.note("to Sources", await app.now() - sources);
    await app.backgroundTasks(sources, "gathering");
    await app.shots("sources");
    // The long list scrolled through, every frame sampled.
    await app.interact("scroll the sources", async () => {
      for (let step = 0; step < 12; step += 1) { await app.page.mouse.wheel(0, 600); await app.page.waitForTimeout(40); }
    }, { regions: SOURCES_REGIONS, budget: BUDGETS.inputToPaint * 2 });
    await app.page.locator(".authorities-workspace").evaluate((element) => element.scrollTo(0, 0));
    await step(app, "Highlights", { via: "next" });
    await app.interact("open the editor", () => app.button("Edit in PDF").click(), { budget: BUDGETS.dialog,
      wait: () => app.page.getByRole("dialog", { name: "Highlights" }).locator(".pdf-text-layer").first().waitFor({ timeout: 60_000 }) });
    await switchSources(app, 8);
    await app.shots("editor");
    await app.page.getByRole("dialog", { name: "Highlights" }).getByRole("button", { name: "Close highlights" }).click();
    await step(app, "Build book", { via: "next" });
    await app.shots("build");
    const first = await build(app, "book", { missing: /./u, budget: 90_000, shot: "missing-pdfs" });
    const files = await downloads(app, "book"), book = pick(files, /book-of-authorities\.pdf$/u);
    const pdf = await checkPdf(record, "book", book);
    record.check(pdf.tabs.length >= 100, "the article's authorities each have a tab", pdf.tabs.length);
    const code = pdf.tabs.find(({ title }) => /Criminal Code/u.test(title));
    record.check(code && pdf.outline.filter(({ depth }) => depth > code.depth).length > 100, "the rebuilt Criminal Code keeps its structure in the bookmarks");
    await renderer.sheet(book, path.join(record.out, "book.jpg"), { first: 4, pages: code ? [1, 2, 3, code.page, code.page + 1] : undefined });
    await discard(record, book);
    // The same book again, nothing changed: what a rebuild costs.
    const again = await build(app, "book again", { missing: /./u, budget: 30_000 });
    record.note("first build and rebuild", { first: Math.round(first), again: Math.round(again) });
    await app.close();
  },
}, {
  name: "big-statute",
  needs: ["article"],
  title: "A book of nearly 900 pages: the Criminal Code rebuilt from its text, its cited sections marked",
  async run({ open, local, record, renderer, browser }) {
    const har = await loadHar(local.article.har);
    // An invented brief that cites the public Code; its text is what A2AJ answered when recorded.
    const brief = path.join(record.out, "code-brief.pdf"), page = await browser.newPage();
    await page.setContent(briefHtml({ title: "Memorandum on Intoxication", paragraphs: [
      { text: "1. The accused relies on the defence of mental disorder.", note: "Criminal Code, RSC 1985, c C-46, s 16." },
      { text: "2. Self-induced intoxication is addressed by statute.", note: "Criminal Code, RSC 1985, c C-46, s 33.1." },
      { text: "3. The Code's general part applies.", note: "Ibid, s 8." }] }));
    await writeFile(brief, await page.pdf({ preferCSSPageSize: true })); await page.close();
    const app = await open({ network: { har } });
    await app.load();
    await importBrief(app, brief);
    await step(app, "Sources", { via: "next", budget: 5000 });
    await app.idle(120_000);
    await app.shots("sources");
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await build(app, "code book", { missing: null, budget: 60_000 });
    const book = pick(await downloads(app, "book"), /book-of-authorities\.pdf$/u);
    const pdf = await checkPdf(record, "code book", book, { tabs: 1, marks: true });
    record.check(pdf.pages > 800, "the whole Code is rebuilt", pdf.pages);
    record.check(pdf.outline.length > 1000, "its Parts, headings and sections are bookmarked", pdf.outline.length);
    const marked = [...new Set(pdf.marks.map(({ page }) => page))];
    record.note("marked pages", marked);
    const sections = (number) => pdf.text.findIndex((text) => new RegExp(`(?:^|\\n)${number.replace(".", "\\.")}\\s?\\(1\\)|(?:^|\\n)${number.replace(".", "\\.")} `, "u").test(text)) + 1;
    for (const section of ["16", "33.1"]) {
      const at = sections(section);
      record.check(at && marked.some((page) => Math.abs(page - at) <= 1), `s ${section} is marked where it is printed`, { at, marked: marked.slice(0, 10) });
    }
    await renderer.sheet(book, path.join(record.out, "code-book.jpg"), { pages: [1, 2, 3, ...marked.slice(0, 5)] });
    await discard(record, book);
    await app.close();
  },
}, {
  name: "many-authorities",
  title: "A brief citing 120 authorities (cases, statutes, articles): import, review, sources, build and the Word table",
  async run({ open, fixtures, record, renderer, word }) {
    const app = await open({ network: { a2aj: fixtures.long.a2aj } });
    await app.load();
    await importBrief(app, fixtures.longPdf, { budget: 8000 });
    await app.shots("review");
    const count = await walkReview(app, "review", { arrows: 12, clicks: 8 });
    // One citation a note, whether in full, by ibid or by supra.
    record.check(count === fixtures.long.paragraphs.length, "every citation of the long brief is listed", [count, fixtures.long.paragraphs.length]);
    const sources = await app.now();
    await step(app, "Sources", { via: "next", budget: 3000 });
    await app.idle(120_000);
    await app.backgroundTasks(sources, "gathering");
    const slots = await app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem").count();
    record.check(slots === fixtures.long.authorities.length, "each authority has one tab slot", [slots, fixtures.long.authorities.length]);
    await app.shots("sources");
    await app.interact("scroll the sources", async () => {
      for (let step = 0; step < 12; step += 1) { await app.page.mouse.wheel(0, 600); await app.page.waitForTimeout(40); }
    }, { regions: SOURCES_REGIONS, budget: BUDGETS.inputToPaint * 2 });
    await app.page.locator(".authorities-workspace").evaluate((element) => element.scrollTo(0, 0));
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await app.interact("Create both", () => app.page.getByLabel("Create").selectOption("both"), { shiftsOk: () => true }); await app.idle();
    const ms = await build(app, "book and table", { missing: /./u, budget: 30_000 });
    record.note("build of 120 authorities", ms);
    const files = await downloads(app, "outputs"), book = pick(files, /book-of-authorities\.pdf$/u);
    const pdf = await checkPdf(record, "long book", book, { tabs: fixtures.long.authorities.length, marks: true });
    await renderer.sheet(book, path.join(record.out, "long-book.jpg"), { first: 4, pages: [1, 2, 3, 4, pdf.tabs[10]?.page, pdf.tabs[60]?.page].filter(Boolean) });
    const table = pick(files, /table-of-authorities\.docx$/u);
    // The table opens with the cases in alphabetical order: the first of them is on its first page.
    const first = fixtures.long.authorities.filter(({ kind }) => kind === "case").map(({ name }) => name).sort()[0];
    if (table) word.push({ record, file: table, expect: { lists: [first] } });
    await discard(record, book);
    // The same brief as Word, imported in a profile of its own.
    const docx = await open({ network: { a2aj: fixtures.long.a2aj }, label: "docx" });
    await docx.load();
    await importBrief(docx, fixtures.longDocx, { budget: 6000 });
    record.check(await rows(docx).count() === fixtures.long.paragraphs.length, "the Word brief lists every citation too",
      [await rows(docx).count(), fixtures.long.paragraphs.length]);
    await docx.close();
    await app.close();
  },
}, {
  name: "scans",
  title: "Four scans recognized at once: progress, pause, cancel and resume, a reload while they are read, and their marks",
  async run({ open, fixtures, record, renderer }) {
    const app = await open({});
    await app.load();
    await app.page.getByRole("tab", { name: "Manual" }).click();
    await app.page.getByRole("textbox").first().fill("Scanned decisions");
    const files = fixtures.scans.map(({ file }) => file);
    const started = await app.now();
    await app.pick(() => app.button("Add files").click(), files);
    await app.page.waitForFunction((count) => document.querySelectorAll("[aria-label='Authority tab slots'] > [role=listitem]").length === count,
      files.length, { timeout: 60_000 });
    // Several read at once: one recognizing, the rest waiting their turn, every row keeping its height.
    const status = () => app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("status").allInnerTexts();
    await app.page.waitForFunction(() => [...document.querySelectorAll("[aria-label='Authority tab slots'] [role=status]")]
      .some((item) => /Recognizing|Waiting/u.test(item.textContent)), null, { timeout: 30_000 });
    record.note("recognition", await status());
    await app.shots("scans-recognizing");
    const pause = app.page.getByRole("button", { name: /^Pause text recognition for/u }).first();
    if (await pause.count()) {
      await app.interact("pause a recognition", () => pause.click());
      await app.page.getByRole("button", { name: /^Resume text recognition for/u }).first().waitFor();
      await app.interact("resume it", () => app.page.getByRole("button", { name: /^Resume text recognition for/u }).first().click());
    }
    // A reload while the scans are read: the draft comes back and recognition goes on.
    await app.reload({ until: () => app.page.getByRole("list", { name: "Authority tab slots" }).waitFor({ timeout: 60_000 }) });
    const regions = { list: "[aria-label='Authority tab slots']" };
    await app.interact("wait for every scan to be read", () => app.page.waitForFunction((count) =>
      [...document.querySelectorAll("[aria-label='Authority tab slots'] [role=status]")].filter((item) => /complete|Recognized/u.test(item.textContent)).length === count ||
      ![...document.querySelectorAll("[aria-label='Authority tab slots'] [role=status]")].some((item) => /Recogniz|Waiting|Paused/u.test(item.textContent)),
    files.length, { timeout: 180_000, polling: 250 }), { regions, budget: 1000 });
    record.note("all scans read", await app.now() - started);
    record.check(!(await status()).some((text) => /failed|could not/iu.test(text)), "every scan is read", await status());
    await app.backgroundTasks(started, "recognition");
    await app.shots("scans-read");
    await step(app, "Highlights", { via: "next" });
    await app.button("Edit in PDF").click();
    const editor = app.page.getByRole("dialog", { name: "Highlights" });
    await editor.locator(".pdf-text-layer").first().waitFor({ timeout: 30_000 });
    await app.page.waitForFunction(() => [...document.querySelectorAll("dialog .pdf-text-layer")].some((layer) => layer.textContent.trim().length > 40),
      null, { timeout: 30_000 }).catch(() => {});
    const recognized = await app.page.evaluate(() => [...document.querySelectorAll("dialog .pdf-text-layer")].map((layer) => layer.textContent).join(" "));
    record.check(/\[\d+\] The court considered/u.test(recognized), "a scan's recognized text is in the editor", recognized.slice(0, 160));
    await app.shots("scan-editor");
    await editor.getByRole("button", { name: "Close highlights" }).click();
    await step(app, "Build book", { via: "next" });
    await build(app, "scanned book", { budget: 30_000 });
    const book = pick(await downloads(app, "book"), /\.pdf$/u);
    const pdf = await checkPdf(record, "scanned book", book, { tabs: files.length });
    record.check(pdf.text.filter((text) => /The court considered/u.test(text)).length >= files.length, "the book's scans carry their recognized text",
      pdf.text.map((text) => text.length));
    await renderer.sheet(book, path.join(record.out, "scanned-book.jpg"), { first: 6 });
    await app.close();
  },
}, {
  name: "slow-a2aj",
  title: "Edits made fast while slow A2AJ answers still gather the sources; Next waits, nothing is lost",
  async run({ open, record, browser }) {
    const long = longBrief(18), brief = path.join(record.out, "slow-brief.pdf"), page = await browser.newPage();
    await page.setContent(briefHtml(long)); await writeFile(brief, await page.pdf({ preferCSSPageSize: true })); await page.close();
    const app = await open({ network: { a2aj: long.a2aj, slow: 700 } });
    await app.load();
    await importBrief(app, brief);
    // Gathering has started; edit at once, fast, while it runs.
    const list = rows(app), before = await list.count();
    for (let index = 0; index < 8; index += 1)
      await app.interact(`ArrowDown while gathering ${index + 1}`, () => app.page.keyboard.press("ArrowDown"), { regions: REVIEW_REGIONS, rest: 40 });
    await list.nth(4).click(); await app.page.locator(".citation-review").focus();
    await app.interact("Delete while gathering", () => app.page.keyboard.press("Delete"), { shiftsOk: ({ sources }) => sources.every(({ list }) => list) });
    await list.nth(9).click(); await app.page.locator(".citation-review").focus();
    await app.interact("Delete another", () => app.page.keyboard.press("Delete"), { shiftsOk: ({ sources }) => sources.every(({ list }) => list) });
    await app.interact("Ctrl+Z", () => app.page.keyboard.press("Control+z"), { shiftsOk: ({ sources }) => sources.every(({ list }) => list) });
    const edited = await list.allInnerTexts();
    record.check(edited.length === before - 1, "one deletion stands, one is undone", [before, edited.length]);
    const pending = app.log.filter(({ url }) => url.includes("api.a2aj.ca")).length;
    record.note("A2AJ answered before Next", pending);
    // Next waits for the sources still gathering, the review held still meanwhile.
    const next = await app.now();
    await step(app, "Sources", { via: "next", budget: 60_000 });
    await app.idle(120_000);
    record.note("Next to Sources while gathering", await app.now() - next);
    await app.backgroundTasks(next, "waiting for sources");
    await app.page.getByRole("tab", { name: "Citations" }).click();
    await app.page.locator(".citation-document .citation-band[data-active]").first().waitFor();
    record.check(JSON.stringify(await list.allInnerTexts()) === JSON.stringify(edited), "the edits made while gathering are all kept", (await list.allInnerTexts()).length);
    await app.page.getByRole("tab", { name: "Sources" }).click();
    const marks = await app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem")
      .evaluateAll((items) => items.map((item) => item.querySelector("[role=img]")?.getAttribute("aria-label") ?? ""));
    record.check(marks.filter((mark) => /Built from source text/u.test(mark)).length >= long.authorities.filter(({ record: found }) => found).length - 1,
      "the slow answers all arrived as sources", marks);
    record.check(!marks.some((mark) => /couldn't be reached|took too long/u.test(mark)), "nothing is reported unreachable", marks);
    await app.shots("slow-sources");
    await app.close();
  },
}, {
  name: "repeated-builds",
  title: "Five builds in a row, one cancelled, a setting changed between: each current, each as quick, none different",
  async run({ open, fixtures, record }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.briefPdf);
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await attach(app, "Lakeshore", fixtures.scan);
    await row(app, "Lakeshore").getByRole("status").filter({ hasText: "Text recognition complete" }).waitFor({ timeout: 30_000 });
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    const times = [], pages = [];
    for (let index = 0; index < 5; index += 1) {
      times.push(Math.round(await build(app, `build ${index + 1}`, { budget: 2500 })));
      const book = pick(await downloads(app, `build-${index + 1}`), /book-of-authorities\.pdf$/u);
      pages.push((await checkPdf(record, `build ${index + 1}`, book, { tabs: 5 })).pages);
    }
    record.note("build times", times);
    record.check(new Set(pages).size === 1, "every build makes the same book", pages);
    record.check(Math.max(...times) < Math.min(...times) * 3 + 300, "builds stay as quick as the first", times);
    // A build cancelled as it starts says so, and the next one builds.
    await dock(app).getByRole("button", { name: "Build" }).click();
    await dock(app).getByRole("button", { name: "Cancel" }).click({ timeout: 5000 }).catch(() => {});
    await app.idle();
    const said = await app.page.locator("[role=tablist][aria-label='Book steps'] ~ [data-tabs-actions] [role=status]").innerText();
    record.note("after cancel", said);
    record.check(!/could not|error|failed/iu.test(said), "a cancelled build reports nothing broken", said);
    // A setting changed after a build marks the outputs as those of the last build until built again.
    await setOption(app, "Tabs", "alpha");
    await app.idle();
    record.check(/Changed since this build/u.test(await dock(app).innerText()), "the dock says the outputs predate the change", await dock(app).innerText());
    await app.shots("changed-since");
    await build(app, "after the change", { budget: 2500 });
    const book = pick(await downloads(app, "lettered"), /book-of-authorities\.pdf$/u);
    const pdf = await checkPdf(record, "lettered", book, { tabs: 5 });
    record.check(pdf.tabs[0]?.title.startsWith("Tab A"), "the rebuilt book has the changed setting", pdf.tabs[0]?.title);
    await app.close();
  },
}];
