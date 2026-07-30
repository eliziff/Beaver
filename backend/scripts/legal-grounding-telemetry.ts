/**
 * Token-usage telemetry over legal-grounding experiment receipts.
 *
 * Sweeps every *.jsonl receipt file in the experiments directory (or the
 * files given as arguments), dedupes cells the same way the analysis
 * scripts do (last row per model|arm|checker|case_id|policy|effort wins),
 * and aggregates per model x effort: cells, errors, uncached input,
 * cache reads/writes, output, reasoning, latency. Cache-aware on both
 * lanes: codex reports cached_tokens + reasoning_tokens via the
 * Responses API; claude-p reports cache_read/write_input_tokens — its
 * per-turn `inputTokens` is UNCACHED input only, so "effective input"
 * (uncached + cache read) is the comparable volume column and
 * "billable-shaped" cost intuition should weight cache reads low.
 *
 * Usage (from backend/):
 *   npx tsx scripts/legal-grounding-telemetry.ts            # sweep default dir
 *   npx tsx scripts/legal-grounding-telemetry.ts a.jsonl b.jsonl
 *   npx tsx scripts/legal-grounding-telemetry.ts --by-run   # add per-file tables
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

type Row = {
  model: string;
  arm: string;
  effort?: string;
  checker_model: string | null;
  case_id: string;
  rank_policy: string | null;
  latency_ms: number;
  error: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    reasoningTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
  };
};

const args = process.argv.slice(2).filter((arg) => arg !== "--by-run");
const byRun = process.argv.includes("--by-run");
const defaultDir = path.join(
  process.env.LOCALAPPDATA ?? "",
  "OpenLegalData/experiments/legal-grounding/2026-07-30",
);
const files = args.length
  ? args
  : existsSync(defaultDir)
    ? readdirSync(defaultDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => path.join(defaultDir, name))
    : [];
if (!files.length) throw new Error("no receipt files found");

type Agg = {
  cells: number;
  errors: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  latencyMs: number;
};
const empty = (): Agg => ({
  cells: 0,
  errors: 0,
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  latencyMs: 0,
});

function table(rows: Map<string, Agg>, title: string) {
  console.log(`\n== ${title}`);
  console.log(
    "model/effort | cells | err | input | cacheRead | cacheWrite | output | reasoning | in/cell | out/cell | s/cell",
  );
  for (const [key, agg] of [...rows.entries()].sort()) {
    const effective = agg.input + agg.cacheRead;
    console.log(
      `${key} | ${agg.cells} | ${agg.errors} | ${agg.input} | ${agg.cacheRead} | ${agg.cacheWrite} | ${agg.output} | ${agg.reasoning} | ${Math.round(effective / Math.max(1, agg.cells))} | ${Math.round(agg.output / Math.max(1, agg.cells))} | ${(agg.latencyMs / Math.max(1, agg.cells) / 1000).toFixed(1)}`,
    );
  }
}

const overall = new Map<string, Agg>();
for (const file of files) {
  const byCell = new Map<string, Row>();
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const row = JSON.parse(line) as Row;
    byCell.set(
      `${row.model}|${row.arm}|${row.checker_model ?? "same"}|${row.case_id}|${row.rank_policy ?? "-"}|${row.effort ?? "-"}`,
      row,
    );
  }
  const perFile = new Map<string, Agg>();
  for (const row of byCell.values()) {
    const key = `${row.model} @${row.effort ?? "?"}`;
    for (const target of [overall, perFile]) {
      const agg = target.get(key) ?? empty();
      agg.cells += 1;
      if (row.error) agg.errors += 1;
      agg.input += row.usage?.inputTokens ?? 0;
      agg.cacheRead += row.usage?.cacheReadInputTokens ?? 0;
      agg.cacheWrite += row.usage?.cacheWriteInputTokens ?? 0;
      agg.output += row.usage?.outputTokens ?? 0;
      agg.reasoning += row.usage?.reasoningTokens ?? 0;
      agg.latencyMs += row.latency_ms ?? 0;
      target.set(key, agg);
    }
  }
  if (byRun) table(perFile, path.basename(file));
}
table(overall, `all runs (${files.length} files, deduped per file)`);
