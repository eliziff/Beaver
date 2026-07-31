/**
 * Offline retrieval ablation on LegalBench-RAG-mini (Stage 15 lever
 * selection): sweeps passage-retrieval configs against the HUMAN gold
 * char spans with the upstream scoring formulas. Deterministic, zero
 * model calls — the whole sweep is free. Published product baseline
 * for reference (2026-07-28, doc-level FTS5 + snippet window):
 * overall char P 0.0077 / R 0.0209 / doc recall 0.4987 @k=8.
 *
 * Usage (from backend/): npx tsx scripts/legalbench-retrieval-ablate.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  LEGALBENCH_RAG_DATA_DIR,
  MANIFEST_PATH,
  SOURCE_BENCHMARKS,
  charPrecisionRecall,
  upstreamBenchmarkSchema,
  validateMiniManifest,
  type Span,
} from "../src/lib/legalbenchRag";
import { searchPassages } from "../src/lib/passageRetrieval";

const manifest = validateMiniManifest(
  JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
);
const tests = SOURCE_BENCHMARKS.flatMap((source) => {
  const parsed = upstreamBenchmarkSchema.parse(
    JSON.parse(
      readFileSync(
        path.join(LEGALBENCH_RAG_DATA_DIR, `mini/benchmarks/${source}.json`),
        "utf8",
      ),
    ),
  );
  return parsed.tests.map((test) => ({
    source,
    query: test.query,
    gold: test.snippets.map((snippet) => ({
      filePath: snippet.file_path,
      start: snippet.span[0],
      end: snippet.span[1],
    })) as Span[],
  }));
});
const sourceDb = path.join(LEGALBENCH_RAG_DATA_DIR, "db", "a2aj-mini.sqlite");

type Config = {
  target: number;
  overlap: number;
  nameWeight: number;
  perDocCap: number;
};
const configs: Config[] = [];
for (const target of [600, 1000, 1600])
  for (const overlap of [0, 120])
    for (const nameWeight of [1, 4, 16])
      configs.push({ target, overlap, nameWeight, perDocCap: 2 });

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

console.log(
  "target overlap nameW | k | precision recall docRecall | chars/query",
);
for (const config of configs) {
  const perK: Record<number, { p: number[]; r: number[]; d: number[]; c: number[] }> =
    { 4: { p: [], r: [], d: [], c: [] }, 8: { p: [], r: [], d: [], c: [] } };
  for (const test of tests) {
    const hits = searchPassages({
      sourceDb,
      query: test.query,
      k: 8,
      target: config.target,
      overlap: config.overlap,
      nameWeight: config.nameWeight,
      perDocCap: config.perDocCap,
    });
    const goldDocs = new Set(test.gold.map((span) => span.filePath));
    for (const k of [4, 8]) {
      const spans = hits.slice(0, k).map((hit) => ({
        filePath: hit.citation,
        start: hit.start,
        end: hit.end,
      }));
      const { precision, recall } = charPrecisionRecall(spans, test.gold);
      perK[k].p.push(precision);
      perK[k].r.push(recall);
      perK[k].d.push(spans.some((span) => goldDocs.has(span.filePath)) ? 1 : 0);
      perK[k].c.push(spans.reduce((n, s) => n + (s.end - s.start), 0));
    }
  }
  for (const k of [4, 8])
    console.log(
      `${config.target} ${config.overlap} ${config.nameWeight} | ${k} | ` +
        `${mean(perK[k].p).toFixed(4)} ${mean(perK[k].r).toFixed(4)} ` +
        `${mean(perK[k].d).toFixed(4)} | ${Math.round(mean(perK[k].c))}`,
    );
}
