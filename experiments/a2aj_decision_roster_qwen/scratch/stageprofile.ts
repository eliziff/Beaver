#!/usr/bin/env node

import path from "node:path";
import { readFileSync } from "node:fs";
import { deriveA2AJSourceDoc } from "../../../backend/src/lib/sourceDocA2AJ";
import { shutdownSourceStructureEngine } from "../../../backend/src/lib/sourceStructureEngine";
import {
  analyzeOpinionStructure,
  deriveTextOpinionStructure,
  partitionOpinionStructure,
} from "../../../backend/experiments/a2aj-decision-roster/legalOpinionBoundaries";

async function main() {
const TEXT_CACHE_DIR = path.join(__dirname, "..", "scratch", ".textcache");
const fingerprint = readFileSync(path.join(TEXT_CACHE_DIR, "..", ".drawcache", "4.SCC.1000.json"), "utf8");
void fingerprint;
const cacheBase = "11078942720_1785605623570.433";
const index = JSON.parse(
  readFileSync(path.join(TEXT_CACHE_DIR, `${cacheBase}.index.json`), "utf8"),
) as { entries: Array<{ documentId: number; offset: number; length: number }> };
const bin = readFileSync(path.join(TEXT_CACHE_DIR, `${cacheBase}.texts.bin`));
const texts = index.entries.map((e) => bin.toString("utf8", e.offset, e.offset + e.length));

const lens = texts.map((t) => t.length).sort((a, b) => a - b);
const pct = (p: number) => lens[Math.floor(lens.length * p)];
console.log(
  `texts: ${texts.length}, len p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${lens[lens.length - 1]}, sum=${lens.reduce((a, b) => a + b) / 1e6}MB`,
);

let compileMs = 0;
let analyzeMs = 0;
let partitionMs = 0;
let deriveMs = 0;
let totalMs = 0;
const sample = texts.slice(0, 60);
for (const text of sample) {
  const t0 = performance.now();
  const source = await deriveA2AJSourceDoc({
    citation: "x",
    docType: "cases",
    text,
    url: null,
    alternateCitation: null,
    dataset: "SCC",
    name: null,
  });
  const t1 = performance.now();
  const paragraphs = source.blocks.filter((block) => block.kind === "paragraph");
  const structure = analyzeOpinionStructure({
    text: source.text,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
  });
  const t2 = performance.now();
  partitionOpinionStructure(
    structure,
    paragraphs.map((block) => {
      const match = /^par(\d+)$/u.exec(block.label);
      return match ? Number(match[1]) : Number(block.label) || 0;
    }),
  );
  const t3 = performance.now();
  deriveTextOpinionStructure({
    text: source.text,
    paragraphs,
    firstParagraphStart: paragraphs[0]?.start ?? 0,
    structure,
  });
  const t4 = performance.now();
  compileMs += t1 - t0;
  analyzeMs += t2 - t1;
  partitionMs += t3 - t2;
  deriveMs += t4 - t3;
  totalMs += t4 - t0;
}
console.log(
  `per-doc avg: compile=${(compileMs / sample.length).toFixed(2)}ms analyze=${(analyzeMs / sample.length).toFixed(2)}ms partition=${(partitionMs / sample.length).toFixed(2)}ms derive=${(deriveMs / sample.length).toFixed(2)}ms total=${(totalMs / sample.length).toFixed(2)}ms`,
);
}

void (async () => {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await shutdownSourceStructureEngine();
  }
})();
