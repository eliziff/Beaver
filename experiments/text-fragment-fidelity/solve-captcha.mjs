#!/usr/bin/env node
// Interactive Decisia crawl: HEADED Chrome, a persistent profile so a solved
// captcha clears the wall for the rest of the run. When a page returns the
// "Validation" challenge, this script keeps the Chrome window open and waits
// for you to solve it, then continues.
//
// Usage (repo root): node experiments/text-fragment-fidelity/solve-captcha.mjs
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const cacheDir = path.join(resultsDir, "page-html");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
fs.mkdirSync(cacheDir, { recursive: true });

function fetchUrlFor(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (/decisia\.lexum\.com|decisions?\.[\w-]+\.(?:gc\.)?ca|coadecisions\.|decision\.tcc-cci\.gc\.ca$/iu.test(parsed.hostname)) {
      parsed.searchParams.set("iframe", "true");
      parsed.searchParams.set("site_preference", "mobile");
      return parsed.toString();
    }
  } catch {}
  return rawUrl;
}
function normalizeKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${url.origin}${url.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return rawUrl.split("#")[0];
  }
}
const isChallenge = (html) => /<title>\s*Validation\s*<\/title>/iu.test(html);

const seeds = fs.readFileSync(seedsPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const urls = [...new Set(seeds.map((s) => fetchUrlFor(s.url.split("#")[0])))];
const have = new Set(
  fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return normalizeKey(JSON.parse(l).url); } catch { return null; } })
        .filter(Boolean)
    : [],
);
const pending = urls.filter((u) => !have.has(normalizeKey(u)));
console.log(JSON.stringify({ pending: pending.length }));

const profileDir = path.join(resultsDir, "captcha-profile");
const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame", "--log-level=3",
  ],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});

const manifest = fs.createWriteStream(manifestPath, { flags: "a" });
const page = context.pages()[0] ?? (await context.newPage());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForSolve(page) {
  console.log("\n>>> CAPTCHA: the Chrome window is showing a 'Validation' page.");
  console.log(">>> Solve it there, then leave this terminal alone. Polling...\n");
  for (let i = 0; i < 150; i += 1) {
    await sleep(2000);
    try {
      const html = await page.content();
      if (!isChallenge(html)) return true;
    } catch {}
  }
  return false;
}

let solved = 0;
for (const url of pending) {
  try {
    await page.goto(url, { waitUntil: "load", timeout: 40_000 });
    await page.waitForTimeout(2_500);
    let html = await page.content();
    if (isChallenge(html)) {
      const ok = await waitForSolve(page);
      if (!ok) { console.log(JSON.stringify({ event: "gave-up", url })); continue; }
      solved += 1;
      await page.waitForTimeout(2_500);
      html = await page.content();
    }
    const challenged = isChallenge(html);
    const key = crypto.createHash("sha1").update(url).digest("hex");
    const file = `${key}.html`;
    fs.writeFileSync(path.join(cacheDir, file), html);
    manifest.write(`${JSON.stringify({ url, file, bytes: html.length, challenged })}\n`);
    console.log(JSON.stringify({ event: "cached", solved, url: url.slice(0, 70), bytes: html.length, challenged }));
  } catch (error) {
    manifest.write(`${JSON.stringify({ url, file: null, error: String(error).slice(0, 80) })}\n`);
  }
  await sleep(1500);
}
manifest.end();
await context.close();
console.log(JSON.stringify({ event: "done", solved, cached: pending.length }));
