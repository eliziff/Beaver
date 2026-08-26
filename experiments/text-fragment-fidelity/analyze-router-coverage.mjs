#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const results = path.join(import.meta.dirname, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const proof = new Map(read("webdriver-exact-final-publisher-current.jsonl")
  .map((row) => [row.label, row.verdict]));
for (const row of read("webdriver-exact-final-publisher-current-errors.jsonl")) {
  proof.set(row.label, row.verdict);
}
const groups = new Map();
for (const row of read("targets.jsonl")) {
  if (row.label === "FCA_2026_FC_103_p20_short-exact") continue;
  const host = new URL(row.target ?? row.url).hostname.toLowerCase();
  const group = groups.get(host) ?? { host, total: 0, residual: 0 };
  group.total += 1;
  group.residual += proof.get(row.label) === "exact-match" ? 0 : 1;
  groups.set(host, group);
}
console.log(JSON.stringify([...groups.values()]
  .filter((row) => row.residual)
  .sort((a, b) => b.residual - a.residual || a.host.localeCompare(b.host)), null, 2));
