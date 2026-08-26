#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const { shouldUseA2AJWebFallback } = await import(pathToFileURL(path.join(
  results,
  "worktrees/root-seam/backend/src/lib/legalSourceLinks.ts",
)).href);

const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const expected = new Set(read("a2aj-document-routed-targets-v22.jsonl")
  .map((row) => row.label));
const actual = new Set();

for (const row of read("targets.jsonl")) {
  if (row.label === "FCA_2026_FC_103_p20_short-exact") continue;
  const document = documents.get(seedDocumentKey(row));
  if (!document) throw new Error(`missing document: ${row.label}`);
  const route = shouldUseA2AJWebFallback(
    row.providerClass === "a2aj-legislation" ? "laws" : "cases",
    row.target,
    {
      directives: row.directives,
      sourceWordIntervals: row.sourceWordIntervals,
      sourceSafeComplete: row.sourceSafeComplete,
      paintedWords: row.paintedWords,
      paintQuotes: row.paintQuotes,
    },
    document.text,
  );
  if (route) actual.add(row.label);
}

const missing = [...expected].filter((label) => !actual.has(label));
const extra = [...actual].filter((label) => !expected.has(label));
console.log(JSON.stringify({ expected: expected.size, actual: actual.size, missing, extra }));
if (missing.length || extra.length) process.exitCode = 1;
