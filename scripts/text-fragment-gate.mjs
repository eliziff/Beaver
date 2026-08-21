#!/usr/bin/env node
// Text-fragment landing gate.
//
// Opens each supplied URL in real Chrome, lets any #.:~:text= fragment
// navigate, then records the resulting scroll position and a full-page
// screenshot so a human (or vision-capable reviewer) can see exactly where
// the page landed.
//
// Usage:
//   node scripts/text-fragment-gate.mjs --url "<url>" [--url ...] [--out dir]
//
// Writes one JSON line per case plus <out>/<label>.png. Exit code is
// non-zero when any case stays at scrollY 0.

import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const urls = [];
let outDir = "text-fragment-shots";
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--url") urls.push(argv[++index]);
  else if (argv[index] === "--out") outDir = argv[++index];
  else throw new Error(`unknown argument ${argv[index]}`);
}
if (!urls.length) {
  console.error("no URLs given");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
let failures = 0;
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    // Decisia and CanLII reject the HeadlessChrome user agent outright;
    // a plain Chrome string gets the same rendering users see.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    deviceScaleFactor: 1,
  });
  for (const [index, url] of urls.entries()) {
    const label = `case-${index + 1}`;
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(2_000);
      const scrollY = await page.evaluate(() => Math.round(window.scrollY));
      const shot = path.resolve(outDir, `${label}.png`);
      await page.screenshot({ path: shot });
      console.log(
        JSON.stringify({ label, scrollY, shot, directive: decodeURIComponent(url.split("#:~:text=")[1] ?? "") }),
      );
      if (scrollY === 0) failures += 1;
    } catch (error) {
      console.log(JSON.stringify({ label, error: String(error?.message ?? error) }));
      failures += 1;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
