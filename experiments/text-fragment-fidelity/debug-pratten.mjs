import { chromium } from "playwright-core";

const target = "https://www.bccourts.ca/jdb-txt/CA/12/04/2012BCCA0480.htm";
const needle = "of rights and freedoms: s. 1 the";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForTimeout(1200);
  const body = await page.content();
  const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/iu) ?? [])[1] ?? "";
  const text = body
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(\d+);/gu, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, "\"")
    .replace(/[\u00A0\u202F\u2007\u2009]/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .toLowerCase();
  console.log(JSON.stringify({
    title: title.slice(0, 60),
    textLength: text.length,
    needle,
    found: text.includes(needle),
    firstChars: text.slice(0, 120),
    aroundFreedoms: (() => {
      const at = text.indexOf("rights and freedoms");
      return at >= 0 ? text.slice(at, at + 90) : null;
    })(),
    aroundGuarantees: (() => {
      const at = text.indexOf("guarantees the rights");
      return at >= 0 ? text.slice(Math.max(0, at - 140), at + 60) : null;
    })(),
  }));
} finally {
  await browser.close();
}
