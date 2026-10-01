// Reads what the standalone Authorities page downloaded: PDF pages, bookmarks, highlight and
// link annotations (with the page each link lands on), and the Word copy's fields and text.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const frontend = path.resolve(import.meta.dirname, "../../frontend");
const require = createRequire(path.join(frontend, "package.json"));
const pdfjs = await import(pathToFileURL(path.join(frontend, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
const JSZip = require("jszip");

/** Every page's text, the outline as a tree of { title, page, children } (pages from 1), and
 *  each page's highlight and link annotations, a link with the page its destination opens. */
export async function readPdf(file) {
  const task = pdfjs.getDocument({ data: new Uint8Array(await readFile(file)), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, verbosity: 0 }), document = await task.promise;
  try {
    const explicitDestination = async (destination) =>
      typeof destination === "string" ? await document.getDestination(destination) : destination;
    const destinationPage = async (destination) => {
      const explicit = await explicitDestination(destination);
      return Array.isArray(explicit) && explicit[0] ? await document.getPageIndex(explicit[0]) + 1 : null;
    };
    const outline = async (items) => Promise.all((items ?? []).map(async (item) => ({ title: item.title,
      page: item.dest ? await destinationPage(item.dest) : null, children: await outline(item.items) })));
    const pages = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      const page = await document.getPage(number);
      const text = (await page.getTextContent()).items.map((item) => `${item.str}${item.hasEOL ? "\n" : ""}`).join("");
      const annotations = await Promise.all((await page.getAnnotations()).map(async (annotation) => ({
        subtype: annotation.subtype, rect: annotation.rect, url: annotation.url ?? null,
        destinationPage: annotation.dest ? await destinationPage(annotation.dest) : null,
        // "Fit" opens a whole page (a tab); "XYZ" opens a place on it (a pinpoint), with its top.
        destination: annotation.dest ? (await explicitDestination(annotation.dest))?.slice(1).map((part) => part?.name ?? part) : null })));
      pages.push({ number, text, annotations });
    }
    return { pageCount: document.numPages, outline: await outline(await document.getOutline()), pages };
  } finally { await task.destroy(); }
}

/** The Word document's body XML and its plain text, field codes included. */
export async function readDocx(file) {
  const zip = await JSZip.loadAsync(await readFile(file));
  const xml = await zip.file("word/document.xml").async("string");
  const notes = await zip.file("word/footnotes.xml")?.async("string") ?? "";
  const text = (source) => [...source.matchAll(/<w:(?:t|instrText)\b[^>]*>([^<]*)<\/w:(?:t|instrText)>/gu)].map(([, value]) => value).join("");
  return { xml, notes, text: text(xml), noteText: text(notes) };
}

/** The flat list of outline entries, each with its depth. */
export const flatOutline = (items, depth = 0) => items.flatMap((item) =>
  [{ ...item, depth }, ...flatOutline(item.children, depth + 1)]);
