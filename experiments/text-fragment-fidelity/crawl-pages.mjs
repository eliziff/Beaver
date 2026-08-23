#!/usr/bin/env node
// One-time crawl: caches the HTML of every unique seed page for local replay.
// Parallel across hosts with per-host politeness. Idempotent: cached URLs are
// skipped on re-run.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const cacheDir = path.join(resultsDir, "page-html");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
fs.mkdirSync(cacheDir, { recursive: true });

// The crawl must fetch the page the builder actually navigates to, not the raw
// seed URL: the builder rewrites ontario.ca e-laws API -> HTML, laws-lois
// justice XML -> FullText.html, canlii PDF -> HTML, and adds Decisia
// iframe/mobile params. Reuse the builder's own sourceUrl so the two can never
// drift again (the earlier API/XML cache-miss gap came from replicating only
// part of that transform here).
const { sourceUrl } = await import(pathToFileURL(path.join(here, "builder-candidate.ts")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPdfUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (/laws\.yukon\.ca\/cms\/images\/LEGISLATION/iu.test(u.href)) return true;
    if (/justice\.gov\.nt\.ca\/en\/files\/legislation/iu.test(u.href)) return true;
    if (/princeedwardisland\.ca\/sites\/default\/files\/legislation/iu.test(u.href)) return true;
    if (/publications\.saskatchewan\.ca\/api\/v1\/products.*\/formats\//iu.test(u.href)) return true;
  } catch {
    return rawUrl.toLowerCase().split("?")[0].split("#")[0].endsWith(".pdf");
  }
  return false;
}

function fetchUrlFor(rawUrl) {
  try {
    const transformed = sourceUrl(rawUrl);
    if (transformed) return transformed.split("#")[0];
  } catch {}
  return rawUrl;
}

const seeds = fs.readFileSync(seedsPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const urls = [...new Set(seeds.map((s) => s.url.split("#")[0]))];
const have = new Set();
if (fs.existsSync(manifestPath)) {
  for (const line of fs.readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row.url) continue;
      // PDF placeholder from page.content() is ~159 bytes (Chrome PDF viewer HTML),
      // not real PDF bytes. Treat tiny PDF entries as not cached so they get re-fetched
      // via Node fetch as binary.
      if (row.bytes != null && row.bytes < 5000) continue;
      if (row.file == null) continue;
      // Manifest rows already hold the fetch URL; key them as-is so a stale
      // entry at a raw seed URL (e.g. ontario.ca API JSON) does not mask a
      // missing entry at the transformed URL.
      have.add(row.url);
    } catch {}
  }
}
const pending = urls.filter((url) => !have.has(fetchUrlFor(url)));
console.log(JSON.stringify({ unique: urls.length, cached: have.size, pending: pending.length }));

const manifest = fs.createWriteStream(manifestPath, { flags: "a" });
// Stealth launch, ported from the Digital Commons downloader
// (oajd/downloaders/platforms/digitalcommons.py): a fresh user-data-dir per
// run plus AutomationControlled disable and the navigator.webdriver hide are
// what get past Decisia's "Validation" wall.
const stealthUserDataDir = path.join(
  process.env.TEMP ?? "/tmp",
  `stealth-crawl-${process.pid}-${Date.now()}`,
);
const context = await chromium.launchPersistentContext(stealthUserDataDir, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1366, height: 900 },
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
    "--log-level=3",
  ],
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
const pages = context.pages()[0] ?? (await context.newPage());

async function crawl(page, url) {
  try {
    // Fetch the URL the builder actually navigates to: Decisia shells need
    // iframe/mobile params to serve the decision text at all.
    const fetchUrl = fetchUrlFor(url);
    if (isPdfUrl(fetchUrl)) {
      // PDFs: page.content() returns Chrome's PDF viewer HTML (~159 bytes), not
      // the PDF bytes. Try Node fetch first (fast for NT, PE), fall back to
      // browser fetch for Cloudflare-protected hosts (laws.yukon.ca).
      let buf = null;
      try {
        const res = await fetch(fetchUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "application/pdf,*/*",
          },
        });
        if (res.ok) {
          const candidate = Buffer.from(await res.arrayBuffer());
          if (candidate.length >= 1000 && candidate.slice(0, 5).toString() === "%PDF-") {
            buf = candidate;
          } else {
            const head = candidate.slice(0, 200).toString("utf8").replace(/\s+/gu, " ").slice(0, 120);
            console.log(JSON.stringify({ event: "pdf-node-not-pdf", url: fetchUrl.slice(0, 90), bytes: candidate.length, head, status: res.status }));
          }
        } else {
          console.log(JSON.stringify({ event: "pdf-node-http", url: fetchUrl.slice(0, 90), status: res.status }));
        }
      } catch (error) {
        console.log(JSON.stringify({ event: "pdf-node-error", url: fetchUrl.slice(0, 90), error: String(error).slice(0, 80) }));
      }
      if (!buf) {
        // Browser fallback: Cloudflare challenge requires JS (laws.yukon.ca returns 403 + "Just a moment..." for Node fetch).
        // Visit origin to obtain cf_clearance cookie, then fetch PDF via page.evaluate which inherits cookies.
        try {
          const origin = new URL(fetchUrl).origin;
          let needNav = true;
          try { needNav = new URL(page.url()).origin !== origin; } catch {}
          if (needNav) {
            await page.goto(`${origin}/`, { waitUntil: "load", timeout: 40_000 });
            await page.waitForTimeout(3000);
          }
          const result = await page.evaluate(async (u) => {
            const r = await fetch(u);
            if (!r.ok) return { ok: false, status: r.status };
            const ab = await r.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { ok: true, status: r.status, b64: btoa(binary), len: bytes.length };
          }, fetchUrl);
          if (!result.ok) throw new Error(`pdf browser fetch ${result.status}`);
          const candidate = Buffer.from(result.b64, "base64");
          if (candidate.length < 1000 || candidate.slice(0, 5).toString() !== "%PDF-") {
            throw new Error(`pdf browser not pdf bytes=${candidate.length}`);
          }
          buf = candidate;
          console.log(JSON.stringify({ event: "pdf-browser-ok", url: fetchUrl.slice(0, 90), bytes: buf.length }));
        } catch (error) {
          throw new Error(`pdf browser failed: ${String(error).slice(0, 80)}`);
        }
      }
      const key = crypto.createHash("sha1").update(fetchUrl).digest("hex");
      const file = `${key}.pdf`;
      fs.writeFileSync(path.join(cacheDir, file), buf);
      manifest.write(`${JSON.stringify({ url: fetchUrl, file, bytes: buf.length, contentType: "application/pdf", challenged: false })}\n`);
      return { ok: true, bytes: buf.length, contentType: "application/pdf" };
    }
    await page.goto(fetchUrl, { waitUntil: "load", timeout: 90_000 });
    // Decisia-family pages inject the decision text after load; a short settle
    // caches only shells (title present, reasons missing). Some tenants (e.g.
    // decisions.ct-tc.gc.ca) are slower than others, so Decisia gets a 5s
    // settle and everything else keeps the short one.
    const settle = /(^|\.)decisions?\.[\w-]+\.(?:gc\.)?ca$|decisia\.lexum\.com|coadecisions\.ontariocourts\.ca$/iu.test(
      (() => { try { return new URL(fetchUrl).hostname; } catch { return ""; } })(),
    )
      ? 5_000
      : 1_500;
    await page.waitForTimeout(settle);
    let html = await page.content();
    // Anti-bot "Validation" challenge: one quick retry.
    if (/<title>\s*Validation\s*<\/title>/iu.test(html)) {
      console.log(JSON.stringify({ event: "validation-retry", url: fetchUrl.slice(0, 90) }));
      await page.waitForTimeout(5_000);
      await page.goto(fetchUrl, { waitUntil: "load", timeout: 90_000 });
      await page.waitForTimeout(settle);
      html = await page.content();
    }
    const challenged = /<title>\s*Validation\s*<\/title>/iu.test(html);
    const key = crypto.createHash("sha1").update(fetchUrl).digest("hex");
    const file = `${key}.html`;
    fs.writeFileSync(path.join(cacheDir, file), html);
    manifest.write(`${JSON.stringify({ url: fetchUrl, file, bytes: html.length, contentType: "text/html", challenged })}\n`);
    return { ok: true, bytes: html.length, challenged };
  } catch (error) {
    manifest.write(`${JSON.stringify({ url, file: null, error: String(error).slice(0, 80) })}\n`);
    return { ok: false, error: String(error).slice(0, 80) };
  }
}

// Parallel across hosts under the stealth profile, per-host starts spaced by
// HOST_MIN_INTERVAL_MS. The earlier wall was triggered by a NON-stealth
// parallel pass; test how far stealth parallelism gets us.
const WORKERS = Number(process.env.CRAWL_WORKERS ?? 8);
const HOST_MIN_INTERVAL_MS = 600;
try {
  const workerPages = [];
  for (let i = 0; i < WORKERS; i += 1) {
    workerPages.push(i === 0 ? pages : await context.newPage());
  }
  const busy = new Array(WORKERS).fill(false);
  const hostLastStart = new Map();
  const queue = [...pending];
  let started = 0;
  let completed = 0;
  while (queue.length) {
    const workerIndex = busy.findIndex((b) => !b);
    if (workerIndex < 0) { await sleep(30); continue; }
    let bestIndex = -1;
    let bestWait = -Infinity;
    const now = Date.now();
    for (let i = 0; i < queue.length; i += 1) {
      let host = "?";
      try { host = new URL(fetchUrlFor(queue[i])).hostname; } catch {}
      const wait = now - (hostLastStart.get(host) ?? -Infinity);
      if (wait > bestWait) { bestWait = wait; bestIndex = i; }
      if (wait >= HOST_MIN_INTERVAL_MS) break;
    }
    if (bestWait < HOST_MIN_INTERVAL_MS) {
      await sleep(Math.max(20, HOST_MIN_INTERVAL_MS - bestWait));
      continue;
    }
    const url = queue.splice(bestIndex, 1)[0];
    let host = "?";
    try { host = new URL(fetchUrlFor(url)).hostname; } catch {}
    hostLastStart.set(host, Date.now());
    busy[workerIndex] = true;
    started += 1;
    crawl(workerPages[workerIndex], url).then((result) => {
      busy[workerIndex] = false;
      completed += 1;
      if (completed % 25 === 0 || !result.ok || result.challenged) {
        console.log(JSON.stringify({ event: "progress", completed, of: started, url: url.slice(0, 80), ...result }));
      }
    });
  }
  while (completed < started) await sleep(100);
  console.log(JSON.stringify({ event: "crawl-done", cached: completed }));
} finally {
  await context.close();
}
