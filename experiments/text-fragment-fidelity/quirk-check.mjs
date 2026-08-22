import { chromium } from "playwright-core";
import fs from "node:fs";

const results = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/gate-results.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.label, r]),
);
const seeds = new Map(
  fs.readFileSync("experiments/text-fragment-fidelity/results/seeds.jsonl", "utf8")
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);

const labels = [
  "BCCA_2012_BCCA_480_p14_short-exact",
  "CITT_CITT_EP-2009-002_p10_hard-act-name",
  "CITT_CITT_EP-2012-002_p12_short-exact",
  "CITT_CITT_EP-2012-006_p8_short-exact",
];

function normalize(value) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(\d+);/gu, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "\"")
    .replace(/[\u00A0\u202F\u2007\u2009]/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}
const stripPunct = (value) => value.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  for (const label of labels) {
    const seed = seeds.get(label);
    const row = results.get(label);
    const quote = normalize(seed.quotes[0]);
    const core = stripPunct(quote).split(" ").slice(0, 10).join(" ");
    const page = await context.newPage();
    let report;
    try {
      await page.goto(row.target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(1200);
      const body = await page.content();
      const text = normalize(body);
      const at = stripPunct(text).indexOf(core);
      report = { label, found: at >= 0 };
      if (at >= 0) {
        const mapped = text.slice(Math.max(0, at - 60), at + 160);
        report.renderedWindow = mapped;
        report.quoteWindow = quote.slice(0, 200);
      }
    } catch (error) {
      report = { label, error: String(error).slice(0, 80) };
    } finally {
      await page.close();
    }
    console.log(JSON.stringify(report));
  }
} finally {
  await browser.close();
}
