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
const labels = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  for (const label of labels) {
    const seed = seeds.get(label);
    const row = results.get(label);
    if (!seed || !row) continue;
    const page = await context.newPage();
    try {
      await page.goto(row.target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForTimeout(1200);
      const body = await page.content();
      const text = body
        .replace(/&nbsp;|&#160;/giu, " ").replace(/[’‘]/gu, "'").replace(/[“”]/gu, "\"")
        .replace(/\s+/gu, " ")
        .toLowerCase();
      const blockHead = seed.blockText.replace(/\s+/gu, " ").trim().slice(0, 90);
      // Find the longest prefix of the quote that survives on the page.
      const quoteWords = seed.quotes[0].replace(/\s+/gu, " ").toLowerCase().split(" ");
      let best = 0;
      for (let len = quoteWords.length; len >= 2; len -= 1) {
        if (text.includes(quoteWords.slice(0, len).join(" "))) { best = len; break; }
      }
      console.log(JSON.stringify({
        label,
        blockHeadFound: text.includes(blockHead.toLowerCase()),
        longestQuotePrefixWords: best,
        of: quoteWords.length,
        quoteHead: quoteWords.slice(0, 8).join(" "),
      }));
    } catch (error) {
      console.log(JSON.stringify({ label, error: String(error).slice(0, 80) }));
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
