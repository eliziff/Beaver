// Pinpoints added as a reader adds them: a citation chosen, its pinpoint dragged across with the
// mouse wherever its note writes it, then "+ Pinpoint" or P. A citation the import missed, added
// by hand, is identified from its own text and takes pinpoints as any other; every review edit is
// taken back by Ctrl+Z and made again by Ctrl+Shift+Z or Ctrl+Y; and what is left after a reload
// reaches the book and the table.
import path from "node:path";
import { readDocx } from "../../authorities-html-e2e/outputs.mjs";
import { fixtureA2aj, GUIDANCE } from "../fixtures.mjs";
import { build, downloads, importBrief, outputsChange, setOption, step } from "../flows.mjs";
import { checkPdf } from "../outputs.mjs";
import { chips, dragSelect, listChange, rows } from "../review.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];

/** The bar's state once it shows `expected` (or the time runs out), for a check to read. */
const shows = async (app, expected) => {
  await app.page.waitForFunction((expected) => [...document.querySelectorAll(".citation-pins .citation-chip")]
    .map((chip) => chip.innerText.replace(/\s+/gu, "")).join(" ") === expected, expected, { timeout: 15_000 }).catch(() => {});
  return chips(app);
};
const selectedRow = (app) => app.page.locator(".citation-outline [role=option][aria-selected=true]").innerText();

/** Drags across `phrase` and checks the pointer selected it. */
async function select(app, label, phrase, options) {
  const selected = await dragSelect(app, phrase, options);
  const wanted = options?.prefix ? phrase.replace(/\s+/gu, "").slice(0, options.prefix) : phrase.replace(/\s+/gu, " ");
  app.record.check(selected.replace(/\s+/gu, "") === wanted.replace(/\s+/gu, ""), `${app.label} ${label}: the pointer selects "${wanted}"`, selected);
}
const key = (app, label, combo, expected, options = {}) => app.interact(label, async () => {
  await app.page.locator(".citation-review").focus(); await app.page.keyboard.press(combo);
}, options).then(async () => app.record.check(await shows(app, expected) === expected, `${app.label} ${label} shows ${expected || "no pinpoint"}`, await chips(app)));

export const PINPOINT_CASES = [{
  name: "hand-pinpoints",
  title: "Pinpoints by mouse on a detected and a hand-added citation, each edit undone and redone, kept through a reload, in the book and the table",
  async run({ open, record, fixtures }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.guidancePdf);
    const { page } = app;
    record.check(!(await rows(app).allInnerTexts()).some((text) => text.includes("Riverbend")), "the import misses the guidance note", await rows(app).allInnerTexts());

    // A detected citation: its pinpoint, at the citation's end, taken out and dragged across again.
    await rows(app).filter({ hasText: "R v Jordan" }).click();
    record.check(await shows(app, "¶46-48") === "¶46-48", "Jordan shows its pinpoint", await chips(app));
    await app.interact("remove Jordan's pinpoint", () => app.button("Remove pinpoint ¶ 46-48").click());
    await select(app, "Jordan's pinpoint", "46-48");
    await app.interact("+ Pinpoint", () => app.button("+ Pinpoint").click());
    record.check(await shows(app, "¶46-48") === "¶46-48", "+ Pinpoint adds the dragged pinpoint at the citation's end", await chips(app));

    // The guidance note, added by hand: identified from its own text, so nothing asks what it refers to.
    await select(app, "the guidance note", GUIDANCE.cited);
    await app.interact("Add citation", () => app.button("Add citation").click(), { shiftsOk: listChange });
    record.check(await selectedRow(app) === GUIDANCE.cited, "the selection becomes the selected citation", await selectedRow(app));
    record.check(!await page.locator(".citation-authority-trigger").count(), "a full citation is not asked what it refers to");
    await app.shots("hand-added");
    // Two pinpoints after it in its note: one by + Pinpoint, one by P.
    await select(app, "the first pinpoint", "4, 9", { prefix: 1 });
    await app.interact("+ Pinpoint on the hand-added citation", () => app.button("+ Pinpoint").click());
    record.check(await shows(app, "p.4") === "p.4", "+ Pinpoint adds a pinpoint to the hand-added citation", await chips(app));
    await select(app, "the second pinpoint", "9.", { prefix: 1 });
    await key(app, "P", "p", "p.4 p.9");
    // One changed in kind (page, section, paragraph), the other removed.
    for (const expected of ["s4 p.9", "¶4 p.9"]) {
      await app.interact(`step the kind to ${expected}`, () => page.locator(".citation-chip > button").first().click());
      record.check(await shows(app, expected) === expected, `the kind steps to ${expected}`, await chips(app));
    }
    await app.interact("remove p.9", () => app.button("Remove pinpoint p. 9").click());
    record.check(await shows(app, "¶4") === "¶4", "× removes a pinpoint", await chips(app));
    await app.shots("hand-pinpoints");

    // Every edit is its own step: back through the removal and a kind change, and forward again.
    await key(app, "Ctrl+Z puts the removed pinpoint back", "Control+z", "¶4 p.9");
    await key(app, "Ctrl+Z takes the kind back a step", "Control+z", "s4 p.9");
    await key(app, "Ctrl+Shift+Z makes the kind again", "Control+Shift+z", "¶4 p.9");
    await key(app, "Ctrl+Y removes the pinpoint again", "Control+y", "¶4");
    // A boundary moved a word, then taken back.
    await app.interact("Shift+← moves the end a word", async () => { await page.locator(".citation-review").focus(); await page.keyboard.press("Shift+ArrowLeft"); }, { rest: 900 });
    record.check(await selectedRow(app) === GUIDANCE.cited.replace(/ \(2029\)$/u, ""), "the end moves back a word", await selectedRow(app));
    await key(app, "Ctrl+Z restores the end", "Control+z", "¶4");
    record.check(await selectedRow(app) === GUIDANCE.cited, "Ctrl+Z restores the range", await selectedRow(app));
    // Removed, then put back with its pinpoint.
    const listed = await rows(app).count();
    await app.interact("Delete the hand-added citation", async () => { await page.locator(".citation-review").focus(); await page.keyboard.press("Delete"); }, { shiftsOk: listChange });
    record.check(await rows(app).count() === listed - 1, "Delete removes it", await rows(app).count());
    await app.interact("Ctrl+Z after Delete", async () => { await page.locator(".citation-review").focus(); await page.keyboard.press("Control+z"); }, { shiftsOk: listChange });
    record.check(await rows(app).count() === listed && await selectedRow(app) === GUIDANCE.cited && await shows(app, "¶4") === "¶4",
      "Ctrl+Z puts the citation back, selected, with its pinpoint", [await rows(app).count(), await selectedRow(app), await chips(app)]);

    // A reload keeps it all.
    await app.idle();
    await app.reload({ until: () => page.locator(".citation-document .citation-band[data-active]").first().waitFor({ timeout: 60_000 }) });
    await rows(app).filter({ hasText: GUIDANCE.cited }).click();
    record.check(await shows(app, "¶4") === "¶4", "after a reload the hand-added citation keeps its pinpoint", await chips(app));
    await rows(app).filter({ hasText: "R v Jordan" }).click();
    record.check(await shows(app, "¶46-48") === "¶46-48", "after a reload Jordan keeps its pinpoint", await chips(app));

    // Its authority is listed with the others, by its citation; a judgment-like PDF stands in for it.
    await step(app, "Sources", { via: "next", budget: 3000 });
    const guidance = page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem").filter({ hasText: "Riverbend" });
    record.check(await guidance.count() === 1, "Sources lists the guidance note as an authority");
    await app.pick(async () => {
      await guidance.getByRole("button", { name: /^Upload (?:PDF )?for/u }).filter({ hasText: "Upload" }).click();
      const menu = page.getByRole("menuitem", { name: "Upload from computer" });
      if (await menu.count()) await menu.click();
    }, [fixtures.decisionPdfs[0]]);
    await guidance.getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30_000 });
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await app.interact("Create both", () => page.getByLabel("Create").selectOption("both"), { shiftsOk: outputsChange }); await app.idle();
    await setOption(app, "Table locations", "pinpoints");
    await build(app, "book and table", { budget: 15_000 });
    const files = await downloads(app, "outputs");
    const book = await checkPdf(record, "book", pick(files, /book-of-authorities\.pdf$/u), { marks: true });
    const tab = book.tabs.find(({ title }) => title.includes("Riverbend"));
    record.check(!!tab, "the book has a tab for the guidance note", book.tabs.map(({ title }) => title));
    record.check(book.text.slice(0, 3).some((text) => text.includes("Riverbend Waterways Board")), "the book's index lists the guidance note");
    const next = tab && book.tabs.find(({ page: start }) => start > tab.page);
    const marked = tab ? book.marks.filter(({ page: at }) => at >= tab.page && (!next || at < next.page)) : [];
    const paragraph = marked.map(({ page: at }) => book.text[at - 1]).find((text) => text.includes("[4]"));
    record.check(!!paragraph, "the book marks paragraph 4 in the guidance note's tab", marked.map(({ page: at }) => at));
    const table = await readDocx(pick(files, /table-of-authorities\.docx$/u));
    const entry = table.text.slice(table.text.indexOf("Riverbend"), table.text.indexOf("Riverbend") + 160);
    record.check(table.text.includes(GUIDANCE.cited) && /\b4\b/u.test(entry.slice(GUIDANCE.cited.length)),
      "the table lists the guidance note with its pinpoint", entry);
    await app.close();

    // The same by mouse in a Word brief.
    const word = await open({ network: { a2aj: fixtureA2aj() }, label: "docx" });
    await word.load();
    await importBrief(word, fixtures.guidanceDocx);
    await rows(word).filter({ hasText: "R v Jordan" }).click();
    await word.interact("remove Jordan's pinpoint", () => word.button("Remove pinpoint ¶ 46-48").click());
    await select(word, "Jordan's pinpoint", "46-48");
    await key(word, "P adds it back", "p", "¶46-48");
    await select(word, "the guidance note", GUIDANCE.cited);
    await word.interact("Add citation", () => word.button("Add citation").click(), { shiftsOk: listChange });
    await select(word, "its pinpoint", "4, 9", { prefix: 1 });
    await word.interact("+ Pinpoint", () => word.button("+ Pinpoint").click());
    record.check(await shows(word, "p.4") === "p.4", "docx: + Pinpoint adds a pinpoint to the hand-added citation", await chips(word));
    await key(word, "Ctrl+Z", "Control+z", "");
    await key(word, "Ctrl+Y", "Control+y", "p.4");
    await word.shots("docx-hand-pinpoints");
    await word.close();
  },
}];
