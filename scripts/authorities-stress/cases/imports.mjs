// Briefs as a brand-new profile's first import, a real public judgment and a Word brief written
// the ways real ones are, each taken through every step to its delivered files.
import path from "node:path";
import { fixtureA2aj, VARIETY } from "../fixtures.mjs";
import { attach, build, dock, downloads, importBrief, outputsChange, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf } from "../outputs.mjs";
import { rows, walkReview } from "../review.mjs";

const PUBLIC = "benchmarks/legal-generalization-corpus/raw";
const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];

/** The Final PDF dialog's links, chosen, then built. */
async function finalPdf(app, { brief = null, shot = "final-pdf" } = {}) {
  await app.interact("open the Final PDF dialog", () => dock(app).getByRole("button", { name: /^(?:Set up|Final PDF options)$/u }).click(),
    { budget: BUDGETS.dialog });
  const dialog = app.page.getByRole("dialog", { name: "Final PDF" });
  await dialog.waitFor();
  for (const name of ["Citations to their tabs", "Pinpoints to the passage"]) {
    const box = dialog.getByRole("checkbox", { name });
    if (!await box.isChecked()) await app.interact(`tick ${name}`, () => box.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }));
  }
  if (brief) {
    // Without the brief saved as PDF the dialog says so calmly, and waits for it.
    app.record.check(await app.button("Build final PDF", dialog).isDisabled() && /Add your brief as PDF to build it/u.test(await dialog.innerText()),
      `${app.label}: the final PDF waits for the brief PDF, and says so`);
    await app.shots(`${shot}-without-brief`);
    await app.pick(() => app.button("Upload the brief PDF", dialog).click(), [brief]);
    await app.button("Replace the brief PDF", dialog).waitFor();
  }
  await app.shots(shot);
  return dialog;
}

export const IMPORT_CASES = [{
  name: "first-pdf",
  title: "A public SCC judgment as a new profile's first import (file:// and http), through Build and the final PDF",
  async run({ open, record, renderer, root }) {
    const brief = path.join(root, PUBLIC, "ca-case-2014-scc-bhasin-v-hrynew.pdf");
    for (const mode of ["http", "file"]) {
      const app = await open({ mode, network: { a2aj: fixtureA2aj() } });
      await app.load();
      if (mode === "file") await app.shots("start");
      await importBrief(app, brief, { first: true, shot: mode === "file" ? "import-options" : null });
      if (mode === "http") { await app.close(); continue; }
      await app.shots("review");
      await walkReview(app, "review", { arrows: 12 });
      await step(app, "Sources", { via: "next" });
      await app.idle();
      await app.shots("sources");
      await step(app, "Highlights", { via: "next" });
      await app.shots("highlights");
      await step(app, "Build book", { via: "next" });
      await app.shots("build");
      await build(app, "book", { missing: /./u, shot: "missing-pdfs", budget: 8000 });
      await app.shots("built");
      const book = pick(await downloads(app, "book"), /book-of-authorities\.pdf$/u);
      const pdf = await checkPdf(record, "book", book, { unprinted: ["ca-case-2014-scc-bhasin-v-hrynew"] });
      record.check(pdf.tabs.length > 50, "the judgment's authorities each have a tab", pdf.tabs.length);
      await renderer.sheet(book, path.join(record.out, "book.jpg"), { first: 4, last: 4 });
      const dialog = await finalPdf(app);
      await build(app, "final", { start: () => app.button("Build final PDF", dialog).click(), budget: 10000 });
      const final = pick(await downloads(app, "final"), /\.final\.pdf$/u);
      const merged = await checkPdf(record, "final", final);
      record.check(merged.pages > pdf.pages, "the final PDF is the brief and then the book", [merged.pages, pdf.pages]);
      record.check(merged.links.some(({ url }) => !url), "the final PDF links citations into the book", merged.links.length);
      await renderer.sheet(final, path.join(record.out, "final.jpg"), { first: 4 });
      await app.close();
    }
  },
}, {
  name: "first-docx",
  title: "A Word brief with numbering, styles, a table, tracked changes, a hyperlink and split runs, first import, to Word and the final PDF",
  async run({ open, record, fixtures, renderer, word }) {
    for (const mode of ["http", "file"]) {
      const app = await open({ mode, network: { a2aj: fixtureA2aj() } });
      await app.load();
      await importBrief(app, fixtures.varietyDocx, { first: true });
      const listed = (await rows(app).allInnerTexts()).join("\n");
      for (const name of ["Jordan", "Vavilov", "Waterways", "Lakeshore"])
        record.check(listed.includes(name), `${mode}: the Word brief's ${name} citation is listed`, listed);
      record.check(!listed.includes("Oakes"), `${mode}: a citation deleted with tracked changes is not listed`, listed);
      if (mode === "http") { await app.close(); continue; }
      await app.shots("review");
      await walkReview(app, "review", { arrows: 6, clicks: 2 });
      await step(app, "Sources", { via: "next" });
      await app.idle();
      await attach(app, "Waterways Licensing Act", fixtures.statute);
      await app.shots("sources");
      await step(app, "Highlights", { via: "next" });
      await step(app, "Build book", { via: "next" });
      const copy = app.page.getByRole("group", { name: "Word copy" }), references = app.page.getByRole("group", { name: "Tab references" });
      await app.interact("choose the marked copy and table", () => copy.getByRole("radio", { name: "Marked copy and table" })
        .locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }), { shiftsOk: outputsChange });
      await app.interact("choose [Tab 1]", () => references.getByRole("radio", { name: "[Tab 1]" })
        .locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }));
      await app.idle();
      await app.interact("Create both", () => app.page.getByLabel("Create").selectOption("both"), { shiftsOk: outputsChange }); await app.idle();
      await app.shots("build");
      await build(app, "book and copy", { missing: /Lakeshore/u, budget: 4000 });
      const files = await downloads(app, "outputs");
      const copyFile = pick(files, /with-table-of-authorities\.docx$/u), table = pick(files, /\.table-of-authorities\.docx$/u);
      record.check(copyFile && table, "the Word brief builds its Word copy and table", Object.keys(files));
      if (copyFile) word.push({ record, file: copyFile, expect: { ta: 4, toa: true, tabs: 4, toaHas: ["Jordan", "Vavilov"] } });
      if (table) word.push({ record, file: table, expect: { lists: ["Jordan"], table: true, italics: ["Jordan"] } });
      const book = pick(files, /book-of-authorities\.pdf$/u);
      await checkPdf(record, "book", book, { unprinted: ["harbour-factum"] });
      await renderer.sheet(book, path.join(record.out, "book.jpg"), { first: 3, last: 3 });
      const dialog = await finalPdf(app, { brief: fixtures.varietyPdf });
      await build(app, "final", { start: () => app.button("Build final PDF", dialog).click(), missing: /Lakeshore/u, budget: 4000 });
      const final = pick(await downloads(app, "final"), /\.final\.pdf$/u);
      const merged = await checkPdf(record, "final", final);
      record.check(merged.links.some(({ url }) => url === VARIETY.webLink), "the brief's own web link is kept", merged.links.map(({ url }) => url).filter(Boolean));
      await renderer.sheet(final, path.join(record.out, "final.jpg"), { first: 3 });
      await app.close();
    }
  },
}, {
  name: "unusual-inputs",
  title: "Damaged Word files, a US opinion and a US memo: a clear message or a review, and the page stays usable",
  async run({ open, record, root }) {
    const app = await open({});
    await app.load();
    // A body naming styles its style part lacks still reads (that contract cites nothing); a broken body or zip does not.
    const inputs = [...[["corrupt-style.docx", "uncited"], ["malformed-body.docx", "damaged"], ["truncated.docx", "damaged"]].map(([name, kind]) =>
      [path.join(root, "benchmarks/docx_edit/fixtures/real", name), kind]),
    [path.join(root, PUBLIC, "us-court-opinion-ilnd-05-cv-03198.pdf"), "foreign"],
    [path.join(root, "benchmarks/harvey-labs/tasks/antitrust-competition/draft-antitrust-complaint/documents/legal-research-memo.docx"), "foreign"]];
    for (const [file, kind] of inputs) {
      if (await app.button("New").isEnabled()) await app.button("New").click();
      await app.pick(() => app.button("Add file").click(), [file]);
      const setup = app.page.getByRole("dialog", { name: "Import options" });
      await setup.waitFor();
      const started = await app.now();
      await app.button("Import and review").click();
      // A review, a review that found no citation, or the dialog saying why it could not import.
      const outcome = await Promise.race([
        app.page.locator(".citation-document .citation-band[data-active]").first().waitFor({ timeout: 30_000 }).then(() => "review"),
        app.page.getByText("No citations found.").waitFor({ timeout: 30_000 }).then(() => "no citations"),
        setup.getByRole("status").filter({ hasText: /\w/u }).waitFor({ timeout: 30_000 }).then(() => "message"),
      ]).catch(() => "nothing");
      const said = outcome === "message" ? await setup.getByRole("status").filter({ hasText: /\w/u }).innerText() : "";
      record.note(path.basename(file), { outcome, ms: Math.round(await app.now() - started), said, citations: outcome === "review" ? await rows(app).count() : 0 });
      record.check(outcome !== "nothing", `${path.basename(file)}: the import ends in a review or a message`);
      if (kind === "damaged") record.check(outcome === "message" && /invalid|corrupt|readable/iu.test(said),
        `${path.basename(file)}: a damaged Word file is named as such`, said || outcome);
      if (kind === "uncited") record.check(outcome === "no citations", `${path.basename(file)}: a readable file that cites nothing says so`, said || outcome);
      await app.shots(path.basename(file, path.extname(file)));
      if (outcome === "message") {
        await app.page.keyboard.press("Escape");
        await setup.waitFor({ state: "detached" });
        record.check(await app.button("Add file").isEnabled(), `${path.basename(file)}: the page stays usable after it`);
      }
    }
    await app.close();
  },
}];
