#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const outputName = process.argv[2] ?? "a2aj-document-routed-targets.jsonl";
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const publisherProof = new Map(read("webdriver-exact-final-publisher-current.jsonl")
  .map((row) => [row.label, row.verdict]));
for (const row of read("webdriver-exact-final-publisher-current-errors.jsonl")) {
  publisherProof.set(row.label, row.verdict);
}
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const { buildA2AJWebPinpointUrl } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/a2ajWebLinks.ts"),
).href);
const { structureNative } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/structureNative.ts"),
).href);
const structure = structureNative();
const nativeDocuments = new Map();
const normalize = (value) => String(value).normalize("NFKC").toLocaleLowerCase("en")
  .replace(/\s+/gu, " ").trim();
const occurrences = (haystack, needle) => {
  if (!needle) return 0;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
};
const uniqueCaseFamily = (row, host) =>
  row.shape === "long-range" && new Set([
    "decisia.lexum.com", "decisions.sst-tss.gc.ca", "decision.tcc-cci.gc.ca",
  ]).has(host)
  || new Set(["hard-act-name", "hard-section-word"]).has(row.shape)
    && new Set(["decisia.lexum.com", "refugeelab.ca"]).has(host)
  || row.shape === "hard-section-word" && host === "www.oic-ci.gc.ca"
  || row.shape === "hard-statute-ref"
    && new Set(["www.bccourts.ca", "decisions.scc-csc.ca"]).has(host)
  || row.shape === "hard-act-name" && host === "decisions.scc-csc.ca"
  || row.shape === "short-exact" && host === "decisia.lexum.com";

const rows = [];
for (const row of read("targets.jsonl")) {
  if (row.label === "FCA_2026_FC_103_p20_short-exact") continue;
  const documentKey = seedDocumentKey(row);
  const document = documents.get(documentKey);
  if (!document?.citation) throw new Error(`missing document: ${row.label}`);
  const targetEnd = Math.max(0, ...row.sourceWordIntervals.map((span) => span.end));
  const normalizedDocument = normalize(document.text);
  const counts = row.paintQuotes.map((quote) => occurrences(normalizedDocument, normalize(quote)));
  const occurrenceClass = counts.some((count) => count === 0) ? "missing"
    : counts.some((count) => count > 1) ? "repeated" : "unique";
  const legislation = row.providerClass === "a2aj-legislation";
  const host = new URL(row.target ?? row.url).hostname.toLowerCase();
  const route = targetEnd <= 200_001 && (legislation
    || row.providerClass === "a2aj-case" && occurrenceClass === "repeated"
    || row.providerClass === "a2aj-case" && occurrenceClass === "unique"
      && uniqueCaseFamily(row, host));
  if (!route) continue;
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
    targetEnd,
    occurrenceClass,
    publisherHost: host,
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
