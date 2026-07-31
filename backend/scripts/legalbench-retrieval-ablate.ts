/**
 * Offline retrieval ablation on LegalBench-RAG-mini (Stage 15 lever
 * selection): sweeps passage-retrieval configs against the HUMAN gold
 * char spans with the upstream scoring formulas. Deterministic, zero
 * model calls — the whole sweep is free. Published product baseline
 * for reference (2026-07-28, doc-level FTS5 + snippet window):
 * overall char P 0.0077 / R 0.0209 / doc recall 0.4987 @k=8.
 *
 * Usage (from backend/): npx tsx scripts/legalbench-retrieval-ablate.ts
 * Stage 18 arms ({chars,clause} x {plain,phrases} at t1600/o120/w16,
 * per-source lexical R@4 + pool R@48, JSONL receipts):
 *   npx tsx scripts/legalbench-retrieval-ablate.ts --stage18
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
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
  return parsed.tests.map((test, index) => ({
    id: `${source}:${String(index).padStart(3, "0")}`,
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

// Fair-comparison row: paper-matched ~500-char chunks, k=4, so the
// retrieval comparison vs arXiv:2408.10343 is chunk-size-matched.
if (process.argv.includes("--fair500")) {
  const perSource = new Map<string, { p: number[]; r: number[] }>();
  for (const test of tests) {
    const hits = searchPassages({
      sourceDb,
      query: test.query,
      k: 4,
      target: 500,
      overlap: 0,
      nameWeight: 16,
      perDocCap: 2,
    });
    const { precision, recall } = charPrecisionRecall(
      hits.map((hit) => ({
        filePath: hit.citation,
        start: hit.start,
        end: hit.end,
      })),
      test.gold,
    );
    const entry = perSource.get(test.source) ?? { p: [], r: [] };
    entry.p.push(precision);
    entry.r.push(recall);
    perSource.set(test.source, entry);
  }
  const all = { p: [] as number[], r: [] as number[] };
  for (const [source, entry] of perSource) {
    all.p.push(...entry.p);
    all.r.push(...entry.r);
    console.log(
      `fair500 ${source}: P4=${mean(entry.p).toFixed(4)} R4=${mean(entry.r).toFixed(4)} (n=${entry.p.length})`,
    );
  }
  console.log(
    `fair500 ALL: P4=${mean(all.p).toFixed(4)} R4=${mean(all.r).toFixed(4)}`,
  );
  process.exit(0);
}

// Stage 18 registered arms: {chars,clause} x {plain,phrases} at the
// crowned t1600/o120/w16, gated on maud pool R@48. Deterministic, free.
if (process.argv.includes("--stage18")) {
  const output = path.join(
    process.env.LOCALAPPDATA ?? "",
    "OpenLegalData/experiments/legal-grounding/2026-07-30/stage18-retrieval-arms.jsonl",
  );
  writeFileSync(output, "", "utf8");
  const arms = [
    { arm: "chars", mode: "chars" as const, phrases: false },
    { arm: "chars+phrases", mode: "chars" as const, phrases: true },
    { arm: "clause", mode: "clause" as const, phrases: false },
    { arm: "clause+phrases", mode: "clause" as const, phrases: true },
  ];
  for (const { arm, mode, phrases } of arms) {
    const bySource = new Map<
      string,
      { lexR4: number[]; poolR48: number[] }
    >();
    for (const test of tests) {
      const pool = searchPassages({
        sourceDb,
        query: test.query,
        k: 48,
        target: 1600,
        overlap: mode === "clause" ? 0 : 120,
        nameWeight: 16,
        perDocCap: 24,
        mode,
        phrases,
      });
      const spans = (hits: typeof pool) =>
        hits.map((hit) => ({
          filePath: hit.citation,
          start: hit.start,
          end: hit.end,
        }));
      const lexical = charPrecisionRecall(spans(pool.slice(0, 4)), test.gold);
      const poolScore = charPrecisionRecall(spans(pool), test.gold);
      appendFileSync(
        output,
        `${JSON.stringify({
          arm,
          test_id: test.id,
          source: test.source,
          lexical_p4: lexical.precision,
          lexical_r4: lexical.recall,
          pool_r48: poolScore.recall,
        })}\n`,
        "utf8",
      );
      const entry = bySource.get(test.source) ?? { lexR4: [], poolR48: [] };
      entry.lexR4.push(lexical.recall);
      entry.poolR48.push(poolScore.recall);
      bySource.set(test.source, entry);
    }
    const overall = { lexR4: [] as number[], poolR48: [] as number[] };
    for (const [source, entry] of bySource) {
      overall.lexR4.push(...entry.lexR4);
      overall.poolR48.push(...entry.poolR48);
      console.log(
        `${arm} ${source}: lexR4=${mean(entry.lexR4).toFixed(4)} poolR48=${mean(entry.poolR48).toFixed(4)} (n=${entry.lexR4.length})`,
      );
    }
    console.log(
      `${arm} ALL: lexR4=${mean(overall.lexR4).toFixed(4)} poolR48=${mean(overall.poolR48).toFixed(4)}\n`,
    );
  }
  console.log(`Receipts: ${output}`);
  process.exit(0);
}

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
