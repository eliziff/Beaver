#!/usr/bin/env node
// Merge exact ChromeDriver shards and rank the remaining failure classes.
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (file) => fs.existsSync(file)
  ? fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const targets = new Map(read(path.join(results, "targets.jsonl")).map((row) => [row.label, row]));
const merged = new Map();
for (const row of read(path.join(results, "webdriver-exact-html.jsonl"))) merged.set(row.label, row);
for (const row of read(path.join(results, "webdriver-exact-pdf.jsonl"))) merged.set(row.label, row);
const stale = [...merged.values()].filter((row) => targets.get(row.label)?.target !== row.target);
const rows = [...merged.values()].filter((row) => targets.get(row.label)?.target === row.target).map((row) => {
  const seed = targets.get(row.label) ?? {};
  let host = "?";
  try { host = new URL(seed.target).hostname.replace(/^www\./u, ""); } catch {}
  return { ...row, dataset: seed.dataset, shape: seed.shape, host };
});
const tally = (items, key) => Object.fromEntries([...items.reduce((map, row) => {
  const value = typeof key === "function" ? key(row) : row[key] ?? "?";
  map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1]));
const failures = rows.filter((row) => row.verdict !== "exact-match");
const report = {
  seeds: targets.size,
  verified: rows.length,
  stale: stale.length,
  verdicts: tally(rows, "verdict"),
  failuresByHost: tally(failures, "host"),
  failuresByDataset: tally(failures, "dataset"),
  failuresByShape: tally(failures, "shape"),
};
fs.writeFileSync(path.join(results, "exact-scorecard.json"), `${JSON.stringify(report, null, 1)}\n`);
fs.writeFileSync(path.join(results, "exact-failures.jsonl"), `${failures.map((row) => JSON.stringify(row)).join("\n")}\n`);
console.log(JSON.stringify(report, null, 1));
