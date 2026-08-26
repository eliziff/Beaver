#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.existsSync(path.join(results, name))
  ? fs.readFileSync(path.join(results, name), "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse)
  : [];
const byLabel = (name) => new Map(read(name).map((row) => [row.label, row]));
const verdicts = (name) => new Map(read(name).map((row) => [row.label, row.verdict]));
const basePlans = byLabel("a2aj-document-fallback-targets-v2.jsonl");
const splitPlans = byLabel("a2aj-document-fallback-targets-v4.jsonl");
const rangePlans = byLabel("a2aj-document-fallback-targets-v5.jsonl");
const baseProof = verdicts("webdriver-exact-final-a2aj-document-v2.jsonl");
const splitProof = verdicts("webdriver-exact-fast-a2aj-document-v4.jsonl");
const rangeProof = verdicts("webdriver-exact-fast-a2aj-document-v5.jsonl");
const proofRows = {
  base: byLabel("webdriver-exact-final-a2aj-document-v2.jsonl"),
  split: byLabel("webdriver-exact-fast-a2aj-document-v4.jsonl"),
  range: byLabel("webdriver-exact-fast-a2aj-document-v5.jsonl"),
};
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const misses = [];
const selections = new Map();
const chosenTargets = [];
const chosenProof = [];

for (const [label, row] of basePlans) {
  const text = documents.get(seedDocumentKey(row))?.text ?? "";
  const spans = new Map();
  for (const interval of row.sourceWordIntervals) {
    const span = spans.get(interval.quoteIndex) ?? { start: interval.start, end: interval.end };
    span.start = Math.min(span.start, interval.start);
    span.end = Math.max(span.end, interval.end);
    spans.set(interval.quoteIndex, span);
  }
  const slices = [...spans.values()].map((span) => text.slice(span.start, span.end));
  const letteredBreaks = slices.reduce((count, slice) =>
    count + [...slice.matchAll(/\r?\n\([a-z]\)/gu)].length, 0);
  const periodParagraphs = slices.reduce((count, slice) =>
    count + [...slice.matchAll(/\.\r?\n(?=[A-Z])/gu)].length, 0);
  let mode = "range";
  if (!rangePlans.has(label) || letteredBreaks >= 2) mode = "base";
  else if (periodParagraphs === 1 && splitPlans.has(label)) mode = "split";
  selections.set(mode, (selections.get(mode) ?? 0) + 1);
  const verdict = mode === "base" ? baseProof.get(label)
    : mode === "split" ? splitProof.get(label)
      : rangeProof.get(label);
  const target = mode === "base" ? basePlans.get(label)
    : mode === "split" ? splitPlans.get(label)
      : rangePlans.get(label);
  chosenTargets.push({ ...target, hybridMode: mode, letteredBreaks, periodParagraphs });
  chosenProof.push({ ...proofRows[mode].get(label), hybridMode: mode });
  if (verdict !== "exact-match") {
    misses.push({ label, mode, verdict, letteredBreaks, periodParagraphs });
  }
}

fs.writeFileSync(path.join(results, "a2aj-document-hybrid-targets.jsonl"),
  `${chosenTargets.map(JSON.stringify).join("\n")}\n`);
fs.writeFileSync(path.join(results, "webdriver-exact-a2aj-document-hybrid.jsonl"),
  `${chosenProof.map(JSON.stringify).join("\n")}\n`);

console.log(JSON.stringify({ selections: Object.fromEntries(selections), exact: basePlans.size - misses.length,
  total: basePlans.size, misses }, null, 2));
