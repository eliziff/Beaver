#!/usr/bin/env node
// Host-parallel text-fragment gate. Same verdicts and resume format as
// gate.mjs, but seeds flow to a pool of worker pages round-robin across
// publisher hosts. Politeness is preserved per host: starts for the same
// host are spaced at least HOST_MIN_INTERVAL_MS apart.
//
// Usage (repo root):
//   npx tsx experiments/text-fragment-fidelity/gate-parallel.mjs \
//     [--seeds ...] [--results ...] [--shots ...] [--workers 5]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}
const resultsDir = path.join(here, "results");
const seedsPath = arg("--seeds", path.join(resultsDir, "seeds.jsonl"));
const resultsPath = arg("--results", path.join(resultsDir, "gate-v3.jsonl"));
const outDir = arg("--shots", path.join(resultsDir, "shots-v3"));
const WORKERS = Number(arg("--workers", "5"));
const HOST_MIN_INTERVAL_MS = 1500;
const CLIP_HEIGHT = 600;
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

const { buildLegalSourcePinpointUrl } = await import(
  pathToFileURL(path.join(here, "builder-candidate.ts")).href
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

function isHighlightPixel(r, g, b) {
  return r >= 205 && g >= 175 && r - g >= 12 && b - g >= 18 && b >= 228 && r <= 255 && b <= 255 && b >= r;
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
      await page.bringToFront();
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(1_000);
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
      const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: CLIP_HEIGHT } });
      const highlight = await analyzeHighlight(analyzer, shot);
      const painted = highlight.pixels >= 350;
      const placement = painted ? await placementCheck(page, seed, highlight.firstRow >= 0 ? highlight.firstRow : null) : null;
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
  const hostLastStart = new Map();
  const queue = [...pending];
  let started = 0;
  let completed = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (queue.length) {
    const idle = workers.find((worker) => !worker.busy);
    if (!idle) {
      await sleep(50);
      continue;
    }
    // Pick the seed whose host has waited longest (per-host politeness).
    let bestIndex = -1;
    let bestWait = -Infinity;
    const now = Date.now();
    for (let i = 0; i < queue.length; i += 1) {
      let host = "?";
      try { host = new URL(queue[i].url).hostname; } catch {}
      const last = hostLastStart.get(host) ?? -Infinity;
      const wait = now - last;
      if (wait > bestWait) { bestWait = wait; bestIndex = i; }
      if (wait >= HOST_MIN_INTERVAL_MS) break;
    }
    if (bestWait < HOST_MIN_INTERVAL_MS) {
      await sleep(Math.max(20, HOST_MIN_INTERVAL_MS - bestWait));
      continue;
    }
    const seed = queue.splice(bestIndex, 1)[0];
    let host = "?";
    try { host = new URL(seed.url).hostname; } catch {}
    hostLastStart.set(host, Date.now());
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
