#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const proofPath = path.join(
  results,
  "webdriver-exact-final-routed-lawweb-v22-cache.jsonl",
);
const targetsPath = path.join(results, "a2aj-document-routed-targets-v23.jsonl");
const outputPath = path.join(results, "lawweb-citation-cache-manifest.jsonl");
const targets = new Map(fs.readFileSync(targetsPath, "utf8").split(/\r?\n/u)
  .filter(Boolean).map(JSON.parse).map((row) => [row.label, row]));
const rows = fs.readFileSync(proofPath, "utf8").split(/\r?\n/u)
  .filter(Boolean).map(JSON.parse).filter(({ verdict, label }) =>
    verdict === "cache-miss" && targets.has(label));
const pages = new Map();

for (const row of rows) {
  const seed = targets.get(row.label);
  const url = new URL(seed.target);
  url.hash = "";
  if (url.protocol !== "https:" || url.hostname !== "law.a2aj.ca" ||
      url.pathname !== "/document") {
    throw new Error(`unexpected Law Web target: ${row.label}`);
  }
  const keys = [...new Set(url.searchParams.keys())].sort();
  if (keys.join(",") !== "citation,doc_type" || !url.searchParams.get("citation") ||
      !["cases", "laws"].includes(url.searchParams.get("doc_type"))) {
    throw new Error(`unsafe Law Web query: ${row.label}`);
  }
  const target = url.toString();
  const page = pages.get(target) ?? { target, labels: [], requiredPaintQuotes: new Set() };
  page.labels.push(row.label);
  for (const quote of seed.paintQuotes) page.requiredPaintQuotes.add(quote);
  pages.set(target, page);
}

const output = [...pages.values()].sort((a, b) => a.target.localeCompare(b.target))
  .map((page, index) => ({
    label: `lawweb-citation-cache-${String(index + 1).padStart(4, "0")}`,
    url: page.target,
    target: page.target,
    seedCount: page.labels.length,
    requiredPaintQuotes: [...page.requiredPaintQuotes],
  }));
const body = `${output.map(JSON.stringify).join("\n")}\n`;
fs.writeFileSync(outputPath, body);
console.log(JSON.stringify({
  output: path.basename(outputPath),
  seedCacheMisses: rows.length,
  citationOnlyPages: output.length,
  fragmentBearingUrls: output.filter(({ target }) => target.includes("#")).length,
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
}));
