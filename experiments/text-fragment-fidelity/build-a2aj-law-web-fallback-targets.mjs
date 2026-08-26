#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const publisherProofName = process.argv[2] ?? "webdriver-exact-final-publisher-current.jsonl";
const outputName = process.argv[3] ?? "a2aj-document-fallback-targets.jsonl";
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const proven404 = "FCA_2026_FC_103_p20_short-exact";
const publisherProof = new Map(read(publisherProofName).map((row) => [row.label, row]));
const documents = new Map(read("doctext.jsonl").map((row) => [row.key, row]));
const targets = read("targets.jsonl");
const { buildA2AJWebPinpointUrl } = await import(pathToFileURL(
  path.join(here, "../../backend/src/lib/a2ajWebLinks.ts"),
).href);

const citationCounts = new Map();
for (const document of documents.values()) {
  const docType = /^(?:LEGISLATION|REGULATIONS)-/u.test(document.dataset) ? "laws" : "cases";
  const key = `${docType}\0${document.citation}`;
  citationCounts.set(key, (citationCounts.get(key) ?? 0) + 1);
}

const rows = [];
for (const row of targets) {
  if (row.label === proven404 || publisherProof.get(row.label)?.verdict === "exact-match") continue;
  const document = documents.get(seedDocumentKey(row));
  if (!document?.citation) throw new Error(`missing document citation for ${row.label}`);
  const docType = /^(?:LEGISLATION|REGULATIONS)-/u.test(document.dataset) ? "laws" : "cases";
  const target = buildA2AJWebPinpointUrl({ citation: document.citation, docType }, row);
  if (!target) throw new Error(`fallback builder rejected ${row.label}`);
  const targetEnd = Math.max(0, ...(row.sourceWordIntervals ?? []).map((span) => span.end));
  rows.push({
    ...row,
    citation: document.citation,
    docType,
    publisherTarget: row.target,
    publisherVerdict: publisherProof.get(row.label)?.verdict ?? "missing-proof",
    target,
    fallback: "a2aj-document",
    targetEnd,
    withinInitialChunk: targetEnd <= 200_001,
    citationMatches: citationCounts.get(`${docType}\0${document.citation}`),
  });
}

const output = path.join(results, outputName);
fs.writeFileSync(output, `${rows.map(JSON.stringify).join("\n")}\n`);
console.log(JSON.stringify({
  publisherProof: publisherProofName,
  publisherProofSha256: digest(path.join(results, publisherProofName)),
  targets: rows.length,
  beyondInitialChunk: rows.filter((row) => !row.withinInitialChunk).length,
  ambiguousCitations: rows.filter((row) => row.citationMatches !== 1).length,
  output,
}));
