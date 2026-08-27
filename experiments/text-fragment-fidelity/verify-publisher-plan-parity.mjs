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
const { structureNative } = await import(pathToFileURL(path.join(
  here,
  "../../backend/src/lib/structureNative.ts",
)).href);
const { buildLegalSourcePinpoint } = await import(pathToFileURL(path.join(
  here,
  "../../backend/src/lib/legalSourceLinks.ts",
)).href);
const structure = structureNative();
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const nativeDocuments = new Map();

const comparable = (plan) => ({
  directives: plan.directives,
  sourceWordIntervals: plan.sourceWordIntervals,
  sourceSafeComplete: plan.sourceSafeComplete,
  paintedWords: plan.paintedWords,
  paintQuotes: plan.paintQuotes,
});

const targets = read("targets.jsonl");
const mismatches = [];
const candidates = [];
let processed = 0;
for (const row of targets) {
  const key = seedDocumentKey(row);
  const document = documents.get(key);
  if (!document) throw new Error(`missing document: ${row.label}`);
  let native = nativeDocuments.get(key);
  if (!native) {
    native = await structure.deriveDocumentStructure({ kind: "a2aj", input: {
      citation: document.citation,
      source_kind: row.providerClass === "a2aj-legislation" ? "laws" : "cases",
      text: document.text,
      dataset: document.dataset,
      url: row.url,
    } });
    nativeDocuments.set(key, native);
  }
  const base = row.target.split(":~:", 1)[0];
  const built = buildLegalSourcePinpoint({
    url: base,
    docType: row.providerClass === "a2aj-legislation" ? "laws" : "cases",
    blockText: row.blockText ?? "",
    documentText: native,
  }, row.quotes ?? [], row.providerClass === "a2aj-legislation");
  if (!built?.plan) throw new Error(`unbuildable target: ${row.label}`);
  const actual = comparable(built.plan);
  const expected = comparable(row);
  candidates.push({
    ...row,
    ...actual,
    target: built.target,
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    mismatches.push({ label: row.label, expected, actual });
  }
  processed += 1;
  if (processed % 250 === 0) {
    console.error(JSON.stringify({ progress: processed, of: targets.length,
      mismatches: mismatches.length }));
  }
}

fs.writeFileSync(path.join(results, "publisher-plan-candidates.jsonl"),
  `${candidates.map(JSON.stringify).join("\n")}\n`);

const receipt = {
  rows: targets.length,
  documents: nativeDocuments.size,
  matching: targets.length - mismatches.length,
  mismatches,
};
fs.writeFileSync(path.join(results, "publisher-plan-parity.json"),
  `${JSON.stringify(receipt)}\n`);
console.log(JSON.stringify({ ...receipt, mismatches: mismatches.slice(0, 10) }));
if (mismatches.length) process.exitCode = 1;
