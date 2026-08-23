#!/usr/bin/env node
// HEADED Chrome: do MODERN ct-tc decisions render inline text under Beaver's
// params? Item 521808 = CT_2026_Comp_Trib_19 ("Symbol submits" era sibling).
import { chromium } from "playwright-core";

const URL_2026 =
  "https://decisions.ct-tc.gc.ca/ct-tc/cdo/en/item/521808/index.do?iframe=true&site_preference=mobile";

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--disable-blink-features=AutomationControlled"],
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-CA" });
  const page = await context.newPage();
  await page.goto(URL_2026, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(12_000);
  const info = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : "";
    return {
      finalUrl: location.href,
      title: document.title.slice(0, 90),
      textLength: text.length,
      parAnchorCount: document.querySelectorAll('a[name^="par"], [id^="par"]').length,
      pdfLinks: [...document.querySelectorAll("a[href]")]
        .map((a) => a.getAttribute("href"))
        .filter((h) => h && /document\.do|\.pdf/iu.test(h))
        .slice(0, 4),
    };
  });
  await page.screenshot({ path: "results/ct-headed-2026.png", fullPage: false });
  console.log(JSON.stringify(info));
} finally {
  await browser.close();
}
