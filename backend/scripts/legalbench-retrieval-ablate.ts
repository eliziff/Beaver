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
 * Stage 18 F1 name-stripped audit (any mode; "+stripped" labels):
 *   ... --context-arms --context-jsonl <headers.jsonl> --strip-consider
 */
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

// Stage 18 F1 name-stripped audit: every benchmark query is templated
// "Consider <document identity>; <question>", so lexical retrieval can
// be scoring the document name instead of the question. --strip-consider
// removes everything through the first ";" and re-runs the same configs;
// arm labels and receipt files carry a "+stripped" suffix so a stripped
// run can never be mistaken for the unstripped baseline.
const STRIP_CONSIDER = process.argv.includes("--strip-consider");
const STRIP_TAG = STRIP_CONSIDER ? "+stripped" : "";
export function stripConsider(query: string): string {
  if (!query.startsWith("Consider ")) return query;
  const at = query.indexOf(";");
  return at < 0 ? query : query.slice(at + 1).replace(/^\s+/u, "");
}

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
    query: STRIP_CONSIDER ? stripConsider(test.query) : test.query,
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

// Stage 18 R5 measurement: contextual-enrichment weight sweep.
// Deterministic and free once headers exist: lexical R@4 + pool R@48
// at contextWeight {0 (champion plain index), 1, 2, 4} over the
// enriched sidecar. Pass the LINTED headers file (attested-entity
// lint output), not the raw generation receipts.
//   npx tsx scripts/legalbench-retrieval-ablate.ts --context-arms \
//     --context-jsonl <headers.jsonl> --label <raw|linted>
// The lint itself is an ABLATION ARM, not an assumed improvement: run
// once with the raw generation receipts and once with the linted file;
// each labeled run gets its own receipts and hash-keyed sidecar.
if (process.argv.includes("--context-arms")) {
  const at = process.argv.indexOf("--context-jsonl");
  const contextJsonl = at >= 0 ? process.argv[at + 1] : "";
  if (!contextJsonl) throw new Error("missing --context-jsonl");
  const labelAt = process.argv.indexOf("--label");
  const label = labelAt >= 0 ? process.argv[labelAt + 1] : "linted";
  const output = path.join(
    process.env.LOCALAPPDATA ?? "",
    `OpenLegalData/experiments/legal-grounding/2026-07-30/stage18-context-arms-${label}${STRIP_TAG}.jsonl`,
  );
  writeFileSync(output, "", "utf8");
  for (const weight of [0, 1, 2, 4]) {
    const bySource = new Map<
      string,
      { lexR4: number[]; poolR48: number[]; docHit: number[] }
    >();
    for (const test of tests) {
      const pool = searchPassages({
        sourceDb,
        query: test.query,
        k: 48,
        target: 1600,
        overlap: 120,
        nameWeight: 16,
        perDocCap: 24,
        ...(weight > 0 ? { contextJsonl, contextWeight: weight } : {}),
      });
      const spans = (hits: typeof pool) =>
        hits.map((hit) => ({
          filePath: hit.citation,
          start: hit.start,
          end: hit.end,
        }));
      const lexical = charPrecisionRecall(spans(pool.slice(0, 4)), test.gold);
      const poolScore = charPrecisionRecall(spans(pool), test.gold);
      const goldDocs = new Set(test.gold.map((span) => span.filePath));
      const docHit = pool.some((hit) => goldDocs.has(hit.citation));
      appendFileSync(
        output,
        `${JSON.stringify({
          arm: `ctx-${label}-w${weight}${STRIP_TAG}`,
          test_id: test.id,
          source: test.source,
          lexical_r4: lexical.recall,
          pool_r48: poolScore.recall,
          doc_hit: docHit,
        })}\n`,
        "utf8",
      );
      const entry = bySource.get(test.source) ?? {
        lexR4: [],
        poolR48: [],
        docHit: [],
      };
      entry.lexR4.push(lexical.recall);
      entry.poolR48.push(poolScore.recall);
      entry.docHit.push(docHit ? 1 : 0);
      bySource.set(test.source, entry);
    }
    const overall = {
      lexR4: [] as number[],
      poolR48: [] as number[],
      docHit: [] as number[],
    };
    const parts: string[] = [];
    for (const [source, entry] of [...bySource.entries()].sort()) {
      overall.lexR4.push(...entry.lexR4);
      overall.poolR48.push(...entry.poolR48);
      overall.docHit.push(...entry.docHit);
      parts.push(
        `${source} lexR4=${mean(entry.lexR4).toFixed(4)} poolR48=${mean(entry.poolR48).toFixed(4)} docR=${mean(entry.docHit).toFixed(4)}`,
      );
    }
    console.log(
      `ctx-${label}-w${weight}${STRIP_TAG}: lexR4=${mean(overall.lexR4).toFixed(4)} poolR48=${mean(overall.poolR48).toFixed(4)} docR=${mean(overall.docHit).toFixed(4)} | ${parts.join(" | ")}`,
    );
  }
  console.log(`Receipts: ${output}`);
  process.exit(0);
}

// Stage 18 R3: rerank compute ablation — same crowned lexical pool
// (k=48, t1600/o120/w16, perDocCap 24), one listwise rerank call per
// {model, effort} arm, char P/R of the unstitched top-6. Flat-rate
// model calls; resumable (arm|test_id keyed on non-error rows).
//   npx tsx scripts/legalbench-retrieval-ablate.ts --rerank-arms \
//     [--per-source 48] [--concurrency 3] [--resume 1]
async function rerankArmsMain() {
  const argValue = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const perSource = Number(argValue("per-source", "48"));
  const concurrency = Number(argValue("concurrency", "3"));
  const resume = argValue("resume", "0") !== "0";
  const output = path.join(
    process.env.LOCALAPPDATA ?? "",
    `OpenLegalData/experiments/legal-grounding/2026-07-30/stage18-rerank-arms${STRIP_TAG}.jsonl`,
  );
  const arms: { arm: string; model: string; effort?: string }[] = [
    { arm: "luna@default", model: "codex:gpt-5.6-luna" },
    { arm: "luna@low", model: "codex:gpt-5.6-luna", effort: "low" },
    { arm: "luna@high", model: "codex:gpt-5.6-luna", effort: "high" },
    { arm: "sol@medium", model: "codex:gpt-5.6-sol", effort: "medium" },
    { arm: "terra@medium", model: "codex:gpt-5.6-terra", effort: "medium" },
  ];
  const { rerankPassages } = await import("../src/lib/retrievalRerank");
  const bySource = new Map<string, typeof tests>();
  for (const test of tests) {
    const entry = bySource.get(test.source) ?? [];
    if (entry.length < perSource) entry.push(test);
    bySource.set(test.source, entry);
  }
  const selected = [...bySource.values()].flat();
  const done = new Set<string>();
  if (resume && existsSync(output)) {
    for (const line of readFileSync(output, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { arm: string; test_id: string; error?: string };
      if (!row.error) done.add(`${row.arm}|${row.test_id}`);
    }
  } else {
    writeFileSync(output, "", "utf8");
  }
  const cells = arms.flatMap((arm) =>
    selected
      .filter((test) => !done.has(`${arm.arm}|${test.id}`))
      .map((test) => ({ arm, test })),
  );
  console.log(
    `rerank-arms: ${cells.length} cells to run (${done.size} resumed), ` +
      `${selected.length} tests x ${arms.length} arms`,
  );
  let next = 0;
  const runCell = async () => {
    for (;;) {
      const index = next++;
      if (index >= cells.length) return;
      const { arm, test } = cells[index];
      const pool = searchPassages({
        sourceDb,
        query: test.query,
        k: 48,
        target: 1600,
        overlap: 120,
        nameWeight: 16,
        perDocCap: 24,
      });
      try {
        const { hits, fallback } = await rerankPassages({
          query: test.query,
          hits: pool,
          model: arm.model,
          top: 6,
          preview: 1600,
          ...(arm.effort ? { effort: arm.effort } : {}),
        });
        const { precision, recall } = charPrecisionRecall(
          hits.map((hit) => ({
            filePath: hit.citation,
            start: hit.start,
            end: hit.end,
          })),
          test.gold,
        );
        appendFileSync(
          output,
          `${JSON.stringify({
            arm: arm.arm,
            model: arm.model,
            effort: arm.effort ?? null,
            test_id: test.id,
            source: test.source,
            p6: precision,
            r6: recall,
            fallback,
          })}\n`,
          "utf8",
        );
      } catch (error) {
        appendFileSync(
          output,
          `${JSON.stringify({
            arm: arm.arm,
            test_id: test.id,
            source: test.source,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
          "utf8",
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => runCell()),
  );
  // Summary over ALL non-error rows in the file (resumed + fresh).
  const rows = readFileSync(output, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      arm: string;
      source: string;
      p6?: number;
      r6?: number;
      fallback?: boolean;
      error?: string;
    })
    .filter((row) => !row.error);
  for (const arm of arms) {
    const armRows = rows.filter((row) => row.arm === arm.arm);
    const sources = [...new Set(armRows.map((row) => row.source))].sort();
    const parts = sources.map(
      (source) =>
        `${source} R6=${mean(
          armRows.filter((row) => row.source === source).map((row) => row.r6 ?? 0),
        ).toFixed(4)}`,
    );
    console.log(
      `${arm.arm}: P6=${mean(armRows.map((row) => row.p6 ?? 0)).toFixed(4)} ` +
        `R6=${mean(armRows.map((row) => row.r6 ?? 0)).toFixed(4)} ` +
        `fallback=${armRows.filter((row) => row.fallback).length}/${armRows.length} | ${parts.join(" ")}`,
    );
  }
  console.log(`Receipts: ${output}`);
  process.exit(0);
}
if (process.argv.includes("--rerank-arms")) {
  rerankArmsMain().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

// Stage 18 registered arms: {chars,clause} x {plain,phrases} at the
// crowned t1600/o120/w16, gated on maud pool R@48. Deterministic, free.
if (process.argv.includes("--stage18")) {
  const output = path.join(
    process.env.LOCALAPPDATA ?? "",
    `OpenLegalData/experiments/legal-grounding/2026-07-30/stage18-retrieval-arms${STRIP_TAG}.jsonl`,
  );
  writeFileSync(output, "", "utf8");
  const arms = [
    { arm: `chars${STRIP_TAG}`, mode: "chars" as const, phrases: false },
    { arm: `chars+phrases${STRIP_TAG}`, mode: "chars" as const, phrases: true },
    { arm: `clause${STRIP_TAG}`, mode: "clause" as const, phrases: false },
    {
      arm: `clause+phrases${STRIP_TAG}`,
      mode: "clause" as const,
      phrases: true,
    },
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

if (!process.argv.includes("--rerank-arms")) {
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
}
