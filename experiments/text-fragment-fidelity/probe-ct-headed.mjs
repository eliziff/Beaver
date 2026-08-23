#!/usr/bin/env node
// HEADED Chrome verification: what does a real user's browser render on
// decisions.ct-tc.gc.ca item/464120 under (a) Beaver's exact deep-link params
// and (b) plain desktop? Screenshots are the evidence; innerText is the check.
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464120/index.do";
const SHOTS = "results";

async function inspect(browser, name, url) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-CA",
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    // give JS/network idle-ish time to settle without depending on events
    await page.waitForTimeout(12_000);
    const info = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return {
        finalUrl: location.href,
        title: document.title,
        textLength: text.length,
        symbolSubmits: text.includes("Symbol submits"),
        grantedLeave: text.includes("granted Leave"),
        parAnchorCount: document.querySelectorAll('a[name^="par"], [id^="par"]').length,
        pdfLinks: [...document.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href"))
          .filter((h) => h && /document\.do|\.pdf/iu.test(h))
          .slice(0, 5),
      };
    });
    const shot = `${SHOTS}/ct-headed-${name}.png`;
    await page.screenshot({ path: shot, fullPage: false });
    console.log(JSON.stringify({ variant: name, ...info, screenshot: shot }));
  } catch (error) {
    console.log(JSON.stringify({ variant: name, error: String(error).slice(0, 200) }));
  } finally {
    await context.close();
  }
}

fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  // Fresh context per variant so the site_preference cookie cannot leak across.
  // (beaver-params already measured this session; desktop-only re-run.)
  await inspect(browser, "desktop", BASE);
} finally {
  await browser.close();
}
