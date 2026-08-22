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

const label = process.argv[2] ?? "NSPC_2008_NSPC_24_p9_short-exact";
const seed = seeds.get(label);
const row = results.get(label);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(row.target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const title = document.querySelector("title")?.textContent ?? "";
    const heading = document.querySelector("h1, h2")?.textContent ?? "";
    // Find any paragraph that starts with [9]
    let par9 = null;
    for (const el of document.querySelectorAll("p")) {
      if (/^\[?9\]?/.test((el.textContent ?? "").trim())) { par9 = (el.textContent ?? "").trim().slice(0, 160); break; }
    }
    return { title: title.slice(0, 120), heading: heading.slice(0, 80), par9 };
  });
  console.log(JSON.stringify({
    seedExpects: {
      anchor: seed.anchor,
      blockHead: seed.blockText.trim().slice(0, 140),
    },
    livePage: info,
  }, null, 1));
} finally {
  await browser.close();
}
