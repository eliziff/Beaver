/**
 * Compare two LAB runs of the same task. Reports what each arm spent and
 * what it did, so a leanness claim is a number rather than a feeling.
 *
 *   npx tsx scripts/ab-compare.ts <run-id-A> <run-id-B> [--lab-root <dir>]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LAB_ROOT = "C:/Users/elias/Desktop/harvey-labs";

type Metrics = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  wall_clock_seconds?: number;
  documents_read?: number;
  total_documents?: number;
  finished_cleanly?: boolean;
};

function load(runId: string) {
  const dir = path.join(LAB_ROOT, "results", runId);
  const metricsPath = path.join(dir, "metrics.json");
  const receiptsPath = path.join(dir, "beaver-receipts.json");
  if (!existsSync(metricsPath)) return null;
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8")) as Metrics;
  const receipts = existsSync(receiptsPath)
    ? (JSON.parse(readFileSync(receiptsPath, "utf8")) as {
        tool_calls?: string[];
        answer?: string;
        docs_created?: string[];
      })
    : {};
  return { dir, metrics, receipts };
}

const pct = (a: number, b: number) =>
  a === 0 ? "—" : `${(((b - a) / a) * 100).toFixed(1)}%`;

function main() {
  const [idA, idB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const A = load(idA);
  const B = load(idB);
  if (!A || !B) {
    console.log(`missing results: A=${Boolean(A)} B=${Boolean(B)}`);
    return;
  }

  const rows: [string, number | string, number | string, string][] = [
    [
      "input tokens",
      A.metrics.input_tokens ?? 0,
      B.metrics.input_tokens ?? 0,
      pct(A.metrics.input_tokens ?? 0, B.metrics.input_tokens ?? 0),
    ],
    [
      "output tokens",
      A.metrics.output_tokens ?? 0,
      B.metrics.output_tokens ?? 0,
      pct(A.metrics.output_tokens ?? 0, B.metrics.output_tokens ?? 0),
    ],
    [
      "total tokens",
      A.metrics.total_tokens ?? 0,
      B.metrics.total_tokens ?? 0,
      pct(A.metrics.total_tokens ?? 0, B.metrics.total_tokens ?? 0),
    ],
    [
      "wall clock s",
      (A.metrics.wall_clock_seconds ?? 0).toFixed(0),
      (B.metrics.wall_clock_seconds ?? 0).toFixed(0),
      pct(A.metrics.wall_clock_seconds ?? 0, B.metrics.wall_clock_seconds ?? 0),
    ],
    [
      "tool calls",
      A.receipts.tool_calls?.length ?? 0,
      B.receipts.tool_calls?.length ?? 0,
      pct(A.receipts.tool_calls?.length ?? 0, B.receipts.tool_calls?.length ?? 0),
    ],
    [
      "docs read",
      `${A.metrics.documents_read ?? 0}/${A.metrics.total_documents ?? 0}`,
      `${B.metrics.documents_read ?? 0}/${B.metrics.total_documents ?? 0}`,
      "",
    ],
    [
      "answer chars",
      (A.receipts.answer ?? "").length,
      (B.receipts.answer ?? "").length,
      pct((A.receipts.answer ?? "").length, (B.receipts.answer ?? "").length),
    ],
  ];

  console.log(`A = ${idA} (baseline)   B = ${idB} (lean)\n`);
  console.log(
    `${"metric".padEnd(16)}${"A".padStart(12)}${"B".padStart(12)}${"B vs A".padStart(10)}`,
  );
  for (const [label, a, b, delta] of rows) {
    console.log(
      `${label.padEnd(16)}${String(a).padStart(12)}${String(b).padStart(12)}${delta.padStart(10)}`,
    );
  }

  const seq = (calls?: string[]) => (calls ?? []).join(" → ") || "(none)";
  console.log(`\nA tools: ${seq(A.receipts.tool_calls)}`);
  console.log(`\nB tools: ${seq(B.receipts.tool_calls)}`);
  console.log(
    `\nclean finish: A=${A.metrics.finished_cleanly} B=${B.metrics.finished_cleanly}`,
  );
}

main();
