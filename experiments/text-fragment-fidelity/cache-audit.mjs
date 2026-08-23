#!/usr/bin/env node
// Prove that every target base URL has a usable immutable cache artifact.
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const cacheDir = path.join(results, "page-html");
const read = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
function key(raw) {
  const url = new URL(raw);
  if (/(^|\.)bclaws\.gov\.bc\.ca$/iu.test(url.hostname) && url.pathname.endsWith("/xml")) {
    url.pathname = url.pathname.slice(0, -4);
  }
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  return `${url.origin}${url.pathname}?${params.map(([name, value]) => `${name}=${value}`).join("&")}`.toLowerCase();
}
const manifest = new Map();
for (const row of read(path.join(results, "page-html-manifest.jsonl"))) {
  if (!row.url) continue;
  manifest.set(key(row.url), row);
}
const missing = [];
const invalid = [];
const used = new Map();
for (const seed of read(path.join(results, "targets.jsonl"))) {
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
  used.set(key(base), row.file);
}
const report = { seeds: read(path.join(results, "targets.jsonl")).length, cachedPages: used.size, missing, invalid };
fs.writeFileSync(path.join(results, "cache-audit.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ seeds: report.seeds, cachedPages: used.size, missing: missing.length, invalid: invalid.length }));
if (missing.length || invalid.length) process.exitCode = 1;
