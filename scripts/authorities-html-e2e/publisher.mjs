// The publisher-block path of the standalone Authorities.html. The download service (the
// Authorities-lite Worker) is stubbed: from file:// it answers that the publisher asked for
// verification; over http it answers this page's address without letting the page read it, as
// the real one does for an origin it does not serve. Two invented-for-the-test decisions stand in
// for an S.C.C. judgment and a Federal Court one. Folder pick-up runs over http, where the page's
// own origin-private storage is the folder Chrome would have handed it.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SERVICE = "https://quiet-wildflower-ab0d.authorities-lite.workers.dev/";
const DECISIONS = [
  { citation: "2019 SCC 65", alternate: "[2019] 4 SCR 653", name: "Canada (Minister of Citizenship and Immigration) v. Vavilov",
    heading: "Vavilov", page: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/99001/index.do",
    opens: "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/99001/1/document.do", subject: "certificate" },
  { citation: "2031 FC 212", alternate: null, name: "Harbour Paddlers Co-operative v. Canada (Attorney General)",
    heading: "Harbour Paddlers", page: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/512345/index.do",
    opens: "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/512345/index.do", subject: "launch permit" },
];
const WORDS = ["board", "record", "season", "notice", "river", "reply", "hearing", "delay", "basin", "reasons",
  "licence", "weather", "members", "schedule", "harbour", "minister"];
/** Placeholder reasons, different words for each decision, so its text tells it apart. */
const prose = (subject, count = 40) => Array.from({ length: count }, (_, index) =>
  `[${index + 1}] The ${subject} ${WORDS[index % WORDS.length]} was weighed against the ${WORDS[(index * 7 + 3) % WORDS.length]} ` +
  `and the ${WORDS[(index * 5 + 1) % WORDS.length]} in paragraph ${index + 1} of these ${subject} reasons.`).join("\n\n");
const record = (item) => ({ dataset: "test", citation_en: item.citation, citation2_en: item.alternate, name_en: item.name,
  document_date_en: "2031-03-04", url_en: item.page, unofficial_text_en: prose(item.subject),
  upstream_license: "Synthetic test record" });
const BRIEF = `<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:1in}body{font:12pt/1.6 serif}</style>
<h1>Memorandum of the Applicant</h1><p>1. The applicant asks the Court to review the refusal of its launch permit.</p>
<p>2. Reasonableness is the presumptive standard: Canada (Minister of Citizenship and Immigration) v Vavilov, 2019 SCC 65 at para 10.</p>
<p>3. A permit board must give reasons for a refusal: Harbour Paddlers Co-operative v Canada (Attorney General), 2031 FC 212 at para 5.</p>`;
const judgment = (heading, body) => `<!doctype html><meta charset="utf-8"><style>@page{size:Letter;margin:1in}body{font:11pt/1.5 serif}p{margin:0 0 8pt}</style>
${heading.map((line) => `<p>${line}</p>`).join("")}${body.split("\n\n").map((text) => `<p>${text}</p>`).join("")}`;

/** The publisher-block runs: file:// in both source modes, then http with folder pick-up. */
export async function publisherRuns({ browser, html, serve, out, check, note, instrument }) {
  const shotDir = path.join(out, "screenshots"), files = path.join(out, "fixtures");
  const pdf = async (markup, name) => {
    const page = await browser.newPage();
    try { await page.setContent(markup); await writeFile(path.join(files, name), await page.pdf({ preferCSSPageSize: true })); }
    finally { await page.close(); }
    return path.join(files, name);
  };
  const brief = await pdf(BRIEF, "permit-brief.pdf");
  const [harbour, vavilov] = [DECISIONS[1], DECISIONS[0]];
  const downloads = {
    // Saved under the publisher's names, which say nothing of the case.
    "document.pdf": await pdf(judgment(["Federal Court", "Date: 20310304", `Citation: ${harbour.name}, ${harbour.citation}`],
      prose(harbour.subject)), "document.pdf"),
    "document (1).pdf": await pdf(judgment(["Reasons for Judgment"], prose(vavilov.subject)), "document (1).pdf"),
    "brochure.pdf": await pdf(judgment(["Federal Court", "Citation: Hill v. Shore, 2031 FC 9"], prose(harbour.subject)), "brochure.pdf"),
    "document (2).pdf": await pdf(judgment(["Federal Court", `Citation: ${harbour.name}, ${harbour.citation}`],
      prose(harbour.subject)), "document (2).pdf"),
  };
  for (const [mode, sourceMode] of [["file", "automatic"], ["file", "manual"], ["http", "manual"]]) {
    console.log(`\n== ${mode}, a blocked publisher, ${sourceMode} sources ==`);
    const server = mode === "http" ? await serve(html) : null;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), service = [], opened = [];
    await context.route(/^https?:\/\//u, async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (["127.0.0.1", "localhost"].includes(url.hostname)) return route.continue();
      if (url.hostname === "api.a2aj.ca") {
        const citation = url.searchParams.get("citation");
        const hit = url.pathname === "/fetch" && DECISIONS.find((item) => [item.citation, item.alternate].includes(citation));
        return route.fulfill({ json: { results: hit ? [record(hit)] : [] } });
      }
      if (url.href.startsWith(SERVICE)) {
        service.push(`${request.method()} ${url.searchParams.get("source")}`);
        // Over http the real service answers without a CORS header, so the page cannot read it.
        if (mode === "http") return request.method() === "HEAD" ? route.fulfill({ status: 403 }) : route.abort("failed");
        return route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" }, json: {
          error: "Automatic download blocked.", code: "verification_required",
          verificationUrl: `${url.searchParams.get("source").split("/").slice(0, 3).join("/")}/robocop/captcha/en/query.do` } });
      }
      if (DECISIONS.some((item) => new URL(item.page).hostname === url.hostname)) {
        opened.push(url.href);
        return route.fulfill({ contentType: "text/html", body: "<title>Publisher</title>" });
      }
      return route.abort("blockedbyclient");
    });
    await context.addInitScript(instrument);
    // Chrome's folder chooser cannot be answered headless; the folder it would hand over is a real
    // directory in the page's origin-private storage, read through the same handle interface.
    if (mode === "http") await context.addInitScript(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("Authorities", { create: true });
      if (sessionStorage.getItem("e2e-folder-asks")) {
        let granted = false;
        FileSystemHandle.prototype.queryPermission = async () => granted ? "granted" : "prompt";
        FileSystemHandle.prototype.requestPermission = async () => { granted = true; return "granted"; };
      }
    });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(30000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/^Error in (?:pix|bmf)\w+:|Failed to load resource/u.test(message.text())) errors.push(message.text()); });
    const label = `publisher-${mode}-${sourceMode}`;
    try {
      await blocked(page, { mode, sourceMode, url: server?.url ?? pathToFileURL(html).href, brief, label, service, opened, shotDir, check, note });
      if (mode === "http") await folder(page, { downloads, label, shotDir, check, note });
    } catch (error) {
      check(false, `${label}: the run stopped`, error.stack?.split("\n").slice(0, 6).join("\n"));
      await page.screenshot({ path: path.join(shotDir, `${label}-stopped.png`) }).catch(() => {});
    } finally {
      check(!errors.length, `${label}: the page reported errors`, errors.slice(0, 10));
      check(!opened.some((url) => /robocop/u.test(url)), `${label}: nothing opens a CAPTCHA page`, opened);
      await context.close(); await server?.close();
    }
  }
}

const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const idle = async (page) => {
  await page.waitForFunction(() => !document.querySelector("[role=status][aria-busy=true]"), null, { timeout: 60000 });
  await settle(page);
};
// The test's own window resizes move everything; shifts while it resizes are not the page's.
const resized = [];
/** Both window sizes; `open` brings back a menu the resize closed. */
async function shots(page, shotDir, name, open) {
  const from = await page.evaluate(() => performance.now());
  for (const [width, height] of [[1440, 900], [1280, 720]]) {
    await page.setViewportSize({ width, height }); await settle(page);
    if (open && !await page.getByRole("menu").isVisible()) { await open(); await settle(page); }
    await page.screenshot({ path: path.join(shotDir, `${name}-${width}x${height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await settle(page);
  resized.push([from, await page.evaluate(() => performance.now()) + 50]);
}
const shifts = async (page, from) => (await page.evaluate((from) => window.__e2e.window(from, performance.now()).shifts, from))
  .filter(({ start }) => !resized.some(([from, to]) => start >= from && start <= to))
  .map(({ value, sources }) => [value.toFixed(4), sources.map(({ node, moved }) => `${node} ${moved}`)]);
const row = (page, name) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, exact: false }) });

/** Imports the brief with the chosen source handling, goes to Sources, and checks each blocked row. */
async function blocked(page, { mode, sourceMode, url, brief, label, service, opened, shotDir, check, note }) {
  await page.goto(url);
  await page.getByRole("button", { name: "Add file" }).waitFor();
  await page.waitForFunction(() => !document.querySelector("button:disabled[aria-label='Add file'], [aria-busy=true]"));
  if (mode === "file") {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add file", exact: true }).click();
    await (await chooser).setFiles([brief]);
  } else {
    await page.evaluate((staged) => { window.__e2ePick = staged; },
      [{ name: path.basename(brief), base64: (await readFile(brief)).toString("base64") }]);
    await page.getByRole("button", { name: "Add file", exact: true }).click();
  }
  const setup = page.getByRole("dialog", { name: "Import options" });
  await setup.waitFor();
  if (sourceMode === "manual") await setup.locator("label", { has: page.getByRole("radio",
    { name: "Use available original PDFs and manually add the PDFs myself for the rest" }) }).click({ position: { x: 6, y: 6 } });
  await page.getByRole("button", { name: "Import and review", exact: true }).click();
  await page.locator(".citation-document .citation-band").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(500); await idle(page);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const list = page.getByRole("list", { name: "Authority tab slots" });
  await list.waitFor({ timeout: 60000 });
  const from = await page.evaluate(() => performance.now());
  await idle(page); await page.waitForTimeout(400);
  note(mode, `${label}-service`, service);
  const reason = mode === "http" ? "Automatic downloads don't work from this page's address."
    : "The publisher blocked the automatic download.";
  for (const decision of DECISIONS) {
    const item = row(page, decision.heading), title = await item.getByRole("heading").innerText();
    const mark = sourceMode === "automatic" ? `Built from source text. ${reason}` : reason;
    check(await item.getByRole("img", { name: mark, exact: true }).count() === 1,
      `${label}: ${decision.heading} says why its original is missing`, await item.getByRole("img").evaluateAll((marks) => marks.map((m) => m.getAttribute("aria-label"))));
    const link = item.getByRole("link", { name: `Open publisher for ${title}` });
    const menu = item.getByRole("button", { name: `Options for ${title}` });
    check(!await item.getByRole("button", { name: "Retry download" }).count() && !await item.getByText("Retry download").count(),
      `${label}: ${decision.heading} has no Retry download in the row`);
    if (sourceMode === "automatic") {
      // The text rebuild stays: View and Replace in the row, the publisher in its options.
      check(!await link.count() && await item.getByRole("button", { name: `View PDF for ${title}` }).count() === 1 &&
        await item.getByRole("button", { name: `Replace for ${title}` }).count() === 1,
      `${label}: ${decision.heading} keeps its text rebuild with View and Replace`);
      const popup = page.context().waitForEvent("page");
      await menu.click();
      const items = await page.getByRole("menuitem").allInnerTexts();
      check(items.includes("Open publisher") && !items.includes("Retry download"),
        `${label}: ${decision.heading}'s options open the publisher`, items);
      if (decision === DECISIONS[0]) await shots(page, shotDir, `${label}-options`, () => menu.click());
      if (!await page.getByRole("menuitem", { name: "Open publisher" }).isVisible()) await menu.click();
      await page.getByRole("menuitem", { name: "Open publisher" }).click();
      const tab = await popup;
      await tab.waitForLoadState("domcontentloaded").catch(() => {});
      check(tab.url() === decision.opens, `${label}: ${decision.heading}'s Open publisher opens ${decision.opens}`, tab.url());
      await tab.close();
    } else {
      check(await link.getAttribute("href") === decision.opens, `${label}: ${decision.heading}'s Open publisher links ${decision.opens}`,
        await link.getAttribute("href"));
      await menu.click();
      const items = await page.getByRole("menuitem").allInnerTexts();
      // Asking a service that refuses this page again is no use; a block may clear.
      check(items.includes("Retry download") === (mode === "file") && !items.includes("Open publisher"),
        `${label}: ${decision.heading}'s options ${mode === "file" ? "hold" : "leave out"} Retry download`, items);
      if (decision === DECISIONS[0]) await shots(page, shotDir, `${label}-options`, () => menu.click());
      await page.keyboard.press("Escape");
    }
  }
  check(opened.every((url) => DECISIONS.some(({ opens }) => opens === url)), `${label}: only the publishers' own pages open`, opened);
  if (sourceMode === "manual" && mode === "file") {
    const asked = service.length, title = await row(page, "Vavilov").getByRole("heading").innerText();
    await row(page, "Vavilov").getByRole("button", { name: `Options for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Retry download" }).click();
    await idle(page); await page.waitForTimeout(300);
    check(service.length > asked && await row(page, "Vavilov").getByRole("img", { name: reason, exact: true }).count() === 1,
      `${label}: Retry download asks the service again and the row keeps its reason`, service.slice(asked));
  }
  // The actions keep one column whatever a row holds, and nothing moved while the reasons arrived.
  const columns = await list.getByRole("listitem").evaluateAll((items) => items.map((item) =>
    [...item.querySelectorAll("button[aria-label^='Options for']")].map((button) => Math.round(button.getBoundingClientRect().left)).join()));
  check(new Set(columns).size === 1, `${label}: every row's options sit in one column`, columns);
  const moved = await shifts(page, from);
  check(!moved.length, `${label}: the Sources rows do not move as their reasons arrive, menus open and retries run`, moved);
  await shots(page, shotDir, `${label}-sources`);
}

/** Folder pick-up over the page's own storage: real PDFs, the real matcher, no OCR. */
async function folder(page, { downloads, label, shotDir, check, note }) {
  const button = page.getByRole("button", { name: "Auto-fetch from folder" });
  check(/Downloads\\Authorities/u.test(await button.getAttribute("title")) && /won't share Downloads itself/u.test(await button.getAttribute("title")),
    `${label}: Auto-fetch says to choose the folder Chrome saves into`, await button.getAttribute("title"));
  await button.click();
  await page.getByRole("button", { name: /^Watching Authorities/u }).waitFor();
  const put = async (names) => {
    for (const name of names) await page.evaluate(async ({ name, base64 }) => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle("Authorities", { create: true });
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      await writable.write(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))); await writable.close();
    }, { name, base64: (await readFile(downloads[name])).toString("base64") });
    // Coming back to the tab looks at once, without waiting for the next look.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  };
  const from = await page.evaluate(() => performance.now());
  await put(["document.pdf", "document (1).pdf", "brochure.pdf"]);
  const loaded = (heading, file) => row(page, heading).getByRole("img", { name: file, exact: true });
  await loaded("Harbour Paddlers", "document.pdf").waitFor({ timeout: 30000 }).catch(() => {});
  await loaded("Vavilov", "document (1).pdf").waitFor({ timeout: 30000 }).catch(() => {});
  await idle(page);
  check(await loaded("Harbour Paddlers", "document.pdf").count() === 1,
    `${label}: a download named for nothing is matched by the citation it opens with`);
  check(await loaded("Vavilov", "document (1).pdf").count() === 1,
    `${label}: a download with no citation is matched by A2AJ's text of the case`);
  note("http", `${label}-folder-toast`, await page.getByRole("status").filter({ hasText: /^Auto-fetched/u }).allInnerTexts());
  check(!await page.getByText(/Recognizing text|Waiting to recognize/u).count(), `${label}: nothing from the folder is recognized`);
  await shots(page, shotDir, `${label}-folder-matched`);
  // A later copy never replaces a PDF an authority has.
  await put(["document (2).pdf"]); await page.waitForTimeout(3000); await idle(page);
  check(await loaded("Harbour Paddlers", "document.pdf").count() === 1, `${label}: a later download never replaces a PDF the authority has`);
  const moved = await shifts(page, from);
  check(!moved.length, `${label}: folder pick-up moves nothing`, moved);
  // The folder is kept: a new visit watches it again with nothing to click.
  await page.reload();
  await page.getByRole("button", { name: /^Watching Authorities/u }).waitFor({ timeout: 30000 });
  check(!await page.getByRole("dialog", { name: "Folder access" }).count(), `${label}: a kept folder Chrome still allows is watched without asking`);
  // When Chrome asks again, the next click explains it once, and Allow resumes watching.
  await page.evaluate(() => sessionStorage.setItem("e2e-folder-asks", "1"));
  await page.reload();
  await page.getByRole("button", { name: "Auto-fetch from folder" }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  check(!await page.getByRole("dialog", { name: "Folder access" }).count(), `${label}: nothing asks before a click`);
  await page.getByRole("button", { name: "Auto-fetch from folder" }).click();
  const prompt = page.getByRole("dialog", { name: "Folder access" });
  await prompt.waitFor();
  await shots(page, shotDir, `${label}-folder-access`);
  await prompt.getByRole("button", { name: "Allow access" }).click();
  await page.getByRole("button", { name: /^Watching Authorities/u }).waitFor();
  check(!await prompt.count(), `${label}: Allow access resumes watching the kept folder`);
}
