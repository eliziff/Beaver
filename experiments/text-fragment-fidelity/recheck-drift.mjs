import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsPath = path.join(here, "results", "gate-results.jsonl");
const seedsPath = path.join(here, "results", "seeds.jsonl");
const classesPath = path.join(here, "results", "flagged-classes.json");
const outPath = path.join(here, "results", "drift-recheck.jsonl");

const driftLabels = new Set(
  fs.readFileSync(classesPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.klass === "page-drift")
    .map((r) => r.label),
);
const seeds = new Map(
  fs.readFileSync(seedsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const targets = new Map(
  fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.label, r.target]),
);

function normalize(value) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(\d+);/gu, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "\"")
    .replace(/[\u00A0\u202F\u2007\u2009]/gu, " ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}
// Marker-free needle: drop only a LEADING "[N]"/"N" paragraph marker, then
// take the next 7 words; interior digits (s. 1, para. 33) are real prose.
function midNeedle(quote) {
  const words = quote.split(/\s+/u);
  let start = 0;
  if (/^\[\d+\]$/u.test(words[0] ?? "") || /^\d+$/u.test(words[0] ?? "")) start = 1;
  return words.slice(start, start + 7).join(" ");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const out = [];
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  for (const label of [...driftLabels].sort()) {
    const seed = seeds.get(label);
    const target = targets.get(label);
    if (!seed || !target) { out.push({ label, klass: "unchecked" }); continue; }
    const needle = normalize(midNeedle(seed.quotes[0]));
    const page = await context.newPage();
    let classification;
    try {
      await page.goto(target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40_000 });
      await page.waitForTimeout(1_200);
      const body = await page.content();
      const text = normalize(body.replace(/<[^>]+>/gu, " "));
      const title = normalize((body.match(/<title[^>]*>([\s\S]*?)<\/title>/iu) ?? [])[1] ?? "");
      if (title.includes("validation") || text.length < 800) {
        classification = "dead-page";
      } else if (needle && text.includes(needle)) {
        classification = "styling-difference";
      } else {
        classification = "true-drift";
      }
    } catch (error) {
      classification = "unreachable";
    } finally {
      await page.close();
    }
    out.push({ label, klass: classification });
    fs.appendFileSync(outPath, `${JSON.stringify({ label, klass: classification })}\n`);
    console.log(JSON.stringify({ label, klass: classification }));
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
} finally {
  await browser.close();
}
const tally = {};
for (const row of out) tally[row.klass] = (tally[row.klass] ?? 0) + 1;
console.log(JSON.stringify({ rechecked: out.length, tally }, null, 1));
