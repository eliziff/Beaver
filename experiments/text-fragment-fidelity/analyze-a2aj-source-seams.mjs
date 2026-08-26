#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const verdicts = (name) => new Map(read(name).map((row) => [row.label, row.verdict]));
const base = verdicts("webdriver-exact-final-a2aj-document-v2.jsonl");
const split = verdicts("webdriver-exact-fast-a2aj-document-v4.jsonl");
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));

for (const row of read("a2aj-document-fallback-targets-v4.jsonl")) {
  const baseExact = base.get(row.label) === "exact-match";
  const splitExact = split.get(row.label) === "exact-match";
  if (baseExact === splitExact) continue;
  const text = documents.get(seedDocumentKey(row))?.text ?? "";
  const intervals = row.sourceWordIntervals;
  const gaps = [];
  for (let index = 1; index < intervals.length; index += 1) {
    const left = intervals[index - 1];
    const right = intervals[index];
    if (left.quoteIndex !== right.quoteIndex) continue;
    gaps.push({
      gap: text.slice(left.end, right.start),
      context: text.slice(Math.max(0, left.end - 50), Math.min(text.length, right.start + 70)),
    });
  }
  console.log(JSON.stringify({
    class: splitExact ? "gain" : "regression",
    label: row.label,
    gaps,
  }));
}
