// Cache tier for link-strategy candidates (PLAN.md "Link strategies").
//
// Serves saved CanLII pages from local stores under their original paths,
// opens each candidate URL (anchor and/or text directive intact) in headless
// Chrome with all other traffic blocked, and records:
//   - the URL anchor: does the element exist, is it in the viewport;
//   - the text directive: did Chrome paint ::target-text in the viewport;
//   - where the viewport landed (nearest paragraph/section anchor) and
//     whether that is front matter (before the first body paragraph);
//   - whether a wheel scroll after landing still moves the page.
// This tests directive correctness against the page bytes, not live site
// behaviour (site scripts and styles do not run).
//
// Page stores (first match wins):
//   %LOCALAPPDATA%/OpenLegalData/pinpointer-corpus/index.jsonl  (default)
//   --canlii-cache <dir with index.json>  (ALR Quote Verifier cache/canlii_html layout)

import { chromium } from "playwright-core";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PAINT = [255, 0, 255];

function argValues(name) {
  const argv = process.argv.slice(2);
  return argv.flatMap((value, index) => (argv[index - 1] === name ? [value] : []));
}

function loadPageStores() {
  const pages = new Map();
  const key = (url) => url.split(/[?#]/u)[0].replace(/^https?:\/\/(www\.)?canlii\.org/u, "");
  const localData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const pinpointer = path.join(localData, "OpenLegalData", "pinpointer-corpus");
  const index = path.join(pinpointer, "index.jsonl");
  if (fs.existsSync(index)) {
    for (const line of fs.readFileSync(index, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const file = path.join(pinpointer, row.dir, "raw.html");
      if (row.provider === "canlii" && !pages.has(key(row.url)) && fs.existsSync(file)) {
        pages.set(key(row.url), { file, store: "pinpointer-corpus" });
      }
    }
  }
  for (const dir of argValues("--canlii-cache")) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    for (const [url, entry] of Object.entries(entries)) {
      const file = path.join(dir, entry.html_path.replaceAll("\\", path.sep));
      if (!pages.has(key(url)) && !/\.pdf$/u.test(key(url)) && fs.existsSync(file)) {
        pages.set(key(url), { file, store: "canlii_html" });
      }
    }
  }
  return { pages, key };
}

function serve(pages) {
  const server = http.createServer((request, response) => {
    const page = pages.get(decodeURIComponent(new URL(request.url, "http://x").pathname));
    if (!page) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(page.file).pipe(response);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function directiveWords(url) {
  const directive = url.split(":~:")[1] ?? "";
  return directive.split("&").filter((part) => part.startsWith("text=")).map((part) =>
    part.slice(5).split(",").map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    }).filter((piece) => !piece.endsWith("-") && !piece.startsWith("-")).join(" … "));
}

async function paintedPixels(helper, png) {
  return helper.evaluate(async ({ data, paint }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    let top = null;
    for (let at = 0; at < pixels.length; at += 4) {
      if (Math.abs(pixels[at] - paint[0]) < 8 && pixels[at + 1] < 8 && Math.abs(pixels[at + 2] - paint[2]) < 8) {
        count += 1;
        top ??= Math.floor(at / 4 / canvas.width);
      }
    }
    return { count, top };
  }, { data: png.toString("base64"), paint: PAINT });
}

// Runs in the page: anchor, landing and target facts.
function pageFacts({ anchor, pinpoint, words }) {
  const height = window.innerHeight;
  const byName = (name) => name ? document.getElementById(name) ??
    document.querySelector(`a[name="${CSS.escape(name)}"]`) : null;
  const rect = (element) => element ? element.getBoundingClientRect() : null;
  const inView = (box) => Boolean(box) && box.bottom > 0 && box.top < height;
  const normalize = (text) => text.normalize("NFKD").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  const markers = [...document.querySelectorAll('a[name^="par"], a[name^="sec"], [id^="sec"]')]
    .map((element) => ({ name: element.getAttribute("name") ?? element.id, top: rect(element).top }))
    .filter(({ name }) => /^(par|sec)[\d.]+/u.test(name));
  const firstBody = markers.find(({ name }) => /^par1$/u.test(name));
  const viewText = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const box = node.parentElement?.getBoundingClientRect();
    if (node.textContent.trim() && box && box.bottom > 0 && box.top < height) viewText.push(node.textContent);
  }
  const view = normalize(viewText.join(" "));
  const anchorElement = byName(anchor);
  const pinElement = /^(par|sec)[\d.]+$/u.test(pinpoint ?? "") ? byName(pinpoint) : null;
  return {
    scrollY: Math.round(window.scrollY),
    anchorExists: anchor ? Boolean(anchorElement) : null,
    anchorInView: anchor ? inView(rect(anchorElement)) : null,
    pinpointExists: pinElement ? true : /^(par|sec)/u.test(pinpoint ?? "") ? false : null,
    pinpointInView: pinElement ? inView(rect(pinElement)) : null,
    markers: markers.filter(({ top }) => top > -4 * height && top < height),
    firstBodyTop: firstBody ? Math.round(firstBody.top) : null,
    wordsInView: words ? view.includes(normalize(words)) : null,
    title: document.title.slice(0, 120),
  };
}

export async function runCacheTier({ seedsPath, outDir }) {
  const seeds = fs.readFileSync(seedsPath, "utf8").split(/\r?\n/u)
    .filter((line) => line.trim() && !line.startsWith("//")).map((line) => JSON.parse(line))
    .filter((seed) => seed.tier === "cache");
  const { pages, key } = loadPageStores();
  const server = await serve(pages);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route("**/*", (route) => {
      const request = route.request();
      return request.url().startsWith(origin) && request.resourceType() === "document"
        ? route.continue() : route.abort();
    });
    await context.addInitScript((paint) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = `::target-text { background-color: rgb(${paint.join(",")}) !important; color: #000 !important; }`;
        document.head.append(style);
      });
    }, PAINT);
    const helper = await (await browser.newContext()).newPage();
    for (const seed of seeds) {
      const page = await context.newPage();
      const pageKey = key(seed.url);
      const local = `${origin}${seed.url.replace(/^https?:\/\/(www\.)?canlii\.org/u, "")}`;
      const [, fragment = ""] = seed.url.split("#");
      const anchor = fragment.split(":~:")[0] || null;
      const record = { id: seed.id, role: seed.role, origin: seed.origin, strategy: seed.strategy,
        url: seed.url, store: pages.get(pageKey)?.store ?? null };
      try {
        if (!record.store) throw new Error("page not in any local store");
        await page.goto(local, { waitUntil: "load", timeout: 60_000 });
        await page.waitForTimeout(1_200);
        const facts = await page.evaluate(pageFacts, {
          anchor, pinpoint: seed.target?.pinpoint?.split(" ")[0], words: seed.target?.words ?? null,
        });
        const shot = path.resolve(outDir, `${seed.id}.png`);
        const png = await page.screenshot({ path: shot });
        const paint = await paintedPixels(helper, png);
        await page.mouse.move(640, 450);
        await page.mouse.wheel(0, 700);
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => Math.round(window.scrollY));
        // Landing = the paragraph/section holding the painted text, else the viewport top.
        const focus = paint.count > 40 ? paint.top : 2;
        const { markers, firstBodyTop, ...rest } = facts;
        let landedAt = null;
        for (const marker of markers) if (marker.top <= focus) landedAt = marker.name;
        Object.assign(record, rest, {
          landedAt,
          frontMatter: firstBodyTop !== null && focus < firstBodyTop,
          directives: directiveWords(seed.url),
          painted: paint.count > 40,
          paintedPixels: paint.count,
          paintTopY: paint.top,
          scrollAfter: after !== facts.scrollY,
          shot,
        });
      } catch (error) {
        record.error = String(error?.message ?? error).split("\n")[0];
      } finally {
        await page.close();
      }
      results.push(record);
      console.log(JSON.stringify(record));
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(outDir, "cache-tier.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
