// The settings matrices: every court preset with each output it allows, the Word copy against the
// tab references, and missing sources against the scanned-PDF policy. Each combination is built and
// what it delivers is opened.
import path from "node:path";
import { fixtureA2aj } from "../fixtures.mjs";
import { attach, build, chooseCourt, dock, downloads, importBrief, outputsChange, row, setOption, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf } from "../outputs.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
/** A fixture brief with its statute and recognized scan attached, at Build. */
async function toBuild(app, fixtures, { sourceMode, scan = true } = {}) {
  await importBrief(app, fixtures.briefPdf, { sourceMode });
  await step(app, "Sources", { via: "next" });
  await attach(app, "Waterways Licensing Act", fixtures.statute);
  if (scan) {
    await attach(app, "Lakeshore", fixtures.scan);
    await row(app, "Lakeshore").getByRole("status").filter({ hasText: "Text recognition complete" }).waitFor({ timeout: 30_000 });
  }
  await step(app, "Highlights", { via: "next" });
  await step(app, "Build book", { via: "next" });
  await dock(app).waitFor();
}
const create = (app) => app.page.getByLabel("Create");

export const SETTINGS_CASES = [{
  name: "courts",
  title: "Every court preset (none, Alberta King's Bench, Alberta Court of Appeal, Federal Court) with each output it allows",
  async run({ open, fixtures, record, renderer, word }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await toBuild(app, fixtures);
    const court = () => app.page.getByRole("button", { name: /^Court:/u });
    // No preset: a book, a table, or both.
    for (const mode of ["book", "table", "both"]) {
      await app.interact(`Create ${mode}`, () => create(app).selectOption(mode), { shiftsOk: outputsChange });
      await app.idle();
      await build(app, `general ${mode}`, { missing: null });
      const files = await downloads(app, `general-${mode}`);
      const book = pick(files, /book-of-authorities\.pdf$/u), table = pick(files, /table-of-authorities\.docx$/u);
      record.check(!!book === (mode !== "table") && !!table === (mode !== "book"), `no preset, ${mode}: builds what it names`, Object.keys(files));
      if (book) await checkPdf(record, `general ${mode}`, book, { tabs: 5, unprinted: ["harbourside-brief"] });
      if (table && mode === "table") word.push({ record, file: table, expect: { lists: ["Vavilov", "Waterways"], table: true,
        italics: ["Vavilov", "Waterways Licensing Act"] } });
    }
    await app.shots("general-both");
    // Alberta King's Bench: missing sources leave the book; every tab keeps its number.
    await chooseCourt(app, court(), "abkb", { shiftsOk: outputsChange });
    await app.idle();
    await app.shots("abkb");
    await build(app, "abkb", { missing: null });
    const abkb = pick(await downloads(app, "abkb"), /book-of-authorities\.pdf$/u);
    if (abkb) { await checkPdf(record, "abkb", abkb); await renderer.sheet(abkb, path.join(record.out, "abkb-book.jpg"), { first: 4 }); }
    // Alberta Court of Appeal: a table only, its entries linked to their sources.
    await chooseCourt(app, court(), "abca", { shiftsOk: outputsChange });
    await app.idle();
    record.check(await create(app).isDisabled() && await create(app).inputValue() === "table", "the Court of Appeal makes a table only",
      await create(app).inputValue());
    await app.shots("abca");
    await build(app, "abca", { missing: null });
    const abca = await downloads(app, "abca");
    record.check(!pick(abca, /book-of-authorities\.pdf$/u) && !!pick(abca, /table-of-authorities/u), "the Court of Appeal builds its table and no book", Object.keys(abca));
    const linked = pick(abca, /table-of-authorities\.docx$/u);
    if (linked) word.push({ record, file: linked, expect: { lists: ["Vavilov"], italics: ["Vavilov"] } });
    // Federal Court: its cover needs the court file and the parties, and who files.
    await chooseCourt(app, court(), "federal", { shiftsOk: outputsChange });
    await app.idle();
    if (await create(app).inputValue() === "table") await create(app).selectOption("book");
    await app.idle();
    await app.shots("federal");
    record.check(/Add the cover details to build/u.test(await dock(app).innerText()), "the Federal Court asks for its cover details", await dock(app).innerText());
    await app.interact("Build opens the cover details", () => app.button("Build", dock(app)).click(), { budget: BUDGETS.dialog });
    const cover = app.page.getByRole("dialog", { name: "Cover details" });
    await cover.waitFor();
    await cover.getByLabel("Court file number").fill("T-1234-31");
    const groups = cover.getByRole("region", { name: /^Party group/u });
    await groups.nth(0).getByLabel("Party names").fill("Harbourside Paddling Co-operative");
    await groups.nth(1).getByLabel("Party names").fill("Marsh Harbour Licensing Board");
    await app.shots("federal-cover");
    await app.button("Save cover", cover).click(); await app.idle();
    record.check(/Choose who is filing to build/u.test(await dock(app).innerText()), "then asks who is filing", await dock(app).innerText());
    await app.page.getByLabel("Filed by").selectOption("applicant"); await app.idle();
    await build(app, "federal", { missing: null });
    const federal = pick(await downloads(app, "federal"), /\.pdf$/u);
    if (federal) {
      const pdf = await checkPdf(record, "federal", federal);
      record.check(/T-1234-31/u.test(pdf.text[0]) && /Harbourside Paddling Co-operative/u.test(pdf.text[0]), "the federal cover names the file and the parties", pdf.text[0].slice(0, 400));
      await renderer.sheet(federal, path.join(record.out, "federal-book.jpg"), { first: 3, width: 420 });
    }
    await app.close();
  },
}, {
  name: "word-matrix",
  title: "A Word brief's copy (none, marks, marks and table) against its tab references (none, [Tab 1], your wording), each opened in Word",
  async run({ open, fixtures, record, word }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.briefDocx);
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    const copy = app.page.getByRole("group", { name: "Word copy" }), references = app.page.getByRole("group", { name: "Tab references" });
    const choose = async (group, name, exact = true) => {
      const option = group.getByRole("radio", { name, exact });
      if (!await option.isChecked()) await app.interact(`choose ${name}`, () => option.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }),
        { shiftsOk: outputsChange });
    };
    // The wording typed shows as it is inserted.
    const words = references.getByRole("textbox", { name: "Words before the tab number" });
    await words.fill("Respondent's Book of Authorities, Tab"); await words.press("Enter"); await app.idle();
    await app.interact("Create table", () => create(app).selectOption("table"), { shiftsOk: outputsChange }); await app.idle();
    for (const [mark, fields, table] of [["No marks", false, false], ["Marked copy", true, false], ["Marked copy and table", true, true]])
      for (const [reference, written] of [["None", null], ["[Tab 1]", /\[Tab \d+\]/u], ["Your wording", /\[Respondent.s Book of Authorities, Tab \d+\]/u]]) {
        await choose(copy, mark); await choose(references, reference); await app.idle();
        const label = `${mark} · ${reference}`;
        // A table alone has no book to miss a PDF from.
        await build(app, label, { missing: null });
        const files = await downloads(app, label.replace(/\W+/gu, "-"));
        const copyFile = Object.entries(files).find(([name]) => /\.docx$/u.test(name) && !/\.table-of-authorities\.docx$/u.test(name))?.[1];
        if (!fields && !written) { record.check(!copyFile, `${label}: no Word copy`, Object.keys(files)); continue; }
        record.check(!!copyFile, `${label}: a Word copy`, Object.keys(files));
        if (copyFile) word.push({ record, file: copyFile, expect: { ta: fields ? 5 : 0, toa: table, tabs: written ? 5 : 0, ...(written ? { text: written } : {}) } });
      }
    await app.shots("word-matrix");
    await app.close();
  },
}, {
  name: "sources-matrix",
  title: "Missing sources (keep the tab, leave out) against scanned PDFs (keep the scan, OCR cited pages, OCR every page)",
  async run({ open, fixtures, record, renderer }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    // Manual source handling leaves the three decisions A2AJ knows without a PDF.
    await toBuild(app, fixtures, { sourceMode: "manual" });
    for (const missing of ["placeholder", "omit"]) for (const scanned of ["page-margin", "cited-pages", "full"]) {
      await setOption(app, "Missing sources", missing);
      await setOption(app, "Scanned PDFs", scanned);
      await app.idle();
      const label = `${missing} · ${scanned}`;
      await build(app, label, { missing: 3, budget: 8000 });
      const book = pick(await downloads(app, `${missing}-${scanned}`), /book-of-authorities\.pdf$/u);
      if (!book) { record.check(false, `${label}: a book`); continue; }
      const pdf = await checkPdf(record, label, book, { tabs: missing === "omit" ? 2 : 5 });
      const scan = pdf.tabs.find(({ title }) => /Lakeshore/u.test(title));
      const scanText = scan ? pdf.text.slice(scan.page - 1, scan.page + 1).join(" ") : "";
      record.check(/\[22\] A board that departs/u.test(scanText) === (scanned !== "page-margin"),
        `${label}: the scan's cited page ${scanned === "page-margin" ? "stays an image" : "carries its recognized text"}`, scanText.slice(0, 160));
      if (missing === "placeholder") {
        const vavilov = pdf.tabs.find(({ title }) => /Vavilov/u.test(title));
        record.check(vavilov && /Vavilov/u.test(pdf.text[vavilov.page - 1]) && pdf.text[vavilov.page - 1].length < 600,
          `${label}: a missing PDF's tab keeps one page naming it`, vavilov && pdf.text[vavilov.page - 1].slice(0, 200));
      }
      if (scanned === "cited-pages") await renderer.sheet(book, path.join(record.out, `${missing}-book.jpg`), { first: 6 });
    }
    await app.shots("sources-matrix");
    await app.close();
  },
}];
