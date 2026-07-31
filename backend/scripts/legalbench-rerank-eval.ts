/**
 * Stage 16 W2 eval: whole-pool LLM reranking (k=48 lexical pool →
 * top 4) scored against LegalBench-RAG-mini human gold. Deterministic
 * scoring; the only stochastic element is the ranking call itself,
 * whose output is indices — evidence text is never touched. Resumable
 * (one JSONL row per test, keyed model|test_id).
 *
 * Usage: npx tsx scripts/legalbench-rerank-eval.ts --model codex:gpt-5.6-luna `
 *          [--limit 200] [--concurrency 6] [--output file.jsonl]
 */
import "../src/lib/loadEnv";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { rerankPassages } from "../src/lib/retrievalRerank";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < process.argv.length)
    return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const model = flag("model", "codex:gpt-5.6-luna");
const limit = Number(flag("limit", "0"));
const concurrency = Number(flag("concurrency", "6"));
const output = flag(
  "output",
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "OpenLegalData/experiments/legal-grounding/2026-07-30/stage16-rerank-eval.jsonl",
  ),
);

validateMiniManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));
const sourceDb = path.join(LEGALBENCH_RAG_DATA_DIR, "db", "a2aj-mini.sqlite");
const all = SOURCE_BENCHMARKS.flatMap((source) => {
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
    gold: test.snippets.map((s) => ({
      filePath: s.file_path,
      start: s.span[0],
      end: s.span[1],
    })) as Span[],
  }));
});
// Interleave sources so a --limit sample covers all four.
const bySource = SOURCE_BENCHMARKS.map((source) =>
  all.filter((test) => test.source === source),
);
const interleaved = Array.from(
  { length: Math.max(...bySource.map((list) => list.length)) },
  (_, index) => bySource.flatMap((list) => (list[index] ? [list[index]] : [])),
).flat();
const tests = limit > 0 ? interleaved.slice(0, limit) : interleaved;

const done = new Set<string>();
if (existsSync(output)) {
  for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean))
    done.add(JSON.parse(line).key);
} else {
  writeFileSync(output, "", "utf8");
}

async function main() {
  const queue = tests.filter((test) => !done.has(`${model}|${test.id}`));
  console.log(`${queue.length} tests to run (${done.size} resumed)`);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (index < queue.length) {
        const test = queue[index++];
        const pool = searchPassages({
          sourceDb,
          query: test.query,
          k: 48,
          target: 1600,
          overlap: 120,
          nameWeight: 16,
          perDocCap: 24,
        });
        const spans = (hits: typeof pool) =>
          hits.map((hit) => ({
            filePath: hit.citation,
            start: hit.start,
            end: hit.end,
          }));
        const lexical = charPrecisionRecall(spans(pool.slice(0, 4)), test.gold);
        const poolScore = charPrecisionRecall(spans(pool), test.gold);
        const started = Date.now();
        const reranked = await rerankPassages({
          query: test.query,
          hits: pool,
          model,
          top: 4,
        });
        const score = charPrecisionRecall(spans(reranked.hits), test.gold);
        const goldDocs = new Set(test.gold.map((span) => span.filePath));
        const row = {
          key: `${model}|${test.id}`,
          test_id: test.id,
          source: test.source,
          model,
          fallback: reranked.fallback,
          latency_ms: Date.now() - started,
          lexical_p4: lexical.precision,
          lexical_r4: lexical.recall,
          pool_r48: poolScore.recall,
          rerank_p4: score.precision,
          rerank_r4: score.recall,
          rerank_doc4: reranked.hits.some((hit) => goldDocs.has(hit.citation)),
        };
        appendFileSync(output, `${JSON.stringify(row)}\n`, "utf8");
        console.log(
          `${test.id}: R4 ${lexical.recall.toFixed(3)} -> ${score.recall.toFixed(3)}` +
            `${reranked.fallback ? " FALLBACK" : ""}`,
        );
      }
    }),
  );
  const rows = readFileSync(output, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.model === model);
  const mean = (field: string) =>
    rows.reduce((a, row) => a + Number(row[field] ?? 0), 0) / rows.length;
  console.log(
    `\nn=${rows.length} fallbacks=${rows.filter((r) => r.fallback).length}\n` +
      `lexical  P4=${mean("lexical_p4").toFixed(4)} R4=${mean("lexical_r4").toFixed(4)}\n` +
      `reranked P4=${mean("rerank_p4").toFixed(4)} R4=${mean("rerank_r4").toFixed(4)} ` +
      `doc4=${(rows.filter((r) => r.rerank_doc4).length / rows.length).toFixed(4)}\n` +
      `pool bound R48=${mean("pool_r48").toFixed(4)} | mean latency ${(mean("latency_ms") / 1000).toFixed(1)}s`,
  );
}

main().catch((error) => {
  console.error("[legalbench-rerank-eval]", error);
  process.exit(1);
});
