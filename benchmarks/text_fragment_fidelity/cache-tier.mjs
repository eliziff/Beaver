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
//   --provider-cache <dir with page-html-manifest.jsonl and page-html/>  (any host, keyed by its whole address:
//     experiments/text-fragment-fidelity/results, as crawl-pages.mjs stores publisher pages)
//   --law-web <a2aj-law-web checkout> --law-web-texts <jsonl of {citation, dataset, name, date, url, text}>:
//     A2AJ Law Web's reader (github.com/a2aj-ca/a2aj-law-web, a static page that asks api.a2aj.ca/fetch for a
//     document's text and renders it) at law.a2aj.ca, its /fetch answered from the given texts, so a Law Web link
//     opens on the page Law Web itself draws. With --law-web-server <port>, a real local server answers both names
//     instead (experiments/text-fragment-fidelity/law-web-server.mjs), Chrome resolving them to it.
// Pages are served at their own address. --workers N opens N pages at once (Law Web pages one at a time, after the
// rest); --resume keeps the rows already in <out>/cache-tier.jsonl; --no-shots keeps no screenshots; --fast judges
// paint only. A row that is no test of its link says why in `excluded`: "bad page" (the saved page is an error page) or
// "no target" (the seed's block is not in its source document, and nothing was painted).

import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const PAINT = [255, 0, 255];

function argValues(name) {
  const argv = process.argv.slice(2);
  return argv.flatMap((value, index) => (argv[index - 1] === name ? [value] : []));
}

// A publisher page's identity: its address without the fragment, its query sorted (crawl-pages.mjs keys).
function providerKey(url) {
  try {
    const parsed = new URL(url);
    const query = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    return `${parsed.origin}${parsed.pathname}?${query.map(([name, value]) => `${name}=${value}`).join("&")}`;
  } catch {
    return url.split("#")[0];
  }
}

function loadPageStores() {
  const pages = new Map();
  const canliiKey = (url) => url.split(/[?#]/u)[0].replace(/^https?:\/\/(www\.)?canlii\.org/u, "");
  const key = (url) => /^https?:\/\/(www\.)?canlii\.org\//u.test(url) ? canliiKey(url) : providerKey(url);
  const localData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const pinpointer = path.join(localData, "OpenLegalData", "pinpointer-corpus");
  const index = path.join(pinpointer, "index.jsonl");
  // A stored "page" that is not the site's HTML (some imports are markdown) is not that page.
  const html = (file) => {
    const handle = fs.openSync(file, "r");
    const head = Buffer.alloc(4096);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    fs.closeSync(handle);
    return /<html|<!doctype html/iu.test(head.subarray(0, read).toString("utf8"));
  };
  if (fs.existsSync(index)) {
    for (const line of fs.readFileSync(index, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const file = path.join(pinpointer, row.dir, "raw.html");
      if (row.provider === "canlii" && !pages.has(key(row.url)) && fs.existsSync(file) && html(file)) {
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
  for (const dir of argValues("--provider-cache")) {
    for (const line of fs.readFileSync(path.join(dir, "page-html-manifest.jsonl"), "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      const file = row.file && path.join(dir, "page-html", row.file);
      if (!file || row.challenged || pages.has(key(row.url)) || !fs.existsSync(file)) continue;
      const pdf = /pdf/iu.test(row.contentType ?? "") || /\.pdf$/iu.test(row.file);
      pages.set(key(row.url), { file, store: "provider", pdf });
    }
  }
  return { pages, key, lawWeb: loadLawWeb(pages, key) };
}

// A2AJ Law Web reproduced from its own source: the reader's files, and its API's /fetch answered from local texts.
function loadLawWeb(pages, key) {
  const [root] = argValues("--law-web");
  const [textsPath] = argValues("--law-web-texts");
  if (!root || !textsPath) return null;
  const texts = new Map();
  for (const line of fs.readFileSync(textsPath, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const docType = /^(?:LEGISLATION|REGULATIONS)-/u.test(row.dataset) ? "laws" : "cases";
    const id = `${docType}|${row.citation}`;
    if (texts.has(id)) continue;
    texts.set(id, row);
    const page = new URL("https://law.a2aj.ca/document");
    page.searchParams.set("citation", row.citation);
    page.searchParams.set("doc_type", docType);
    if (!pages.has(key(page.href))) pages.set(key(page.href), { store: "law-web" });
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
  // --law-web-server <port>: law.a2aj.ca and api.a2aj.ca answered by a real local server (law-web-server.mjs) that
  // Chrome reaches under those names, instead of from inside the browser.
  const served = argValues("--law-web-server").length > 0;
  return (request) => {
    const url = new URL(request.url());
    if (served) return /^(law|api)\.a2aj\.ca$/u.test(url.hostname) ? "served" : null;
    if (url.hostname === "law.a2aj.ca") {
      const file = path.join(root, url.pathname === "/document" ? "document.html" : url.pathname.slice(1));
      return fs.existsSync(file) && fs.statSync(file).isFile()
        ? { status: 200, contentType: types[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) }
        : { status: 404, body: "" };
    }
    if (url.hostname !== "api.a2aj.ca" || url.pathname !== "/fetch") return null;
    const docType = url.searchParams.get("doc_type") === "laws" ? "laws" : "cases";
    const row = texts.get(`${docType}|${url.searchParams.get("citation")}`);
    const start = Number(url.searchParams.get("start_char") ?? 0);
    const end = url.searchParams.has("end_char") ? Number(url.searchParams.get("end_char")) : undefined;
    const results = row ? [{ citation_en: row.citation, name_en: row.name ?? null, dataset: row.dataset,
      document_date_en: row.date ?? null, url_en: row.url ?? null, upstream_license: "",
      unofficial_text_en: row.text.slice(start, end) }] : [];
    return { status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ results }) };
  };
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

// The screenshot's pixels: an 8-bit RGB or RGBA PNG (Chrome's), inflated and unfiltered here, so no page draws it.
function pngPixels(png) {
  let at = 8, width = 0, height = 0, channels = 0;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      if (png[at + 16] !== 8 || png[at + 20] !== 0) throw new Error("unsupported PNG");
      channels = { 2: 3, 6: 4 }[png[at + 17]];
      if (!channels) throw new Error("unsupported PNG colour type");
    } else if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels, pixels = Buffer.alloc(height * stride);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)], line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[row * stride + x - channels] : 0;
      const up = row ? pixels[(row - 1) * stride + x] : 0;
      const corner = row && x >= channels ? pixels[(row - 1) * stride + x - channels] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1
        : filter === 4 ? (() => {
          const estimate = left + up - corner;
          const [a, b, c] = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - corner)];
          return a <= b && a <= c ? left : b <= c ? up : corner;
        })() : 0;
      pixels[row * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

// Whether a pixel is the paint ::target-text is given here.
const isPaint = (pixels, at) => Math.abs(pixels[at] - PAINT[0]) < 8 && pixels[at + 1] < 8 &&
  Math.abs(pixels[at + 2] - PAINT[2]) < 8;

// Runs in the page: each word in the viewport and its box, in document order.
function viewportWords() {
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (node) =>
    node.parentElement?.closest("script, style, noscript") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement?.getBoundingClientRect();
    if (!parent || parent.bottom < 0 || parent.top > window.innerHeight) continue;
    for (const match of node.textContent.matchAll(/\S+/gu)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      const box = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0);
      if (box && box.bottom > 0 && box.top < window.innerHeight) {
        words.push({ word: match[0], left: box.left, top: box.top, right: box.right, bottom: box.bottom });
      }
    }
  }
  return words;
}

// The words the paint covers: a word is painted where most of its box's pixels are paint (the text over it is not).
function paintedWords(png, words) {
  const { width, height, channels, pixels } = pngPixels(png);
  return words.filter(({ left, top, right, bottom }) => {
    let paint = 0, total = 0;
    for (let y = Math.max(0, Math.ceil(top)); y < Math.min(height, Math.floor(bottom)); y += 1) {
      for (let x = Math.max(0, Math.ceil(left)); x < Math.min(width, Math.floor(right)); x += 1) {
        total += 1;
        if (isPaint(pixels, (y * width + x) * channels)) paint += 1;
      }
    }
    return total > 0 && paint / total >= 0.4;
  }).map(({ word }) => word);
}

function paintedPixels(png) {
  const { width, height, channels, pixels } = pngPixels(png);
  let count = 0;
  let top = null;
  let bottom = null;
  const rows = new Map();
  for (let row = 0; row < height; row += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (row * width + x) * channels;
      if (isPaint(pixels, at)) {
        count += 1;
        top ??= row;
        bottom = row;
        rows.set(row, (rows.get(row) ?? 0) + 1);
      }
    }
  }
  return { count, top, bottom, rows: [...rows] };
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
  // The viewport's text, read only when a seed names words to look for (it measures every text node's box).
  const viewText = [];
  const walker = words ? document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT) : null;
  for (let node = walker?.nextNode(); node; node = walker.nextNode()) {
    const box = node.parentElement?.getBoundingClientRect();
    if (node.textContent.trim() && box && box.bottom > 0 && box.top < height) viewText.push(node.textContent);
  }
  const view = normalize(viewText.join(" "));
  const anchorElement = byName(anchor);
  const pinElement = /^(par\d+|sec[\d.]+(subsec\d+)?)$/u.test(pinpoint ?? "") ? byName(pinpoint) : null;
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
    heading: document.querySelector("h1")?.textContent.replace(/\s+/gu, " ").trim().slice(0, 120) ?? "",
  };
}

// A saved page that is a site's error page (a cached 404), told by its short title or heading: an HTTP error status
// with "error" or "not found", or a bare "not found" ("404 Error | CanLII", "Error 404 - File not found"; of 6,433
// stored pages, 42 match and all are error pages).
const ERROR_PAGE = /\b[45]\d\d\b[^|]*\b(?:error|not found|forbidden|unavailable)\b|\b(?:error|not found)\b[^|]*\b[45]\d\d\b|^\s*(?:(?:page|file|document)\s+)?not\s+found\b/iu;

// Runs in the page: where the intended words sit (viewport coordinates), found by their own text inside the cited
// block: the block they are quoted from (`within`, found on the page by its own words), kept to the paragraph or section
// the pinpoint's anchor opens where the page has one (a source block may run into later paragraphs). Of several
// occurrences there, the one whose neighbouring words are the source's (`contexts`), else the whole block. Words not in
// the block are found on the whole page: nearest the anchor, else at the occurrence the source holds them at (`ordinal`
// of `occurrences` there); else the anchor's passage. Several texts (a link painting several quotations) give the box
// around all.
function targetBox({ pinpoint, texts, within, ordinal, occurrences, passageText, contexts }) {
  const tokenize = (value) => [...value.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)];
  const words = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (node) =>
    node.parentElement?.closest("script, style, noscript") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    for (const match of tokenize(node.textContent)) words.push({ node, start: match.index, end: match.index + match[0].length, word: match[0] });
  const anchor = /^(par\d+|sec[\d.]+(subsec\d+)?)$/u.test(pinpoint ?? "")
    ? document.getElementById(pinpoint) ?? document.querySelector(`a[name="${CSS.escape(pinpoint)}"]`) : null;
  // A passage whose page has no anchor for it (older CanLII pages print most paragraph numbers as text) is its words.
  if (!anchor && !texts.length && passageText) texts = [passageText];
  const box = (range) => {
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    return rects.length ? { top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)) } : null;
  };
  const at = (from, sequence) => sequence.every((word, offset) => words[from + offset]?.word === word);
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  const toRange = ([start, end]) => {
    const range = document.createRange();
    range.setStart(words[start].node, words[start].start);
    range.setEnd(words[end].node, words[end].end);
    return range;
  };
  // Each place a text's words run on the page, from its first six words to its last six, within words [from, to];
  // a leading number (a printed label a page may set apart) read only where `labelled`.
  const spansOf = (text, from = 0, to = words.length - 1, labelled = false) => {
    const wanted = tokenize(text ?? "").map((match) => match[0]);
    while (!labelled && wanted.length > 3 && /^\d+$/u.test(wanted[0])) wanted.shift();
    const headLength = Math.min(6, wanted.length), tailLength = Math.min(6, wanted.length);
    const spans = [];
    if (!headLength) return spans;
    for (let start = from; start <= to; start += 1) {
      if (!at(start, wanted.slice(0, headLength))) continue;
      for (let end = start + headLength - 1; end <= Math.min(to, start + wanted.length * 2 + 20); end += 1)
        if (at(end - tailLength + 1, wanted.slice(-tailLength)) && end - tailLength + 1 >= start) { spans.push([start, end]); break; }
    }
    return spans;
  };
  // The anchor's passage: from it to the next paragraph or section anchor that is not one of its own subsections.
  const name = (element) => element.getAttribute("name") ?? element.id;
  let passageRange = null;
  if (anchor) {
    const markers = [...document.querySelectorAll('a[name^="par"], a[name^="sec"], [id^="sec"]')]
      .filter((element) => /^(par|sec)[\d.]+/u.test(name(element)));
    const next = markers.slice(markers.indexOf(anchor) + 1)
      .find((element) => !(name(element).startsWith(pinpoint) && /^[a-z]/u.test(name(element).slice(pinpoint.length))));
    passageRange = document.createRange();
    passageRange.setStartBefore(anchor);
    if (next) passageRange.setEndBefore(next);
    else passageRange.setEndAfter(document.body.lastChild);
  }
  // Its words, first to last.
  const inPassage = passageRange ? words.flatMap((word, index) =>
    passageRange.isPointInRange(word.node, word.start) ? [index] : []) : [];
  const scope = inPassage.length ? [inPassage[0], inPassage.at(-1)] : null;
  // The block the texts are quoted from, where the page holds it once: with its own number where the page prints it
  // there (a headnote may repeat the block's words), else without; kept to the anchor's passage.
  const labelledBlocks = within ? spansOf(within, 0, words.length - 1, true) : [];
  const blocks = labelledBlocks.length ? labelledBlocks : within ? spansOf(within) : [];
  let block = blocks.length === 1 ? blocks[0] : null;
  if (scope) block = block && block[0] <= scope[1] && block[1] >= scope[0]
    ? [Math.max(block[0], scope[0]), Math.min(block[1], scope[1])] : scope;
  // Of several occurrences, the one whose neighbouring words agree with the source's most, where only one does.
  const byContext = (spans, context) => {
    if (!context || spans.length < 2) return null;
    const before = tokenize(context.before ?? "").map((match) => match[0]).reverse();
    const after = tokenize(context.after ?? "").map((match) => match[0]);
    const agree = ([start, end]) => {
      let count = 0;
      while (count < before.length && words[start - 1 - count]?.word === before[count]) count += 1;
      let following = 0;
      while (following < after.length && words[end + 1 + following]?.word === after[following]) following += 1;
      return count + following;
    };
    const scored = spans.map((span) => [span, agree(span)]).sort((a, b) => b[1] - a[1]);
    return scored[0][1] >= 2 && scored[0][1] > scored[1][1] ? scored[0][0] : null;
  };
  const found = [];
  let count = 0, ambiguous = false;
  for (const [index, text] of texts.entries()) {
    const inBlock = block ? spansOf(text, block[0], block[1]) : [];
    if (inBlock.length > 1) {
      // The block holds the words more than once: the source's occurrence, else (the quotation names none of them) the
      // block is the target.
      const whole = box(toRange(byContext(inBlock, contexts?.[index]) ?? block));
      if (index === 0) count = inBlock.length;
      if (whole) { found.push(whole); continue; }
    }
    const spans = inBlock.length === 1 ? inBlock : spansOf(text);
    const boxes = spans.map((span) => box(toRange(span)));
    if (!boxes.some(Boolean)) continue;
    if (index === 0) count = spans.length;
    let chosen;
    if (anchorTop !== null) {
      chosen = boxes.filter(Boolean).sort((a, b) => Math.abs(a.top - anchorTop) - Math.abs(b.top - anchorTop))[0];
    } else if (boxes.length === 1) {
      chosen = boxes[0];
      ambiguous ||= inBlock.length !== 1 && count > 1;
    } else {
      // The page holds the words more often than the source, or the source repeats them: its own ordinal.
      ambiguous ||= index === 0 ? occurrences !== boxes.length : true;
      chosen = boxes[Math.min(index === 0 ? ordinal ?? 0 : 0, boxes.length - 1)];
    }
    if (chosen) found.push(chosen);
  }
  if (found.length) return { method: "text", occurrences: count, ambiguous,
    top: Math.min(...found.map(({ top }) => top)), bottom: Math.max(...found.map(({ bottom }) => bottom)) };
  if (!anchor) return null;
  const passage = box(passageRange);
  return passage ? { method: "anchor", occurrences: 0, ambiguous: false, ...passage } : null;
}

export async function runCacheTier({ seedsPath, outDir }) {
  const argv = process.argv.slice(2);
  // At most 4 pages at once, each reused: one browser, one context.
  const workers = Math.min(4, Math.max(1, Number(argValues("--workers")[0] ?? 1)));
  const keepShots = !argv.includes("--no-shots");
  // --fast: the paint verdict only (a short settle, no landed-block text, no scroll check).
  const fast = argv.includes("--fast");
  const output = path.join(outDir, "cache-tier.jsonl");
  const done = new Set(argv.includes("--resume") && fs.existsSync(output)
    ? fs.readFileSync(output, "utf8").split(/\r?\n/u).filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line))
      // A row the browser failed on (it closed or crashed) is gated again.
      .filter((row) => !row.error || /local store|pdf page/u.test(row.error)).map((row) => row.id) : []);
  if (!done.size) fs.writeFileSync(output, "");
  const seeds = fs.readFileSync(seedsPath, "utf8").split(/\r?\n/u)
    .filter((line) => line.trim() && !line.startsWith("//")).map((line) => JSON.parse(line))
    .filter((seed) => seed.tier === "cache" && !done.has(seed.id));
  const { pages, key, lawWeb } = loadPageStores();
  const [lawWebServer] = argValues("--law-web-server");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: lawWebServer
    ? [`--host-resolver-rules=MAP law.a2aj.ca 127.0.0.1:${lawWebServer},MAP api.a2aj.ca 127.0.0.1:${lawWebServer}`] : [] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: !!lawWebServer });
  // Each saved page answers its own address; every other request is refused.
  await context.route("**/*", (route) => {
    const request = route.request();
    const drawn = lawWeb?.(request);
    if (drawn === "served") return route.continue();
    if (drawn) return route.fulfill(drawn);
    const page = request.resourceType() === "document" ? pages.get(key(request.url())) : null;
    return page ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fs.readFileSync(page.file) })
      : route.abort();
  });
  await context.addInitScript((paint) => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = `::target-text { background-color: rgb(${paint.join(",")}) !important; color: #000 !important; }`;
      document.head.append(style);
    });
  }, PAINT);
  try {
    const gate = async (seed, page) => {
      const [, fragment = ""] = seed.url.split("#");
      const anchor = fragment.split(":~:")[0] || null;
      const stored = pages.get(key(seed.url));
      const record = { id: seed.id, role: seed.role, origin: seed.origin, strategy: seed.strategy,
        url: seed.url, store: stored?.store ?? null };
      if (!stored) return { ...record, error: "page not in any local store" };
      if (stored.pdf) return { ...record, error: "pdf page: the cache tier paints HTML only" };
      const started = Date.now();
      try {
        // A fresh document each time: a link differing from the last only in its fragment would otherwise be a
        // same-document navigation, which does not process text directives.
        await page.goto("about:blank");
        await page.goto(seed.url, { waitUntil: "load", timeout: 60_000 });
        // Law Web draws the document after its /fetch answers: wait for the text, then settle.
        if (stored.store === "law-web") {
          await page.waitForFunction(() => (document.getElementById("doc-text")?.textContent.length ?? 0) > 200,
            null, { timeout: 30_000 }).catch(() => {});
        }
        const t = [Date.now()];
        // A page drawn after load (Law Web) has its directives found on Chrome's later search: up to the full settle,
        // less once that search has scrolled to them (--fast).
        if (fast && stored.store === "law-web") {
          await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 1_200, polling: 100 })
            .then(() => page.waitForTimeout(200), () => {});
        } else {
          await page.waitForTimeout(fast ? 300 : 1_200);
        }
        t.push(Date.now());
        const pinpoint = seed.target?.pinpoint?.split(" ")[0];
        const facts = await page.evaluate(pageFacts, { anchor, pinpoint, words: seed.target?.words ?? null });
        const texts = seed.target?.texts ?? (seed.target?.text ? [seed.target.text] : []);
        const target = texts.length || seed.target?.pinpoint ? await page.evaluate(targetBox, { pinpoint, texts,
          within: seed.target?.within, ordinal: seed.target?.ordinal, occurrences: seed.target?.occurrences,
          passageText: seed.target?.passage, contexts: seed.target?.contexts }) : null;
        t.push(Date.now());
        // A file name Windows accepts (seed ids hold ":").
        const shot = keepShots ? path.resolve(outDir, `${seed.id.replace(/[<>:"/\\|?*]/gu, "_")}.png`) : undefined;
        const png = await page.screenshot(shot ? { path: shot } : {});
        t.push(Date.now());
        const paint = paintedPixels(png);
        t.push(Date.now());
        record.steps = t.slice(1).map((v, i) => v - t[i]);
        // The share of the paint inside the intended words' box, and of the box's visible rows painted.
        if (target && paint.count) {
          const inside = paint.rows.filter(([row]) => row >= target.top - 6 && row <= target.bottom + 6);
          record.paintInTarget = Number((inside.reduce((sum, [, n]) => sum + n, 0) / paint.count).toFixed(3));
        }
        record.target = target && { method: target.method, occurrences: target.occurrences,
          ambiguous: target.ambiguous, top: Math.round(target.top), bottom: Math.round(target.bottom) };
        record.paintBottomY = paint.bottom;
        // The painted words, read off the screenshot word by word.
        if (paint.count) record.paintedWords = paintedWords(png, await page.evaluate(viewportWords)).join(" ");
        // The text of the block the landing sits in, for judging what was highlighted.
        const landedText = fast ? "" : await page.evaluate((focus) => {
          const markers = [...document.querySelectorAll('a[name^="par"], a[name^="sec"], [id^="sec"]')]
            .filter((element) => /^(par|sec)[\d.]+/u.test(element.getAttribute("name") ?? element.id));
          const at = markers.findLastIndex((element) => element.getBoundingClientRect().top <= focus);
          if (at < 0) {
            const element = document.elementFromPoint(window.innerWidth / 2, Math.min(focus + 4, window.innerHeight - 1));
            return (element?.closest("p, li, blockquote, div") ?? element)?.textContent?.slice(0, 4000) ?? "";
          }
          const range = document.createRange();
          range.setStartBefore(markers[at]);
          if (markers[at + 1]) range.setEndBefore(markers[at + 1]);
          else range.setEndAfter(document.body.lastChild);
          return range.toString().slice(0, 8000);
        }, paint.count > 40 ? paint.top : 2);
        record.landedText = landedText.replace(/\s+/gu, " ").trim().slice(0, 2000);
        let after = facts.scrollY;
        if (!fast) {
          await page.mouse.move(640, 450);
          await page.mouse.wheel(0, 700);
          await page.waitForTimeout(500);
          after = await page.evaluate(() => Math.round(window.scrollY));
        }
        // Landing = the paragraph/section holding the painted text, else the viewport top.
        const focus = paint.count > 40 ? paint.top : 2;
        const { markers, firstBodyTop, ...rest } = facts;
        // Rows that are no test of the link: a cached error page, or a target whose block the source document lacks
        // (the link rightly paints nothing).
        if ([facts.title, facts.heading].some((text) => text.length <= 60 && ERROR_PAGE.test(text))) {
          record.excluded = "bad page";
        } else if (seed.target?.missing && paint.count <= 40) record.excluded = "no target";
        let landedAt = null;
        for (const marker of markers) if (marker.top <= focus) landedAt = marker.name;
        Object.assign(record, rest, {
          landedAt,
          frontMatter: firstBodyTop !== null && focus < firstBodyTop,
          directives: directiveWords(seed.url),
          painted: paint.count > 40,
          paintedPixels: paint.count,
          paintTopY: paint.top,
          ...!fast && { scrollAfter: after !== facts.scrollY },
          shot,
        });
      } catch (error) {
        record.error = String(error?.message ?? error).split("\n")[0];
      }
      record.ms = Date.now() - started;
      return record;
    };
    // Seeds with the same link and intended words are one load: the first is gated, the rest take its row.
    const same = new Map();
    for (const seed of seeds) {
      const key = JSON.stringify([seed.url, seed.target ?? null]);
      same.set(key, [...same.get(key) ?? [], seed]);
    }
    // Law Web's text arrives after load and Chrome finds no fragment in text that arrives late, so its pages are opened
    // one at a time after the rest (at a stated --delay-ms of law-web-server.mjs that is a latency measurement, never a
    // concurrency one); other pages --workers at a time.
    const groups = [...same.values()];
    const lawWebPage = (group) => pages.get(key(group[0].url))?.store === "law-web";
    const drain = (queue, lanes) => Promise.all(Array.from({ length: lanes }, async () => {
      let worker = await context.newPage();
      for (let group = queue.shift(); group; group = queue.shift()) {
        const record = await gate(group[0], worker);
        // A page the browser failed on (a load that timed out keeps navigating) is replaced.
        if (record.error && !/local store|pdf page/u.test(record.error)) {
          await worker.close().catch(() => {});
          worker = await context.newPage();
        }
        for (const seed of group) {
          const row = { ...record, id: seed.id, role: seed.role, origin: seed.origin, strategy: seed.strategy };
          fs.appendFileSync(output, `${JSON.stringify(row)}\n`);
        }
        console.log(JSON.stringify({ id: record.id, seeds: group.length, painted: record.painted ?? null,
          paintInTarget: record.paintInTarget ?? null, error: record.error, excluded: record.excluded }));
      }
      await worker.close().catch(() => {});
    }));
    await drain(groups.filter((group) => !lawWebPage(group)), workers);
    await drain(groups.filter(lawWebPage), 1);
  } finally {
    await context.close();
    await browser.close();
  }
}
