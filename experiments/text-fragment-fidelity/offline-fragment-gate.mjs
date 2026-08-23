#!/usr/bin/env node
// Fast candidate loop: screen directives against immutable cached renditions
// without launching Chrome. Calibrate against webdriver-exact-*.jsonl; use
// ChromeDriver only for changed/failing seeds and final acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import v8 from "node:v8";
import { tokenizeHtml } from "./html-tokenizer.mjs";
import { normalizeKey } from "./gap-lib.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const cacheDir = path.join(results, "page-html");
const browserTextDir = path.join(results, "browser-rendered-text");
const pdftotext = "C:/Program Files/Git/mingw64/bin/pdftotext.exe";
const indexPath = path.join(results, "rendered-search-index.bin");
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
const targetsPath = process.argv[2] ?? path.join(results, "targets.jsonl");
const output = process.argv[3] ?? path.join(results, "offline-fragment-screen.jsonl");
const read = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
const manifest = new Map();
for (const row of read(path.join(results, "page-html-manifest.jsonl"))) {
  if (row.url && row.file && !row.challenged) manifest.set(normalizeKey(row.url).toLowerCase(), row);
}

const whitespaceFold = (text) => text.toLocaleLowerCase().replace(/[\s\u00a0\u202f\u2007\u2009\u200b]+/gu, " ").trim();
const wordFold = (text) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const occurrences = (text, wanted) => {
  const out = [];
  let at = 0;
  while (wanted && (at = text.indexOf(wanted, at)) >= 0) {
    out.push([at, at + wanted.length]);
    at += Math.max(1, wanted.length);
  }
  return out;
};
const directives = (target) => {
  const fragment = target.split("#")[1] ?? "";
  const payload = fragment.includes(":~:") ? fragment.split(":~:")[1] : fragment;
  return payload.split("&").filter((piece) => piece.startsWith("text=")).map((piece) => piece.slice(5));
};
const decodePieces = (raw) => {
  let pieces = raw.split(",");
  if (pieces[0]?.endsWith("-")) pieces = pieces.slice(1);
  if (pieces.at(-1)?.startsWith("-")) pieces = pieces.slice(0, -1);
  return pieces.filter(Boolean).map((piece) => whitespaceFold(decodeURIComponent(piece)));
};
const hasStableEndpoints = (raw) => {
  try {
    let pieces = raw.split(",");
    if (pieces[0]?.endsWith("-")) pieces = pieces.slice(1);
    if (pieces.at(-1)?.startsWith("-")) pieces = pieces.slice(0, -1);
    const start = decodeURIComponent(pieces[0] ?? "").trim();
    const end = decodeURIComponent(pieces.at(-1) ?? "").trim();
    return /^[\p{L}\p{N}]/u.test(start) && /[\p{L}\p{N}]$/u.test(end);
  } catch { return false; }
};

function htmlBlocks(html) {
  const blocks = [];
  let current = "";
  for (const segment of tokenizeHtml(html)) {
    if (segment.boundaryBefore && current.trim()) {
      blocks.push(whitespaceFold(current));
      current = "";
    }
    current += segment.text;
  }
  if (current.trim()) blocks.push(whitespaceFold(current));
  return blocks.filter(Boolean);
}

function directiveMatches(blocks, raw) {
  const pieces = decodePieces(raw);
  if (!pieces.length) return [];
  const starts = blocks.flatMap((block, blockIndex) => occurrences(block, pieces[0]).map(([start, end]) => ({ blockIndex, start, end })));
  if (pieces.length === 1) return starts.map((hit) => ({ start: hit, end: hit }));
  const ends = blocks.flatMap((block, blockIndex) => occurrences(block, pieces.at(-1)).map(([start, end]) => ({ blockIndex, start, end })));
  const matches = [];
  for (const start of starts) {
    const after = ends.filter((end) => end.blockIndex > start.blockIndex || end.blockIndex === start.blockIndex && end.start >= start.end)
      .sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start);
    if (after[0]) matches.push({ start, end: after[0] });
  }
  return matches;
}

function firstWordSpan(text, raw) {
  const pieces = decodePieces(raw).map(wordFold).filter(Boolean);
  if (!pieces.length) return null;
  const start = text.indexOf(pieces[0]);
  if (start < 0) return null;
  if (pieces.length === 1) return [start, start + pieces[0].length];
  const endStart = text.indexOf(pieces.at(-1), start + pieces[0].length);
  return endStart < 0 ? null : [start, endStart + pieces.at(-1).length];
}

function literalSpan(lines, raw) {
  let pieces = raw.split(",");
  if (pieces[0]?.endsWith("-")) pieces = pieces.slice(1);
  if (pieces.at(-1)?.startsWith("-")) pieces = pieces.slice(0, -1);
  try { pieces = pieces.filter(Boolean).map((piece) => decodeURIComponent(piece).toLocaleLowerCase()); }
  catch { return null; }
  if (!pieces.length) return null;
  let startLine = -1;
  let start = -1;
  for (let line = 0; line < lines.length; line += 1) {
    start = lines[line].indexOf(pieces[0]);
    if (start >= 0) { startLine = line; break; }
  }
  if (startLine < 0) return null;
  if (pieces.length === 1) return [startLine, start, startLine, start + pieces[0].length];
  for (let line = startLine; line < lines.length; line += 1) {
    const from = line === startLine ? start + pieces[0].length : 0;
    const end = lines[line].indexOf(pieces.at(-1), from);
    if (end >= 0) return [startLine, start, line, end + pieces.at(-1).length];
  }
  return null;
}

function intendedSpan(text, quote, block) {
  const wanted = wordFold(quote);
  if (!wanted) return null;
  const hits = occurrences(text, wanted);
  if (hits.length === 1) return hits[0];
  const context = wordFold(block);
  if (!context) return null;
  const blocks = occurrences(text, context);
  const contained = hits.filter(([start, end]) => blocks.some(([b0, b1]) => b0 <= start && end <= b1));
  return contained.length === 1 ? contained[0] : null;
}

let pageCache = new Map();
try { pageCache = new Map(v8.deserialize(fs.readFileSync(indexPath))); } catch {}
let indexChanged = false;
function page(row) {
  const file = path.join(cacheDir, row.file);
  const sourceStat = fs.statSync(file);
  const size = sourceStat.size;
  const browserTextFile = path.join(browserTextDir, `${path.parse(row.file).name}.txt`);
  const browserTextStat = fs.existsSync(browserTextFile) ? fs.statSync(browserTextFile) : null;
  const browserTextSize = browserTextStat?.size ?? 0;
  const cached = pageCache.get(row.file);
  if (cached?.size === size && cached?.sourceMtimeMs === sourceStat.mtimeMs &&
      cached?.browserTextSize === browserTextSize && cached?.browserTextMtimeMs === (browserTextStat?.mtimeMs ?? 0) &&
      cached?.literalLines) return cached;
  let rawText;
  if (row.file.toLowerCase().endsWith(".pdf")) {
    const pdfTextFile = path.join(results, "pdf-text", `${path.parse(row.file).name}.txt`);
    fs.mkdirSync(path.dirname(pdfTextFile), { recursive: true });
    rawText = fs.existsSync(pdfTextFile)
      ? fs.readFileSync(pdfTextFile, "utf8")
      : execFileSync(pdftotext, ["-enc", "UTF-8", file, "-"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    if (!fs.existsSync(pdfTextFile)) fs.writeFileSync(pdfTextFile, rawText);
  } else if (browserTextSize) {
    rawText = fs.readFileSync(browserTextFile, "utf8");
  } else {
    rawText = fs.readFileSync(file, "utf8");
  }
  const value = {
    size, sourceMtimeMs: sourceStat.mtimeMs, browserTextSize,
    browserTextMtimeMs: browserTextStat?.mtimeMs ?? 0,
    browserText: row.file.toLowerCase().endsWith(".pdf") || browserTextSize > 0,
    literalLines: rawText.split(/\r?\n|\f/gu).map((line) => line.toLocaleLowerCase()), words: wordFold(rawText),
  };
  pageCache.set(row.file, value);
  indexChanged = true;
  return value;
}

const started = performance.now();
let pageMs = 0;
let scoreMs = 0;
const out = [];
const usedPages = new Set();
const seeds = read(targetsPath);
for (const [seedIndex, seed] of seeds.entries()) {
  const base = seed.target.split("#")[0];
  const row = manifest.get(normalizeKey(base).toLowerCase());
  if (!row) {
    out.push({ label: seed.label, verdict: "cache-miss" });
    continue;
  }
  let phase = performance.now();
  const rendered = page(row);
  usedPages.add(row.file);
  pageMs += performance.now() - phase;
  if (!rendered.browserText) {
    out.push({ label: seed.label, verdict: "browser-text-miss", cacheFile: row.file });
    continue;
  }
  phase = performance.now();
  const intended = (seed.quotes ?? []).map((quote) => intendedSpan(rendered.words, quote, seed.blockText ?? ""));
  if (!intended.length || intended.some((span) => !span)) {
    out.push({ label: seed.label, verdict: "quote-not-rendered", cacheFile: row.file });
    continue;
  }
  const rawDirectives = directives(seed.target);
  const proofs = rawDirectives.map((raw) => ({
    directive: decodeURIComponent(raw),
    span: literalSpan(rendered.literalLines, raw) ? firstWordSpan(rendered.words, raw) : null,
  })).filter((proof) => proof.span);
  const stray = proofs.filter(({ span: [start, end] }) => !intended.some(([q0, q1]) => q0 <= start && end <= q1));
  let verdict = "offline-compatible";
  if (!proofs.length) verdict = "no-compatible-directive";
  else if (stray.length) verdict = "unsafe-directive";
  else if (intended.some(([q0, q1]) => !proofs.some(({ span }) => span[0] === q0) || !proofs.some(({ span }) => span[1] === q1))) verdict = "partial-directive";
  else if (rawDirectives.some((raw) => !hasStableEndpoints(raw))) verdict = "needs-browser";
  out.push({ label: seed.label, verdict, cacheFile: row.file, intended, proofs, unsafe: stray });
  scoreMs += performance.now() - phase;
  if ((seedIndex + 1) % 250 === 0) console.error(JSON.stringify({ progress: seedIndex + 1, of: seeds.length }));
}
for (let index = 0; index < out.length; index += 1) out[index].target = seeds[index].target;
fs.writeFileSync(output, `${out.map((row) => JSON.stringify(row)).join("\n")}\n`);
if (indexChanged) fs.writeFileSync(indexPath, v8.serialize([...pageCache]));
const tally = Object.fromEntries([...out.reduce((map, row) => map.set(row.verdict, (map.get(row.verdict) ?? 0) + 1), new Map())]);
console.log(JSON.stringify({
  seeds: out.length, pages: usedPages.size, seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
  pageMs: Math.round(pageMs), scoreMs: Math.round(scoreMs), verdicts: tally,
}));
