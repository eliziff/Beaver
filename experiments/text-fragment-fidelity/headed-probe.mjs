// Decisive test: does HEADED stealth Chrome clear Decisia's Validation wall?
import { chromium } from "playwright-core";
import path from "node:path";

const stealthUserDataDir = path.join(process.env.TEMP ?? "/tmp", `stealth-probe-${Date.now()}`);
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
try {
  const page = context.pages()[0] ?? (await context.newPage());
  const url = "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/18909/index.do?iframe=true&site_preference=mobile";
  await page.goto(url, { waitUntil: "load", timeout: 40_000 });
  await page.waitForTimeout(4_000);
  const html = await page.content();
  const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  console.log(JSON.stringify({
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu) ?? [])[1]?.slice(0, 60),
    bytes: html.length,
    textLen: text.length,
    hasDecisionText: /divorce act/iu.test(text),
    challenged: /<title>\s*Validation\s*<\/title>/iu.test(html),
  }));
} finally {
  await context.close();
}
