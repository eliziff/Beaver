import { chromium } from "playwright-core";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto("https://www.bccourts.ca/jdb-txt/CA/12/04/2012BCCA0480.htm", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(1500);
  const html = await page.content();
  const at = html.indexOf("s. 1&nbsp;");
  console.log("s.1 found at:", at);
  if (at >= 0) {
    const slice = html.slice(at - 450, at + 60);
    // Show whitespace explicitly: NBSP as ␣, newline as ¶
    console.log(JSON.stringify(slice
      .replace(/\u00A0/gu, "\u2423")
      .replace(/\r/gu, "")
      .replace(/\n/gu, "\u00B6")
      .replace(/\t/gu, "\u21E5")));
  }
} finally {
  await browser.close();
}
