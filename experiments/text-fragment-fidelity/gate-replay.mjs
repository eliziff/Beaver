#!/usr/bin/env node
// Replay gate: same verdicts as gate.mjs, but pages come from the local
// crawl cache via route interception. No publisher traffic, no politeness
// pause: a full-corpus run takes minutes. Fidelity is certified by diffing
// replay verdicts against collected live results (calibrate.mjs).
//
// Usage (repo root):
//   npx tsx experiments/text-fragment-fidelity/gate-replay.mjs \
//     [--seeds ...] [--results ...] [--shots ...] [--workers 6]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}
const resultsDir = path.join(here, "results");
const seedsPath = arg("--seeds", path.join(resultsDir, "seeds.jsonl"));
const resultsPath = arg("--results", path.join(resultsDir, "gate-replay.jsonl"));
const outDir = arg("--shots", path.join(resultsDir, "shots-replay"));
const WORKERS = Number(arg("--workers", "6"));
const CLIP_HEIGHT = 600;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

function isPdfUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (/decisions\.ct-tc\.gc\.ca/iu.test(u.hostname) && /\/document\.do$/iu.test(u.pathname)) return true;
    if (/laws\.yukon\.ca\/cms\/images\/LEGISLATION/iu.test(u.href)) return true;
    if (/justice\.gov\.nt\.ca\/en\/files\/legislation/iu.test(u.href)) return true;
    if (/princeedwardisland\.ca\/sites\/default\/files\/legislation/iu.test(u.href)) return true;
    if (/publications\.saskatchewan\.ca\/api\/v1\/products.*\/formats\//iu.test(u.href)) return true;
  } catch {
    const lower = rawUrl.toLowerCase().split("?")[0].split("#")[0];
    if (lower.endsWith(".pdf")) return true;
    if (lower.includes("decisions.ct-tc.gc.ca") && lower.includes("/document.do")) return true;
    if (lower.includes("laws.yukon.ca/cms/images/legislation")) return true;
    if (lower.includes("justice.gov.nt.ca/en/files/legislation")) return true;
  }
  return false;
}

function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return rawUrl.split("#")[0];
  }
}
const pageCache = new Map();
const contentTypeCache = new Map();
const challengedPages = new Set();
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
if (fs.existsSync(manifestPath)) {
  for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.file) {
        const key = normalizeKey(row.url);
        const filePath = path.join(resultsDir, "page-html", row.file);
        if (!fs.existsSync(filePath)) continue;
        const body = fs.readFileSync(filePath);
        pageCache.set(key, body);
        let ct = row.contentType;
        if (!ct) {
          if (row.file.toLowerCase().endsWith(".pdf") || isPdfUrl(row.url)) ct = "application/pdf";
          else ct = "text/html";
        }
        contentTypeCache.set(key, ct);
      }
      if (row.challenged) challengedPages.add(normalizeKey(row.url));
    } catch {}
  }
}
console.error(JSON.stringify({ cachedPages: pageCache.size, challengedPages: challengedPages.size }));

const { buildLegalSourcePinpointUrl } = await import(
  arg("--builder", "production") === "production"
    ? pathToFileURL(path.join(here, "..", "..", "backend/src/lib/legalSourceLinks.ts")).href
    : pathToFileURL(path.join(here, "builder-candidate.ts")).href
);
const doctext = new Map();
const doctextPath = path.join(resultsDir, "doctext.jsonl");
if (fs.existsSync(doctextPath)) {
  for (const line of fs.readFileSync(doctextPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.key && row.text) doctext.set(row.key, row.text);
    } catch {}
  }
}

const seeds = [];
for (const line of fs.readFileSync(seedsPath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue;
  seeds.push(JSON.parse(line));
}
let doneLabels = new Set();
let resultsStream = null;
if (fs.existsSync(resultsPath)) {
  doneLabels = new Set(
    fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line).label; } catch { return null; } })
      .filter(Boolean),
  );
}
resultsStream = fs.createWriteStream(resultsPath, { flags: "a" });
function emit(record) {
  const line = JSON.stringify(record);
  console.log(line);
  resultsStream.write(`${line}\n`);
}

// ::target-text paints a distinctive lavender measured at ~(231,209,252),
// red above green by ~20 and blue above green by ~40. Chrome's PDF viewer
// paints the same lavender for text fragments — NOT yellow — so one detector
// covers HTML and PDF alike. Require blue >= red: publisher chrome (e.g.
// Decisia's pink paragraph markers ~(255,219,242)) is red-dominant and would
// otherwise read as a false "highlight".
function isHighlightPixel(r, g, b) {
  return (
    r >= 205 && g >= 175 &&
    r - g >= 12 && b - g >= 18 &&
    b >= 228 && r <= 255 && b <= 255 &&
    b >= r
  );
}
function quoteNeedle(quote) {
  const words = (quote ?? "").split(/\s+/u);
  let start = 0;
  if (/^\[\d+\]$/u.test(words[0] ?? "") || /^\d+$/u.test(words[0] ?? "")) start = 1;
  return words.slice(start, start + 4).join(" ").toLowerCase();
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  await context.route("**", async (route) => {
    const request = route.request();
    const url = request.url();
    // PDF viewer is a Chrome extension (chrome-extension:// + chrome://); aborting
    // its scripts/styles breaks PDF rendering (white screenshots, 0 highlight).
    if (url.startsWith("chrome-extension://") || url.startsWith("chrome://")) {
      await route.continue();
      return;
    }
    if (request.resourceType() === "document") {
      const key = normalizeKey(url);
      const body = pageCache.get(key);
      if (body) {
        const ct = contentTypeCache.get(key) ?? (isPdfUrl(url) ? "application/pdf" : "text/html");
        await route.fulfill({ contentType: ct, body });
        return;
      }
    }
    await route.abort();
  });

  const workers = [];
  for (let i = 0; i < WORKERS; i += 1) {
    const page = await context.newPage();
    const analyzer = await context.newPage();
    await analyzer.goto("about:blank");
    workers.push({ page, analyzer, busy: false });
  }

  async function analyzeHighlight(analyzer, buffer) {
    const b64 = buffer.toString("base64");
    return analyzer.evaluate(async ({ b64, source }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const isHighlight = new Function(`return ${source}`)();
      let pixels = 0;
      let firstRow = -1;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const at = (y * canvas.width + x) * 4;
          if (isHighlight(data[at], data[at + 1], data[at + 2])) {
            pixels += 1;
            if (firstRow < 0) firstRow = y;
          }
        }
      }
      return { pixels, firstRow };
    }, { b64, source: isHighlightPixel.toString() });
  }

  async function placementCheck(page, seed, bandTopInViewport) {
    const quote = seed.quotes?.[0];
    if (!quote || bandTopInViewport === null) return "misplaced";
    // Find the block(s) containing the quote's opening words. Matching is
    // punctuation/NBSP-normalized and falls back to shorter prefixes (4 -> 1
    // words) so hard bits ("s. 17", "1(1)(a)(ii)", "[t]he") can't turn a real
    // hit into an unknown. The return is always definitive: "correct" if the
    // painted highlight band overlaps a matching block, "misplaced" otherwise.
    const boxes = await page.evaluate((wanted) => {
      const normalize = (s) => (s ?? "")
        .toLowerCase()
        .replace(/\u00a0/gu, " ")
        .replace(/[\u2010-\u2015]/gu, "-")
        .replace(/[\u2018\u2019]/gu, "'")
        .replace(/[\u201c\u201d]/gu, "\"")
        .replace(/[^\p{L}\p{N}\s-]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      const words = normalize(wanted).split(" ").filter(Boolean);
      // Drop leading structural labels (paragraph numbers "[29]", list markers
      // "(a)"/"(ii)") the same way the builder's edge-trimming does: the
      // fragment target never contains them, so a needle that starts with one
      // can't match the prose block the highlight actually landed on.
      let start = 0;
      while (start < words.length) {
        const w = words[start];
        if (/^\d+$/.test(w) || /^[ivxlcdm]+$/.test(w) || /^[a-z]$/.test(w)) start += 1;
        else break;
      }
      const prose = words.slice(start);
      const needles = [];
      for (let n = Math.min(4, prose.length); n >= 1; n -= 1) {
        const s = prose.slice(0, n).join(" ");
        if (s.length >= 2) needles.push(s);
      }
      // Longest needle first. A "block" is the smallest ancestor of a matching
      // text node whose innerText contains the needle — this works for P, LI,
      // TD, and DIV/SECTION/custom block markup alike (Decisia/Word HTML,
      // legisquebec), instead of a fixed tag whitelist.
      for (const needle of needles) {
        const blocks = [];
        const seen = new Set();
        const firstWord = needle.split(" ")[0];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode()) && blocks.length < 40) {
          const text = (node.textContent ?? "").toLowerCase();
          if (!text.includes(firstWord)) continue;
          let el = node.parentElement;
          let matchEl = null;
          while (el && el !== document.body && el !== document.documentElement) {
            if (normalize(el.innerText ?? "").includes(needle)) { matchEl = el; break; }
            el = el.parentElement;
          }
          if (!matchEl || seen.has(matchEl)) continue;
          seen.add(matchEl);
          const rect = matchEl.getBoundingClientRect();
          if (rect.height <= 0 || rect.height > 4000) continue;
          blocks.push({ top: rect.top, bottom: rect.bottom });
        }
        if (blocks.length) return blocks;
      }
      return [];
    }, quote).catch(() => []);
    const correct = boxes.some(
      (box) => box.top - 60 <= bandTopInViewport && bandTopInViewport <= box.bottom + 200,
    );
    return correct ? "correct" : "misplaced";
  }

  // PDFs process their text fragment only while the tab is the active one.
  // With 6 workers racing for the front tab, most PDFs never get a fair turn,
  // so PDF navigation is serialized through this lock (HTML ::target-text
  // highlights fine in a background tab and stays parallel).
  let pdfLock = Promise.resolve();
  async function navigate(page, target, isPdf) {
    if (!isPdf) {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(1000);
      return;
    }
    const run = async () => {
      await page.bringToFront();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // PDF viewer loads async and paints highlight slower than HTML ::target-text.
      await page.waitForTimeout(2000);
    };
    const next = pdfLock.then(run, run);
    pdfLock = next.catch(() => {});
    await next;
  }

  async function runSeed(worker, seed) {
    const { page, analyzer } = worker;
    let target = null;
    try {
      target = buildLegalSourcePinpointUrl(
        {
          url: seed.url,
          ...(seed.anchor ? { anchor: seed.anchor } : {}),
          blockText: seed.blockText ?? "",
          ...(doctext.get(seedDocumentKey(seed))
            ? { documentText: doctext.get(seedDocumentKey(seed)) }
            : {}),
        },
        seed.quotes ?? [],
      );
    } catch (error) {
      return { label: seed.label, dataset: seed.dataset, shape: seed.shape, verdict: "build-error", error: String(error?.message ?? error).slice(0, 120) };
    }
    if (!target) {
      return { label: seed.label, dataset: seed.dataset, shape: seed.shape, verdict: "no-link" };
    }
    try {
      const isPdf = isPdfUrl(target);
      await navigate(page, target, isPdf);
      const state = await page.evaluate(() => ({
        scrollY: Math.round(window.scrollY),
        viewport: (() => {
          const pieces = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode()) && pieces.join(" ").length < 300) {
            const text = node.textContent?.trim();
            const rect = node.parentElement?.getBoundingClientRect();
            if (text && rect && rect.top >= -20 && rect.top < window.innerHeight) pieces.push(text);
          }
          return pieces.join(" ").replace(/\s+/gu, " ").slice(0, 300);
        })(),
      }));
      const challenged = /verification required|forbidden/iu.test(state.viewport);
      // PDFs need larger clip (full viewport) — viewer layout differs and highlight
      // may appear lower; 600px can miss it. Use 900px (viewport height) for PDFs.
      const shot = await page.screenshot(
        isPdf
          ? { clip: { x: 0, y: 0, width: 480, height: 900 } }
          : { clip: { x: 0, y: 0, width: 480, height: CLIP_HEIGHT } },
      );
      const highlight = await analyzeHighlight(analyzer, shot);
      const painted = highlight.pixels >= 350;
      // PDF viewer DOM is shadow/canvas — a text-node walk can't locate the
      // needle, but PDFium only paints lavender when it found the encoded
      // fragment text, so a painted PDF is its own placement verification.
      const placement = painted
        ? isPdf
          ? "correct"
          : await placementCheck(page, seed, highlight.firstRow >= 0 ? highlight.firstRow : null)
        : null;
      const verdict = challenged
        ? "provider-blocked"
        : painted
          ? placement === "correct" ? "matched-correct"
          : placement === "misplaced" ? "matched-misplaced"
          : "matched-unverified"
          : "no-highlight";
      return {
        label: seed.label,
        providerClass: seed.providerClass,
        dataset: seed.dataset,
        shape: seed.shape,
        verdict,
        placement,
        highlightPixels: highlight.pixels,
        highlightTopInViewport: highlight.firstRow >= 0 ? highlight.firstRow : null,
        scrollY: state.scrollY,
        target,
      };
    } catch (error) {
      return {
        label: seed.label,
        dataset: seed.dataset,
        shape: seed.shape,
        verdict: "error",
        error: String(error?.message ?? error).slice(0, 160),
        target,
      };
    }
  }

  const pending = seeds.filter((seed) => !doneLabels.has(seed.label));
  console.log(JSON.stringify({ total: seeds.length, skipped: doneLabels.size, pending: pending.length, workers: WORKERS }));
  const queue = [...pending];
  let started = 0;
  let completed = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (queue.length) {
    const idle = workers.find((worker) => !worker.busy);
    if (!idle) { await sleep(20); continue; }
    const seed = queue.shift();
    idle.busy = true;
    started += 1;
    runSeed(idle, seed).then((record) => {
      emit(record);
      idle.busy = false;
      completed += 1;
    }).catch((error) => {
      emit({ label: seed.label, dataset: seed.dataset, shape: seed.shape, verdict: "error", error: String(error).slice(0, 120) });
      idle.busy = false;
      completed += 1;
    });
  }
  while (completed < started) await sleep(100);
} finally {
  await browser.close();
  resultsStream?.end();
}
