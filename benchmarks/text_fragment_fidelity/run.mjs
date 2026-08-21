#!/usr/bin/env node
// Text fragment fidelity smoke runner.
//
// Reads seeds.jsonl, builds each URL through the production link builder,
// opens it in real Chrome, and records where the page landed. See PLAN.md.
//
// Usage (from repo root):
//   npx tsx benchmarks/text_fragment_fidelity/run.mjs [--out dir] [--seeds file]

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : fallback;
}
const root = path.resolve(import.meta.dirname, "..", "..");
const seedsPath = arg("--seeds", path.join(import.meta.dirname, "seeds.jsonl"));
const outDir = arg("--out", "text-fragment-shots");
fs.mkdirSync(outDir, { recursive: true });

const { buildLegalSourcePinpointUrl } = await import(
  pathToFileURL(path.join(root, "backend/src/lib/legalSourceLinks.ts")).href
);

const seeds = [];
for (const line of (await fs.promises.readFile(seedsPath, "utf8")).split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("//")) seeds.push(JSON.parse(trimmed));
}

function manualUrl(seed) {
  // Mirror the transport rewrites production applies via sourceUrl():
  // bare Decisia index.do URLs are iframe shells that 404 or refuse
  // fragments without these parameters.
  const url = new URL(seed.url);
  if (/decisia\.lexum\.com|decisions?\.[\w-]+\.(?:gc\.)?ca$/iu.test(url.hostname)) {
    url.searchParams.set("iframe", "true");
    url.searchParams.set("site_preference", "mobile");
  }
  const directives = [seed.manualDirective].flat().map(encodeURIComponent);
  const anchorPart = seed.anchor ? `#${seed.anchor}` : "";
  return `${url.toString()}${anchorPart}:~:text=${directives.join("&text=")}`;
}

function buildTarget(seed) {
  if (seed.manualDirective) return manualUrl(seed);
  return buildLegalSourcePinpointUrl(
    {
      url: seed.url,
      ...(seed.anchor ? { anchor: seed.anchor } : {}),
      blockText: seed.blockText ?? "",
      ...(seed.documentText ? { documentText: seed.documentText } : {}),
    },
    seed.quotes ?? [],
  );
}

async function measure(page, target) {
  await page.goto(target, { waitUntil: "load", timeout: 45_000 });
  await page.waitForTimeout(2_000);
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
  const wantedWords = decodeURIComponent(target.split("#:~:text=")[1] ?? "")
    .split("&")[0]
    .replace(/^[-,]+|[-,]+$/gu, "")
    .split(/[\s,]+/u)
    .filter((word) => /[A-Za-z0-9]{3,}/u.test(word))
    .slice(0, 5)
    .join(" ")
    .toLowerCase();
  const challenged = /verification required|forbidden/iu.test(state.viewport);
  const landed =
    !challenged &&
    (state.scrollY > 0 ||
      Boolean(wantedWords && state.viewport.toLowerCase().includes(wantedWords)));
  const innerHeight = await page.evaluate(() => window.innerHeight);
  const pastBodyAnchor =
    state.firstBodyAnchorY === null ||
    state.scrollY === 0 ||
    state.scrollY >= state.firstBodyAnchorY - innerHeight;
  return { landed, challenged, pastBodyAnchor, ...state };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const results = [];
  for (const seed of seeds) {
    const target = buildTarget(seed);
    let record;
    try {
      const measurement = await measure(page, target);
      const verdict = measurement.challenged
        ? "provider-blocked"
        : measurement.landed
          ? "landed"
          : "no-landing";
      record = {
        label: seed.label,
        providerClass: seed.providerClass,
        expectLanding: seed.expectLanding ?? true,
        verdict,
        landed: measurement.landed,
        pastBodyAnchor: measurement.pastBodyAnchor,
        scrollY: measurement.scrollY,
        firstBodyAnchorY: measurement.firstBodyAnchorY,
        note: seed.note ?? undefined,
        target,
      };
      await page.screenshot({
        path: path.resolve(outDir, `${seed.label}.png`),
      });
    } catch (error) {
      record = {
        label: seed.label,
        providerClass: seed.providerClass,
        expectLanding: seed.expectLanding ?? true,
        landed: false,
        error: String(error?.message ?? error),
        target,
      };
    }
    results.push(record);
    console.log(JSON.stringify(record));
    // Politeness: sequential loads with a pause between publisher fetches.
    await page.waitForTimeout(1_500);
  }
  const failures = results.filter(
    (record) =>
      record.verdict !== "provider-blocked" &&
      record.verdict !== "error" &&
      record.expectLanding === true &&
      record.verdict !== "landed",
  ).length;
  console.log(JSON.stringify({
    summary: {
      total: results.length,
      failures,
      verdicts: Object.fromEntries(
        [...new Set(results.map((record) => record.verdict ?? "error"))].map(
          (verdict) => [
            verdict,
            results.filter((record) =>
              (record.verdict ?? "error") === verdict).length,
          ],
        ),
      ),
    },
  }));
  if (failures) process.exit(1);
} finally {
  await browser.close();
}
