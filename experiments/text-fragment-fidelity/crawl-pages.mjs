#!/usr/bin/env node
// One-time crawl: caches the HTML of every unique seed page for local replay.
// Parallel across hosts with per-host politeness. Idempotent: cached URLs are
// skipped on re-run.
import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decodeEntities, htmlToText } from "./gap-lib.mjs";

const here = import.meta.dirname;
if (process.platform === "win32") {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
}
const resultsDir = path.join(here, "results");
const seedsPath = path.join(resultsDir, "seeds.jsonl");
const inputPath = process.env.CRAWL_TARGETS_JSONL
  ? path.resolve(process.env.CRAWL_TARGETS_JSONL)
  : seedsPath;
const cacheDir = path.join(resultsDir, "page-html");
const browserTextDir = path.join(resultsDir, "browser-rendered-text");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(browserTextDir, { recursive: true });

// The crawl must fetch the page the builder actually navigates to, not the raw
// seed URL: the builder rewrites ontario.ca e-laws API -> HTML, laws-lois
// justice XML -> FullText.html, canlii PDF -> HTML, and adds Decisia
// iframe/mobile params. Reuse the builder's own sourceUrl so the two can never
// drift again (the earlier API/XML cache-miss gap came from replicating only
// part of that transform here).
const { sourceUrl } = await import(pathToFileURL(path.join(here, "builder-candidate.ts")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownedChromeQuery = String.raw`
$needle = [Environment]::GetEnvironmentVariable('TEXT_FRAGMENT_OWNED_PROFILE')
$expected = [IO.Path]::GetFullPath($needle).TrimEnd('\')
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
  Where-Object {
    if (-not $_.CommandLine) { return $false }
    $match = [regex]::Match(
      $_.CommandLine,
      '(?i)"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|(?:^|\s)--user-data-dir=([^\s"]+)'
    )
    if (-not $match.Success) { return $false }
    $actual = @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value) |
      Where-Object { $_ } | Select-Object -First 1
    try { [IO.Path]::GetFullPath($actual).TrimEnd('\') -ieq $expected } catch { $false }
  } |
  ForEach-Object { $_.ProcessId }
`;

function ownedChromeProcessIds(profileMarker) {
  if (process.platform !== "win32") return [];
  const marker = String(profileMarker).trim();
  if (!marker) throw new Error("owned Chrome profile marker must not be empty");
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", ownedChromeQuery],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, TEXT_FRAGMENT_OWNED_PROFILE: marker },
    },
  );
  return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)
    .map(Number).filter((value) => Number.isInteger(value) && value > 0);
}

async function stopOwnedChromeProcesses(profileMarker) {
  if (process.platform !== "win32") return;
  let emptyChecks = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const processIds = ownedChromeProcessIds(profileMarker);
    if (!processIds.length) {
      emptyChecks += 1;
      if (emptyChecks === 2) return;
      await sleep(100);
      continue;
    }
    emptyChecks = 0;
    for (const processId of processIds) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
          stdio: "ignore", windowsHide: true,
        });
      } catch {}
    }
    await sleep(100);
  }
  const survivors = ownedChromeProcessIds(profileMarker);
  if (survivors.length) throw new Error(`owned Chrome processes survived cleanup: ${survivors.join(",")}`);
  if (emptyChecks + 1 < 2) throw new Error("owned Chrome cleanup did not reach a stable empty state");
}

async function removeOwnedProfile(profileDir) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(100 * (attempt + 1));
      continue;
    }
    if (!fs.existsSync(profileDir)) return;
  }
  throw new Error(`owned Chrome profile survived cleanup: ${profileDir}`);
}

async function downloadBytes(download) {
  const stream = await download.createReadStream();
  let timer;
  const body = (async () => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  try {
    return await Promise.race([
      body,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          stream.destroy();
          reject(new Error("download stream timed out"));
        }, 90_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isPdfUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.pathname.toLowerCase().endsWith(".pdf")) return true;
    if (u.pathname.toLowerCase().endsWith("/document.do")) return true;
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

const allSeeds = fs.readFileSync(inputPath, "utf8")
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const retryResults = process.env.CRAWL_LABELS_JSONL;
const retryLabels = retryResults
  ? new Set(fs.readFileSync(retryResults, "utf8").split(/\r?\n/u).filter(Boolean)
    .map(JSON.parse).filter((row) => row.verdict !== "range-exact").map((row) => row.label))
  : null;
const seeds = retryLabels ? allSeeds.filter(({ label }) => retryLabels.has(label)) : allSeeds;
const urls = [...new Set(seeds.map((s) => (s.target ?? s.url).split("#")[0]))];
const sourcePageByTarget = new Map();
const requiredTextByTarget = new Map();
for (const seed of seeds) {
  const target = (seed.target ?? seed.url).split("#")[0];
  if (!sourcePageByTarget.has(target)) sourcePageByTarget.set(target, seed.url.split("#")[0]);
  const required = requiredTextByTarget.get(target) ?? [];
  required.push(...(seed.requiredPaintQuotes ?? []));
  requiredTextByTarget.set(target, required);
}
const normalizedText = (value) => String(value).normalize("NFKC")
  .toLocaleLowerCase("en").replace(/\s+/gu, " ").trim();
function cacheIsUsable(row) {
  if (row.httpStatus != null && (row.httpStatus < 200 || row.httpStatus >= 400)) return false;
  if (row.file?.toLowerCase().endsWith(".pdf")) return true;
  const file = row.file && path.join(cacheDir, row.file);
  if (!file || !fs.existsSync(file)) return false;
  const rendered = path.join(browserTextDir, `${path.parse(row.file).name}.txt`);
  const text = (fs.existsSync(rendered)
    ? fs.readFileSync(rendered, "utf8")
    : decodeEntities(htmlToText(fs.readFileSync(file, "utf8"), true))).trim();
  // Cache collection must not redefine a legitimate publisher seam as an
  // absent quote. Native Chrome verification decides whether the built link
  // paints; the crawler only certifies that it captured a nonempty page.
  const error = /(?:^|\n)\s*(?:this page isn.t working|\S+ is currently unable to handle this request|http error [45]\d\d|error\s+[45]\d\d\b|[45]\d\d(?:\s+[-:]|\s+error)|bad gateway|service unavailable|internal server error|access denied|validation|just a moment)/iu;
  return text.length >= 100 && !error.test(text.slice(0, 2_000));
}
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
      if (!cacheIsUsable(row)) continue;
      // Manifest rows already hold the fetch URL; key them as-is so a stale
      // entry at a raw seed URL (e.g. ontario.ca API JSON) does not mask a
      // missing entry at the transformed URL.
      have.add(row.url);
    } catch {}
  }
}
const pending = retryLabels ? urls : urls.filter((url) => !have.has(fetchUrlFor(url)));
console.log(JSON.stringify({ unique: urls.length, cached: have.size, pending: pending.length }));
if (!pending.length) process.exit(0);
if (process.env.CRAWL_DRY_RUN === "1") {
  const fetchUrls = pending.map(fetchUrlFor);
  console.log(JSON.stringify({
    dryRun: true,
    pending: fetchUrls.length,
    hosts: [...new Set(fetchUrls.map((url) => new URL(url).hostname))].sort(),
    fragmentBearingUrls: fetchUrls.filter((url) => new URL(url).hash).length,
  }));
  process.exit(0);
}

const manifest = fs.createWriteStream(manifestPath, { flags: "a" });
// Stealth launch, ported from the Digital Commons downloader
// (oajd/downloaders/platforms/digitalcommons.py): a fresh user-data-dir per
// run plus AutomationControlled disable and the navigator.webdriver hide are
// what get past Decisia's "Validation" wall.
const stealthUserDataDir = path.join(
  process.env.TEMP ?? "/tmp",
  `stealth-crawl-${process.pid}-${Date.now()}`,
);
let context = null;
let cleanupRunning = null;
let stopping = false;
let signalExitCode = 0;
const inflight = new Set();

async function startOwnedWindowsSupervisor() {
  if (process.platform !== "win32") return;
  const supervisor = spawn(
    process.env.PYTHON ?? "python",
    [
      path.join(here, "webdriver-exact-parallel.py"),
      "--crawler-owner-pid", String(process.pid),
      "--crawler-profile", path.resolve(stealthUserDataDir),
    ],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("crawler Job supervisor did not become ready")),
        15_000,
      );
      const failed = (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      supervisor.once("error", failed);
      supervisor.once("exit", (code) => failed(
        new Error(`crawler Job supervisor exited before ready (${code})`),
      ));
      supervisor.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!output.includes("crawler-supervisor-ready")) return;
        clearTimeout(timer);
        supervisor.removeListener("error", failed);
        resolve();
      });
    });
  } catch (error) {
    supervisor.kill();
    throw error;
  }
  supervisor.stdout.destroy();
  supervisor.unref();
}

async function stopBrowser() {
  stopping = true;
  if (cleanupRunning) await cleanupRunning;
  cleanupRunning = (async () => {
    const ownedContext = context;
    context = null;
    if (ownedContext) {
      const close = ownedContext.close().catch(() => undefined);
      await Promise.race([close, sleep(5_000)]);
    }
    const errors = [];
    try { await stopOwnedChromeProcesses(path.resolve(stealthUserDataDir)); }
    catch (error) { errors.push(error); }
    try { await removeOwnedProfile(stealthUserDataDir); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "owned crawler cleanup failed");
  })();
  try {
    await cleanupRunning;
  } finally {
    cleanupRunning = null;
  }
}

const handleSignal = (signal) => {
  if (signalExitCode) return;
  signalExitCode ||= signal === "SIGINT" ? 130 : signal === "SIGBREAK" ? 131 : 143;
  void stopBrowser().catch((error) => {
    process.exitCode = 1;
    console.error(JSON.stringify({ event: "cleanup-error", error: String(error).slice(0, 300) }));
  });
};
const signalHandlers = new Map(
  ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]
    .map((signal) => [signal, () => handleSignal(signal)]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

try {
await startOwnedWindowsSupervisor();
if (stopping) throw new Error("crawl interrupted before browser launch");
context = await chromium.launchPersistentContext(stealthUserDataDir, {
  channel: "chrome",
  headless: false,
  timeout: 60_000,
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
context.setDefaultTimeout(90_000);
context.setDefaultNavigationTimeout(90_000);
await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
});
const pages = context.pages()[0] ?? (await context.newPage());

async function crawl(page, url) {
  try {
    // Fetch the URL the builder actually navigates to: Decisia shells need
    // iframe/mobile params to serve the decision text at all.
    const fetchUrl = fetchUrlFor(url);
    const sourcePageUrl = sourcePageByTarget.get(url) ?? url;
    if (isPdfUrl(fetchUrl)) {
      // PDFs: page.content() returns Chrome's PDF viewer HTML (~159 bytes), not
      // the PDF bytes. Try Node fetch first (fast for NT, PE), fall back to
      // browser fetch for Cloudflare-protected hosts (laws.yukon.ca).
      let buf = null;
      try {
        const res = await fetch(fetchUrl, {
          signal: AbortSignal.timeout(90_000),
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            Accept: "application/pdf,*/*",
            Referer: sourcePageUrl,
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
          const landing = new URL(sourcePageUrl);
          if (/\/item\/\d+\/index\.do$/iu.test(landing.pathname)) {
            landing.searchParams.set("iframe", "true");
            landing.searchParams.set("site_preference", "mobile");
          }
          await page.goto(landing.origin === origin ? landing.toString() : `${origin}/`, {
            waitUntil: "load", timeout: 90_000,
          });
          await page.waitForTimeout(3000);
          const result = await page.evaluate(async (u) => {
            const r = await fetch(u, { signal: AbortSignal.timeout(90_000) });
            if (!r.ok) return { ok: false, status: r.status };
            const ab = await r.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { ok: true, status: r.status, b64: btoa(binary), len: bytes.length };
          }, fetchUrl);
          let candidate;
          if (result.ok) {
            candidate = Buffer.from(result.b64, "base64");
          } else {
            const directDownloadPromise = page.waitForEvent("download", { timeout: 15_000 })
              .catch(() => null);
            try {
              const response = await page.goto(fetchUrl, {
                waitUntil: "commit", timeout: 90_000, referer: landing.toString(),
              });
              if (response?.ok()) {
                const body = Buffer.from(await response.body());
                if (body.slice(0, 5).toString() === "%PDF-") candidate = body;
              }
            } catch {}
            if (!candidate) {
              const download = await Promise.race([directDownloadPromise, sleep(1_000).then(() => null)]);
              if (download) {
                candidate = await downloadBytes(download);
              }
            }
          }
          if (!candidate) {
            // Some Decisia collections reject fetch() but permit the explicit
            // publisher download control. Follow that control in the headed
            // session instead of synthesizing or retrying the URL shape.
            await page.goto(landing.toString(), { waitUntil: "load", timeout: 90_000 });
            const selector = "li.documents a[href], .decisia-decision-pdf-only a[href]";
            const linkIndex = await page.evaluate(([css, wanted]) => {
              const target = new URL(wanted, location.href).toString();
              return [...document.querySelectorAll(css)].findIndex((link) =>
                new URL(link.getAttribute("href"), location.href).toString() === target);
            }, [selector, fetchUrl]);
            if (linkIndex < 0) throw new Error(`pdf browser fetch ${result.status}; control missing`);
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout: 30_000 }),
              page.locator(selector).nth(linkIndex).click(),
            ]);
            candidate = await downloadBytes(download);
          }
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
    let response = await page.goto(fetchUrl, { waitUntil: "load", timeout: 90_000 });
    let html = await page.content();
    // Anti-bot "Validation" challenge: one quick retry.
    if (/<title>\s*Validation\s*<\/title>/iu.test(html)) {
      console.log(JSON.stringify({ event: "validation-retry", url: fetchUrl.slice(0, 90) }));
      await page.waitForTimeout(5_000);
      response = await page.goto(fetchUrl, { waitUntil: "load", timeout: 90_000 });
      html = await page.content();
    }
    const httpStatus = response?.status() ?? 0;
    if (httpStatus < 200 || httpStatus >= 400) throw new Error(`publisher HTTP ${httpStatus}`);
    let challenged = /<title>\s*(?:Validation|Just a moment(?:\.\.\.)?)\s*<\/title>/iu.test(html);
    const deadline = Date.now() + 30_000;
    const requiredText = [...new Set(requiredTextByTarget.get(url) ?? [])]
      .map(normalizedText).filter(Boolean);
    let bodyText = "";
    let previous = "";
    let stable = 0;
    while (Date.now() < deadline) {
      bodyText = await page.locator("body").innerText();
      const title = await page.title();
      challenged = /^(?:Validation|Just a moment(?:\.\.\.)?|Robot Check)$/iu.test(title.trim());
      const body = bodyText.trim();
      const normalizedBody = normalizedText(body);
      const requiredRendered = requiredText.every((text) => normalizedBody.includes(text));
      stable = !challenged && requiredRendered && body.length >= 100 && body === previous
        ? stable + 1 : 0;
      if (stable >= 2) break;
      previous = body;
      await page.waitForTimeout(100);
    }
    const title = (await page.title()).trim();
    const normalizedBody = normalizedText(bodyText);
    const missingRequired = requiredText.filter((text) => !normalizedBody.includes(text));
    const errorPage = /(?:this page isn.t working|currently unable to handle this request|http error [45]\d\d|error\s+[45]\d\d\b|[45]\d\d(?:\s+[-:]|\s+error)|bad gateway|service unavailable|internal server error)/iu.test(`${title}\n${bodyText.trim().slice(0, 2_000)}`);
    if (challenged || errorPage || bodyText.trim().length < 100 || missingRequired.length) {
      throw new Error(challenged ? "publisher challenge did not clear" :
        errorPage ? `publisher error page (${title || "untitled"})` :
        missingRequired.length ?
          `required passage did not render (${missingRequired.length}/${requiredText.length})` :
          "page body stayed empty");
    }
    const frozen = await page.evaluate(() => {
      const properties = ["display", "visibility", "content-visibility", "white-space"];
      const elements = [...document.querySelectorAll("*")];
      const values = elements.map((element) => {
        const style = getComputedStyle(element);
        return properties.map((property) => style.getPropertyValue(property));
      });
      const before = document.body?.innerText ?? "";
      for (let index = 0; index < elements.length; index += 1) {
        for (let property = 0; property < properties.length; property += 1) {
          elements[index].style.setProperty(properties[property], values[index][property], "important");
        }
      }
      return { before, after: document.body?.innerText ?? "", elements: elements.length };
    });
    if (frozen.before !== frozen.after) throw new Error("computed-style freeze changed rendered text");
    bodyText = frozen.before;
    html = await page.content();
    const key = crypto.createHash("sha1").update(fetchUrl).digest("hex");
    const file = `${key}.html`;
    fs.writeFileSync(path.join(cacheDir, file), html);
    fs.writeFileSync(path.join(browserTextDir, `${key}.txt`), bodyText);
    manifest.write(`${JSON.stringify({ url: fetchUrl, file, bytes: html.length, contentType: "text/html", httpStatus, challenged, frozenElements: frozen.elements })}\n`);
    return { ok: true, bytes: html.length, httpStatus, challenged, frozenElements: frozen.elements };
  } catch (error) {
    manifest.write(`${JSON.stringify({ url, file: null, error: String(error).slice(0, 80) })}\n`);
    return { ok: false, error: String(error).slice(0, 80) };
  }
}

// Parallel across hosts under the stealth profile, per-host starts spaced by
// HOST_MIN_INTERVAL_MS. The earlier wall was triggered by a NON-stealth
// parallel pass; test how far stealth parallelism gets us.
const WORKERS = Number(process.env.CRAWL_WORKERS ?? 8);
const HOST_MIN_INTERVAL_MS = Number(process.env.CRAWL_HOST_INTERVAL_MS ?? 600);
  const workerPages = [];
  for (let i = 0; i < WORKERS; i += 1) {
    workerPages.push(i === 0 ? pages : await context.newPage());
  }
  const busy = new Array(WORKERS).fill(false);
  const hostLastStart = new Map();
  const queue = [...pending];
  let started = 0;
  let completed = 0;
  while (queue.length && !stopping) {
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
    let task;
    task = crawl(workerPages[workerIndex], url).then((result) => {
      busy[workerIndex] = false;
      completed += 1;
      if (completed % 25 === 0 || !result.ok || result.challenged) {
        console.log(JSON.stringify({ event: "progress", completed, of: started, url: url.slice(0, 80), ...result }));
      }
    }).finally(() => inflight.delete(task));
    inflight.add(task);
  }
  while (completed < started && !stopping) await sleep(100);
  if (!stopping) console.log(JSON.stringify({ event: "crawl-done", cached: completed }));
} catch (error) {
  if (!signalExitCode) throw error;
} finally {
  let cleanupError = null;
  try {
    await stopBrowser();
  } catch (error) {
    cleanupError = error;
  }
  await Promise.allSettled(inflight);
  if (!manifest.destroyed && !manifest.closed) {
    try {
      await new Promise((resolve, reject) => {
        manifest.once("error", reject);
        manifest.end(resolve);
      });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  if (cleanupError) throw cleanupError;
}
if (signalExitCode && !process.exitCode) process.exitCode = signalExitCode;
