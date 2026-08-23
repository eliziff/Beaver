#!/usr/bin/env node
// Expand each candidate into one row per text directive for independent replay.
import fs from "node:fs";
import path from "node:path";

const results = path.join(import.meta.dirname, "results");
const source = process.argv[2] ?? path.join(results, "targets.jsonl");
const subset = process.argv[3];
const output = process.argv[4] ?? path.join(results, "directive-sweep-targets.jsonl");
const read = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const wanted = subset ? new Set(read(subset).map((row) => row.label)) : null;
const rows = [];
for (const seed of read(source)) {
  if (wanted && !wanted.has(seed.label)) continue;
  const [base, payload = ""] = seed.target.split(":~:");
  const directives = payload.split("&").filter((value) => value.startsWith("text="));
  directives.forEach((directive, index) => rows.push({
    ...seed,
    sourceLabel: seed.label,
    label: `${seed.label}__d${index}`,
    directiveIndex: index,
    target: `${base}:~:${directive}`,
  }));
}
fs.writeFileSync(output, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
console.log(JSON.stringify({ seeds: wanted?.size ?? "all", directives: rows.length, output }));
