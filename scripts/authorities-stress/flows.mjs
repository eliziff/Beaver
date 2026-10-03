// The workflow's steps as a reader takes them, each timed and checked by the App it drives.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BUDGETS } from "./harness.mjs";

export const PROFILES = { general: "No court preset", abkb: "Court of King’s Bench of Alberta", abca: "Court of Appeal of Alberta",
  federal: "Federal Court" };
const PROFILE_IDS = { general: "general", abkb: "ab-court-of-kings-bench", abca: "ab-court-of-appeal", federal: "federal-court" };
export const MARKINGS = { margin: "Red line and quote highlight", sidelined: "Black line", paragraph: "Paragraph highlight",
  text: "Quote highlight", none: "No passage marks" };
export const SOURCE_MODES = { automatic: "Automatic sources",
  manual: "Use available original PDFs and manually add the PDFs myself for the rest",
  render: "Rebuild all sources from text (where available)" };
const REGIONS = { header: "header[data-workspace-header]", steps: "[role=tablist][aria-label='Book steps']", panel: "#authorities-step" };

/** A choice that changes what is made changes what the Build step and its Outputs dock list. */
export const outputsChange = ({ sources }) => sources.every(({ node }) => (node ?? "").includes("/build"));
/** Picks a court in the court chooser that `opener` opens: its jurisdiction, then the court. */
export async function chooseCourt(app, opener, court, { shiftsOk } = {}) {
  const id = PROFILE_IDS[court];
  await app.interact(`open the court chooser`, () => opener.click(), { budget: BUDGETS.dialog });
  const dialog = app.page.getByRole("dialog", { name: "Choose court" });
  await dialog.waitFor();
  const option = dialog.locator(`[data-choice="${id}"]`);
  for (const jurisdiction of await dialog.getByRole("group", { name: "Jurisdiction" }).getByRole("button").all()) {
    if (await option.count()) break;
    await jurisdiction.click(); await app.settle();
  }
  await app.interact(`choose ${court}`, () => option.click(), { shiftsOk });
  await dialog.waitFor({ state: "detached" });
}
/** Clicks an option card (its corner, clear of anything inside it), timed to the frame that shows it chosen. */
export async function chooseCard(app, scope, name) {
  const option = scope.getByRole("radio", { name, exact: true });
  if (await option.isChecked()) return;
  await app.interact(`choose "${name}"`, () => option.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }));
}

/** Add file, the import's steps (the court, the sources, the marking), Import: to the first citation
 *  marked in the document. */
export async function importBrief(app, file, { court, sourceMode, marking, shot = null, first = false, budget } = {}) {
  await app.pick(() => app.button("Add file").click(), [file]);
  const setup = app.page.getByRole("dialog", { name: "Import" });
  await setup.waitFor();
  if (court) {
    if (await setup.getByRole("radio", { name: PROFILES[court], exact: true }).count()) await chooseCard(app, setup, PROFILES[court]);
    else await chooseCourt(app, setup.getByRole("button", { name: "Other court" }), court);
  }
  const step = (name) => setup.getByRole("list", { name: "Import steps" }).getByRole("button", { name }).click();
  if (sourceMode) { await step("Sources"); await chooseCard(app, setup, SOURCE_MODES[sourceMode]); }
  if (marking) { await step("Marking"); await chooseCard(app, setup, MARKINGS[marking]); }
  if (shot) await app.shots(shot);
  const started = await app.now();
  await setup.getByRole("button", { name: /^Import(?: with .*defaults)?$/u }).click();
  await app.page.locator(".citation-document .citation-band[data-active]").first().waitFor({ timeout: 120_000 });
  const ms = await app.now() - started;
  // A profile's first import starts the engine; every later one finds it warm.
  const limit = budget ?? (first || !app.imported ? 5000 : /\.docx$/iu.test(file) ? 1500 : 3000);
  app.imported = true;
  app.record.note(`${app.label} import ${path.basename(file)}`, ms);
  app.record.check(ms < limit, `${app.label}: import of ${path.basename(file)} in ${Math.round(ms)} ms (budget ${limit})`);
  await app.page.waitForTimeout(400); await app.idle();
  return ms;
}

/** A step tab or Next, to the step drawn; nothing above it moves and no frame is blank. */
export async function step(app, name, { budget = 300, via = "tab", wait } = {}) {
  const tab = app.page.getByRole("tab", { name, exact: true });
  // A step replaces the one before in a single frame, so a big brief's switch may take one task
  // longer than an edit's; what Next is doing shows in the step row's own status line meanwhile.
  const result = await app.interact(`${via === "next" ? "Next" : "tab"} to ${name}`,
    () => via === "next" ? app.button("Next").click() : tab.click(),
    { budget, longTask: BUDGETS.stepTask, regions: REGIONS, shiftsOk: ({ sources }) => sources.every(({ node }) => /beaver-loading-indicator|\[role=status\]/u.test(node ?? "")),
      wait: wait ?? (() => app.page.getByRole("tab", { name, exact: true, selected: true }).waitFor({ timeout: 120_000 })) });
  return result;
}
export const row = (app, name) => app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem")
  .filter({ has: app.page.getByRole("heading", { name, exact: false }) });
/** A PDF for one authority, through its row's Upload (or Replace) menu. */
export async function attach(app, name, file) {
  const item = row(app, name);
  const trigger = item.getByRole("button", { name: /^(?:Upload|Replace) (?:PDF )?for/u }).first();
  await app.pick(async () => {
    await trigger.click();
    const menu = app.page.getByRole("menuitem", { name: "Upload from computer" });
    if (await menu.count()) await menu.click();
  }, [file]);
  await item.getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30_000 });
}

export const dock = (app) => app.page.getByRole("region", { name: "Outputs" });
/** An output's options, opened from its card: `run` works in the dialog, then Done closes it. */
export async function outputOptions(app, card, run) {
  await app.interact(`open the ${card} options`, () => dock(app).getByRole("button", { name: `${card} options` }).click(), { budget: BUDGETS.dialog });
  const dialog = app.page.getByRole("dialog", { name: card });
  await dialog.waitFor();
  const result = await run(dialog);
  await app.button("Done", dialog).click(); await dialog.waitFor({ state: "detached" }); await app.idle();
  return result;
}
/** Ticks or unticks a checkbox card, where it can be changed. */
export async function tick(app, box, on) {
  if (await box.isChecked() === on || await box.isDisabled()) return;
  await app.interact(`${on ? "tick" : "untick"} a box`, () => box.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }),
    { shiftsOk: outputsChange });
}
/** What Build makes, the book, the table or both, through the two outputs' options. */
export async function outputMode(app, mode) {
  const table = await dock(app).getByRole("button", { name: "Word copy options" }).count() ? "Word copy" : "Table of Authorities";
  await outputOptions(app, table, (dialog) => tick(app, dialog.getByRole("checkbox", { name: "A Table of Authorities in its own Word document" }), mode !== "book"));
  await outputOptions(app, "Book of Authorities", (dialog) => tick(app, dialog.getByRole("checkbox", { name: "Make the Book of Authorities" }), mode !== "table"));
}
/** Build (or `start`), through Missing PDFs when it asks; to every output current. */
export async function build(app, label, { missing = null, start = () => app.button("Build", dock(app)).click(), budget = 2500, shot = null } = {}) {
  let started = await app.now();
  const timeout = Math.max(60_000, budget * 4);
  await start();
  // The click shows at once: the build's Cancel, or a dialog.
  await app.page.waitForFunction(() => document.querySelector("dialog[open], [role=dialog]") ||
    [...document.querySelectorAll("[aria-label=Outputs] button")].some((button) => button.textContent.trim() === "Cancel"),
  null, { timeout: 10_000, polling: "raf" });
  // Once the sources are checked it asks about missing PDFs, or builds without asking: built
  // means outputs ready with no Cancel and no dialog left, which an open warning never is.
  const warning = app.page.getByRole("dialog", { name: "Missing PDFs" });
  const asked = await Promise.race([warning.waitFor({ timeout }).then(() => true),
    app.page.waitForFunction(() => document.querySelector("aside[aria-label=Outputs] [data-output][data-ready]") &&
      !document.querySelector("dialog[open], [role=dialog]") &&
      ![...document.querySelectorAll("aside[aria-label=Outputs] button")].some((button) => button.textContent.trim() === "Cancel"),
    null, { timeout, polling: 50 }).then(() => false)]);
  if (asked) {
    const checked = await app.now() - started;
    app.record.note(`${app.label} ${label}: Missing PDFs asked after`, checked);
    app.record.check(checked < budget, `${app.label} ${label}: Missing PDFs asked in ${Math.round(checked)} ms (budget ${budget})`);
    const listed = await warning.locator("li").count();
    if (missing !== null) app.record.check(typeof missing === "number" ? listed === missing : missing.test(await warning.innerText()),
      `${app.label} ${label}: Missing PDFs lists what is missing`, { listed, missing: String(missing) });
    if (shot) await app.shots(shot);
    started = await app.now();
    await app.button("Build", warning).click();
  } else if (missing) app.record.check(false, `${app.label} ${label}: Build asked nothing about missing PDFs`, String(missing));
  await app.page.waitForFunction(() => {
    const outputs = [...document.querySelectorAll("aside[aria-label=Outputs] button[aria-label^='Download ']")];
    return outputs.length && outputs.every((button) => !button.getAttribute("aria-label").startsWith("Download previous")) &&
      ![...document.querySelectorAll("aside[aria-label=Outputs] button")].some((button) => button.textContent.trim() === "Cancel") &&
      !document.querySelector("dialog[open], [role=dialog]");
  }, null, { timeout, polling: 50 });
  const ms = await app.now() - started;
  app.record.note(`${app.label} build ${label}`, ms);
  app.record.check(ms < budget, `${app.label} ${label}: built in ${Math.round(ms)} ms (budget ${budget})`);
  return ms;
}
/** Every download in the Outputs dock, saved under the case's folder. */
export async function downloads(app, label) {
  const saved = {}, dir = path.join(app.record.out, "downloads", `${app.label}-${label}`);
  await mkdir(dir, { recursive: true });
  for (const output of await dock(app).getByRole("button", { name: /^Download / }).all()) {
    const download = app.page.waitForEvent("download");
    await output.click();
    const file = path.join(dir, (await download).suggestedFilename());
    await (await download).saveAs(file);
    saved[path.basename(file)] = file;
  }
  return saved;
}
const SCANNED = { "page-margin": "Keep scans as images", "cited-pages": "Recognize cited pages", full: "Recognize every page" };
/** A setting from Build, set where it lives: the book's or the table's options, or Sources (its scans
 *  and tabs), coming back to Build after. */
export async function setOption(app, label, value) {
  if (label === "Missing sources") return outputOptions(app, "Book of Authorities", (dialog) =>
    chooseCard(app, dialog, value === "omit" ? "Leave out of the book" : "Keep their tabs"));
  if (label === "Table locations") {
    const table = await dock(app).getByRole("button", { name: "Word copy options" }).count() ? "Word copy" : "Table of Authorities";
    return outputOptions(app, table, (dialog) => dialog.locator("#authorities-cited-at").selectOption(value));
  }
  await step(app, "Sources");
  if (label === "Scanned PDFs") {
    const summary = app.page.locator("summary", { hasText: "Scanned PDFs" });
    if (!await summary.evaluate((element) => element.parentElement.open)) await summary.click();
    await chooseCard(app, app.page.getByRole("group", { name: "Scanned PDFs" }), SCANNED[value]);
  } else if (label === "Tabs") {
    await app.button("Tab labels").click();
    const dialog = app.page.getByRole("dialog", { name: "Tab labels" });
    await dialog.getByLabel("Numbering").selectOption(value);
    await app.button("Done", dialog).click();
  } else throw new Error(`No setting ${label}`);
  await app.idle();
  await step(app, "Build book");
}
