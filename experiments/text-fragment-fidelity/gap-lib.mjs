import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
const cacheDir = path.join(resultsDir, "page-html");
const PDTOTEXT = "C:/Program Files/Git/mingw64/bin/pdftotext.exe";

const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
};
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (/(^|\.)bclaws\.gov\.bc\.ca$/iu.test(url.hostname) && url.pathname.endsWith("/xml")) {
      url.pathname = url.pathname.slice(0, -4);
    }
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return rawUrl.split("#")[0];
  }
}

const manifest = new Map();
const manifestFolded = new Map();
for (const row of readLines(manifestPath).map(parse).filter(Boolean)) {
  if (!row.file) continue;
  if (row.bytes != null && row.bytes < 5000) continue;
  const key = normalizeKey(row.url);
  manifest.set(key, row);
  manifestFolded.set(key.toLowerCase(), row);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;|&#xa0;/giu, "\u00A0")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/giu, (m, h) => String.fromCodePoint(parseInt(h, 16)));
}

function htmlToText(html, markBlocks) {
  let text = html.replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ");
  if (markBlocks) {
    text = text.replace(/<\/(p|li|blockquote|h[1-6]|tr|td|th|div|section|article|pre)>/giu, "\n");
    text = text.replace(/<br\s*\/?>/giu, "\n");
  }
  return text.replace(/<[^>]+>/gu, " ");
}

function pdfToText(file) {
  try {
    return execFileSync(PDTOTEXT, ["-enc", "UTF-8", file, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString("utf8");
  } catch { return ""; }
}

function pageTextOf(gateRow) {
  const targetBase = gateRow?.target ? gateRow.target.split("#")[0] : null;
  if (!targetBase) return null;
  const key = normalizeKey(targetBase);
  const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
  if (!row) return { cacheMiss: true };
  const file = path.join(cacheDir, row.file);
  if (!fs.existsSync(file)) return { cacheMiss: true };
  const isPdf = row.file.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    const raw = pdfToText(file);
    if (!raw.trim()) return { cacheMiss: true };
    return { file: row.file, isPdf: true, raw, blocked: raw, html: null };
  }
  const html = fs.readFileSync(file, "utf8");
  const raw = decodeEntities(htmlToText(html, false));
  const blocked = decodeEntities(htmlToText(html, true));
  return { file: row.file, isPdf: false, raw, blocked, html };
}

const reEscape = (ch) => /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
function tolerantPattern(quote) {
  let out = "";
  for (const ch of quote.toLowerCase().trim()) {
    if (/[a-z0-9]/u.test(ch)) out += ch;
    else if (ch === "'") out += "['\u2018\u2019\u02BC]";
    else if (ch === "\"") out += "[\"\u201C\u201D]";
    else if (ch === "-") out += "[\u2010\u2011\u2012\u2013\u2014-]";
    else if (/\s/u.test(ch)) out += "\\s+";
    else out += `\\s*${reEscape(ch)}\\s*`;
  }
  return new RegExp(out, "iu");
}

export { readLines, parse, normalizeKey, manifest, manifestFolded, cacheDir, pageTextOf, tolerantPattern, decodeEntities, htmlToText, resultsDir };
