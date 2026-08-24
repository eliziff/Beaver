#!/usr/bin/env node
// Prove that every target base URL has a usable immutable cache artifact.
import fs from "node:fs";
import path from "node:path";
import { decodeEntities, htmlToText } from "./gap-lib.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const cacheDir = path.join(results, "page-html");
const browserTextDir = path.join(results, "browser-rendered-text");
const targetsPath = process.argv[2] ?? path.join(results, "targets.jsonl");
const read = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
function key(raw) {
  const url = new URL(raw);
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.origin}${url.pathname}?${params.map(([name, value]) => `${name}=${value}`).join("&")}`.toLowerCase();
}
const manifest = new Map();
for (const row of read(path.join(results, "page-html-manifest.jsonl"))) {
  if (!row.url || !row.file) continue;
  manifest.set(key(row.url), row);
}
const missing = [];
const invalid = [];
const used = new Map();
const textCache = new Map();
const errorPage = /(?:^|\n)\s*(?:this page isn.t working|\S+ is currently unable to handle this request|http error [45]\d\d|error\s+[45]\d\d|[45]\d\d(?:\s+[-:]|\s+error)|bad gateway|service unavailable|internal server error|access denied|validation|just a moment)/iu;
for (const seed of read(targetsPath)) {
  if (!seed.target) {
    missing.push({ label: seed.label, reason: "no-target" });
    continue;
  }
  const base = seed.target.split("#")[0];
  const row = manifest.get(key(base));
  if (!row?.file) {
    missing.push({ label: seed.label, url: base, reason: row?.error ?? "no-manifest-entry" });
    continue;
  }
  const file = path.join(cacheDir, row.file);
  if (!fs.existsSync(file) || fs.statSync(file).size < 500) {
    invalid.push({ label: seed.label, url: base, file: row.file, reason: "missing-or-tiny" });
    continue;
  }
  if (row.challenged) {
    invalid.push({ label: seed.label, url: base, file: row.file, reason: "challenge-page" });
    continue;
  }
  if (row.httpStatus != null && (row.httpStatus < 200 || row.httpStatus >= 400)) {
    invalid.push({ label: seed.label, url: base, file: row.file, reason: `http-${row.httpStatus}` });
    continue;
  }
  if (!row.file.toLowerCase().endsWith(".pdf")) {
    let pageText = textCache.get(row.file);
    if (pageText === undefined) {
      const rendered = path.join(browserTextDir, `${path.parse(row.file).name}.txt`);
      pageText = decodeEntities(fs.existsSync(rendered)
        ? fs.readFileSync(rendered, "utf8")
        : htmlToText(fs.readFileSync(file, "utf8"), true)).trim();
      textCache.set(row.file, pageText);
    }
    if (pageText.length < 100 || errorPage.test(pageText.slice(0, 2_000))) {
      invalid.push({ label: seed.label, url: base, file: row.file, reason: "empty-or-error-page" });
      continue;
    }
  }
  used.set(key(base), row.file);
}
const report = { seeds: read(targetsPath).length, cachedPages: used.size, missing, invalid };
fs.writeFileSync(path.join(results, "cache-audit.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ seeds: report.seeds, cachedPages: used.size, missing: missing.length, invalid: invalid.length }));
if (missing.length || invalid.length) process.exitCode = 1;
