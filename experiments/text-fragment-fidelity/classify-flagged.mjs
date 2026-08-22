#!/usr/bin/env node
// Classifies every no-highlight seed:
//   projection-gap : quote text exists on the page but the fragment missed
//   page-drift     : neither quote nor block text found on the fetched page
//   pdf-card       : metadata stub offering a PDF download
//   unreachable    : fetch failed even via Chrome
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsPath = path.join(here, "results", "gate-results.jsonl");
const seedsPath = path.join(here, "results", "seeds.jsonl");
const outPath = path.join(here, "results", "flagged-classes.json");

const rows = fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.verdict === "no-highlight");
const seeds = new Map(
  fs.readFileSync(seedsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);

function normalize(value) {
  return value
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#\d+;/gu, (m) => String.fromCodePoint(Number(m.slice(2, -1))))
    .replace(/[’‘]/gu, "'")
    .replace(/[“”]/gu, "\"")
    .replace(/[\u00A0\u202F\u2007\u2009]/gu, " ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

async function fetchText(browser, url) {
  const plain = await fetch(url.split("#")[0], {
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36" },
  }).then((r) => r.text()).catch(() => null);
  if (plain !== null) return { body: plain, viaBrowser: false };
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  try {
    const page = await context.newPage();
    await page.goto(url.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40_000 });
    const body = await page.content();
    await page.close();
    return { body, viaBrowser: true };
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const out = [];
  let done = 0;
  for (const row of rows) {
    const seed = seeds.get(row.label);
    if (!seed) { out.push({ label: row.label, klass: "seed-missing" }); continue; }
    const wantedQuote = normalize(seed.quotes[0]).slice(0, 70);
    const wantedBlock = normalize(seed.blockText).slice(20, 90);
    let classification;
    try {
      const { body, viaBrowser } = await fetchText(browser, row.target);
      const text = normalize(body.replace(/<[^>]+>/gu, " "));
      const quoteIn = text.includes(wantedQuote);
      const blockIn = text.includes(wantedBlock);
      const pdfCard = /case documents|click here to download/iu.test(body.slice(0, 6000)) && body.length < 40000;
      classification =
        pdfCard ? "pdf-card"
        : quoteIn ? "projection-gap"
        : blockIn ? "quote-restyled"
        : "page-drift";
      out.push({ label: row.label, dataset: row.dataset, shape: row.shape, klass: classification, viaBrowser });
    } catch (error) {
      out.push({ label: row.label, dataset: row.dataset, shape: row.shape, klass: "unreachable", error: String(error).slice(0, 60) });
    }
    done += 1;
    if (done % 15 === 0) console.error(JSON.stringify({ progress: done, of: rows.length }));
  }
  fs.writeFileSync(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tally = {};
  for (const item of out) tally[item.klass] = (tally[item.klass] ?? 0) + 1;
  console.log(JSON.stringify({ total: out.length, tally }, null, 1));
} finally {
  await browser.close();
}
