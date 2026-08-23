// Does Chrome process :~:text= fragments on SAME-DOCUMENT hash navigation
// (location.hash assignment on an already-loaded page)? If yes, the replay
// gate can load each document once and re-point fragments without re-parsing.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsDir = path.join(here, "results");
const manifestPath = path.join(resultsDir, "page-html-manifest.jsonl");
const manifest = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const bccourts = manifest.find((r) => /bccourts\.ca/.test(r.url));
console.log("using page:", bccourts.url);

function isHighlightPixel(r, g, b) {
  return r >= 205 && g >= 175 && r - g >= 12 && b - g >= 18 && b >= 228 && r <= 255 && b <= 255;
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 480, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  });
  await context.route("**", async (route) => {
    if (route.request().resourceType() === "document" && route.request().url().startsWith(bccourts.url)) {
      await route.fulfill({ contentType: "text/html", body: fs.readFileSync(path.join(resultsDir, "page-html", bccourts.file)) });
    } else {
      await route.abort();
    }
  });
  const page = await context.newPage();
  await page.goto(bccourts.url, { waitUntil: "domcontentloaded", timeout: 30000 });

  const fragment = "#par63:~:text=respondents%20cross%20appeal%20on%20the%20ground%20that%3A,The%20Chambers";
  await page.evaluate((frag) => { location.hash = frag; }, fragment);
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    hash: location.hash.slice(0, 60),
  }));
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 600 } });
  const b64 = shot.toString("base64");
  const highlight = await page.evaluate(async ({ b64, source }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isHighlight = new Function(`return ${source}`)();
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (isHighlight(data[i], data[i + 1], data[i + 2])) pixels += 1;
    }
    return pixels;
  }, { b64, source: isHighlightPixel.toString() });
  console.log(JSON.stringify({ ...state, highlightPixels: highlight }));

  // Cleanup check: clearing the hash should clear the highlight.
  await page.evaluate(() => { location.hash = ""; });
  await page.waitForTimeout(300);
  const shot2 = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 600 } });
  const b642 = shot2.toString("base64");
  const highlight2 = await page.evaluate(async ({ b64, source }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const isHighlight = new Function(`return ${source}`)();
    let pixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (isHighlight(data[i], data[i + 1], data[i + 2])) pixels += 1;
    }
    return pixels;
  }, { b64: b642, source: isHighlightPixel.toString() });
  console.log(JSON.stringify({ afterClearPixels: highlight2 }));
} finally {
  await browser.close();
}
