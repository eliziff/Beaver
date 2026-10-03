// The citation review, walked as a reader walks a long brief: the list, the keys, far jumps, and
// every frame meanwhile sampled for a blank page or a band that blinks.
import { BUDGETS } from "./harness.mjs";

export const REVIEW_REGIONS = { document: [".citation-document", "paint"], selected: ".citation-outline [role=option][aria-selected=true]",
  bar: ".citation-panel", steps: "[role=tablist][aria-label='Book steps']" };
export const rows = (app) => app.page.locator(".citation-outline [role=option]");

/** Clicks, arrows and jumps through the list; the header, steps and bar never move. */
export async function walkReview(app, label, { arrows = 10, clicks = 4 } = {}) {
  const list = rows(app), count = await list.count();
  app.record.note(`${app.label} ${label} citations`, count);
  const frame = () => app.page.evaluate(() => [["header[data-workspace-header]"], ["[role=tablist][aria-label='Book steps']"], [".citation-panel"]]
    .map(([selector]) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? [box.x, box.y, box.width, box.height].map(Math.round).join(",") : null; }).join(" | "));
  const fixed = await frame();
  await app.interact(`${label} click the first citation`, () => list.first().click(), { regions: REVIEW_REGIONS, rest: 120 });
  for (let index = 0; index < arrows; index += 1)
    await app.interact(`${label} ArrowDown ${index + 1}`, () => app.page.keyboard.press("ArrowDown"), { regions: REVIEW_REGIONS, rest: 60 });
  await app.interact(`${label} ArrowUp`, () => app.page.keyboard.press("ArrowUp"), { regions: REVIEW_REGIONS, rest: 60 });
  for (let index = 1; index <= clicks; index += 1) {
    const at = Math.min(count - 1, Math.round(index * count / (clicks + 1)));
    await app.interact(`${label} click citation ${at + 1} of ${count}`, () => list.nth(at).click(), { regions: REVIEW_REGIONS, rest: 150 });
  }
  // The far ends of a long brief, each drawn at once.
  await app.interact(`${label} jump to the last citation`, () => list.nth(count - 1).click(), { regions: REVIEW_REGIONS, rest: 300 });
  await app.interact(`${label} jump back to the first`, () => list.first().click(), { regions: REVIEW_REGIONS, rest: 300 });
  app.record.check(await frame() === fixed, `${app.label} ${label}: header, steps and bar keep their boxes`, [fixed, await frame()]);
  return count;
}

/** A citation added or removed moves the list rows after it, and nothing else: a source that kept
 *  its box (a count whose text changed) moved nothing. */
export const listChange = ({ sources }) => sources.every(({ list, moved }) => { const [before, after] = moved.split(" -> "); return list || before === after; });
/** The selected citation's pinpoint chips as the bar shows them, each its kind's symbol and value: "¶10 p.12". */
export const chips = (app) => app.page.locator(".citation-pins .citation-chip").allInnerTexts()
  .then((items) => items.map((chip) => chip.replace(/\s+/gu, "")).join(" "));
/** Drags the pointer across `phrase` in the document (its `nth` occurrence, its first `prefix`
 *  characters), as a reader selects text; returns what is selected. */
export async function dragSelect(app, phrase, { nth = 0, prefix } = {}) {
  const { first, last } = await app.page.evaluate(([phrase, nth, prefix]) => window.__e2e.ends(phrase, nth, prefix), [phrase, nth, prefix]);
  await app.page.mouse.move(first.left + 0.5, (first.top + first.bottom) / 2);
  await app.page.mouse.down();
  await app.page.mouse.move(last.right - 0.5, (last.top + last.bottom) / 2, { steps: 4 });
  await app.page.mouse.up();
  return app.page.evaluate(() => getSelection().toString().replace(/\s+/gu, " ").trim());
}

/** Selects `phrase` in the document with the pointer and makes it a citation, then takes it back. */
export async function addAndRemove(app, label, phrase) {
  await dragSelect(app, phrase);
  await app.interact(`${label} Add citation`, () => app.button("Add citation").click(), { shiftsOk: listChange });
  const selected = await app.page.locator(".citation-outline [role=option][aria-selected=true]").innerText();
  app.record.check(selected.replace(/\s+/gu, " ").includes(phrase.slice(0, 20)), `${app.label} ${label}: the selection became a citation`, selected);
  await app.page.locator(".citation-review").focus();
  await app.interact(`${label} Delete it again`, () => app.page.keyboard.press("Delete"), { shiftsOk: listChange });
  await app.interact(`${label} Ctrl+Z`, () => app.page.keyboard.press("Control+z"), { shiftsOk: listChange, budget: BUDGETS.inputToPaint });
  await app.page.locator(".citation-review").focus();
  await app.interact(`${label} Delete once more`, () => app.page.keyboard.press("Delete"), { shiftsOk: listChange });
}
