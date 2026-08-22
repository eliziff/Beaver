import { chromium } from "playwright-core";
import fs from "node:fs";

const seeds = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const results = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/gate-results.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.label, r]),
);

const label = process.argv[2];
const needle = process.argv[3];
const seed = seeds.get(label);
const row = results.get(label);
console.log("ASCII quote:", JSON.stringify(seed.quotes[0].replace(/\u00A0/g, "\u2423").slice(0, 200)));
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(row.target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(1500);
  const html = await page.content();
  const at = html.indexOf(needle);
  console.log("needle:", JSON.stringify(needle), "-> found at:", at);
  if (at >= 0) {
    console.log("--- raw HTML around match ---");
    console.log(html.slice(Math.max(0, at - 500), at + needle.length + 300)
      .replace(/[ \t]+/gu, " "));
  }
} finally {
  await browser.close();
}
