/**
 * Paired arm comparison over LAB results — never compare score totals again.
 *
 * For two arms on one or more tasks: per-criterion majority verdicts across
 * replicates, McNemar exact binomial on the discordant pairs (per task and
 * pooled, with the pooling caveat printed), per-run metrics, price-weighted
 * cost C = uncached + 1.25*cache_write + 0.1*cache_read + r*output at r in
 * {1,2,4,6} (output tokens are never cache-discounted and dominate real
 * cost; cache writes bill at 1.25x, Anthropic-style), and the
 * deliverable-length confound (chars vs criteria passed).
 *
 * Score source preference per run: scores.majority.json > scores.json. Runs
 * judged by different judge models are refused — cross-judge comparison is
 * not a defined quantity.
 *
 * Usage:
 *   npx tsx scripts/lab-compare.ts \
 *     --task capital-markets/compare-closing-documents-against-closing-checklist \
 *     [--task ...] --arm-a mike_markdown_e2e_floor_v1 --arm-b mike_markdown_e2e_v1 \
 *     [--model claude-p-claude-sonnet-4-6]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const LAB_ROOT = path.join(__dirname, "../../benchmarks/harvey-labs");

type CriterionVerdict = { id: string; verdict: string };
type RunScores = {
  judge_model?: string;
  n_passed?: number;
  n_criteria?: number;
  criteria_results?: CriterionVerdict[];
};
type RunMetrics = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  uncached_input_tokens?: number | null;
  cache_adjusted_input_token_equivalent?: number | null;
  provider_round_count?: number;
  wall_clock_seconds?: number;
  deliverable_chars?: number;
  unique_source_exposure_ratio?: number | null;
};
type Run = {
  dir: string;
  scores: RunScores;
  metrics: RunMetrics | null;
  scoreSource: string;
};

function args(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) values.push(process.argv[i + 1]);
  }
  return values;
}

function loadRuns(task: string, arm: string, modelFilter: string | null): Run[] {
  const taskDir = path.join(LAB_ROOT, "results", ...task.split("/"));
  if (!existsSync(taskDir)) return [];
  const runs: Run[] = [];
  for (const armModel of readdirSync(taskDir)) {
    if (!armModel.startsWith(`beaver-${arm}-`)) continue;
    const rest = armModel.slice(`beaver-${arm}-`.length);
    if (modelFilter && rest !== modelFilter) continue;
    const armModelDir = path.join(taskDir, armModel);
    for (const stamp of readdirSync(armModelDir)) {
      const runDir = path.join(armModelDir, stamp);
      const scorePath = ["scores.majority.json", "scores.json"]
        .map((name) => path.join(runDir, name))
        .find((p) => existsSync(p));
      if (!scorePath) continue;
      const metricsPath = path.join(runDir, "metrics.json");
      runs.push({
        dir: runDir,
        scores: JSON.parse(readFileSync(scorePath, "utf8")),
        metrics: existsSync(metricsPath)
          ? JSON.parse(readFileSync(metricsPath, "utf8"))
          : null,
        scoreSource: path.basename(scorePath),
      });
    }
  }
  return runs;
}

/** Majority verdict per criterion across replicate runs (tie -> fail). */
function majorityByCriterion(runs: Run[]): Map<string, boolean> {
  const votes = new Map<string, { pass: number; total: number }>();
  for (const run of runs) {
    for (const criterion of run.scores.criteria_results ?? []) {
      const entry = votes.get(criterion.id) ?? { pass: 0, total: 0 };
      entry.total += 1;
      if (criterion.verdict === "pass") entry.pass += 1;
      votes.set(criterion.id, entry);
    }
  }
  const majority = new Map<string, boolean>();
  for (const [id, { pass, total }] of votes) majority.set(id, pass * 2 > total);
  return majority;
}

/** Exact two-sided binomial test for b successes in b+c trials at p=0.5. */
function mcnemarExactP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const logFact: number[] = [0];
  for (let i = 1; i <= n; i++) logFact.push(logFact[i - 1] + Math.log(i));
  const pmf = (k: number) =>
    Math.exp(logFact[n] - logFact[k] - logFact[n - k] - n * Math.LN2);
  const observed = pmf(Math.min(b, c));
  let p = 0;
  for (let k = 0; k <= n; k++) if (pmf(k) <= observed + 1e-12) p += pmf(k);
  return Math.min(1, p);
}

/**
 * Price-weighted cost at output:input ratio r. The input side is the
 * metrics' cache_adjusted_input_token_equivalent — true-uncached
 * + 1.25*cache_write + 0.1*cache_read, null unless BOTH cache reporting
 * streams are complete — so cache WRITES are billed at the Anthropic-style
 * 1.25x, not silently dropped (they were dropped before 2026-08-05, which
 * flattered big-prefix arms). Fallback reconstructs the same formula from
 * components; a missing write stream is a null cost, never an estimate.
 */
function costAt(metrics: RunMetrics, r: number): number | null {
  const output = metrics.output_tokens ?? 0;
  const adjustedInput =
    metrics.cache_adjusted_input_token_equivalent ??
    (metrics.uncached_input_tokens != null &&
    metrics.cache_write_input_tokens != null
      ? metrics.uncached_input_tokens +
        1.25 * metrics.cache_write_input_tokens +
        0.1 * (metrics.cache_read_input_tokens ?? 0)
      : null);
  if (adjustedInput == null) return null;
  return adjustedInput + r * output;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

function fmt(value: number | null | undefined, digits = 0): string {
  return value == null ? "—" : value.toFixed(digits);
}

function main() {
  const tasks = args("task");
  const armA = args("arm-a")[0];
  const armB = args("arm-b")[0];
  const modelFilter = args("model")[0] ?? null;
  if (!tasks.length || !armA || !armB)
    throw new Error("usage: --task <t> [--task ...] --arm-a <a> --arm-b <b> [--model <slug>]");

  let pooledB = 0;
  let pooledC = 0;
  const lengths: number[] = [];
  const passes: number[] = [];

  for (const task of tasks) {
    const runsA = loadRuns(task, armA, modelFilter);
    const runsB = loadRuns(task, armB, modelFilter);
    console.log(`\n== ${task}`);
    if (!runsA.length || !runsB.length) {
      console.log(
        `  SKIP: ${armA}=${runsA.length} runs, ${armB}=${runsB.length} runs`,
      );
      continue;
    }
    const judges = new Set(
      [...runsA, ...runsB].map((run) => run.scores.judge_model ?? "unknown"),
    );
    if (judges.size > 1)
      throw new Error(
        `${task}: mixed judge models ${[...judges].join(", ")} — within-judge only`,
      );

    for (const [arm, runs] of [
      [armA, runsA],
      [armB, runsB],
    ] as const) {
      for (const run of runs) {
        const m = run.metrics ?? {};
        const passed = run.scores.n_passed ?? null;
        console.log(
          `  ${arm} ${path.basename(run.dir)} [${run.scoreSource}]: ` +
            `${passed}/${run.scores.n_criteria} | deliv=${fmt(m.deliverable_chars)}c ` +
            `uncached=${fmt(m.uncached_input_tokens)} cacheW=${fmt(m.cache_write_input_tokens)} cacheRead=${fmt(m.cache_read_input_tokens)} ` +
            `out=${fmt(m.output_tokens)} rounds=${fmt(m.provider_round_count)} ` +
            `wall=${fmt(m.wall_clock_seconds)}s | ` +
            `C@1=${fmt(costAt(m, 1))} C@2=${fmt(costAt(m, 2))} C@4=${fmt(costAt(m, 4))} C@6=${fmt(costAt(m, 6))}`,
        );
        if (m.deliverable_chars != null && passed != null) {
          lengths.push(m.deliverable_chars);
          passes.push(passed / (run.scores.n_criteria ?? 1));
        }
      }
    }

    const majorityA = majorityByCriterion(runsA);
    const majorityB = majorityByCriterion(runsB);
    let b = 0;
    let c = 0;
    const aOnly: string[] = [];
    const bOnly: string[] = [];
    for (const [id, aPass] of majorityA) {
      const bPass = majorityB.get(id);
      if (bPass === undefined) continue;
      if (aPass && !bPass) {
        b += 1;
        aOnly.push(id);
      } else if (!aPass && bPass) {
        c += 1;
        bOnly.push(id);
      }
    }
    pooledB += b;
    pooledC += c;
    console.log(
      `  McNemar (majority verdicts): ${armA}-only passes b=${b} [${aOnly.join(",")}], ` +
        `${armB}-only passes c=${c} [${bOnly.join(",")}], exact p=${mcnemarExactP(b, c).toFixed(4)}`,
    );
  }

  console.log(
    `\n== POOLED across ${tasks.length} task(s): b=${pooledB} c=${pooledC} ` +
      `p=${mcnemarExactP(pooledB, pooledC).toFixed(4)}`,
  );
  console.log(
    "   (pooling caveat: criteria within a task share one trajectory — treat as descriptive, decide per-task + sign test)",
  );
  const r = pearson(lengths, passes);
  if (r != null)
    console.log(
      `   deliverable_chars vs pass-rate Pearson r=${r.toFixed(3)} over ${lengths.length} runs (the verbosity confound)`,
    );
}

main();
