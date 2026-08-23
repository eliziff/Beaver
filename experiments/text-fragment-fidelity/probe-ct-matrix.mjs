#!/usr/bin/env node
// Which Decisia param combination makes decisions.ct-tc.gc.ca serve the
// decision body? Live Chrome, one URL, four variants.
import { chromium } from "playwright-core";

const BASE = "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/464120/index.do";
const VARIANTS = [
  ["desktop", ""],
  ["iframe-only", "?iframe=true"],
  ["mobile-only", "?site_preference=mobile"],
  ["both", "?iframe=true&site_preference=mobile"],
];

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 480, height: 900 } });
  const page = await context.newPage();
  for (const [name, qs] of VARIANTS) {
    try {
      await page.goto(BASE + qs, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(6_000);
      const html = await page.content();
      console.log(JSON.stringify({
        variant: name,
        bytes: html.length,
        symbolSubmits: html.includes("Symbol submits"),
        grantedLeave: html.includes("granted Leave"),
        parAnchor: /name=["']?par\d+/i.test(html),
      }));
    } catch (error) {
      console.log(JSON.stringify({ variant: name, error: String(error).slice(0, 120) }));
    }
  }
} finally {
  await browser.close();
}
