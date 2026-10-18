#!/usr/bin/env node
// Cache-tier seeds (benchmarks/text_fragment_fidelity/cache-tier.mjs) from results/targets.jsonl: each target in each
// form a link can take, as `<label>~<form>`:
//   provider  the quotation on the publisher page A2AJ names (`target`), where there is a quotation;
//   canlii    the quotation on the document's CanLII page (`canliiTarget`), where there is a quotation;
//   passage   the block cited on its CanLII page (`canliiPassageTarget`).
// Each seed names its intended words (the quotations, or for a passage link none: the passage its anchor opens) and,
// for a page without the block's anchor, which occurrence of them the A2AJ document means (`ordinal` of
// `occurrences`), counted as the cache tier counts words, and the source words around each quotation where the planner
// found it (`contexts`). A target whose block its document does not hold is `missing`. LégisQuébec targets are left
// out (never fetched or scored).
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
// A document's words with where each starts in its text.
const wordStarts = new Map();
const documentWordStarts = (key) => {
  if (!wordStarts.has(key)) wordStarts.set(key, [...String(documents.get(key) ?? "").matchAll(/[\p{L}\p{N}]+/gu)]
    .map((match) => match.index));
  return wordStarts.get(key);
};
// The words around each quotation where the planner found it in the source (its `sourceWordIntervals`), so the cache
// tier can tell that occurrence from the quotation's other ones: up to 12 words before and after it.
function contexts(key, quotes, intervals) {
  const words = documentWords(key), starts = documentWordStarts(key);
  return quotes.map((quote, index) => {
    const interval = (intervals ?? []).find((item) => item.quoteIndex === index);
    const want = tokenize(quote);
    if (!interval || !want.length || !words.length) return null;
    // The quotation's first word at or after the interval's start (an interval may run past the quotation's words).
    const from = starts.findIndex((start) => start >= interval.start - 2);
    for (let at = Math.max(0, from); at < words.length && starts[at] <= interval.end; at += 1) {
      if (want.every((word, offset) => words[at + offset] === word)) {
        return { before: words.slice(Math.max(0, at - 12), at).join(" "),
          after: words.slice(at + want.length, at + want.length + 12).join(" ") };
      }
    }
    return null;
  });
}
// The share of the six-word runs of `want` (words) that its document holds.
const wordPositions = new Map();
function sharedRuns(key, want) {
  const words = documentWords(key);
  if (!wordPositions.has(key)) {
    const positions = new Map();
    words.forEach((word, at) => positions.has(word) ? positions.get(word).push(at) : positions.set(word, [at]));
    wordPositions.set(key, positions);
  }
  const length = Math.min(6, want.length);
  let shared = 0, runs = 0;
  for (let from = 0; from + length <= want.length; from += 1) {
    runs += 1;
    if ((wordPositions.get(key).get(want[from]) ?? []).some((at) =>
      want.slice(from, from + length).every((word, offset) => words[at + offset] === word))) shared += 1;
  }
  return runs ? shared / runs : 1;
}
// A block may join several paragraphs ("[25] … [46] …", "40 … 56 …", "65. … 69. …"): its pieces, each with its
// paragraph's number. A label is printed as the block's opening one is ("[N]", "N" or "N."), follows a sentence's end
// on the same line (a numbered paragraph quoted on its own line, or a footnote mark "cells.[21]", is not one; "at
// p. 455", "art. 1375" are no sentence's end), starts a sentence and numbers a later paragraph than the block's own (not
// a footnote mark "issue. [29] That", nor a year in a citation "[2017] 1 S.C.R. 250"); where `following`, the next
// paragraph's (a block run on past its own paragraph reaches the next one, not a numbered paragraph it quotes).
function pieces(blockText, following = false) {
  const text = blockText ?? "";
  const style = (match) => match[1] ? "[]" : match[3] ? "." : "";
  const label = /(?:\[(\d{1,4})\]|(\d{1,4})(\.?))\s+(?=[A-Z“"])/u;
  const opening = text.match(new RegExp(String.raw`^\s*` + label.source, "u"));
  if (!opening) return [{ number: NaN, text }];
  const first = Number(opening[1] ?? opening[2]);
  const sentenceEnd = String.raw`(?<=^|(?<!\b(?:[Pp]p?|[Aa]rts?|[Ss]s?|[Pp]aras?|[Cc]h?|[Nn]os?|[Vv]ol|[Rr]r?))[.!?"”’] +)`;
  const cuts = [...text.matchAll(new RegExp(sentenceEnd + label.source, "gu"))]
    .filter((match) => style(match) === style(opening))
    .map((match) => ({ at: match.index, number: Number(match[1] ?? match[2]) }))
    .filter(({ at, number }) => at === 0 || (number > first && number < first + 500))
    .reduce((kept, cut) => !following || !kept.length || cut.number === kept.at(-1).number + 1 ? [...kept, cut] : kept,
      []);
  if (!cuts.length || cuts[0].at > 0) cuts.unshift({ at: 0, number: first });
  return cuts.map((cut, index) => ({ number: cut.number, text: text.slice(cut.at, cuts[index + 1]?.at) }))
    .filter((piece) => piece.text.trim());
}

for (const row of targets) {
  const key = seedDocumentKey(row);
  const quotes = (row.quotes ?? []).filter(Boolean);
  const host = (url) => new URL(url).hostname;
  // The paragraph the pinpoint names, and the cited paragraph the first quotation sits in: in a block joining cited
  // paragraphs from apart in the document, the piece holding it; in a block the document holds in one run, which has
  // run on past its own paragraph (an unsplit "68 … 71 …"), the pinpoint's own piece.
  const oneRun = documents.has(key) && spans(documentWords(key), row.blockText ?? "").length > 0;
  const parts = pieces(row.blockText, oneRun);
  const number = Number(row.label.match(/_p(\d+)_/u)?.[1] ??
    (row.anchor ?? row.canliiPassageTarget?.split("#")[1] ?? "").match(/^par(\d+)/u)?.[1] ?? NaN);
  const own = parts.find((part) => part.number === number)?.text;
  const passage = own ?? row.blockText ?? "";
  const quoted = tokenize(quotes[0] ?? "").join(" ");
  const within = (oneRun ? own : null) ??
    parts.find((part) => quoted && tokenize(part.text).join(" ").includes(quoted))?.text ?? row.blockText ?? "";
  // A block its document does not hold (a citation of a paragraph the document lacks): under a quarter of its six-word
  // runs are in the document (blocks it holds share over 40%, nearly all over 90%; r14 targets).
  const missing = documents.has(key) && sharedRuns(key, tokenize(row.blockText)) < 0.25;
  const around = quotes.length ? contexts(key, quotes, row.sourceWordIntervals) : [];
  const quoteTarget = (pinpoint) => ({ pinpoint, texts: quotes, within, ...occurrence(key, within, quotes[0] ?? ""),
    ...around.some(Boolean) && { contexts: around }, ...missing && { missing: true } });
  // A citation with no quotation has no quotation link: its passage is the passage form's.
  const forms = [
    ["provider", quotes.length ? row.target : null, quoteTarget(row.anchor ?? null)],
    ["canlii", quotes.length ? row.canliiTarget : null, quoteTarget(row.canliiTarget?.split("#")[1]?.split(":~:")[0] || null)],
    ["lawweb", row.lawWebTarget, quotes.length ? quoteTarget(null) : { pinpoint: null, texts: [passage],
      ...occurrence(key, passage, passage), ...missing && { missing: true } }],
    ["passage", row.canliiPassageTarget, { pinpoint: row.canliiPassageTarget?.split("#")[1]?.split(":~:")[0] || null,
      texts: [], passage, ...occurrence(key, passage, passage), ...missing && { missing: true } }],
  ];
  for (const [form, url, target] of forms) {
    if (!url) continue;
    console.log(JSON.stringify({ id: `${row.label}~${form}`, tier: "cache", role: form === "passage" ? "citation" : "quote",
      origin: "a2aj-corpus", strategy: form, host: host(url), dataset: row.dataset, shape: row.shape, url, target }));
  }
}
