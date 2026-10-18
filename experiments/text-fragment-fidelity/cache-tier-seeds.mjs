#!/usr/bin/env node
// Cache-tier seeds (benchmarks/text_fragment_fidelity/cache-tier.mjs) from results/targets.jsonl: each target in each
// form a link can take, as `<label>~<form>`:
//   provider  the quotation on the publisher page A2AJ names (`target`), where there is a quotation;
//   canlii    the quotation on the document's CanLII page (`canliiTarget`), where there is a quotation;
//   passage   the block cited on its CanLII page (`canliiPassageTarget`).
// Each seed names its intended words (the quotations, or for a passage link none: the passage its anchor opens) and,
// for a page without the block's anchor, which occurrence of them the A2AJ document means (`ordinal` of
// `occurrences`), counted as the cache tier counts words. LégisQuébec targets are left out (never fetched or scored).
// Usage: node experiments/text-fragment-fidelity/cache-tier-seeds.mjs [targets.jsonl] > seeds.jsonl
import fs from "node:fs";
import path from "node:path";
import { seedDocumentKey } from "./seed-document-key.mjs";

const results = path.join(import.meta.dirname, "results");
const targetsPath = process.argv[2] ?? path.join(results, "targets.jsonl");
const lines = (file) => fs.readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean);
const targets = lines(targetsPath).map((line) => JSON.parse(line))
  .filter((row) => !/legisquebec/iu.test(row.url));
const wanted = new Set(targets.map(seedDocumentKey));
const documents = new Map();
for (const line of lines(path.join(results, "doctext.jsonl"))) {
  const row = JSON.parse(line);
  if (wanted.has(row.key)) documents.set(row.key, row.text);
}

const tokenize = (value) => [...String(value ?? "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]);
const wordsOf = new Map();
const documentWords = (key) => {
  if (!wordsOf.has(key)) wordsOf.set(key, tokenize(documents.get(key) ?? ""));
  return wordsOf.get(key);
};
// Where the cache tier finds a text: each start of its first six words with its last six words close after; a leading
// number (a printed label) read only where `labelled`.
function spans(words, text, labelled = false) {
  const want = tokenize(text);
  while (!labelled && want.length > 3 && /^\d+$/u.test(want[0])) want.shift();
  const head = want.slice(0, Math.min(6, want.length)), tail = want.slice(-Math.min(6, want.length));
  const at = (from, sequence) => sequence.every((word, offset) => words[from + offset] === word);
  const found = [];
  if (!head.length) return found;
  for (let start = 0; start < words.length; start += 1) {
    if (!at(start, head)) continue;
    for (let end = start + head.length - 1; end < Math.min(words.length, start + want.length * 2 + 20); end += 1)
      if (end - tail.length + 1 >= start && at(end - tail.length + 1, tail)) { found.push(start); break; }
  }
  return found;
}
// The occurrence of `text` the block means: the first at or after the block's own start.
function occurrence(key, blockText, text) {
  const words = documentWords(key);
  const found = spans(words, text);
  const block = spans(words, blockText, true)[0] ?? spans(words, blockText)[0] ?? 0;
  const ordinal = Math.max(0, found.findIndex((start) => start >= block));
  return { ordinal, occurrences: found.length };
}

for (const row of targets) {
  const key = seedDocumentKey(row);
  const quotes = (row.quotes ?? []).filter(Boolean);
  const host = (url) => new URL(url).hostname;
  // The cited paragraph the first quotation sits in: a block may join several ("[25] … [46] … [52] …").
  const quoted = tokenize(quotes[0] ?? "").join(" ");
  const within = (row.blockText ?? "").split(/(?=\[\d+\]\s)/u)
    .find((part) => quoted && tokenize(part).join(" ").includes(quoted)) ?? row.blockText ?? "";
  const quoteTarget = (pinpoint) => ({ pinpoint, texts: quotes, within, ...occurrence(key, within, quotes[0] ?? "") });
  // A citation with no quotation has no quotation link: its passage is the passage form's.
  const forms = [
    ["provider", quotes.length ? row.target : null, quoteTarget(row.anchor ?? null)],
    ["canlii", quotes.length ? row.canliiTarget : null, quoteTarget(row.canliiTarget?.split("#")[1]?.split(":~:")[0] || null)],
    ["lawweb", row.lawWebTarget, quotes.length ? quoteTarget(null) : { pinpoint: null, texts: [row.blockText ?? ""],
      ...occurrence(key, row.blockText ?? "", row.blockText ?? "") }],
    ["passage", row.canliiPassageTarget, { pinpoint: row.canliiPassageTarget?.split("#")[1]?.split(":~:")[0] || null,
      texts: [], passage: row.blockText ?? "", ...occurrence(key, row.blockText ?? "", row.blockText ?? "") }],
  ];
  for (const [form, url, target] of forms) {
    if (!url) continue;
    console.log(JSON.stringify({ id: `${row.label}~${form}`, tier: "cache", role: form === "passage" ? "citation" : "quote",
      origin: "a2aj-corpus", strategy: form, host: host(url), dataset: row.dataset, shape: row.shape, url, target }));
  }
}
