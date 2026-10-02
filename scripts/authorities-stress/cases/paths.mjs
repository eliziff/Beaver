// The paths around the main walk: a draft resumed after a reload at every step, the drafts list,
// and a book built by hand from PDFs.
import path from "node:path";
import { fixtureA2aj } from "../fixtures.mjs";
import { attach, build, chooseCourt, dock, downloads, importBrief, row, step } from "../flows.mjs";
import { BUDGETS } from "../harness.mjs";
import { checkPdf } from "../outputs.mjs";
import { rows } from "../review.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
const selectedTab = (app) => app.page.locator("[role=tablist][aria-label='Book steps'] [role=tab][aria-selected=true]").innerText();
const tabSlots = (app) => app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem");

export const PATH_CASES = [{
  name: "resume",
  title: "A draft resumed after a reload at each step, and after a reload while an edit saves",
  async run({ open, fixtures, record }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.briefPdf);
    const reviewed = () => app.page.locator(".citation-document .citation-band[data-active]").first().waitFor({ timeout: 60_000 });
    // An edit, saved, then a reload: the draft opens where it was, with the edit.
    await rows(app).nth(3).click();
    await app.page.locator(".citation-review").focus();
    await app.page.keyboard.press("Delete"); await app.idle();
    const before = await rows(app).allInnerTexts();
    await app.reload({ until: reviewed });
    record.check(JSON.stringify(await rows(app).allInnerTexts()) === JSON.stringify(before), "the review resumes with its edit", await rows(app).allInnerTexts());
    record.check(await selectedTab(app) === "Citations", "the review resumes on Citations", await selectedTab(app));
    await app.shots("resumed-review");
    // A reload while an edit is still saving leaves a draft that opens, with or without the edit.
    await rows(app).first().click();
    await app.page.locator(".citation-review").focus();
    await app.page.keyboard.press("Delete");
    await app.page.reload();
    await reviewed();
    const after = await rows(app).count();
    record.check(after === before.length || after === before.length - 1, "a reload while an edit saves leaves the draft whole", after);
    record.check(!await app.page.getByRole("alert").count() && !/could not|changed\. Reopen/iu.test(await app.page.locator("body").innerText()),
      "a reload while an edit saves reports nothing broken");
    // Sources: a PDF attached there is still attached after a reload, on that step.
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await app.reload({ until: () => app.page.getByRole("list", { name: "Authority tab slots" }).waitFor({ timeout: 60_000 }) });
    record.check(await row(app, "Waterways Licensing Act").getByRole("button", { name: /^View PDF for/u }).count() === 1,
      "Sources resumes with its PDF attached");
    record.check(await selectedTab(app) === "Sources", "the draft resumes on Sources", await selectedTab(app));
    await app.shots("resumed-sources");
    // Back on Citations for an edit, which takes the draft back to Citations: Next goes on at once.
    await app.page.getByRole("tab", { name: "Citations" }).click();
    await app.page.locator(".citation-document .citation-band[data-active]").first().waitFor();
    await rows(app).nth(1).click(); await app.page.locator(".citation-review").focus();
    await app.page.keyboard.press("Delete"); await app.idle();
    await step(app, "Sources", { via: "next" });
    record.check(await selectedTab(app) === "Sources", "Next after an edit goes on to Sources in one click", await selectedTab(app));
    // Highlights, then Build: built outputs are current after a reload, not "previous".
    await step(app, "Highlights", { via: "next" });
    await app.reload({ until: () => app.button("Edit in PDF").waitFor({ timeout: 60_000 }) });
    record.check(await selectedTab(app) === "Highlights", "the draft resumes on Highlights", await selectedTab(app));
    await step(app, "Build book", { via: "next" });
    await build(app, "book", { missing: 1 });
    await app.reload({ until: () => dock(app).getByRole("button", { name: /^Download / }).first().waitFor({ timeout: 60_000 }) });
    record.check(await selectedTab(app) === "Build book", "the draft resumes on Build", await selectedTab(app));
    const labels = await dock(app).getByRole("button", { name: /^Download / }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
    record.check(labels.length && labels.every((label) => !label.startsWith("Download previous")), "built outputs are current after a reload", labels);
    await app.shots("resumed-build");
    await app.close();
  },
}, {
  name: "drafts",
  title: "The drafts list: nine drafts, two pages, open, rename, duplicate and delete",
  async run({ open, fixtures, record }) {
    const app = await open({ network: { a2aj: fixtureA2aj() } });
    await app.load();
    // Three briefs imported, then duplicated up to nine drafts.
    for (const file of [fixtures.briefPdf, fixtures.briefDocx, fixtures.varietyDocx]) {
      if (await app.button("New").isEnabled()) await app.button("New").click();
      await importBrief(app, file);
    }
    const menu = () => app.page.getByRole("button", { name: "authorities draft actions" });
    for (let count = 3; count < 9; count += 1) {
      await menu().click();
      await app.page.getByRole("menuitem", { name: "Duplicate" }).click();
      await app.page.locator(".citation-document .citation-band[data-active]").first().waitFor();
      await app.idle();
    }
    // Another section is another view: the panel below the header may take its place.
    const view = ({ sources }) => sources.every(({ node }) => /#authorities-panel/u.test(node ?? ""));
    await app.interact("open Drafts", () => app.page.getByRole("tab", { name: "Drafts" }).click(), { shiftsOk: view });
    const list = app.page.locator("#authorities-panel section").filter({ hasText: "Saved drafts" });
    const titles = () => list.locator("button span.truncate").allInnerTexts();
    record.check((await titles()).length === 8 && await list.getByText("Page 1 of 2").count() === 1, "the list shows eight drafts a page, on two pages",
      await titles());
    await app.shots("drafts");
    await app.interact("Drafts page 2", () => list.getByRole("button", { name: "Next" }).click());
    record.check((await titles()).length === 1, "page two holds the ninth draft", await titles());
    await app.interact("Drafts page 1", () => list.getByRole("button", { name: "Previous" }).click());
    // The oldest import is last; open it.
    const opened = (await titles()).find((title) => title.includes("harbour-factum"));
    record.check(!!opened, "an imported draft is listed by its file name", await titles());
    await app.interact("open a draft from the list", () => list.getByRole("button").filter({ hasText: "harbour-factum" }).first().click(),
      { budget: BUDGETS.dialog, shiftsOk: view, wait: () => app.page.locator(".citation-document .citation-band[data-active]").first().waitFor() });
    record.check((await app.page.locator("header h1").innerText()).startsWith("harbour-factum"), "the draft chosen opens", await app.page.locator("header h1").innerText());
    // Rename, then delete: the list follows.
    await menu().click(); await app.page.getByRole("menuitem", { name: "Rename" }).click();
    const name = app.page.getByRole("textbox", { name: "Rename authorities draft" });
    await name.fill("Respondent's factum, renamed"); await name.press("Enter"); await app.idle();
    record.check(await app.page.locator("header h1").innerText() === "Respondent's factum, renamed", "a draft is renamed in place");
    await menu().click(); await app.page.getByRole("menuitem", { name: "Delete" }).click();
    const confirm = app.page.getByRole("alertdialog");
    await app.shots("delete-confirm");
    await app.button("Delete", confirm).click(); await app.idle();
    await app.page.getByRole("tab", { name: "Drafts" }).click();
    const left = [...await titles()];
    if (await list.getByRole("button", { name: "Next" }).isEnabled()) { await list.getByRole("button", { name: "Next" }).click(); left.push(...await titles()); }
    record.check(left.length === 8 && !left.some((title) => title.includes("renamed")), "a deleted draft leaves the list", left);
    await app.close();
  },
}, {
  name: "manual",
  title: "Manual mode: a titled book from five PDFs (one a scan), reordered, relabelled and built",
  async run({ open, fixtures, record, renderer }) {
    const app = await open({});
    await app.load();
    await app.interact("open Manual", () => app.page.getByRole("tab", { name: "Manual" }).click());
    await app.page.getByRole("textbox").first().fill("Book of Authorities of the Respondent");
    await chooseCourt(app, app.page.getByRole("button", { name: /^Court:/u }), "abkb");
    await app.shots("manual-start");
    const files = [...fixtures.decisionPdfs, fixtures.scans[0].file];
    const started = await app.now();
    await app.pick(() => app.button("Add files").click(), files);
    await app.page.getByRole("list", { name: "Authority tab slots" }).waitFor();
    await app.page.waitForFunction((count) => document.querySelectorAll("[aria-label='Authority tab slots'] > [role=listitem]").length === count &&
      !document.querySelector("[role=status][aria-busy=true]"), files.length, { timeout: 60_000 });
    record.note("manual add five PDFs", await app.now() - started);
    record.check(await app.now() - started < 6000, "five PDFs are added in under 6 s", Math.round(await app.now() - started));
    await app.shots("manual-sources");
    // The third moves up one with the keyboard, as its reorder handle offers.
    const names = () => tabSlots(app).locator("h3, span.italic").allInnerTexts();
    const order = await names();
    await tabSlots(app).nth(2).getByRole("button", { name: /^Reorder/u }).focus();
    // The rows it trades places with move; nothing else does.
    await app.interact("move the third PDF up", () => app.page.keyboard.press("ArrowUp"),
      { shiftsOk: ({ sources }) => sources.every(({ node }) => /Authority tab slots\] > article/u.test(node ?? "")) });
    await app.idle();
    const moved = await names();
    record.check(moved[1] === order[2] && moved[2] === order[1], "ArrowUp on a reorder handle moves the PDF up", moved);
    // Tab labels as letters.
    await app.interact("open Tab labels", () => app.button("Tab labels").click(), { budget: BUDGETS.dialog });
    const labels = app.page.getByRole("dialog", { name: "Tab labels" });
    await labels.getByRole("combobox").first().selectOption("alpha");
    await app.shots("tab-labels");
    await app.button("Done", labels).click(); await app.idle();
    record.check((await tabSlots(app).first().locator("button").first().innerText()).includes("A"), "tabs are lettered", await tabSlots(app).first().innerText());
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await app.shots("manual-build");
    await build(app, "manual book", { budget: 20_000 });
    const book = pick(await downloads(app, "book"), /\.pdf$/u);
    const pdf = await checkPdf(record, "manual book", book, { tabs: files.length });
    record.check(pdf.tabs.map(({ title }) => title).join() .includes("Tab A"), "the book's tabs are lettered", pdf.tabs.map(({ title }) => title));
    await renderer.sheet(book, path.join(record.out, "manual-book.jpg"), { first: 6 });
    await app.close();
  },
}];
