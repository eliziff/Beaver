#!/usr/bin/env node
// Ground-truth scorecard + diagnostics. For every gated seed, determine from
// the cached publisher page (HTML or PDF) whether the evidence quote is
// actually present, then cross-tabulate against the gate verdict. This is the
// single source of truth for "can the fragment builder win here":
//
//   quote-present + painted        -> builder won
//   quote-present + no highlight   -> builder gap (ACTIONABLE: spelling miss)
//   quote-absent                   -> page drift (not a builder defect)
//
// The quote is searched with entity/whitespace/punctuation folding; when it
// is present the exact rendered spelling (raw window) is captured, so gap
// diagnostics show precisely how the page text differs from the emitted
// directive. Emits:
//   results/scorecard.jsonl  one row per seed (full diagnostics)
//   results/scorecard.json   aggregate + gap-signal tally
//
// Usage: node experiments/text-fragment-fidelity/scorecard.mjs [gate-results.jsonl]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
const cacheDir = path.join(resultsDir, "page-html");
const gatePath = process.argv[2] ?? path.join(resultsDir, "gate-full-final2.jsonl");
const PDTOTEXT = "C:/Program Files/Git/mingw64/bin/pdftotext.exe";
const PAINT_THRESHOLD = 350;

const readLines = (file) => {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
};
const parse = (line) => {
  try { return JSON.parse(line); } catch { return null; }
};

const seeds = new Map(readLines(seedsPath).map(parse).filter(Boolean).map((s) => [s.label, s]));

// Same key as gate-replay.mjs normalizeKey: the crawl fetch URL identity.
function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return rawUrl.split("#")[0];
  }
}
function isPdfUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (/laws\.yukon\.ca\/cms\/images\/LEGISLATION/iu.test(u.href)) return true;
    if (/justice\.gov\.nt\.ca\/en\/files\/legislation/iu.test(u.href)) return true;
    if (/princeedwardisland\.ca\/sites\/default\/files\/legislation/iu.test(u.href)) return true;
    if (/publications\.saskatchewan\.ca\/api\/v1\/products.*\/formats\//iu.test(u.href)) return true;
  } catch {}
  return false;
}

// Manifest: url -> {file, bytes}, keyed by exact and case-folded identity.
// Last row wins (matching gate-replay's pageCache), and tiny entries — the
// ~174-byte PDF-viewer shells some early crawls cached — are ignored so a real
// PDF/HTML row at the same key is what gets used.
const manifest = new Map();
const manifestFolded = new Map();
for (const row of readLines(manifestPath).map(parse).filter(Boolean)) {
  if (!row.file) continue;
  if (row.bytes != null && row.bytes < 5000) continue;
  const key = normalizeKey(row.url);
  manifest.set(key, row);
  manifestFolded.set(key.toLowerCase(), row);
}

// --- text extraction ------------------------------------------------------
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

// Fold everything a fragment matcher is allowed to fold: whitespace (including
// NBSP) to a single space, typographic quotes/dashes to ASCII, case to lower,
// and punctuation to spaces (a footnote marker "Rules.2" and the rendered
// "rules 2" are the same words; an em-dash run and a space are too). This is
// the honest ground truth for "are the quote's words on the page".
function fold(text) {
  return decodeEntities(text)
    .replace(/[\u00A0\u202F\u2007\u2009\u200B]/gu, " ")
    .replace(/[\u2018\u2019\u02BC]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "\"")
    .replace(/[\u2010\u2011\u2012\u2013\u2014]/gu, "-")
    .replace(/[\u2026]/gu, "...")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .toLowerCase()
    .trim();
}

// Strip HTML to text. `markBlocks` inserts a \n at block-level boundaries so a
// quote that crosses a publisher paragraph seam is detectable (folded text
// would otherwise collapse the seam into a single space).
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
  } catch {
    return "";
  }
}

function pageTextOf(seed, gateRow) {
  // Resolve ONLY the page the gate actually loaded (the target URL base).
  // A cache miss here means the replay served a blank page — the gate never
  // saw the publisher content — so falling back to the seed URL would invent
  // false "quote present" ground truth (e.g. ontario.ca e-laws, whose seed
  // URL is an API JSON endpoint but whose builder output is an HTML page).
  const targetBase = gateRow?.target ? gateRow.target.split("#")[0] : seed.url;
  if (!targetBase) return null;
  const key = normalizeKey(targetBase);
  const row = manifest.get(key) ?? manifestFolded.get(key.toLowerCase());
  if (!row) return { cacheMiss: true };
  const file = path.join(cacheDir, row.file);
  if (!fs.existsSync(file)) return { cacheMiss: true };
  const isPdf = row.file.toLowerCase().endsWith(".pdf") || isPdfUrl(targetBase);
  if (isPdf) {
    const raw = pdfToText(file);
    if (!raw.trim()) return { cacheMiss: true };
    return { file: row.file, isPdf: true, raw, folded: fold(raw), blocked: raw };
  }
  const html = fs.readFileSync(file, "utf8");
  const raw = decodeEntities(htmlToText(html, false));
  const blocked = decodeEntities(htmlToText(html, true)); // \n at block seams, not folded
  return { file: row.file, isPdf: false, raw, folded: fold(raw), blocked };
}

// --- quote presence + location -------------------------------------------
const reEscape = (ch) => /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;

// A regex that matches `quote` in raw/blocked text, folding what a fragment
// matcher may fold: spaces -> \s+ (covers NBSP and block seams), typographic
// quotes/dashes to their ASCII kin, and optional whitespace around punctuation
// (detached punctuation). Case-insensitive.
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

function locateQuote(page, quote) {
  const wanted = fold(quote);
  const words = wanted.split(" ").filter(Boolean);
  if (!words.length || !page.folded) return { present: false, reason: "no-quote" };
  // Presence: punctuation-folded substring. This is the honest ground truth —
  // "the quote's words are on the page" — and it tolerates footnote markers
  // ("Rules.2" vs "rules 2"), em-dash runs, and every other punctuation-only
  // divergence. A seed is only "page-drift" when even the folded words are
  // absent (the page is genuinely gone or an unrendered shell).
  const present = page.folded.includes(wanted);
  let found = null;
  try { found = tolerantPattern(quote).exec(page.raw); } catch {}
  const strictPresent = present;
  let matchedWords = 0;
  let matchedForm;
  if (!strictPresent) {
    for (let n = words.length - 1; n >= 1; n -= 1) {
      const probe = words.slice(0, n).join(" ");
      if (probe.length < 3) continue;
      if (page.folded.includes(probe)) { matchedWords = n; matchedForm = probe; break; }
    }
  } else {
    matchedWords = words.length;
  }
  let window;
  if (found) {
    const start = Math.max(0, found.index - 40);
    const end = Math.min(page.raw.length, found.index + found[0].length + 120);
    window = page.raw.slice(start, end).replace(/\s+/gu, " ");
  }
  return { present, strictPresent, matchedWords, matchedForm, window };
}

// --- fragment directive parsing ------------------------------------------
function parseDirectives(target) {
  if (!target) return [];
  try {
    const u = new URL(target);
    const frag = u.hash.startsWith("#") ? u.hash.slice(1) : u.hash;
    const marker = frag.indexOf(":~:");
    const part = marker >= 0 ? frag.slice(marker + 3) : frag.startsWith("text=") ? frag : "";
    if (!part) return [];
    return part.split("&").filter((d) => d.startsWith("text=")).map((d) => {
      try { return decodeURIComponent(d.slice(5)); } catch { return d.slice(5); }
    });
  } catch {
    return [];
  }
}

// --- gap signals ----------------------------------------------------------
function signals(seed, page, loc, gateRow) {
  if (!page || !loc || !loc.present) return [];
  const quote = seed.quotes?.[0] ?? "";
  const out = new Set();
  const rawWindow = (loc.window ?? "").replace(/\u00A0/gu, "\u00A0");
  if (/[\u00A0\u202F\u2007\u2009]/u.test(rawWindow)) out.add("nbsp-in-page");
  if (/[\u201C\u201D]/u.test(rawWindow) && /["]/u.test(quote)) out.add("curly-quote");
  if (/[\u2018\u2019]/u.test(rawWindow) && /'/u.test(quote)) out.add("typographic-apostrophe");
  // Cross-block seam: the quote run sits across a \n in block-marked text.
  if (page.blocked) {
    try {
      const m = tolerantPattern(quote).exec(page.blocked);
      if (m && m[0].includes("\n")) out.add("cross-block-seam");
    } catch {}
  }
  // Detached punctuation: present only with whitespace around punctuation that
  // the quote has joined (e.g. "Act , a limit" vs "Act, a limit").
  if (!loc.strictPresent && !out.has("cross-block-seam")) out.add("detached-punct");
  // Editorial bracket insertion: "[t]he" / "[63]" style artifacts.
  if (/[\[\]]/u.test(quote)) out.add("editorial-bracket");
  // Orphan-guarded pinpoint: "s. 17" / "para. 33" carries an NBSP.
  if (/\b(s|ss|para|paras|art|p|pp)\.\u00A0\d/iu.test(rawWindow)) out.add("nbsp-pinpoint");
  if (!out.size) out.add("other");
  return [...out];
}

// --- run ------------------------------------------------------------------
const gateRows = new Map();
for (const row of readLines(gatePath).map(parse).filter(Boolean)) {
  gateRows.set(row.label, row);
}

const out = [];
let cacheHits = 0;
for (const [label, seed] of seeds) {
  const gate = gateRows.get(label);
  const page = pageTextOf(seed, gate);
  if (page) cacheHits += 1;
  const quote = seed.quotes?.[0] ?? "";
  const loc = page ? locateQuote(page, quote) : null;
  const painted = (gate?.highlightPixels ?? 0) >= PAINT_THRESHOLD;
  const isPdf = page?.isPdf ?? isPdfUrl(seed.url);
  let truth;
  if (page?.cacheMiss) truth = "cache-miss";
  else if (!page) truth = "no-cache";
  else if (!loc || !loc.present) truth = "page-drift";
  else if (painted) truth = "quote-present-painted";
  else truth = "quote-present-unpainted";

  const row = {
    label,
    dataset: seed.dataset,
    shape: seed.shape,
    providerClass: seed.providerClass,
    host: (() => { try { return new URL(gate?.target ?? seed.url).hostname.replace(/^www\./, ""); } catch { return "?"; } })(),
    isPdf,
    truth,
    quotePresent: Boolean(loc?.present),
    strictPresent: Boolean(loc?.strictPresent),
    matchedWords: loc?.matchedWords ?? 0,
    matchedForm: loc?.matchedForm,
    gateVerdict: gate?.verdict ?? "no-gate",
    placement: gate?.placement,
    painted,
    highlightPixels: gate?.highlightPixels ?? 0,
    highlightTopInViewport: gate?.highlightTopInViewport,
    scrollY: gate?.scrollY,
    error: gate?.error,
    directives: parseDirectives(gate?.target),
    signals: signals(seed, page, loc, gate),
    window: loc?.window,
  };
  out.push(row);
}

fs.writeFileSync(path.join(resultsDir, "scorecard.jsonl"), out.map((r) => JSON.stringify(r)).join("\n") + "\n");

const tally = (key) => {
  const map = new Map();
  for (const row of out) {
    const v = typeof key === "function" ? key(row) : row[key] ?? "?";
    map.set(v, (map.get(v) ?? 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
};
const truthTally = tally("truth");
const gateTally = tally("gateVerdict");
const gap = out.filter((r) => r.truth === "quote-present-unpainted");
const signalTally = {};
for (const r of gap) {
  for (const s of r.signals) signalTally[s] = (signalTally[s] ?? 0) + 1;
}
const gapByHost = tally((r) => r.truth === "quote-present-unpainted" ? r.host : null);

const summary = {
  gateFile: path.basename(gatePath),
  totalSeeds: out.length,
  cacheHits,
  truth: truthTally,
  gate: gateTally,
  builderGapSeeds: gap.length,
  gapSignals: signalTally,
};
fs.writeFileSync(path.join(resultsDir, "scorecard.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(JSON.stringify(summary, null, 1));
