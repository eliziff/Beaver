#!/usr/bin/env node
// Aggregates gate results by verdict / provider host / shape / dataset and
// lists non-clean seeds for manual screenshot review.
//
// Usage: node experiments/text-fragment-fidelity/aggregate.mjs [results.jsonl ...]
import fs from "node:fs";

const rows = [];
for (const file of process.argv.slice(2)) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.label) rows.push(row);
    } catch {}
  }
}
const host = (row) => {
  try { return new URL(row.target).hostname.replace(/^www\./, ""); } catch { return "?"; }
};
const tally = (key) => {
  const map = new Map();
  for (const row of rows) {
    const value = typeof key === "function" ? key(row) : row[key] ?? "?";
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
};
const clean = rows.filter((row) => row.verdict === "matched").length;
const gateable = rows.filter((row) => row.verdict !== "no-link").length;
console.log(JSON.stringify({
  total: rows.length,
  gateable,
  matched: clean,
  matchRate: gateable ? Number((clean / gateable).toFixed(4)) : null,
  verdicts: tally("verdict"),
  byHost: tally(host),
  byShape: tally("shape"),
  byDataset: tally("dataset"),
}, null, 1));
const flagged = rows.filter((row) => !["matched", "provider-blocked", "no-link"].includes(row.verdict));
console.log(`---- ${flagged.length} flagged (read shots/<label>.png):`);
for (const row of flagged) {
  console.log(JSON.stringify({
    label: row.label,
    dataset: row.dataset,
    shape: row.shape,
    verdict: row.verdict,
    host: host(row),
    pixels: row.highlightPixels,
    scrollY: row.scrollY,
    err: row.error ? String(row.error).slice(0, 90) : undefined,
  }));
}
