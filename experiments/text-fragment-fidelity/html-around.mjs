import { chromium } from "playwright-core";

const target = process.argv[2];
const needle = process.argv[3] ?? "The Chambers";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(target.split("#")[0], { waitUntil: "domcontentloaded", timeout: 40_000 });
  await page.waitForTimeout(1_500);
  const html = await page.content();
  const at = html.indexOf(needle);
  console.log("found at:", at);
  if (at >= 0) {
    const slice = html.slice(Math.max(0, at - 700), at + 200);
    // Compress whitespace for readability but keep tag boundaries visible.
    console.log(slice.replace(/[ \t]+/gu, " "));
  }
} finally {
  await browser.close();
}
