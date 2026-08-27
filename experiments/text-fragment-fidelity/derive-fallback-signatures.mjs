#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

const here = import.meta.dirname;
const results = path.join(here, "results");
const [publisherProofName, lawWebTargetsName, lawWebProofName,
  outputName = "fallback-signature-analysis.json"] = process.argv.slice(2);

if (!publisherProofName || !lawWebTargetsName || !lawWebProofName) {
  console.error("usage: node derive-fallback-signatures.mjs " +
    "<headed-publisher-proof.jsonl> <lawweb-targets.jsonl> " +
    "<headed-lawweb-proof.jsonl> [output.json]");
  process.exit(2);
}

const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const digest = (name) => crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(results, name))).digest("hex");
const byLabel = (rows, name) => {
  const indexed = new Map();
  for (const row of rows) {
    if (indexed.has(row.label)) throw new Error(`duplicate ${name}: ${row.label}`);
    indexed.set(row.label, row);
  }
  return indexed;
};
const groupByLabel = (rows) => {
  const grouped = new Map();
  for (const row of rows) {
    const values = grouped.get(row.label) ?? [];
    values.push(row);
    grouped.set(row.label, values);
  }
  return grouped;
};

const candidates = read("publisher-plan-candidates.jsonl");
const publisherProof = byLabel(read(publisherProofName), "publisher proof");
const lawWebTargets = byLabel(read(lawWebTargetsName), "LawWeb target");
const lawWebProofs = groupByLabel(read(lawWebProofName));
const documentKey = (dataset, key) => `${dataset}\0${key}`;
const documents = new Map();
for (const row of read("doctext.jsonl")) {
  const key = documentKey(row.dataset, row.key);
  const prior = documents.get(key);
  if (prior && prior.text !== row.text) throw new Error(`conflicting document: ${key}`);
  documents.set(key, row);
}
const proven404 = "FCA_2026_FC_103_p20_short-exact";

const fold = (value) => value.normalize("NFKD").toLocaleLowerCase("en")
  .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
const occurrences = (documentText, value) => {
  const needle = fold(value);
  if (!needle) return 0;
  const haystack = ` ${documentText} `;
  const wanted = ` ${needle} `;
  let count = 0;
  for (let at = haystack.indexOf(wanted); at >= 0;
    at = haystack.indexOf(wanted, at + 1)) count += 1;
  return count;
};
const occurrenceClass = (documentText, value) => {
  const count = occurrences(documentText, value);
  return count === 0 ? "0" : count === 1 ? "1" : "M";
};
const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

function urlFamily(url) {
  const host = url.hostname.toLocaleLowerCase("en");
  const segments = url.pathname.toLocaleLowerCase("en").split("/").filter(Boolean);
  if (host === "decisia.lexum.com") return segments[0] ?? "";
  if (host === "www.bccourts.ca") return segments.slice(0, 2).join("/");
  if (host === "kings-printer.alberta.ca") {
    return url.searchParams.get("leg_type")?.toLocaleLowerCase("en") ?? "";
  }
  if (host === "laws-lois.justice.gc.ca" || host === "web2.gov.mb.ca" ||
      host === "www.ontario.ca") return segments.slice(0, 2).join("/");
  if (host === "laws.gnb.ca" || host === "www.legisquebec.gouv.qc.ca") {
    return segments.slice(0, 3).join("/");
  }
  if (host === "www.princeedwardisland.ca") {
    return segments[3] === "legislation" ? "legislation" : "asset";
  }
  if (host === "laws.yukon.ca") return segments[3] ?? "";
  if (host === "www.justice.gov.nt.ca") {
    return /\.a\.pdf$/iu.test(url.pathname) ? "act"
      : /\.r\d*\.pdf$/iu.test(url.pathname) ? "reg" : "pdf";
  }
  return "";
}

function signature(row, documentText) {
  const url = new URL(row.target);
  const targetEnd = Math.max(0, ...row.sourceWordIntervals.map(({ end }) => end));
  const directiveParts = row.directives.map((directive) =>
    directive.slice("text=".length).split(","));
  const intervalsPerQuote = new Map();
  for (const interval of row.sourceWordIntervals) {
    intervalsPerQuote.set(
      interval.quoteIndex,
      (intervalsPerQuote.get(interval.quoteIndex) ?? 0) + 1,
    );
  }
  return [
    row.providerClass === "a2aj-legislation" ? "law" : "case",
    url.hostname.toLocaleLowerCase("en"),
    urlFamily(url),
    directiveParts.map((parts) => parts.length).join("/"),
    row.sourceWordIntervals.length,
    [...intervalsPerQuote.values()].join("/"),
    row.sourceSafeComplete ? "safe" : "partial",
    targetEnd <= 100 ? "opening" : targetEnd <= 1_000 ? "early" : "body",
    row.paintQuotes.map((quote) => occurrenceClass(documentText, quote)).join("/"),
    directiveParts.map((parts) => parts.filter(Boolean)
      .map((part) => occurrenceClass(documentText, decode(part))).join("")).join("/"),
  ].join("|");
}

const sameTarget = (proof, target) => proof?.target === target?.target &&
  proof?.headed === true && proof?.sourceContract?.accepted === true;
const exactLawWebProof = (label) => {
  const target = lawWebTargets.get(label);
  return target && (lawWebProofs.get(label) ?? []).some((proof) =>
    proof.verdict === "exact-match" && sameTarget(proof, target));
};

const rows = [];
const foldedDocuments = new Map();
const missingPublisherProof = [];
const stalePublisherProof = [];
for (const candidate of candidates) {
  if (candidate.label === proven404) continue;
  const proof = publisherProof.get(candidate.label);
  if (!proof) {
    missingPublisherProof.push(candidate.label);
    continue;
  }
  if (!sameTarget(proof, candidate)) {
    stalePublisherProof.push(candidate.label);
  }
}
if (missingPublisherProof.length || stalePublisherProof.length) {
  throw new Error(JSON.stringify({ missingPublisherProof, stalePublisherProof }));
}

let processed = 0;
for (const candidate of candidates) {
  if (candidate.label === proven404) continue;
  const proof = publisherProof.get(candidate.label);
  const key = documentKey(
    candidate.dataset,
    seedDocumentKey(candidate),
  );
  const document = documents.get(key);
  if (!document) throw new Error(`missing document: ${candidate.label}`);
  let documentText = foldedDocuments.get(key);
  if (documentText === undefined) {
    documentText = fold(document.text);
    foldedDocuments.set(key, documentText);
  }
  const targetEnd = Math.max(0,
    ...candidate.sourceWordIntervals.map(({ end }) => end));
  rows.push({
    label: candidate.label,
    signature: signature(candidate, documentText),
    publisherExact: proof.verdict === "exact-match",
    lawWebExact: exactLawWebProof(candidate.label),
    oversized: targetEnd > 200_001,
  });
  processed += 1;
  if (processed % 250 === 0) {
    console.error(JSON.stringify({ progress: processed, of: candidates.length - 1 }));
  }
}

const eligible = rows.filter((row) => !row.oversized);
const recoverableResiduals = eligible.filter((row) =>
  !row.publisherExact && row.lawWebExact);
const requiredResiduals = eligible.filter((row) => !row.publisherExact);
const signatures = new Set(requiredResiduals.map((row) => row.signature));
const selected = eligible.filter((row) => signatures.has(row.signature));
const uncovered = recoverableResiduals.filter((row) =>
  !signatures.has(row.signature));
const unprovedSelected = selected.filter((row) => !row.lawWebExact);
const unrecoverableResiduals = eligible.filter((row) =>
  !row.publisherExact && !row.lawWebExact);
const oversized = rows.filter((row) => row.oversized);
const signatureRows = [...signatures].sort().map((value) => {
  const members = selected.filter((row) => row.signature === value);
  return {
    signature: value,
    rows: members.length,
    recoverableResiduals: members.filter((row) => !row.publisherExact && row.lawWebExact).length,
    publisherExactSwitchovers: members.filter((row) => row.publisherExact).length,
    unprovedLawWeb: members.filter((row) => !row.lawWebExact).length,
    labels: members.map((row) => row.label),
  };
});

const receipt = {
  contract: "categorical-no-oracle-fallback-signatures-v1",
  inputs: Object.fromEntries([
    "publisher-plan-candidates.jsonl", publisherProofName,
    lawWebTargetsName, lawWebProofName, "doctext.jsonl",
  ].map((name) => [name, digest(name)])),
  signatureFields: [
    "docType", "publisherHost", "staticUrlFamily", "directivePartTopology",
    "sourceIntervalCount", "intervalsPerQuote", "sourceSafeComplete",
    "sourcePositionClass",
    "paintQuoteOccurrenceClasses",
    "directivePartOccurrenceClasses",
  ],
  rows: rows.length,
  publisherExact: rows.filter((row) => row.publisherExact).length,
  publisherResiduals: rows.filter((row) => !row.publisherExact).length,
  recoverableResiduals: recoverableResiduals.length,
  requiredResiduals: requiredResiduals.length,
  selectedSignatures: signatureRows.length,
  selectedRows: selected.length,
  publisherExactSwitchovers: selected.filter((row) => row.publisherExact).length,
  recoverableResidualCoverage: recoverableResiduals.length === 0 ? 1
    : (recoverableResiduals.length - uncovered.length) / recoverableResiduals.length,
  publisherExactFalsePositiveRate: selected.length === 0 ? 0
    : selected.filter((row) => row.publisherExact).length / selected.length,
  uncoveredRecoverableResiduals: uncovered.map((row) => row.label),
  unprovedSelectedRows: unprovedSelected.map((row) => row.label),
  unrecoverableResiduals: unrecoverableResiduals.map((row) => row.label),
  oversizedExcluded: oversized.map((row) => row.label),
  promotionReady: requiredResiduals.every((row) => signatures.has(row.signature)) &&
    unprovedSelected.length === 0,
  signatures: signatureRows,
};

fs.writeFileSync(path.join(results, outputName), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, signatures: undefined }));
if (!receipt.promotionReady) process.exitCode = 1;
