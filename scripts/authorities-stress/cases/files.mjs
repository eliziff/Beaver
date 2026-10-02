// The files a draft keeps: Chrome asking again for access after a restart, files changed or moved
// on disk, and publishers that block the download. Served over http, where the page keeps real file
// handles (in its origin-private storage here, which a test can change and remove).
import path from "node:path";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { fixtureA2aj } from "../fixtures.mjs";
import { attach, build, downloads, importBrief, row, step } from "../flows.mjs";
import { checkPdf } from "../outputs.mjs";
import { caseRecord } from "../network.mjs";

const pick = (files, pattern) => Object.entries(files).find(([name]) => pattern.test(name))?.[1];
/** Chrome after a restart: a kept file handle cannot be read until the reader allows it again. */
function askAgain() {
  if (!sessionStorage.getItem("stress-ask")) return;
  let granted = false;
  const { getFile } = FileSystemFileHandle.prototype;
  FileSystemFileHandle.prototype.getFile = function () {
    if (!granted) return Promise.reject(new DOMException("The request is not allowed.", "NotAllowedError"));
    return getFile.call(this);
  };
  FileSystemHandle.prototype.queryPermission = async () => granted ? "granted" : "prompt";
  FileSystemHandle.prototype.requestPermission = async () => { granted = true; return "granted"; };
}
const opfs = (app, action, args) => app.page.evaluate(async ([action, args]) => {
  const root = await navigator.storage.getDirectory();
  if (action === "remove") await root.removeEntry(args.name);
  if (action === "write") { const writable = await (await root.getFileHandle(args.name, { create: true })).createWritable();
    await writable.write(Uint8Array.from(atob(args.base64), (character) => character.charCodeAt(0))); await writable.close(); }
  return (await Array.fromAsync(root.keys())).sort();
}, [action, args]);

export const FILE_CASES = [{
  name: "file-access",
  title: "Chrome asks again after a restart: the File access dialog, Not now, a row's Allow file access, and Allow access",
  async run({ open, fixtures, record }) {
    const app = await open({ mode: "http", network: { a2aj: fixtureA2aj() }, init: [askAgain] });
    await app.load();
    await importBrief(app, fixtures.varietyDocx);
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    // A restart: every kept file needs Chrome's leave again.
    await app.page.evaluate(() => sessionStorage.setItem("stress-ask", "1"));
    await app.page.reload();
    const dialog = app.page.getByRole("dialog", { name: "File access" });
    await dialog.waitFor({ timeout: 30_000 });
    const listed = await dialog.locator("li").allInnerTexts();
    record.check(listed.includes("harbour-factum.docx") && listed.includes("waterways-licensing-act.pdf"), "the dialog names every file to allow", listed);
    await app.shots("file-access");
    await app.interact("Not now", () => app.button("Not now", dialog).click());
    const statute = row(app, "Waterways Licensing Act");
    await statute.getByRole("button", { name: "Allow file access" }).waitFor();
    await app.shots("allow-file-access-rows");
    await app.interact("a row's Allow file access", () => statute.getByRole("button", { name: "Allow file access" }).click(),
      { wait: () => statute.getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30_000 }) });
    record.check(!await app.page.getByRole("button", { name: "Allow file access" }).count(), "one allow lets every kept file be read again");
    // Again, through the dialog's Allow access.
    await app.page.reload();
    await dialog.waitFor({ timeout: 30_000 });
    await app.interact("Allow access", () => app.button("Allow access", dialog).click(),
      { wait: () => dialog.waitFor({ state: "detached", timeout: 30_000 }) });
    await statute.getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30_000 });
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await build(app, "after access", { missing: /Lakeshore/u });
    await app.close();
  },
}, {
  name: "relink",
  title: "A kept PDF changed in place is picked up; one moved away is found missing and added again; a moved brief",
  async run({ open, fixtures, record, renderer }) {
    const app = await open({ mode: "http", network: { a2aj: fixtureA2aj() } });
    await app.load();
    await importBrief(app, fixtures.briefPdf);
    await step(app, "Sources", { via: "next" });
    await attach(app, "Waterways Licensing Act", fixtures.statute);
    await attach(app, "Lakeshore", fixtures.scans[1].file);
    const listed = await opfs(app, "list");
    record.note("kept files", listed);
    // The statute saved again with other bytes, where it was: the draft follows it without asking.
    const changed = (await readFile(fixtures.decisionPdfs[0])).toString("base64");
    await opfs(app, "write", { name: path.basename(fixtures.statute), base64: changed });
    await app.page.reload();
    await app.page.getByRole("list", { name: "Authority tab slots" }).waitFor();
    await app.idle(); await app.page.waitForTimeout(800); await app.idle();
    const statute = row(app, "Waterways Licensing Act");
    record.check(await statute.getByRole("button", { name: /^View PDF for/u }).isEnabled(), "a PDF changed in place stays attached",
      await statute.getByRole("img").first().getAttribute("aria-label"));
    // The scan moved away: its row says so and takes it again from where it is now.
    await opfs(app, "remove", { name: path.basename(fixtures.scans[1].file) });
    await app.page.reload();
    const scan = row(app, "Lakeshore");
    await scan.getByRole("img", { name: /could not be found/u }).waitFor({ timeout: 30_000 });
    await app.shots("moved-pdf");
    const moved = path.join(path.dirname(fixtures.scans[1].file), "moved-lakeshore-scan.pdf");
    await copyFile(fixtures.scans[1].file, moved);
    await app.pick(async () => {
      await scan.getByRole("button", { name: /^(?:Upload|Replace) for/u }).click();
      await app.page.getByRole("menuitem", { name: "Upload from computer" }).click();
    }, [moved]);
    await scan.getByRole("button", { name: /^View PDF for/u }).waitFor({ timeout: 30_000 });
    record.check(!await scan.getByRole("img", { name: /could not be found/u }).count(), "the moved PDF is attached again");
    // The brief itself moved away: the review says what to do, and offers it.
    await opfs(app, "remove", { name: path.basename(fixtures.briefPdf) });
    await app.page.reload();
    await app.page.getByRole("list", { name: "Authority tab slots" }).waitFor();
    await app.page.getByRole("tab", { name: "Citations" }).click();
    await app.page.waitForTimeout(1500);
    const said = (await app.page.locator("#authorities-step").innerText()).replace(/\s+/gu, " ").slice(0, 300);
    record.note("moved brief", said);
    await app.shots("moved-brief");
    const reconnect = app.page.getByRole("button", { name: /^(?:Reconnect|Allow file access)/u });
    record.check(await reconnect.count() > 0, "a moved brief can be found again from the review", said);
    if (await reconnect.count()) {
      const brief = path.join(path.dirname(fixtures.briefPdf), "moved-harbourside-brief.pdf");
      await copyFile(fixtures.briefPdf, brief);
      await app.pick(() => reconnect.first().click(), [brief]);
      await app.page.locator(".citation-document .pdf-text-layer").first().waitFor({ timeout: 30_000 });
      await app.idle();
      record.check(!/could not be found/u.test(await app.page.locator("#authorities-step").innerText()), "the moved brief opens again where it is now");
      await app.shots("brief-found");
    }
    await step(app, "Sources", { via: "next" });
    await step(app, "Highlights", { via: "next" });
    await step(app, "Build book", { via: "next" });
    await build(app, "after moves", { budget: 4000 });
    const book = pick(await downloads(app, "book"), /book-of-authorities\.pdf$/u);
    if (book) { await checkPdf(record, "book", book, { tabs: 5 }); await renderer.sheet(book, path.join(record.out, "book.jpg"), { first: 3, last: 3 }); }
    await app.close();
  },
}, {
  name: "publisher-rows",
  title: "Eight decisions whose publishers block or refuse the download, beside two served: rows, reasons, menus and columns",
  async run({ open, record, fixtures, browser }) {
    // Invented decisions on a publisher's site; two download, the rest are blocked.
    const decisions = Array.from({ length: 10 }, (_, index) => ({ citation: `${2031 + index} FC ${400 + index}`,
      name: `Harbour Paddlers ${["North", "South", "East", "West", "Upper", "Lower", "Inner", "Outer", "Far", "Near"][index]} v. Canada (Attorney General)`,
      url: `https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/${700 + index}/index.do` }));
    const a2aj = new Map(decisions.map((item) => [item.citation, caseRecord({ ...item })]));
    const served = new Map([[decisions[0].url, await readFile(fixtures.decisionPdfs[0])], [decisions[1].url, await readFile(fixtures.decisionPdfs[1])]]);
    const service = async (request, source) => {
      const item = decisions.find(({ url }) => source.startsWith(url.split("/item/")[0]) && source.includes(url.match(/item\/(\d+)/u)[1]));
      if (item && served.has(item.url)) return { status: 200, contentType: "application/pdf", headers: { "access-control-allow-origin": "*" }, body: served.get(item.url) };
      return { status: 403, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({
        error: "Automatic download blocked.", code: "verification_required", verificationUrl: `${new URL(source).origin}/robocop/captcha/en/query.do` }) };
    };
    const brief = path.join(record.out, "permit-brief.pdf");
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:1in}body{font:12pt/1.6 serif}</style>
      <h1>Memorandum of the Applicant</h1>${decisions.map((item, index) => `<p>${index + 1}. The board must give reasons: ${item.name.replace(" v. ", " v ")}, ${item.citation} at para ${index + 2}.</p>`).join("")}`);
    await writeFile(brief, await page.pdf({ preferCSSPageSize: true })); await page.close();
    const app = await open({ network: { a2aj, service }, label: "file" });
    await app.load();
    await importBrief(app, brief, { sourceMode: "manual" });
    await step(app, "Sources", { via: "next" });
    await app.idle(); await app.page.waitForTimeout(500);
    const slots = app.page.getByRole("list", { name: "Authority tab slots" }).getByRole("listitem");
    const marks = await slots.evaluateAll((items) => items.map((item) => item.querySelector("[role=img]")?.getAttribute("aria-label")));
    record.check(marks.filter((mark) => mark === "The publisher blocked the automatic download.").length === 8, "eight rows say the publisher blocked the download", marks);
    record.check(await app.page.getByRole("link", { name: /^Open publisher for/u }).count() === 8, "each blocked row opens its publisher");
    await app.shots("publisher-rows");
    for (const index of [2, 9]) {
      const title = await slots.nth(index).getByRole("heading").innerText();
      await app.interact(`open the options of row ${index + 1}`, () => slots.nth(index).getByRole("button", { name: `Options for ${title}` }).click());
      const items = await app.page.getByRole("menuitem").allInnerTexts();
      record.check(items.includes("Retry download"), "a blocked row's options hold Retry download", items);
      if (index === 9) await app.shots("publisher-menu");
      await app.interact("close the menu", () => app.page.keyboard.press("Escape"));
    }
    await app.close();
  },
}];
