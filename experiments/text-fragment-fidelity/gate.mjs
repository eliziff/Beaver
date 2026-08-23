#!/usr/bin/env node
// Black-box text-fragment gate over the harvested corpus. See PLAN.md.
//
// Usage (repo root):
//   npx tsx experiments/text-fragment-fidelity/gate.mjs \
//     [--seeds experiments/text-fragment-fidelity/results/seeds.jsonl] \
//     [--results experiments/text-fragment-fidelity/results/gate-results.jsonl] \
//     [--shots experiments/text-fragment-fidelity/results/shots]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const root = path.resolve(here, "..", "..");
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}
const seedsPath = arg("--seeds", path.join(resultsDirDefault(), "seeds.jsonl"));
const resultsPath = arg("--results", path.join(resultsDirDefault(), "gate-results.jsonl"));
const outDir = arg("--shots", path.join(resultsDirDefault(), "shots"));

function resultsDirDefault() {
  return path.join(here, "results");
}
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

const { buildLegalSourcePinpointUrl } = await import(
  pathToFileURL(path.join(here, "builder-candidate.ts")).href
);

// Full compiled document text per citation: builds are faithful to
// production (full-document uniqueness checks for ranges).
const doctextPath = path.join(here, "results", "doctext.jsonl");
const doctext = new Map();
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
let completed = doneLabels.size;
function emit(record) {
  const line = JSON.stringify(record);
  console.log(line);
  resultsStream.write(`${line}\n`);
}

// ::target-text paints a distinctive lavender measured at ~(231,209,252):
// red sits ABOVE green by ~20 and blue above green by ~40. Self-contained:
// the body is serialized into the analyzer page.
function isHighlightPixel(r, g, b) {
  return (
    r >= 205 && g >= 175 &&
    r - g >= 12 && b - g >= 18 &&
    b >= 228 && r <= 255 && b <= 255 &&
    b >= r
  );
}

async function analyzeHighlight(analyzer, buffer) {
  const b64 = buffer.toString("base64");
  return analyzer.evaluate(async ({ b64, isHighlightSource }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isHighlight = new Function(`return ${isHighlightSource}`)();
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
  }, { b64, isHighlightSource: isHighlightPixel.toString() });
}

async function measure(page, target, analyzer) {
  // Fragments navigate without needing subresources: domcontentloaded plus a
  // short settle is enough for scroll + ::target-text paint. PDFs process the
  // fragment only in the active tab, so bring the page to front first.
  await page.bringToFront();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_000);
  const state = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    viewport: (() => {
      const isFixed = (element) => {
        for (
          let current = element;
          current;
          current = current.parentElement
        ) {
          const position = getComputedStyle(current).position;
          if (position === "fixed" || position === "sticky") return true;
        }
        return false;
      };
      const pieces = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && pieces.join(" ").length < 300) {
        const text = node.textContent?.trim();
        const rect = node.parentElement?.getBoundingClientRect();
        if (
          text &&
          rect &&
          rect.top >= -20 &&
          rect.top < window.innerHeight &&
          !isFixed(node.parentElement)
        ) {
          pieces.push(text);
        }
      }
      return pieces.join(" ").replace(/\s+/gu, " ").slice(0, 300);
    })(),
    firstBodyAnchorY: (() => {
      const anchor =
        document.querySelector('a[name="par1"]') ??
        document.querySelector("#par1") ??
        document.querySelector('[id="par1"]');
      if (!anchor) return null;
      const rect = anchor.getBoundingClientRect();
      return Math.round(rect.top + window.scrollY);
    })(),
  }));
  const challenged = /verification required|forbidden/iu.test(state.viewport);
  const innerHeight = await page.evaluate(() => window.innerHeight);
  const pastBodyAnchor =
    state.firstBodyAnchorY === null ||
    state.scrollY === 0 ||
    state.scrollY >= state.firstBodyAnchorY - innerHeight;
  // Black-box observation only: did ::target-text paint, and where did it
  // start? Placement correctness for non-clean cases is judged by reading
  // the saved screenshot - never by querying publisher structure.
  const shot = await page.screenshot();
  const highlight = await analyzeHighlight(analyzer, shot);
  return {
    challenged,
    scrollY: state.scrollY,
    highlightPixels: highlight.pixels,
    highlightTopInViewport: highlight.firstRow >= 0 ? highlight.firstRow : null,
    pastBodyAnchor,
  };
}

// Placement ground truth: the seeded quote's opening words, located in
// block-level elements on the live page. The verifier may query the
// publisher - the builder under test cannot.
function quoteNeedle(quote) {
  const words = (quote ?? "").split(/\s+/u);
  let start = 0;
  if (/^\[\d+\]$/u.test(words[0] ?? "") || /^\d+$/u.test(words[0] ?? "")) start = 1;
  return words.slice(start, start + 4).join(" ").toLowerCase();
}

async function placementCheck(page, seed, bandTopInViewport) {
  const needle = quoteNeedle(seed.quotes?.[0]);
  if (!needle || bandTopInViewport === null) return "unverified";
  const boxes = await page.evaluate((wanted) => {
    const out = [];
    for (const el of document.querySelectorAll("p, li, blockquote, td, h1, h2, h3")) {
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > 1500) continue;
      if (rect.bottom < -50) continue;
      const text = (el.innerText ?? "").replace(/\s+/gu, " ").toLowerCase();
      if (!text.includes(wanted)) continue;
      out.push({ top: rect.top, bottom: rect.bottom });
      if (out.length >= 30) break;
    }
    return out;
  }, needle).catch(() => []);
  const correct = boxes.some(
    (box) => box.top - 60 <= bandTopInViewport && bandTopInViewport <= box.bottom + 200,
  );
  return correct ? "correct" : boxes.length ? "misplaced" : "unverified";
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const analyzer = await context.newPage();
  await analyzer.goto("about:blank");
  const pending = seeds.filter((seed) => !doneLabels.has(seed.label));
  console.log(JSON.stringify({ total: seeds.length, skipped: doneLabels.size, pending: pending.length }));
  for (const seed of pending) {
    let target = null;
    try {
      const key = seedDocumentKey(seed);
      const documentText = doctext.get(key);
      target = buildLegalSourcePinpointUrl(
        {
          url: seed.url,
          ...(seed.anchor ? { anchor: seed.anchor } : {}),
          blockText: seed.blockText ?? "",
          ...(documentText ? { documentText } : {}),
        },
        seed.quotes ?? [],
      );
    } catch (error) {
      emit({ label: seed.label, dataset: seed.dataset, shape: seed.shape, verdict: "build-error", error: String(error?.message ?? error).slice(0, 120) });
      continue;
    }
    if (!target) {
      emit({ label: seed.label, dataset: seed.dataset, shape: seed.shape, verdict: "no-link" });
      continue;
    }
    let record;
    try {
      const measurement = await measure(page, target, analyzer);
      const painted = measurement.highlightPixels >= 350;
      const placement = painted
        ? await placementCheck(page, seed, measurement.highlightTopInViewport)
        : null;
      const verdict = measurement.challenged
        ? "provider-blocked"
        : painted
          ? placement === "correct"
            ? "matched-correct"
            : placement === "misplaced"
              ? "matched-misplaced"
              : "matched-unverified"
          : "no-highlight";
      record = {
        label: seed.label,
        providerClass: seed.providerClass,
        dataset: seed.dataset,
        shape: seed.shape,
        verdict,
        placement,
        highlightPixels: measurement.highlightPixels,
        highlightTopInViewport: measurement.highlightTopInViewport,
        pastBodyAnchor: measurement.pastBodyAnchor,
        scrollY: measurement.scrollY,
        target,
      };
      await page.screenshot({ path: path.resolve(outDir, `${seed.label.replace(/[^\w.-]+/gu, "_")}.png`) });
    } catch (error) {
      record = {
        label: seed.label,
        dataset: seed.dataset,
        shape: seed.shape,
        verdict: "error",
        error: String(error?.message ?? error).slice(0, 160),
        target,
      };
    }
    emit(record);
    completed += 1;
    // Politeness: sequential loads with a pause between publisher fetches.
    await page.waitForTimeout(900);
  }
} finally {
  await browser.close();
  resultsStream?.end();
}
