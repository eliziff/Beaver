#!/usr/bin/env node
// Caches rendered innerText for actionable failure pages so divergence
// analysis can run offline and reproducibly.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsPath = path.join(here, "results", "gate-results.jsonl");
const classesPath = path.join(here, "results", "flagged-classes.json");
const cacheDir = path.join(here, "results", "pagecache");
fs.mkdirSync(cacheDir, { recursive: true });

const actionable = new Set(
  fs.readFileSync(classesPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.klass === "projection-gap" || r.klass === "quote-restyled")
    .map((r) => r.label),
);
const targets = new Map(
  fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.label, r.target]),
);

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  let done = 0;
  for (const label of [...actionable]) {
    const safe = label.replace(/[^\w.-]+/gu, "_");
    const outPath = path.join(cacheDir, `${safe}.txt`);
    if (fs.existsSync(outPath)) { done += 1; continue; }
    const target = targets.get(label);
    if (!target) continue;
    const page = await context.newPage();
    try {
      await page.goto(target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40_000 });
      await page.waitForTimeout(1_500);
      const text = await page.evaluate(() => document.body?.innerText ?? "");
      fs.writeFileSync(outPath, text);
    } catch (error) {
      console.error(JSON.stringify({ label, error: String(error).slice(0, 80) }));
    } finally {
      await page.close();
    }
    done += 1;
    if (done % 10 === 0) console.error(JSON.stringify({ progress: done, of: actionable.size }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  console.log(JSON.stringify({ cached: done }));
} finally {
  await browser.close();
}
