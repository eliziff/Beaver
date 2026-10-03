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
/** Runs `action` (a click, or a key wherever the focus is after the last one) and checks what the bar
 *  shows in the frame after it: an edit shows at once, never when its save lands. A pinpoint just
 *  added may show its value before its kind, which the save reads. */
async function inFrame(app, label, action, expected, options) {
  let seen;
  await app.interact(label, async () => {
    await action();
    seen = await app.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve([...document
      .querySelectorAll(".citation-pins .citation-chip")].map((chip) => chip.innerText.replace(/\s+/gu, "")).join(" ")))));
  }, options);
  const wanted = [expected].flat();
  app.record.check(wanted.includes(seen), `${app.label} ${label}: the next frame shows ${wanted.join(" or ") || "no pinpoint"}`, seen);
  const final = wanted.at(-1);
  app.record.check(await shows(app, final) === final, `${app.label} ${label}: then shows ${final || "no pinpoint"}`, await chips(app));
}
const press = (app, combo) => () => app.page.keyboard.press(combo);

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
    await inFrame(app, "+ Pinpoint at the citation's end", () => app.button("+ Pinpoint").click(), ["46-48", "¶46-48"]);

    // The guidance note, added by hand: identified from its own text, so nothing asks what it refers to.
    await select(app, "the guidance note", GUIDANCE.cited);
    await app.interact("Add citation", () => app.button("Add citation").click(), { shiftsOk: listChange });
    record.check(await selectedRow(app) === GUIDANCE.cited, "the selection becomes the selected citation", await selectedRow(app));
    record.check(!await page.locator(".citation-authority-trigger").count(), "a full citation is not asked what it refers to");
    await app.shots("hand-added");
    // Each control of the bar leaves the keys with the review: Ctrl+Z right after Add citation takes
    // it back, and Ctrl+Y makes it again.
    const listed = await rows(app).count();
    await app.interact("Ctrl+Z after Add citation", press(app, "Control+z"), { shiftsOk: listChange });
    record.check(await rows(app).count() === listed - 1, "Ctrl+Z right after Add citation takes it back", await rows(app).count());
    await app.interact("Ctrl+Y", press(app, "Control+y"), { shiftsOk: listChange });
    record.check(await rows(app).count() === listed && await selectedRow(app) === GUIDANCE.cited, "Ctrl+Y adds it again, selected", await selectedRow(app));
    // Two pinpoints after it in its note: one by + Pinpoint, one by P, each shown at once.
    await select(app, "the first pinpoint", "4, 9", { prefix: 1 });
    await inFrame(app, "+ Pinpoint on the hand-added citation", () => app.button("+ Pinpoint").click(), ["4", "p.4"]);
    await inFrame(app, "Ctrl+Z right after + Pinpoint", press(app, "Control+z"), "");
    await inFrame(app, "Ctrl+Y", press(app, "Control+y"), ["4", "p.4"]);
    await select(app, "the second pinpoint", "9.", { prefix: 1 });
    await inFrame(app, "P", press(app, "p"), ["p.4 9", "p.4 p.9"]);
    // One changed in kind (page, section, paragraph), the other removed; Ctrl+Z works after each click.
    for (const expected of ["s4 p.9", "¶4 p.9"])
      await inFrame(app, `step the kind to ${expected}`, () => page.locator(".citation-chip > button").first().click(), expected);
    await inFrame(app, "Ctrl+Z right after a kind step", press(app, "Control+z"), "s4 p.9");
    await inFrame(app, "Ctrl+Y", press(app, "Control+y"), "¶4 p.9");
    await inFrame(app, "remove p.9", () => app.button("Remove pinpoint p. 9").click(), "¶4");
    await app.shots("hand-pinpoints");

    // Every edit is its own step: back through the removal and a kind change, and forward again.
    await inFrame(app, "Ctrl+Z right after ×", press(app, "Control+z"), "¶4 p.9");
    await inFrame(app, "Ctrl+Z takes the kind back a step", press(app, "Control+z"), "s4 p.9");
    await inFrame(app, "Ctrl+Shift+Z makes the kind again", press(app, "Control+Shift+z"), "¶4 p.9");
    await inFrame(app, "Ctrl+Y removes the pinpoint again", press(app, "Control+y"), "¶4");
    // A boundary moved a word, then taken back.
    await app.interact("Shift+← moves the end a word", press(app, "Shift+ArrowLeft"), { rest: 900 });
    record.check(await selectedRow(app) === GUIDANCE.cited.replace(/ \(2029\)$/u, ""), "the end moves back a word", await selectedRow(app));
    await inFrame(app, "Ctrl+Z restores the end", press(app, "Control+z"), "¶4");
    record.check(await selectedRow(app) === GUIDANCE.cited, "Ctrl+Z restores the range", await selectedRow(app));
    // Removed by the bar's Remove, then put back by Ctrl+Z with its pinpoint.
    await app.interact("Remove the hand-added citation", () => app.button("Remove").click(), { shiftsOk: listChange });
    record.check(await rows(app).count() === listed - 1, "Remove removes it", await rows(app).count());
    await app.interact("Ctrl+Z right after Remove", press(app, "Control+z"), { shiftsOk: listChange });
    record.check(await rows(app).count() === listed && await selectedRow(app) === GUIDANCE.cited && await shows(app, "¶4") === "¶4",
      "Ctrl+Z puts the citation back, selected, with its pinpoint", [await rows(app).count(), await selectedRow(app), await chips(app)]);

    // A reload, once the edits have saved, keeps it all.
    await app.idle(); await page.waitForTimeout(2000);
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
    record.check(table.text.includes(GUIDANCE.cited) && /(?:^|\D)4(?!\d)/u.test(entry.slice(GUIDANCE.cited.length)),
      "the table lists the guidance note with its pinpoint", entry);
    await app.close();

    // The same by mouse in a Word brief.
    const word = await open({ network: { a2aj: fixtureA2aj() }, label: "docx" });
    await word.load();
    await importBrief(word, fixtures.guidanceDocx);
    await rows(word).filter({ hasText: "R v Jordan" }).click();
    await word.interact("remove Jordan's pinpoint", () => word.button("Remove pinpoint ¶ 46-48").click());
    await select(word, "Jordan's pinpoint", "46-48");
    await inFrame(word, "P adds it back", press(word, "p"), ["46-48", "¶46-48"]);
    await select(word, "the guidance note", GUIDANCE.cited);
    await word.interact("Add citation", () => word.button("Add citation").click(), { shiftsOk: listChange });
    await select(word, "its pinpoint", "4, 9", { prefix: 1 });
    await inFrame(word, "+ Pinpoint", () => word.button("+ Pinpoint").click(), ["4", "p.4"]);
    await inFrame(word, "Ctrl+Z right after + Pinpoint", press(word, "Control+z"), "");
    await inFrame(word, "Ctrl+Y", press(word, "Control+y"), ["4", "p.4"]);
    await word.shots("docx-hand-pinpoints");
    await word.close();
  },
}];
