#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const outputName = process.argv[2] ?? "a2aj-document-routed-targets.jsonl";
const targetsName = process.argv[3] ?? "targets.jsonl";
const proofName = process.argv[4] ?? "webdriver-exact-final-publisher-current.jsonl";
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const publisherProof = new Map(read(proofName)
  .map((row) => [row.label, row.verdict]));
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const { buildA2AJWebPinpointUrl } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/a2ajWebLinks.ts"),
).href);
const { structureNative } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/structureNative.ts"),
).href);
const { shouldUseA2AJWebFallback } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/legalSourceLinks.ts"),
).href);
const structure = structureNative();
const nativeDocuments = new Map();
const rows = [];
const targets = read(targetsName);
let processed = 0;
for (const row of targets) {
  processed += 1;
  if (processed % 100 === 0) {
    console.error(JSON.stringify({ progress: processed, of: targets.length, selected: rows.length }));
  }
  if (row.label === "FCA_2026_FC_103_p20_short-exact") continue;
  const documentKey = seedDocumentKey(row);
  const document = documents.get(documentKey);
  if (!document?.citation) throw new Error(`missing document: ${row.label}`);
  const legislation = row.providerClass === "a2aj-legislation";
  if (!shouldUseA2AJWebFallback(
    legislation ? "laws" : "cases", row.target, row, document.text,
  )) continue;
  let native = nativeDocuments.get(documentKey);
  if (!native) {
    const docType = legislation ? "laws" : "cases";
    native = await structure.deriveDocumentStructure({ kind: "a2aj", input: {
      citation: document.citation,
      source_kind: docType,
      text: document.text,
      dataset: document.dataset,
      url: row.url,
    } });
    nativeDocuments.set(documentKey, native);
  }
  const plan = structure.textFragmentPlan(
    row.blockText ?? "", row.quotes ?? [], false, false, true, native,
  );
  const docType = legislation ? "laws" : "cases";
  const target = buildA2AJWebPinpointUrl({ citation: document.citation, docType }, plan);
  if (!target) throw new Error(`unbuildable routed target: ${row.label}`);
  rows.push({
    ...row,
    publisherDirectives: row.directives,
    publisherPaintQuotes: row.paintQuotes,
    ...plan,
    citation: document.citation,
    docType,
    publisherTarget: row.target,
    publisherVerdict: publisherProof.get(row.label),
    target,
    fallback: "a2aj-document",
    publisherHost: new URL(row.target ?? row.url).hostname.toLowerCase(),
  });
}

fs.writeFileSync(path.join(results, outputName), `${rows.map(JSON.stringify).join("\n")}\n`);
console.log(JSON.stringify({
  output: outputName,
  selected: rows.length,
  publisherResiduals: rows.filter((row) => row.publisherVerdict !== "exact-match").length,
  publisherExactSwitchovers: rows.filter((row) => row.publisherVerdict === "exact-match").length,
  documents: nativeDocuments.size,
}));
