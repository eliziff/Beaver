/**
 * Four-arm evaluation runner CLI (docs/beaver-evaluation-context-plan.md §7,
 * Issue 3). One command produces isolated outputs, a validated run trace per
 * arm, and a comparison report under benchmarks/beaver_can/private_results/:
 *
 *   EVAL_LIVE=1 npx tsx scripts/eval-run.ts \
 *     --task CAN-RETRIEVAL-001 --arms bare_model,oracle_sources
 *
 * Flags: --task <id> (required, tasks/dev id), --arms a,b (default all four),
 * --model <id> (default gpt-5-mini). Live model calls are refused unless
 * EVAL_LIVE=1; the only working key on this machine is OPENAI_API_KEY.
 *
 * bare_model / oracle_sources call the model directly in-process. Beaver arms
 * spawn scripts/eval-beaver-arm.ts in a child process so each arm gets a
 * fresh app bound to its own data home and LLM-manifest file (token receipts).
 */
import "../src/lib/loadEnv";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  EVAL_ARMS,
  beaverCanTaskDir,
  runEval,
  type ArmExecutor,
  type EvalArm,
} from "../src/lib/evalRunner";
import { providerForModel, type NormalizedLlmUsage } from "../src/lib/llm";

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
}

/** Sum provider-reported usage across the arm's LLM context manifests. */
function sumManifestUsage(manifestFile: string): NormalizedLlmUsage | null {
  if (!existsSync(manifestFile)) return null;
  const usages = readFileSync(manifestFile, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(
      (line) => (JSON.parse(line) as { usage?: NormalizedLlmUsage }).usage,
    )
    .filter((usage): usage is NormalizedLlmUsage => Boolean(usage));
  if (!usages.length) return null;
  const sum = (pick: (usage: NormalizedLlmUsage) => number | null) => {
    const known = usages.map(pick).filter((value): value is number => value !== null);
    return known.length ? known.reduce((total, value) => total + value, 0) : null;
  };
  return {
    inputTokens: sum((usage) => usage.inputTokens),
    outputTokens: sum((usage) => usage.outputTokens),
    reasoningTokens: sum((usage) => usage.reasoningTokens),
    cacheReadInputTokens: sum((usage) => usage.cacheReadInputTokens),
    cacheWriteInputTokens: sum((usage) => usage.cacheWriteInputTokens),
  };
}

const beaverTransportExecutor =
  (taskDir: string): ArmExecutor =>
  async ({ loaded, arm, armDir, model }) => {
    const dataHome = path.join(armDir, "data");
    const resultFile = path.join(armDir, "transport-result.json");
    const manifestFile = path.join(armDir, "llm-manifests.jsonl");
    mkdirSync(dataHome, { recursive: true });
    const child = spawnSync(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        path.join(__dirname, "eval-beaver-arm.ts"),
        "--task-dir",
        taskDir,
        "--model",
        model,
        "--out",
        resultFile,
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "",
          AUTH_MODE: "anonymous",
          OPEN_LEGAL_DATA_HOME: dataHome,
          MIKE_LOCAL_DATA_DIR: path.join(dataHome, "apps", "mike", "library"),
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          MIKE_LLM_CONTEXT_MANIFEST_PATH: manifestFile,
        },
        stdio: "inherit",
        timeout: 20 * 60_000,
      },
    );
    if (child.status !== 0)
      throw new Error(`${arm}: transport child exited with ${child.status}`);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
      output_text: string;
      uploaded_source_ids: string[];
      turns: unknown[];
    };
    return {
      outputText: result.output_text,
      provider: providerForModel(model),
      model,
      usage: sumManifestUsage(manifestFile),
      retrievedSourceIds: result.uploaded_source_ids,
      promptHashInput: loaded.prompt,
      receipts: result,
    };
  };

async function main() {
  if (process.env.EVAL_LIVE !== "1") {
    console.error(
      "Refusing to run: live model calls only run with EVAL_LIVE=1 " +
        "(unit tests cover the runner without network).",
    );
    process.exit(2);
  }
  const taskId = flag("task");
  const model = flag("model", "gpt-5-mini");
  const arms = flag("arms", EVAL_ARMS.join(",")).split(",") as EvalArm[];
  for (const arm of arms) {
    if (!EVAL_ARMS.includes(arm))
      throw new Error(`unknown arm ${arm}; valid: ${EVAL_ARMS.join(", ")}`);
  }
  const taskDir = beaverCanTaskDir(taskId);
  const transport = beaverTransportExecutor(taskDir);
  const { runDir, reportPath, report } = await runEval({
    taskDir,
    arms,
    model,
    executors: { beaver_baseline: transport, beaver_candidate: transport },
  });
  console.log(`\nRun directory: ${runDir}`);
  console.log(`Report: ${reportPath}\n`);
  console.log(readFileSync(path.join(runDir, "comparison.md"), "utf8"));
  console.log(
    `Summary: ${report.arms
      .map((arm) => `${arm.arm} all_pass=${arm.all_pass}`)
      .join("; ")}`,
  );
}

main().catch((error) => {
  console.error("[eval-run]", error);
  process.exit(1);
});
