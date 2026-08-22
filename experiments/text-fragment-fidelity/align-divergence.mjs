#!/usr/bin/env node
// For every actionable failure (quote present on page, fragment missed),
// aligns the ASCII quote against the rendered page text and records the
// first divergence plus both renderings, so projection rules can be derived
// as data instead of guesswork.
import fs from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const resultsPath = path.join(here, "results", "gate-results.jsonl");
const seedsPath = path.join(here, "results", "seeds.jsonl");
const classesPath = path.join(here, "results", "flagged-classes.json");
const outPath = path.join(here, "results", "divergence-pairs.jsonl");

const actionable = new Set(
  fs.readFileSync(classesPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.klass === "projection-gap")
    .map((r) => r.label),
);
const seeds = new Map(
  fs.readFileSync(seedsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((s) => [s.label, s]),
);
const targets = new Map(
  fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => [r.label, r]),
);

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, "\u0001") // element boundary marker
    .replace(/&nbsp;|&#160;/giu, "\u00A0")
    .replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(\d+);/gu, (_m, d) => String.fromCodePoint(Number(d)));
}

function main() {
  const pairs = [];
  for (const label of [...actionable]) {
    const seed = seeds.get(label);
    if (!seed) continue;
    // The rendered counterpart was captured during classification; rebuild
    // cheaply by re-deriving from the cached classification step is not
    // possible offline, so this script consumes pre-extracted page text when
    // present (results/pagecache/<label>.txt written by cache-pages.mjs).
    const cachePath = path.join(here, "results", "pagecache", `${label}.txt`);
    if (!fs.existsSync(cachePath)) continue;
    const rendered = fs.readFileSync(cachePath, "utf8");
    const ascii = seed.quotes[0].replace(/\s+/gu, " ").trim();
    // Locate the rendered quote: slide over rendered text comparing with
    // whitespace-insensitive, case-insensitive, NBSP-folding equality while
    // allowing element-boundary markers between words.
    const rawRenderedWords = rendered.split(/[\s\u0001]+/u).filter(Boolean);
    const words = ascii.split(" ").map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    const stripped = rawRenderedWords.map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
    let bestAt = -1;
    let bestScore = 0;
    for (let i = 0; i + words.length <= stripped.length; i += 1) {
      let score = 0;
      for (let j = 0; j < words.length; j += 1) {
        if (words[j] === stripped[i + j]) score += 1;
        else score -= 0.25;
      }
      if (score > bestScore) { bestScore = score; bestAt = i; }
    }
    if (bestAt < 0 || bestScore < words.length * 0.6) continue;
    // Character-accurate window from the raw cache text: punctuation,
    // NBSPs, and element-boundary markers all preserved.
    const renderedWindow = rawRenderedWords.slice(bestAt, bestAt + words.length).join(" ");
    pairs.push({
      label,
      dataset: seed.dataset,
      shape: seed.shape,
      ascii,
      rendered: renderedWindow,
      score: bestScore,
      of: words.length,
    });
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  console.log(JSON.stringify({ aligned: pairs.length, of: actionable.size }));
}
main();
