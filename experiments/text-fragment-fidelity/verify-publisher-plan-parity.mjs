#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const { structureNative } = await import(pathToFileURL(path.join(
  results,
  "worktrees/root-seam/backend/src/lib/structureNative.ts",
)).href);
const structure = structureNative();
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const nativeDocuments = new Map();

const pdfTarget = (raw) => {
  const url = new URL(raw);
  const pathName = url.pathname.toLocaleLowerCase("en");
  const href = url.href.toLocaleLowerCase("en");
  return pathName.endsWith(".pdf") || pathName.endsWith("/document.do") ||
    url.searchParams.get("rendition")?.toLocaleLowerCase("en") === "pdf" ||
    href.includes("laws.yukon.ca/cms/images/legislation/") ||
    href.includes("justice.gov.nt.ca/en/files/legislation/") ||
    href.includes("princeedwardisland.ca/sites/default/files/legislation/") ||
    /publications\.saskatchewan\.ca\/api\/v1\/products\/[^/]+\/formats\//u.test(href);
};
const comparable = (plan) => ({
  directives: plan.directives,
  sourceWordIntervals: plan.sourceWordIntervals,
  sourceSafeComplete: plan.sourceSafeComplete,
  paintedWords: plan.paintedWords,
  paintQuotes: plan.paintQuotes,
});

const targets = read("targets.jsonl");
const mismatches = [];
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
  const actual = comparable(structure.textFragmentPlan(
    row.blockText ?? "",
    row.quotes ?? [],
    pdfTarget(row.target),
    new URL(row.target).hostname === "www.bclaws.gov.bc.ca",
    false,
    native,
  ));
  const expected = comparable(row);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    mismatches.push({ label: row.label, expected, actual });
  }
  processed += 1;
  if (processed % 250 === 0) {
    console.error(JSON.stringify({ progress: processed, of: targets.length,
      mismatches: mismatches.length }));
  }
}

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
