// Stress: a long real article replayed from its recorded lookups, a statute of nearly 900 pages
// rebuilt from its text and put in as an excerpt, a brief with more than a hundred authorities,
// several scans read at once and a reload while they are read, edits made while slow sources are
// still gathering, and builds repeated, cancelled and rebuilt.
import path from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { briefHtml, fixtureA2aj, LONG_STATUTE, longBrief, longStatuteRecord, NAVIGATION_ACT,
  navigationSubsection } from "../fixtures.mjs";
import { attach, build, dock, downloads, importBrief, row, setOption, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf, inspectPdf } from "../outputs.mjs";
import { loadHar } from "../network.mjs";
import { addAndRemove, chips, dragSelect, listChange, REVIEW_REGIONS, rows, walkReview } from "../review.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
const SOURCES_REGIONS = { list: "[aria-label='Authority tab slots']", steps: "[role=tablist][aria-label='Book steps']" };
/** A delivered file too big to keep once it has been read back. */
const discard = async (record, file) => { if (file && (await stat(file)).size > 5_000_000) { record.note(`discarded ${path.basename(file)}`, `${((await stat(file)).size / 1e6).toFixed(1)} MB`); await rm(file); } };
/** A statute row's book copy as it shows: its line, its Excerpt and Whole, and which is pressed. */
const statuteRow = (item) => {
  const group = () => item.getByRole("group", { name: /in the book$/u });
  return { item, line: item.getByText(/^The (?:title page|whole statute)/u), choice: (name) => group().getByRole("button", { name, exact: true }),
    pressed: async () => (await group().getByRole("button", { pressed: true }).allInnerTexts()).join(),
    /** Its line once the excerpt's pages are counted, from the readings prepared ahead. */
    counted: async (timeout) => { await item.getByText(/^The title page and .+ go in the book \(\d+ pages\)\.$/u).waitFor({ timeout });
      return item.getByText(/^The title page /u).innerText(); } };
};
const LIST = { list: "[aria-label='Authority tab slots']" };
const flat = (text) => text.replace(/\s+/gu, " "), words = (text) => flat(text).split(" ").slice(0, 9).join(" ");
/** An invented brief as a PDF: each paragraph with its note. */
async function briefPdf(browser, file, title, paragraphs) {
  const page = await browser.newPage();
  await page.setContent(briefHtml({ title, paragraphs: paragraphs.map(([text, note], index) => ({ text: `${index + 1}. ${text}`, note })) }));
  await writeFile(file, await page.pdf({ preferCSSPageSize: true })); await page.close();
  return file;
}
/** A book's tab bookmarks, each with the last page before the next. */
const tabRanges = (pdf) => pdf.tabs.map((tab, index) => ({ ...tab, last: (pdf.tabs[index + 1]?.page ?? pdf.pages + 1) - 1 }));
/** A book's tab holding a statute's excerpt: the pages its row counted (`said`), its title page and
 *  then only the marked pages its cited sections span, its range in the index, its bookmarks inside it. */
function checkExcerptTab(record, pdf, tab, said, label) {
  const pages = Array.from({ length: tab.last - tab.page + 1 }, (_, index) => tab.page + index);
  const marked = new Set(pdf.marks.map(({ page }) => page));
  record.check(pages.length === Number(/\((\d+) pages\)/u.exec(said)?.[1]), `${label}'s tab holds the pages its row counted`, [pages.length, said]);
  record.check(!marked.has(tab.page) && pages.slice(1).every((number) => marked.has(number)),
    `${label}'s tab is its title page and its cited sections' marked pages`, { pages, marked: pages.filter((number) => marked.has(number)) });
  record.check(pdf.text[1].includes(`${tab.page}–${tab.last}`), `the index gives ${label}'s pages as they are`, pdf.text[1].slice(0, 400));
  const at = pdf.outline.findIndex(({ title }) => title === tab.title);
  const own = pdf.outline.slice(at + 1).filter((_, index, rest) => rest.slice(0, index + 1).every(({ depth }) => depth > tab.depth));
  record.check(own.length && own.every(({ page }) => page >= tab.page && page <= tab.last), `${label}'s bookmarks all open its pages`,
    own.map(({ title, page }) => [title.slice(0, 30), page]).slice(0, 12));
}
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
    // A note's parliamentary evidence, which the import misses, added by hand with the mouse and
    // given the page its note writes after it, by P; Ctrl+Z takes back the pinpoint, then the citation.
    const evidence = "House of Commons, Standing Committee on Justice and Human Rights, Evidence, 44-1, No 035 (31 October 2022)";
    const listed = await rows(app).count();
    await dragSelect(app, evidence);
    await app.interact("add the evidence by hand", () => app.button("Add citation").click(), { shiftsOk: listChange });
    record.check((await app.page.locator(".citation-outline [role=option][aria-selected=true]").innerText()).replace(/\s+/gu, " ") === evidence,
      "the evidence becomes the selected citation");
    record.check(await dragSelect(app, "2 (Michele", { prefix: 1 }) === "2", "the pointer selects its page");
    await app.interact("P adds the page", async () => { await app.page.locator(".citation-review").focus(); await app.page.keyboard.press("p"); });
    // It shows at once; its kind once the save has read it.
    record.check(await app.page.locator(".citation-pins .citation-chip").count() === 1, "the pinpoint shows at once");
    await app.page.waitForFunction(() => document.querySelector(".citation-pins .citation-chip > button")?.textContent, null, { timeout: 30_000 }).catch(() => {});
    record.check(await chips(app) === "p.2", "the hand-added evidence takes its page as a pinpoint", await chips(app));
    for (const label of ["Ctrl+Z takes the page back", "Ctrl+Z takes the citation back"])
      await app.interact(label, async () => { await app.page.locator(".citation-review").focus(); await app.page.keyboard.press("Control+z"); },
        { shiftsOk: listChange });
    record.check(await rows(app).count() === listed, "the list is back as it was", [listed, await rows(app).count()]);
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
  title: "Statutes in the book as excerpts: one of nearly 900 pages rebuilt from its text, a forty-page Act uploaded and " +
    "linked into from the final PDF, and a one-page Act whole, each chosen on its row; the public Criminal Code too where its HAR is kept",
  async run({ open, fixtures, local, record, renderer, browser }) {
    // An invented brief citing an invented consolidation A2AJ serves as text, the e2e's one-page Act and a long Act uploaded.
    const big = `${LONG_STATUTE.name}, ${LONG_STATUTE.citation}`;
    const brief = await briefPdf(browser, path.join(record.out, "statutes-brief.pdf"), "Memorandum on Inland Waters", [
      ["A permit lapses when the vessel is sold.", `${big}, s 718.`],
      ["The registrar keeps the register of permits.", `${big}, s 33(2).`],
      ["An appeal lies to the minister.", `${big}, s 4718(2).`],
      ["A licence is not refused without notice.", "Waterways Licensing Act, SA 2031, c W-4, s 12(2)."],
      ["Every vessel is inspected before it is licensed.", `${NAVIGATION_ACT.name}, ${NAVIGATION_ACT.citation}, s 41(2).`]]);
    const statute = longStatuteRecord(), app = await open({ network: { a2aj: new Map([[LONG_STATUTE.citation, statute]]) } });
    await app.load();
    await importBrief(app, brief);
    // Next waits while the 900 pages are rebuilt from the statute's text.
    const sources = await app.now();
    await step(app, "Sources", { via: "next", budget: 30_000 });
    record.note("to Sources, the statute rebuilt", await app.now() - sources);
    await app.idle(120_000);
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await attach(app, NAVIGATION_ACT.name, fixtures.navigationAct);
    const [long, short, uploaded] = [LONG_STATUTE.name, "Waterways Licensing Act", NAVIGATION_ACT.name].map((name) => statuteRow(row(app, name)));
    record.check(await long.pressed() === "Excerpt" && await uploaded.pressed() === "Excerpt", "the long statutes default to Excerpt",
      [await long.pressed(), await uploaded.pressed()]);
    record.check(await short.pressed() === "Whole" && /^The whole statute goes in the book \(1 page\)\.$/u.test(await short.line.innerText()),
      "the one-page Act defaults to Whole and says how long it is", [await short.pressed(), await short.line.innerText()]);
    // An excerpt's count is read from the readings prepared ahead, into the line it already has.
    const waited = await app.now(), longLine = await long.counted(240_000), uploadedLine = await uploaded.counted(60_000);
    record.note("excerpt counts read after", await app.now() - waited);
    record.note("excerpt lines", [longLine, uploadedLine]);
    record.check(/^The title page and ss 718, 33\(2\), 4718\(2\) go in the book \(\d+ pages\)\.$/u.test(longLine),
      "the long statute's line names its sections as the brief writes them, in its order", longLine);
    record.check(/^The title page and s 41\(2\) go in the book \(\d+ pages\)\.$/u.test(uploadedLine), "the uploaded Act's line names its section", uploadedLine);
    await app.shots("statutes-excerpt");
    // Each choice shows in the frame after it, and nothing moves.
    await app.interact("the long statute: Whole", () => long.choice("Whole").click(), { regions: LIST });
    const whole = await long.line.innerText();
    record.check(await long.pressed() === "Whole" && /^The whole statute goes in the book \(\d{3} pages\)\.$/u.test(whole), "Whole counts every page", whole);
    await app.shots("statutes-whole");
    await app.interact("the long statute: back to Excerpt", () => long.choice("Excerpt").click(), { regions: LIST });
    record.check(await long.line.innerText() === longLine, "back to Excerpt, its count shows at once", await long.line.innerText());
    await app.interact("the one-page Act: Excerpt", () => short.choice("Excerpt").click(), { regions: LIST });
    await app.interact("the one-page Act: back to Whole", () => short.choice("Whole").click(), { regions: LIST });
    // From the keyboard, the same.
    await long.choice("Whole").focus();
    await app.interact("the long statute: Whole by Enter", () => app.page.keyboard.press("Enter"), { regions: LIST });
    await long.choice("Excerpt").focus();
    await app.interact("the long statute: Excerpt by Space", () => app.page.keyboard.press("Space"), { regions: LIST });
    record.check(await long.pressed() === "Excerpt" && await short.pressed() === "Whole", "the choices end where they began",
      [await long.pressed(), await short.pressed()]);
    record.note("choices: input-to-paint ms, shift, long tasks", app.interactions.filter(({ label }) => / statute: | Act: /u.test(label))
      .map(({ label, inputToPaint, shift, longTasks }) => [label, Math.round(inputToPaint), shift, longTasks.length]));
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    // The book and the final PDF, its citations linked to their tabs and pinpoints.
    await app.button("Set up", dock(app)).click();
    const final = app.page.getByRole("dialog", { name: "Final PDF" });
    for (const name of ["Citations to their tabs", "Pinpoints to the passage"]) {
      const box = final.getByRole("checkbox", { name });
      if (!await box.isChecked()) await box.locator("xpath=ancestor::label[1]").click();
    }
    await build(app, "excerpt book", { missing: null, budget: 60_000, start: () => app.button("Build final PDF", final).click() });
    const files = await downloads(app, "excerpts");
    const book = pick(files, /book-of-authorities\.pdf$/u), finalPdf = pick(files, /final\.pdf$/u);
    const pdf = await checkPdf(record, "excerpt book", book, { tabs: 3, marks: true });
    const [longTab, shortTab, uploadedTab] = tabRanges(pdf);
    checkExcerptTab(record, pdf, longTab, longLine, "the long statute");
    checkExcerptTab(record, pdf, uploadedTab, uploadedLine, "the uploaded Act");
    // The words each cited subsection opens with, as printed.
    const subsection = (number, sub) => words(statute.unofficial_text_en.split(`**${number}** `)[1].split("\n\n")[sub - 1]);
    const longText = flat(pdf.text.slice(longTab.page - 1, longTab.last).join(" "));
    record.check(/Inland Waters Consolidation Act/u.test(pdf.text[longTab.page - 1]) && longTab.last - longTab.page < 20,
      "the long statute opens on its title page", pdf.text[longTab.page - 1].slice(0, 160));
    for (const [number, sub] of [[718, 1], [33, 2], [4718, 2]]) record.check(longText.includes(subsection(number, sub)),
      `s ${number}${sub > 1 ? `(${sub})` : ""} is printed in the long statute's tab`, subsection(number, sub));
    record.check(shortTab.last === shortTab.page, "the one-page Act goes in whole", [shortTab.page, shortTab.last]);
    // The final PDF is the brief and then the book: the s 41(2) pinpoint opens its page inside the uploaded Act's excerpt.
    const combined = await inspectPdf(finalPdf), front = combined.pages - pdf.pages;
    const pinpoint = combined.links.find(({ page, destinationPage }) => page <= front && destinationPage > uploadedTab.page + front &&
      destinationPage <= uploadedTab.last + front && flat(combined.text[destinationPage - 1]).includes(words(navigationSubsection(41, 2))));
    record.check(!!pinpoint, "the final PDF's s 41(2) pinpoint opens its page inside the uploaded Act's excerpt",
      combined.links.filter(({ page }) => page <= front).map(({ destinationPage }) => destinationPage));
    await renderer.sheet(book, path.join(record.out, "excerpt-book.jpg"), { pages: [2, longTab.page, longTab.page + 1, longTab.page + 2,
      uploadedTab.page, uploadedTab.page + 1] });
    await app.close();
    if (!local.article) return record.note("the Criminal Code", "skipped: its HAR is not kept");
    // The public Criminal Code, rebuilt from the text A2AJ answered when recorded: an excerpt, then whole.
    const codeBrief = await briefPdf(browser, path.join(record.out, "code-brief.pdf"), "Memorandum on Intoxication", [
      ["The accused relies on the defence of mental disorder.", "Criminal Code, RSC 1985, c C-46, s 16."],
      ["Self-induced intoxication is addressed by statute.", "Criminal Code, RSC 1985, c C-46, s 33.1."],
      ["The Code's general part applies.", "Criminal Code, RSC 1985, c C-46, s 8."]]);
    const code = await open({ network: { har: await loadHar(local.article.har) }, label: "code" });
    await code.load();
    await importBrief(code, codeBrief);
    await step(code, "Sources", { via: "next", budget: 5000 });
    await code.idle(120_000);
    const criminal = statuteRow(row(code, "Criminal Code"));
    record.check(await criminal.pressed() === "Excerpt", "the Criminal Code defaults to Excerpt", await criminal.pressed());
    const codeLine = await criminal.counted(240_000);
    record.check(/^The title page and ss 16, 33\.1, 8 go in the book \(\d+ pages\)\.$/u.test(codeLine), "the Code's line names its sections", codeLine);
    await code.shots("code-excerpt");
    await step(code, "Highlights", { via: "next" });
    await step(code, "Build book", { via: "next" });
    await build(code, "code excerpt", { missing: null, budget: 60_000 });
    const excerpt = await checkPdf(record, "code excerpt", pick(await downloads(code, "code-excerpt"), /book-of-authorities\.pdf$/u),
      { tabs: 1, marks: true });
    checkExcerptTab(record, excerpt, tabRanges(excerpt)[0], codeLine, "the Criminal Code");
    // Chosen whole, all of it with its structure.
    await step(code, "Sources");
    await code.interact("the Code: Whole", () => criminal.choice("Whole").click(), { regions: LIST });
    await step(code, "Build book");
    await build(code, "whole code", { missing: null, budget: 60_000 });
    const wholeBook = pick(await downloads(code, "whole-code"), /book-of-authorities\.pdf$/u);
    const codePdf = await checkPdf(record, "whole code", wholeBook, { tabs: 1, marks: true });
    record.check(codePdf.pages > 800, "the whole Code is rebuilt", codePdf.pages);
    record.check(codePdf.outline.length > 1000, "its Parts, headings and sections are bookmarked", codePdf.outline.length);
    const marked = [...new Set(codePdf.marks.map(({ page }) => page))];
    const sections = (number) => codePdf.text.findIndex((text) => new RegExp(`(?:^|\\n)${number.replace(".", "\\.")}\\s?\\(1\\)|(?:^|\\n)${number.replace(".", "\\.")} `, "u").test(text)) + 1;
    for (const section of ["16", "33.1"]) {
      const at = sections(section);
      record.check(at && marked.some((page) => Math.abs(page - at) <= 1), `s ${section} is marked where it is printed`, { at, marked: marked.slice(0, 10) });
    }
    await renderer.sheet(wholeBook, path.join(record.out, "code-book.jpg"), { pages: [1, 2, 3, ...marked.slice(0, 5)] });
    await discard(record, wholeBook);
    await code.close();
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
    // A setting changed after a build, then built again.
    await setOption(app, "Tabs", "alpha");
    await app.idle();
    await build(app, "after the change", { budget: 2500 });
    const book = pick(await downloads(app, "lettered"), /book-of-authorities\.pdf$/u);
    const pdf = await checkPdf(record, "lettered", book, { tabs: 5 });
    record.check(pdf.tabs[0]?.title.startsWith("Tab A"), "the rebuilt book has the changed setting", pdf.tabs[0]?.title);
    await app.close();
  },
}];
