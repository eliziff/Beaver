// The workflow's steps as a reader takes them, each timed and checked by the App it drives.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { BUDGETS } from "./harness.mjs";

export const PROFILES = { general: "No court preset", abkb: "Court of King’s Bench of Alberta", abca: "Court of Appeal of Alberta",
  federal: "Federal Court" };
const PROFILE_IDS = { general: "general", abkb: "ab-court-of-kings-bench", abca: "ab-court-of-appeal", federal: "federal-court" };
export const MARKINGS = { margin: "Red line and quote highlight", paragraph: "Paragraph highlight",
  text: "Quote highlight", none: "No passage marks" };
export const SOURCE_MODES = { automatic: "Automatic sources",
  manual: "Use available original PDFs and manually add the PDFs myself for the rest",
  render: "Rebuild all sources from text (where available)" };
const REGIONS = { header: "header[data-workspace-header]", steps: "[role=tablist][aria-label='Book steps']", panel: "#authorities-step" };

/** A choice that changes what is made changes what the Build step and its Outputs dock list. */
export const outputsChange = ({ sources }) => sources.every(({ node }) => /\/build|\[Book\]|ul\.grid\.gap-3|section\.min-w-0 > div\.mt-/u.test(node ?? ""));
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

/** Add file, the import's steps (the court, the sources, the marking), then finish: to the first citation
 *  marked in the document. */
export async function importBrief(app, file, { court, sourceMode, marking, scanned, shot = null, first = false, budget } = {}) {
  await app.pick(() => app.button("Add file").click(), [file]);
  const setup = app.page.getByRole("dialog", { name: "Import" });
  await setup.waitFor();
  if (court) {
    if (await setup.getByRole("radio", { name: PROFILES[court], exact: true }).count()) await chooseCard(app, setup, PROFILES[court]);
    else await chooseCourt(app, setup.getByRole("button", { name: /^Court:/u }), court);
  }
  const step = (name) => setup.getByRole("list", { name: "Steps", exact: true }).getByRole("button", { name, exact: true }).click();
  if (sourceMode || scanned) {
    await step("Sources");
    if (sourceMode) await chooseCard(app, setup, SOURCE_MODES[sourceMode]);
    if (scanned) await chooseCard(app, setup.getByRole("group", { name: "Scanned PDFs" }), SCANNED[scanned]);
  }
  if (marking) { await step("Marking"); await chooseCard(app, setup, MARKINGS[marking]); }
  if (shot) await app.shots(shot);
  await step("Marking");
  const started = await app.now();
  await setup.getByRole("button", { name: "Next", exact: true }).click();
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
  // Acknowledge the one-time guidance before opening a menu it would otherwise cover.
  if (name === "Sources" && !app.sourcesExplained) {
    const guidance = app.page.getByRole("dialog", { name: "Some sources need adding" });
    const appeared = await guidance.waitFor({ timeout: 2000 }).then(() => true, () => false);
    if (appeared) { await app.button("Got it", guidance).click(); app.sourcesExplained = true; }
  }
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
/** An output's options, saved together; unchanged choices close with Cancel. */
export async function outputOptions(app, card, run) {
  await app.interact(`open the ${card} options`, () => dock(app).getByRole("button", { name: `Options for ${card}`, exact: true }).click(), { budget: BUDGETS.dialog });
  const dialog = app.page.getByRole("dialog", { name: card });
  await dialog.waitFor();
  const result = await run(dialog);
  const save = app.button("Save", dialog);
  await (await save.isEnabled() ? save : app.button("Cancel", dialog)).click();
  await dialog.waitFor({ state: "detached" }); await app.idle();
  return result;
}
/** Ticks or unticks a checkbox card, where it can be changed. */
export async function tick(app, box, on) {
  if (await box.isChecked() === on || await box.isDisabled()) return;
  await app.interact(`${on ? "tick" : "untick"} a box`, () => box.locator("xpath=ancestor::label[1]").click({ position: { x: 6, y: 6 } }),
    { shiftsOk: outputsChange });
}
/** What Build makes, through the output choices exposed to the reader. */
export async function outputMode(app, mode) {
  const table = await dock(app).getByRole("button", { name: "Options for Word copy", exact: true }).count() ? "Word copy" : "Table of Authorities";
  await outputOptions(app, table, (dialog) => tick(app, dialog.getByRole("checkbox", { name: "A Table of Authorities in its own Word document" }), mode !== "book"));
  const book = dock(app).locator("[data-output=book]").getByRole("switch");
  app.record.check(await book.count() > 0, `${app.label}: output choices include whether to make the book`);
  if (await book.count()) await book.setChecked(mode !== "table");
  await app.idle();
}
/** Build (or `start`), through Missing PDFs when it asks; to every output current. */
export async function build(app, label, { missing = null, start = () => app.button("Build", dock(app)).click(), budget = 2500, shot = null } = {}) {
  let started = await app.now();
  const timeout = Math.max(60_000, budget * 4);
  await start();
  // A fast build may already be finished when the click returns. Read its visible result,
  // including on a rebuild, rather than requiring its transient Cancel button to be observed.
  const ready = dock(app).getByRole("status").filter({ hasText: /\b(?:is|are) ready\.$/u });
  const finished = async () => {
    await ready.waitFor({ timeout });
    await app.page.locator("dialog[open], [role=dialog]").waitFor({ state: "hidden", timeout });
    await ready.waitFor({ timeout });
  };
  const warning = app.page.getByRole("dialog", { name: "Authorities without a PDF" });
  const asked = await Promise.race([warning.waitFor({ timeout }).then(() => true),
    finished().then(() => false)]);
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
  await finished();
  await dock(app).getByRole("button", { name: /^Download .+\.(?:pdf|docx)$/u }).first().waitFor({ timeout });
  const ms = await app.now() - started;
  app.record.note(`${app.label} build ${label}`, ms);
  app.record.check(ms < budget, `${app.label} ${label}: built in ${Math.round(ms)} ms (budget ${budget})`);
  return ms;
}
/** Every download in the Outputs dock, saved under the case's folder. */
export async function downloads(app, label) {
  const saved = {}, dir = path.join(app.record.out, "downloads", `${app.label}-${label}`);
  await mkdir(dir, { recursive: true });
  for (const output of await dock(app).getByRole("button", { name: /^Download (?!all$)/u }).all()) {
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
  if (label === "Missing sources") {
    await app.button("Review the authorities without a PDF").click();
    const dialog = app.page.getByRole("dialog", { name: "Authorities without a PDF", exact: true });
    await chooseCard(app, dialog, value === "omit" ? "Leave out of the book" : "Keep their tabs");
    await app.button("Close", dialog).last().click(); await app.idle();
    return;
  }
  if (label === "Table locations") {
    const table = await dock(app).getByRole("button", { name: "Options for Word copy", exact: true }).count() ? "Word copy" : "Table of Authorities";
    return outputOptions(app, table, (dialog) => dialog.locator("#authorities-cited-at").selectOption(value));
  }
  await step(app, "Sources");
  if (label === "Scanned PDFs") {
    const settings = app.button("Source settings");
    if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
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
