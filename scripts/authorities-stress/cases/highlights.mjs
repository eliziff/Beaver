// Highlights: the editor (switching sources, adding a mark, undo and redo) and every passage
// marking, each built and its marks read back from the book: their kind and their colour.
import path from "node:path";
import { fixtureA2aj } from "../fixtures.mjs";
import { attach, build, dock, downloads, importBrief, MARKINGS, row, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf } from "../outputs.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
const EDITOR_REGIONS = { pdf: ["dialog section[aria-label='Authority PDF editor']", "paint"], panel: "aside[aria-label=Highlights] ul",
  heading: "aside[aria-label=Highlights] h2", tools: "[role=group][aria-label='Highlight tool']" };
// What each marking draws in the book: red or black lines (squares in the margin), yellow highlights.
const EXPECTED = {
  margin: (kinds) => !!kinds["Square red"] && !kinds["Square black"],
  sidelined: (kinds) => !!kinds["Square black"] && !kinds["Square red"] && !kinds["Highlight yellow"],
  paragraph: (kinds) => !!kinds["Highlight yellow"] && !kinds["Square black"],
  text: (kinds) => !kinds["Square black"],
  none: (kinds) => !Object.keys(kinds).length,
};

export const HIGHLIGHT_CASES = [{
  name: "highlights",
  title: "The Highlights editor, and each of the five passage markings built and read back",
  async run({ open, fixtures, record, renderer }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.briefPdf);
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await attach(app, "Lakeshore", fixtures.scan);
    await row(app, "Lakeshore").getByRole("status").filter({ hasText: "Text recognition complete" }).waitFor({ timeout: 30_000 });
    await step(app, "Highlights", { via: "next" });
    await app.shots("highlights-step");
    // Every marking, chosen on the step and built: the book carries that marking's marks only.
    const marking = app.page.getByRole("group", { name: "Passage marking" });
    let reached = false;
    for (const [key, name] of Object.entries(MARKINGS)) {
      if (reached) await app.page.getByRole("tab", { name: "Highlights" }).click();
      await marking.waitFor();
      const option = marking.getByRole("radio", { name, exact: true });
      if (!await option.isChecked()) await app.interact(`choose ${name}`, () => option.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }));
      // Saved, and the highlights prepared again for it.
      await app.page.waitForFunction((name) => {
        const fieldset = [...document.querySelectorAll("fieldset")].find((item) => item.querySelector("legend")?.textContent === "Passage marking");
        const input = [...(fieldset?.querySelectorAll("input[type=radio]") ?? [])].find((item) => item.closest("label")?.textContent.includes(name));
        return input?.checked && !fieldset.disabled;
      }, name, { timeout: 30_000 });
      await app.idle();
      if (reached) await app.page.getByRole("tab", { name: "Build book" }).click();
      else { await step(app, "Build book", { via: "next" }); reached = true; }
      await dock(app).waitFor();
      await build(app, `marking ${key}`, { missing: null, budget: 3000 });
      const book = pick(await downloads(app, `marking-${key}`), /book-of-authorities\.pdf$/u);
      const pdf = await checkPdf(record, `${key} book`, book, { markKinds: EXPECTED[key] });
      // The statute's s 12 and the scan's para 22, as each marking draws them.
      const pages = [...new Set(pdf.marks.map(({ page }) => page))].slice(0, 4);
      await renderer.sheet(book, path.join(record.out, `marking-${key}.jpg`), { pages: pages.length ? pages : [1, 2], width: 420 });
    }
    // The editor: sources switched with every frame sampled, a mark added, undone and redone.
    await app.page.getByRole("tab", { name: "Highlights" }).click();
    await marking.locator("label", { has: app.page.getByRole("radio", { name: MARKINGS.margin, exact: true }) }).click({ position: { x: 6, y: 6 } });
    await app.page.waitForFunction(() => !document.querySelector("fieldset[disabled]"), null, { timeout: 30_000 });
    await app.idle();
    await app.interact("open the editor", () => app.button("Edit in PDF").click(), { budget: BUDGETS.dialog,
      wait: () => app.page.getByRole("dialog", { name: "Highlights" }).locator(".pdf-text-layer").first().waitFor({ timeout: 30_000 }) });
    const editor = app.page.getByRole("dialog", { name: "Highlights" });
    const ready = () => app.page.waitForFunction(() => document.querySelector("aside[aria-label=Highlights]")?.getAttribute("aria-busy") === "false" &&
      !document.querySelector("aside[aria-label=Highlights]")?.textContent.includes("Preparing"), null, { timeout: 30_000 });
    await ready();
    await app.shots("editor");
    for (let index = 0; index < 4; index += 1)
      await app.interact(`next source ${index + 1}`, () => editor.getByRole("button", { name: /^Next authority/u }).click(),
        { regions: EDITOR_REGIONS, wait: ready, rest: 400 });
    await app.interact("previous source", () => editor.getByRole("button", { name: /^Previous authority/u }).click(),
      { regions: EDITOR_REGIONS, wait: ready, rest: 400 });
    const statute = await editor.getByRole("combobox", { name: "Authority PDF" }).evaluate((select) =>
      [...select.options].find((option) => option.text.includes("Waterways"))?.value);
    await app.interact("choose the statute", () => editor.getByRole("combobox", { name: "Authority PDF" }).selectOption(statute),
      { regions: EDITOR_REGIONS, wait: ready, rest: 400 });
    const cards = editor.locator("aside ul > li"), before = await cards.count();
    await app.page.waitForFunction((phrase) => {
      for (const layer of document.querySelectorAll("dialog .pdf-text-layer")) {
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(phrase);
          if (at < 0) continue;
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + phrase.length);
          getSelection().removeAllRanges(); getSelection().addRange(range); return true;
        }
      }
      return false;
    }, "shall not refuse", { timeout: 30_000 });
    await app.interact("Highlight text", () => editor.getByRole("button", { name: "Highlight text" }).click(),
      { wait: () => app.page.waitForFunction((count) => document.querySelectorAll("dialog aside ul > li").length > count, before) });
    await editor.getByText("Saving…").waitFor({ state: "detached" });
    await app.interact("Undo", () => editor.getByRole("button", { name: "Undo" }).click(),
      { wait: () => app.page.waitForFunction((count) => document.querySelectorAll("dialog aside ul > li").length === count, before) });
    await app.interact("Redo", () => editor.getByRole("button", { name: "Redo" }).click(),
      { wait: () => app.page.waitForFunction((count) => document.querySelectorAll("dialog aside ul > li").length === count + 1, before) });
    await editor.getByText("Saving…").waitFor({ state: "detached" });
    await app.shots("editor-added");
    record.check(await cards.count() === before + 1, "the added highlight is kept after undo and redo", await cards.allInnerTexts());
    await app.interact("close the editor", () => editor.getByRole("button", { name: "Close highlights" }).click(),
      { wait: () => editor.waitFor({ state: "detached" }) });
    await app.close();
  },
}];
