#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { cacheDir, decodeEntities, manifest, normalizeKey, resultsDir } from "./gap-lib.mjs";

const seeds = fs.readFileSync(path.join(resultsDir, "seeds.jsonl"), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const urls = [...new Set(seeds.map((seed) => seed.url).filter((url) =>
  /^https:\/\/decisia\.lexum\.com\/nsc\//iu.test(url)))];
const missingCache = [];
const noDocumentLink = [];
const alternateShape = [];
const byDataset = {};
let exactFormula = 0;
let pdfOnly = 0;

for (const raw of urls) {
  const page = new URL(raw);
  page.searchParams.set("iframe", "true");
  page.searchParams.set("site_preference", "mobile");
  const row = manifest.get(normalizeKey(page.toString()));
  const file = row?.file && path.join(cacheDir, row.file);
  if (!file || !fs.existsSync(file)) { missingCache.push(raw); continue; }
  const html = fs.readFileSync(file, "utf8");
  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/giu)]
    .map((match) => match[1] ?? match[2])
    .filter((href) => /\/document\.do(?:$|[?#])/iu.test(href))
    .map((href) => new URL(decodeEntities(href), page).toString());
  const expected = new URL(raw);
  expected.pathname = expected.pathname.replace(/\/item\/(\d+)\/index\.do$/iu, "/$1/1/document.do");
  expected.search = "";
  expected.hash = "";
  const dataset = new URL(raw).pathname.split("/")[2]?.toUpperCase() ?? "?";
  const bucket = byDataset[dataset] ??= { pages: 0, links: 0, exact: 0, pdfOnly: 0 };
  bucket.pages += 1;
  if (links.length) bucket.links += 1;
  else noDocumentLink.push(raw);
  if (links.includes(expected.toString())) { exactFormula += 1; bucket.exact += 1; }
  else if (links.length) alternateShape.push({ raw, expected: expected.toString(), links });
  if (/\bdecisia-decision-pdf-only\b/iu.test(html)) { pdfOnly += 1; bucket.pdfOnly += 1; }
}

console.log(JSON.stringify({ pages: urls.length, exactFormula, pdfOnly, missingCache, noDocumentLink, alternateShape, byDataset }, null, 2));
