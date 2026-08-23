import { chromium } from "playwright-core";
import fs from "node:fs";

const rows = fs.readFileSync(process.env.TEMP + "/opencode/gate-slice2-results.jsonl", "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const row = rows.find((r) => r.label === "BCCA_2014_BCCA_79_p131_hard-statute-ref");
const seeds = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const seed = seeds.get(row.label);
const needle = seed.quotes[0].split(/\s+/u).slice(0, 6).join(" ").toLowerCase();

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(row.target, { waitUntil: "load", timeout: 45000 });
  await page.waitForTimeout(2500);
  const state = await page.evaluate((wanted) => {
    const boxes = [];
    for (const el of document.querySelectorAll("p, li, blockquote, td, h1, h2, h3")) {
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0 || rect.height > 1500) continue;
      const text = (el.innerText ?? "").replace(/\s+/gu, " ").toLowerCase();
      if (!text.includes(wanted)) continue;
      boxes.push({
        top: Math.round(rect.top), bottom: Math.round(rect.bottom),
        sample: text.slice(0, 70),
      });
    }
    return { scrollY: Math.round(window.scrollY), boxes: boxes.slice(0, 6) };
  }, needle);
  console.log(JSON.stringify({
    label: row.label,
    needle,
    bandTopInViewport: row.highlightTopInViewport,
    ...state,
  }, null, 1));
} finally {
  await browser.close();
}
