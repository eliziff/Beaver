#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

const results = path.join(import.meta.dirname, "results");
const read = (name) => fs.readFileSync(path.join(results, name), "utf8")
  .split(/\r?\n/u).filter(Boolean).map(JSON.parse);
const write = (name, rows) => fs.writeFileSync(path.join(results, name),
  `${rows.map(JSON.stringify).join("\n")}\n`);
const routed = new Set(read("a2aj-document-routed-targets-v25.jsonl")
  .map(({ label }) => label));
const residuals = read("publisher-plan-candidates.jsonl")
  .filter(({ label }) => routed.has(label));
const pdf = residuals.filter(({ target }) => new URL(target).pathname.endsWith(".pdf"));
const html = residuals.filter(({ target }) => !new URL(target).pathname.endsWith(".pdf"));

const anchorless = (target) => {
  const [base, fragment = ""] = target.split("#", 2);
  const directive = fragment.split(":~:", 2)[1];
  return directive ? `${base}#:~:${directive}` : target;
};
const withParams = (target, params) => {
  const url = new URL(target);
  for (const [name, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  return url.href;
};
const longestFirst = (target) => {
  const [base, fragment = ""] = target.split("#", 2);
  const [anchor, directives = ""] = fragment.split(":~:", 2);
  const parts = directives.split("&").filter(Boolean);
  parts.sort((left, right) => decodeURIComponent(right).length -
    decodeURIComponent(left).length);
  return parts.length ? `${base}#${anchor}:~:${parts.join("&")}` : target;
};
const fold = (value) => value.normalize("NFKD").toLocaleLowerCase("en")
  .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
const occurrences = (text, value) => {
  const needle = ` ${fold(value)} `;
  if (needle === "  ") return Number.MAX_SAFE_INTEGER;
  const haystack = ` ${text} `;
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0;
    at = haystack.indexOf(needle, at + 1)) count += 1;
  return count;
};
const documentText = new Map(read("doctext.jsonl")
  .map((row) => [row.key, fold(row.text)]));
const rarityFirst = (row) => {
  const [base, fragment = ""] = row.target.split("#", 2);
  const [anchor] = fragment.split(":~:", 1);
  const text = documentText.get(seedDocumentKey(row)) ?? "";
  const directives = row.directives.map((directive, index) => ({
    directive,
    quote: row.paintQuotes[index] ?? decodeURIComponent(directive.slice(5)),
  }));
  directives.sort((left, right) => occurrences(text, left.quote) -
    occurrences(text, right.quote) || right.quote.length - left.quote.length);
  return `${base}#${anchor}:~:${directives.map(({ directive }) => directive).join("&")}`;
};

write("publisher-probe-pdf-combined.jsonl", pdf);
const combinedProof = path.join(results, "webdriver-exact-probe-pdf-combined.jsonl");
const unresolvedPdf = fs.existsSync(combinedProof)
  ? new Set(read("webdriver-exact-probe-pdf-combined.jsonl")
      .filter(({ verdict }) => verdict !== "exact-match").map(({ label }) => label))
  : new Set(pdf.map(({ label }) => label));
write("publisher-probe-pdf-longest-first.jsonl", pdf
  .filter(({ label }) => unresolvedPdf.has(label))
  .map((row) => ({ ...row, target: longestFirst(row.target) })));
const longestProof = path.join(results, "webdriver-exact-probe-pdf-longest-first.jsonl");
const unresolvedRarity = fs.existsSync(longestProof)
  ? new Set(read("webdriver-exact-probe-pdf-longest-first.jsonl")
      .filter(({ verdict }) => verdict !== "exact-match").map(({ label }) => label))
  : unresolvedPdf;
write("publisher-probe-pdf-rarity-first.jsonl", pdf
  .filter(({ label }) => unresolvedRarity.has(label))
  .map((row) => ({ ...row, target: rarityFirst(row) })));
write("publisher-probe-html-anchorless.jsonl",
  html.map((row) => ({ ...row, target: anchorless(row.target) })));
const framed = html.filter(({ target }) => new URL(target).searchParams.has("iframe"));
write("publisher-probe-html-iframe-only.jsonl", framed.map((row) => ({
  ...row, target: withParams(row.target, { iframe: "true", site_preference: null }),
})));
const exactLabels = (name) => fs.existsSync(path.join(results, name))
  ? new Set(read(name).filter(({ verdict }) => verdict === "exact-match")
      .map(({ label }) => label))
  : new Set();
const methodLabels = {
  combined: exactLabels("webdriver-exact-probe-pdf-combined.jsonl"),
  longest: exactLabels("webdriver-exact-probe-pdf-longest-first.jsonl"),
  rarity: exactLabels("webdriver-exact-probe-pdf-rarity-first.jsonl"),
};
const receiptPath = path.join(results, "fallback-signature-analysis-v25-final.json");
if (fs.existsSync(receiptPath)) {
  const signatures = JSON.parse(fs.readFileSync(receiptPath, "utf8")).signatures;
  const methods = { combined: [], longest: [], rarity: [], lawWeb: [] };
  for (const group of signatures) {
    const names = new Set(group.labels.map((label) =>
      Object.entries(methodLabels).find(([, labels]) => labels.has(label))?.[0] ?? "lawWeb"));
    if (names.size !== 1) throw new Error(`mixed method signature: ${group.signature}`);
    methods[[...names][0]].push(group.signature);
  }
  const methodRows = Object.fromEntries(Object.entries(methodLabels)
    .map(([name, labels]) => [name, labels.size]));
  methodRows.lawWeb = signatures.flatMap(({ labels }) => labels)
    .filter((label) => !Object.values(methodLabels).some((labels) => labels.has(label))).length;
  fs.writeFileSync(path.join(results, "publisher-method-signatures-v26.json"),
    `${JSON.stringify({ methods: Object.fromEntries(Object.entries(methods)
      .map(([name, values]) => [name, {
        rows: methodRows[name], signatureCount: values.length, signatures: values,
      }])),
    }, null, 2)}\n`);
  const lawWebLabels = new Set(signatures.flatMap((group) =>
    methods.lawWeb.includes(group.signature) ? group.labels : []));
  write("a2aj-document-routed-targets-v26.jsonl",
    read("a2aj-document-routed-targets-v25.jsonl")
      .filter(({ label }) => lawWebLabels.has(label)));
  write("publisher-optimized-proof-v26.jsonl", [
    ...read("webdriver-exact-probe-pdf-combined.jsonl"),
    ...read("webdriver-exact-probe-pdf-longest-first.jsonl"),
    ...read("webdriver-exact-probe-pdf-rarity-first.jsonl"),
  ].filter(({ verdict }) => verdict === "exact-match"));

  const optimized = new Map(read("publisher-optimized-proof-v26.jsonl")
    .map((row) => [row.label, row]));
  const composite = read("final-composite-proof-v25.jsonl").map((row) =>
    optimized.has(row.label) ? { route: "publisher", ...optimized.get(row.label) } : row);
  const cacheRoots = ["page-html", "live-rendered-html"].map((name) =>
    path.join(results, name));
  const cacheBound = (row) => cacheRoots.some((root) => {
    const identity = row.cacheIdentity;
    const file = identity?.file && path.join(root, identity.file);
    if (!file || !fs.existsSync(file)) return false;
    const bytes = fs.readFileSync(file);
    return bytes.length === identity.bytes && crypto.createHash("sha256")
      .update(bytes).digest("hex") === identity.sha256;
  });
  if (composite.length !== 2_370 || composite.some((row) => !cacheBound(row)) ||
      composite.filter(({ verdict }) => verdict === "exact-match").length !== 2_369 ||
      composite.filter(({ route }) => route === "a2aj-law-web").length !== 98) {
    throw new Error("v26 composite contract failed");
  }
  write("final-composite-proof-v26.jsonl", composite);
}

console.log(JSON.stringify({ residuals: residuals.length, pdf: pdf.length,
  unresolvedPdf: unresolvedPdf.size, unresolvedRarity: unresolvedRarity.size,
  html: html.length, framed: framed.length }));
