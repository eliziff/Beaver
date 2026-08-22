import { chromium } from "playwright-core";
const url = process.argv[2];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    title: document.title.slice(0, 80),
    textStart: (document.body?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 200),
  }));
  console.log(JSON.stringify(state));
} finally {
  await browser.close();
}
