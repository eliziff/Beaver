// Opens each delivered file as its reader would. PDFs are read back (pages, bookmarks, links,
// marks, any text nobody asked for) and their key pages rendered with PDF.js in Chromium; Word
// documents are opened in invisible Word (scripts/authorities-stress/word.ps1), unchanged, and
// what Word shows is read back and exported to PDF to be rendered the same way.
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { flatOutline } from "../authorities-html-e2e/outputs.mjs";

const pdfjs = path.dirname(createRequire(new URL("../../frontend/package.json", import.meta.url)).resolve("pdfjs-dist/package.json"));
const pdfjsLib = await import(pathToFileURL(path.join(pdfjs, "legacy/build/pdf.mjs")).href);
// Text no output may carry: draft stamps, and labels or times the app never asked to print.
const STAMPS = /\b(?:INCOMPLETE|DO NOT FILE|NOT FOR FILING|DRAFT COPY)\b|Generated (?:by|on)|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u;

/** What a PDF holds, from its own structure: pages and their text, bookmarks, links and marks
 *  (each with its kind, colour and any note a viewer would show beside it). */
export async function inspectPdf(file) {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, verbosity: 0 }), document = await task.promise;
  try {
    const target = async (destination) => {
      const explicit = typeof destination === "string" ? await document.getDestination(destination) : destination;
      return Array.isArray(explicit) && explicit[0] ? await document.getPageIndex(explicit[0]) + 1 : null;
    };
    const tree = async (items) => Promise.all((items ?? []).map(async (item) => ({ title: item.title,
      page: item.dest ? await target(item.dest) : null, children: await tree(item.items) })));
    const outline = flatOutline(await tree(await document.getOutline()));
    const text = [], annotations = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      text.push((await page.getTextContent()).items.map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`).join(""));
      for (const annotation of await page.getAnnotations()) annotations.push({ page: number, subtype: annotation.subtype,
        url: annotation.url ?? null, destinationPage: annotation.dest ? await target(annotation.dest) : null,
        color: annotation.color ? [...annotation.color] : null, rect: annotation.rect,
        note: [annotation.titleObj?.str, annotation.contentsObj?.str].filter(Boolean).join(" — ") });
    }
    return { pages: document.numPages, title: (await document.getMetadata()).info?.Title ?? "", outline,
      tabs: outline.filter(({ title }) => /^Tab\b/u.test(title)),
      links: annotations.filter(({ subtype }) => subtype === "Link"),
      marks: annotations.filter(({ subtype }) => !["Link", "Widget", "Popup"].includes(subtype)), text };
  } finally { await task.destroy(); }
}
/** A mark's colour by name: red, black or yellow. */
export const colourOf = ({ color }) => !color ? "none" : color[0] > 150 && color[1] < 80 ? "red"
  : color[0] < 60 && color[1] < 60 && color[2] < 60 ? "black" : color[0] > 200 && color[1] > 180 && color[2] < 190 ? "yellow" : color.join(",");

/** The checks every delivered PDF passes, and those its case expects. Returns its summary. */
export async function checkPdf(record, label, file, expect = {}) {
  const pdf = await inspectPdf(file), where = `${label} ${path.basename(file)}`;
  record.check(pdf.pages > 0, `${where}: has pages`);
  const badOutline = pdf.outline.filter(({ page }) => !page || page < 1 || page > pdf.pages);
  record.check(!badOutline.length, `${where}: every bookmark opens a page in it`, badOutline.slice(0, 4).map(({ title }) => title));
  const multiLine = pdf.outline.filter(({ title }) => /[\r\n]/u.test(title));
  record.check(!multiLine.length, `${where}: bookmark titles are one line`, multiLine.slice(0, 4).map(({ title }) => title));
  const badLinks = pdf.links.filter(({ url, destinationPage }) => !url && (!destinationPage || destinationPage > pdf.pages));
  record.check(!badLinks.length, `${where}: every link lands in the PDF`, badLinks.slice(0, 4));
  const noted = pdf.marks.filter(({ note }) => note);
  record.check(!noted.length, `${where}: no mark carries an author or comment`, noted.slice(0, 3).map(({ note }) => note));
  const stamped = pdf.text.flatMap((text, index) => STAMPS.test(text) ? [`p${index + 1}: ${STAMPS.exec(text)[0]}`] : []);
  record.check(!stamped.length, `${where}: nothing stamped or printed that was not asked for`, stamped.slice(0, 4));
  for (const name of expect.unprinted ?? []) {
    const pages = pdf.text.flatMap((text, index) => text.includes(name) ? [index + 1] : []);
    record.check(!pages.length, `${where}: "${name}" is not printed`, pages.slice(0, 6));
  }
  if (expect.tabs !== undefined) record.check(pdf.tabs.length === expect.tabs, `${where}: ${expect.tabs} tab bookmarks`,
    pdf.tabs.map(({ title }) => title).slice(0, 12));
  if (expect.marks === true) record.check(pdf.marks.length > 0, `${where}: carries passage marks`);
  if (expect.marks === false) record.check(!pdf.marks.length, `${where}: carries no passage marks`, pdf.marks.slice(0, 3).map(({ subtype, page }) => `${subtype} p${page}`));
  const kinds = pdf.marks.reduce((all, mark) => { const key = `${mark.subtype} ${colourOf(mark)}`; return { ...all, [key]: (all[key] ?? 0) + 1 }; }, {});
  if (expect.markKinds) record.check(expect.markKinds(kinds), `${where}: marks of the kind chosen`, kinds);
  record.outputs.push({ file: path.relative(record.out, file), pages: pdf.pages, tabs: pdf.tabs.length, bookmarks: pdf.outline.length,
    links: pdf.links.length, marks: kinds });
  return pdf;
}

/** A page renderer: PDF.js in a page of its own, served from the frontend's copy. */
export async function pdfRenderer(browser) {
  const context = await browser.newContext({ viewport: { width: 1300, height: 900 } }), served = new Map();
  await context.route("http://render.test/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><body style=margin:0></body>" });
    if (pathname.startsWith("/doc/")) return route.fulfill({ contentType: "application/pdf", body: served.get(pathname.slice(5)) });
    const file = pathname.startsWith("/standard_fonts/") ? path.join(pdfjs, pathname) : path.join(pdfjs, "build", pathname);
    return route.fulfill({ contentType: pathname.endsWith(".mjs") ? "text/javascript" : "application/octet-stream", body: await readFile(file) });
  });
  const page = await context.newPage();
  await page.goto("http://render.test/");
  let count = 0;
  /** A sheet of `pages` (1-based), or the `first` and `last` pages, up to `max`, as one JPEG, each page labelled. */
  async function sheet(file, out, { pages, first, last, max = 12, width = 300 } = {}) {
    const id = String(count += 1); served.set(id, await readFile(file));
    const data = await page.evaluate(async ({ id, pages, first, last, max, width }) => {
      const pdfjs = await import("http://render.test/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "http://render.test/pdf.worker.mjs";
      const task = pdfjs.getDocument({ url: `http://render.test/doc/${id}`, standardFontDataUrl: "http://render.test/standard_fonts/" });
      const document = await task.promise;
      const all = Array.from({ length: document.numPages }, (_, index) => index + 1);
      const wanted = [...new Set(pages ?? (first || last ? [...all.slice(0, first ?? 0), ...all.slice(-(last ?? 0) || all.length)] : all))]
        .filter((number) => number >= 1 && number <= document.numPages).slice(0, max);
      const tiles = [];
      for (const number of wanted) {
        const pdfPage = await document.getPage(number), base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: width / base.width }), canvas = Object.assign(globalThis.document.createElement("canvas"),
          { width: Math.round(viewport.width), height: Math.round(viewport.height) });
        await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
        tiles.push({ number, canvas });
      }
      const columns = Math.min(4, tiles.length), rows = Math.ceil(tiles.length / columns);
      const height = Math.max(...tiles.map(({ canvas }) => canvas.height)) + 22;
      const out = Object.assign(globalThis.document.createElement("canvas"), { width: columns * (width + 10) + 10, height: rows * (height + 10) + 10 });
      const context = out.getContext("2d"); context.fillStyle = "#777"; context.fillRect(0, 0, out.width, out.height);
      tiles.forEach(({ number, canvas }, index) => {
        const x = 10 + (index % columns) * (width + 10), y = 10 + Math.floor(index / columns) * (height + 10);
        context.fillStyle = "#fff"; context.fillRect(x, y, canvas.width, canvas.height); context.drawImage(canvas, x, y);
        context.fillStyle = "#fff"; context.font = "14px sans-serif"; context.fillText(`p ${number}`, x + 4, y + canvas.height + 16);
      });
      await task.destroy();
      return out.toDataURL("image/jpeg", 0.82);
    }, { id, pages, first, last, max, width });
    served.delete(id);
    await writeFile(out, Buffer.from(data.split(",")[1], "base64"));
    return out;
  }
  return { sheet, close: () => context.close() };
}

/** Word's running processes, by id. */
export const wordProcesses = () => execFileSync("tasklist", ["/FI", "IMAGENAME eq WINWORD.EXE", "/FO", "CSV", "/NH"], { encoding: "utf8" })
  .split(/\r?\n/u).flatMap((line) => /^"WINWORD\.EXE","(\d+)"/iu.exec(line)?.[1] ?? []).map(Number);
/** Opens every Word document in invisible Word, unchanged; returns what Word showed, in order. A
 *  document Word does not finish opening within `stall` ms (a dialog it shows unseen) is recorded as
 *  such, the Word started for it is stopped, and the rest are opened in a new one. Only the Word
 *  this function starts is ever stopped. */
export async function openInWord(items, dir, { stall = 45_000 } = {}) {
  const done = [];
  while (done.length < items.length) {
    const rest = items.slice(done.length), round = done.length;
    const manifest = path.join(dir, `word-manifest-${round}.json`), results = path.join(dir, `word-results-${round}.jsonl`);
    const pids = path.join(dir, `word-pid-${round}.txt`);
    await writeFile(manifest, JSON.stringify(rest.map(({ file, pdf }) => ({ file: path.resolve(file), pdf: pdf && path.resolve(pdf) }))));
    await writeFile(results, "");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(import.meta.dirname, "word.ps1"), "-Manifest", manifest, "-Results", results, "-PidFile", pids], { stdio: "inherit" });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    const read = async () => (await readFile(results, "utf8")).split(/\r?\n/u).map((line) => line.replace(/^﻿/u, "").trim())
      .filter(Boolean).map((line) => JSON.parse(line));
    let seen = 0, since = Date.now(), finished = false;
    exited.then(() => { finished = true; });
    while (!finished) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const count = (await read()).length;
      if (count !== seen) { seen = count; since = Date.now(); }
      if (Date.now() - since > stall) {
        // Word sits on a dialog nobody can see: stop the Word started for this round, and the script.
        const started = (await readFile(pids, "utf8").catch(() => "")).split(",").map((value) => Number(value.trim())).filter(Boolean);
        for (const pid of started) try { process.kill(pid); } catch { /* already gone */ }
        child.kill(); await exited; break;
      }
    }
    const results$ = await read();
    done.push(...results$);
    if (results$.length < rest.length && done.length < items.length) done.push({ file: path.resolve(rest[results$.length].file), opened: false,
      error: `Word did not finish opening it within ${stall / 1000} s; it shows invisible Word a dialog.` });
  }
  return done;
}

/** What Word showed of a document's tables of authorities (scripts/authorities-stress/word.ps1),
 *  checked as its reader sees them. `expect`: `toa`, a table in the brief; `ta`, the citation fields
 *  Word's own inserted table lists; `table`, a table delivered as its own document; `italics`, names
 *  in italics. Its text is black throughout, a printed link alone in link colour. */
export function checkWordTables(check, where, result, expect) {
  // A table of authorities reads as one as Word shows it: each entry on its own line, its pages after a
  // tab, and its style of cause in italics where the citation begins.
  const listed = (entries = []) => entries.filter(({ text }) => text.includes("\t"));
  const styled = (entries) => entries.some(({ italic }) => italic) && entries.every(({ text, italic }) => !italic || text.startsWith(italic));
  if (expect.toa) {
    const entries = listed(result.toaEntries);
    check(entries.length && entries.every(({ text }) => /\t\d[\d, ]*$/u.test(text)), `${where}: its table lists each entry with its pages`, result.toaEntries);
    check(styled(entries), `${where}: its table italicizes each style of cause where the citation begins`, entries);
  }
  // Word's own table, inserted from the citation fields as its reader would (References > Insert Table of
  // Authorities), lists every authority marked, with its pages and its italics.
  if (expect.ta) {
    const entries = listed(result.insertedEntries);
    check(entries.length >= expect.ta && entries.every(({ text }) => /\t\d[\d, ]*$/u.test(text)),
      `${where}: Word's own table, inserted from its fields, lists ${expect.ta} authorities with their pages`, result.insertedEntries);
    check(styled(entries), `${where}: Word's own table keeps each style of cause in italics`, entries);
  }
  // A table on its own reads as the brief's: each entry its citation, then after a tab its pages or its tab.
  if (expect.table) {
    const entries = listed(result.entries);
    check(entries.length && entries.every(({ text }) => /\t\S[^\t]*$/u.test(text)), `${where}: lists each entry with its pages or tab`, result.entries);
    check(styled(entries), `${where}: italicizes each style of cause where the citation begins`, entries);
  }
  for (const name of expect.italics ?? []) check((result.entries ?? []).some(({ italic }) => italic.includes(name)),
    `${where}: ${name} is in italics`, result.entries);
  const colored = [...expect.table || expect.italics ? result.entries ?? [] : [], ...result.toaEntries ?? []].filter(({ colored }) => colored && !/^https?:\/\/\S+$/u.test(colored));
  check(!colored.length, `${where}: its tables' text is black, a printed link alone in link colour`, colored);
}
