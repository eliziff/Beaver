#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const { preferredPublisherPdfTarget, shouldUseA2AJWebFallback } = await import(pathToFileURL(path.join(
  here,
  "../../backend/src/lib/legalSourceLinks.ts",
)).href);

const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const expected = new Set(read(process.argv[2] ?? "a2aj-document-routed-targets-v23.jsonl")
  .map((row) => row.label));
const optimizedProof = new Map(read(process.argv[3] ?? "publisher-optimized-proof-v26.jsonl")
  .map((row) => [row.label, row]));
const oldPublisherTargets = new Map(read("a2aj-document-routed-targets-v25.jsonl")
  .map((row) => [row.label, row.publisherTarget]));
const expectedPreferred = new Set([...optimizedProof]
  .filter(([label, proof]) => proof.target !== oldPublisherTargets.get(label))
  .map(([label]) => label));
const actual = new Set();
const actualPreferred = new Set();
const preferredTargetMismatches = [];

for (const row of read("publisher-plan-candidates.jsonl")) {
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
    row.blockText ?? "",
  );
  const preferred = preferredPublisherPdfTarget(
    row.providerClass === "a2aj-legislation" ? "laws" : "cases",
    row.target,
    row,
    document.text,
    row.blockText ?? "",
  );
  if (preferred) {
    actualPreferred.add(row.label);
    if (preferred !== optimizedProof.get(row.label)?.target) {
      preferredTargetMismatches.push(row.label);
    }
  } else if (route) actual.add(row.label);
}

const missing = [...expected].filter((label) => !actual.has(label));
const extra = [...actual].filter((label) => !expected.has(label));
const missingPreferred = [...expectedPreferred]
  .filter((label) => !actualPreferred.has(label));
const extraPreferred = [...actualPreferred]
  .filter((label) => !expectedPreferred.has(label));
console.log(JSON.stringify({ expected: expected.size, actual: actual.size, missing, extra,
  expectedPreferred: expectedPreferred.size, actualPreferred: actualPreferred.size,
  missingPreferred, extraPreferred, preferredTargetMismatches }));
if (missing.length || extra.length || missingPreferred.length || extraPreferred.length ||
    preferredTargetMismatches.length) process.exitCode = 1;
