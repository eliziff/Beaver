/**
 * LegalBench external-benchmark run. Downloads/verifies the pinned task data
 * (official test splits + upstream base prompts), sends the official prompts
 * to one model, scores with the official exact-match balanced accuracy, and
 * reports our number next to the paper's published GPT-4 baseline:
 *
 *   EVAL_LIVE=1 npx tsx scripts/legalbench-run.ts \
 *     --task abercrombie,cuad_anti-assignment --limit 25
 *
 * Flags: --task <name,name|all> (default all), --effort <low|medium|high>
 * (optional, forwarded as reasoningEffort), --model <id> (default
 * gpt-5-mini), --limit <n|all> (default 25 examples per task, deterministic
 * class-stratified prefix of the official test split — see
 * selectStratifiedRows), --setup-only (download/verify data, no model calls),
 * --write-manifest (first authoring / deliberate re-pin only).
 *
 * Network (HF datasets-server + raw.githubusercontent prompt files) and model
 * calls both require EVAL_LIVE=1; with the data already pinned on disk,
 * --setup-only re-verifies fully offline. Results land under git-ignored
 * benchmarks/legalbench/results/ with one validated run trace per task.
 */
import "../src/lib/loadEnv";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateCostUsd } from "../src/lib/evalRunner";
import {
  LEGALBENCH_DATA_DIR,
  LEGALBENCH_RESULTS_DIR,
  LEGALBENCH_TASKS,
  MANIFEST_PATH,
  SCORING_VERSION,
  dataFilePath,
  fetchTaskRows,
  fillPromptTemplate,
  legalBenchTask,
  promptFilePath,
  scoreTask,
  selectStratifiedRows,
  taskDataBytes,
  taskDataSchema,
  validateLegalBenchManifest,
  verifyAgainstManifest,
  verifyManifestMatchesRegistry,
  type LegalBenchManifest,
  type ManifestFile,
  type TaskScore,
} from "../src/lib/legalbench";
import {
  providerForModel,
  streamChatWithTools,
  type NormalizedLlmUsage,
} from "../src/lib/llm";
import { gitRunState, sha256Hex, writeRunTrace } from "../src/lib/runTrace";

const REPO_ROOT = path.join(__dirname, "..", "..");
const repoRelative = (file: string) =>
  path.relative(REPO_ROOT, file).split(path.sep).join("/");

const UPSTREAM = {
  repository: "https://github.com/HazyResearch/legalbench",
  /** main @ 2026-03-30; base_prompt.txt files are fetched at this commit. */
  prompts_commit: "b46bf4ffae90524b2b72aaa30e7745fe9db64481",
  hf_dataset: "nguha/legalbench",
  hf_rows_api: "https://datasets-server.huggingface.co/rows",
  paper: "https://arxiv.org/abs/2308.11462",
  license_note:
    "LegalBench tasks carry per-task licenses (paper license table). All nine selected tasks are CC BY 4.0. The Learned Hands issue-spotting family was excluded because it is CC BY-NC-SA 4.0 (noncommercial); rule_qa was excluded because the paper scores it manually. Downloaded rows and prompt files stay in the git-ignored data/ directory; only this manifest is committed.",
} as const;

const flag = (name: string, fallback?: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error(`missing --${name}`);
  return value;
};
const has = (name: string) => process.argv.includes(`--${name}`);
const LIVE = process.env.EVAL_LIVE === "1";

// ---------------------------------------------------------------------------
// Data: download when live, then verify byte-for-byte against the manifest.
// ---------------------------------------------------------------------------

async function downloadDerivedFiles(): Promise<{
  files: ManifestFile[];
  rowCounts: Map<string, number>;
}> {
  const files: ManifestFile[] = [];
  const rowCounts = new Map<string, number>();
  for (const task of LEGALBENCH_TASKS) {
    const promptUrl = `https://raw.githubusercontent.com/HazyResearch/legalbench/${UPSTREAM.prompts_commit}/tasks/${task.task}/base_prompt.txt`;
    const response = await fetch(promptUrl);
    if (!response.ok)
      throw new Error(`prompt download failed: ${promptUrl} HTTP ${response.status}`);
    files.push({
      path: promptFilePath(task.task),
      bytes: Buffer.from(await response.arrayBuffer()),
    });
    const rows = await fetchTaskRows(task.task);
    rowCounts.set(task.task, rows.length);
    files.push({
      path: dataFilePath(task.task),
      bytes: taskDataBytes(task.task, rows),
    });
    console.log(`fetched ${task.task}: ${rows.length} test rows`);
  }
  return { files, rowCounts };
}

function writeManifest(files: ManifestFile[], rowCounts: Map<string, number>) {
  const entry = (filePath: string) => {
    const file = files.find((f) => f.path === filePath)!;
    return {
      path: filePath,
      sha256: sha256Hex(file.bytes),
      bytes: file.bytes.length,
    };
  };
  const manifest = validateLegalBenchManifest({
    schema_version: "1",
    name: "legalbench",
    upstream: UPSTREAM,
    scoring: {
      version: SCORING_VERSION,
      normalization:
        "TypeScript port of normalize() and evaluate_exact_match_balanced_accuracy() in HazyResearch/legalbench evaluation.py",
    },
    tasks: LEGALBENCH_TASKS.map((task) => ({
      task: task.task,
      capability: task.capability,
      labels: [...task.labels],
      license: task.license,
      gpt4_balanced_accuracy: task.gpt4_balanced_accuracy,
      gpt4_source: task.gpt4_source,
      test_rows: rowCounts.get(task.task)!,
      prompt: entry(promptFilePath(task.task)),
      data: entry(dataFilePath(task.task)),
    })),
  });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote manifest: ${MANIFEST_PATH}`);
}

/** Returns the verified manifest, downloading data first when needed. */
async function ensureData(): Promise<LegalBenchManifest> {
  const pinnedPaths = LEGALBENCH_TASKS.flatMap((task) => [
    promptFilePath(task.task),
    dataFilePath(task.task),
  ]);
  const missing = pinnedPaths.filter(
    (file) => !existsSync(path.join(LEGALBENCH_DATA_DIR, file)),
  );
  if (missing.length || has("write-manifest")) {
    if (!LIVE) {
      console.error(
        `Missing ${missing.length} derived files under ${LEGALBENCH_DATA_DIR} and EVAL_LIVE!=1 — refusing to touch the network. Run with EVAL_LIVE=1 once to download.`,
      );
      process.exit(2);
    }
    const { files, rowCounts } = await downloadDerivedFiles();
    for (const file of files) {
      const target = path.join(LEGALBENCH_DATA_DIR, file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    if (has("write-manifest")) writeManifest(files, rowCounts);
  }
  if (!existsSync(MANIFEST_PATH))
    throw new Error(
      `no manifest at ${MANIFEST_PATH}; run with --write-manifest to pin`,
    );
  const manifest = validateLegalBenchManifest(
    JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
  );
  const onDisk = manifest.tasks.flatMap((task) =>
    [task.prompt.path, task.data.path].map((file) => ({
      path: file,
      bytes: readFileSync(path.join(LEGALBENCH_DATA_DIR, file)),
    })),
  );
  const problems = [
    ...verifyManifestMatchesRegistry(manifest),
    ...verifyAgainstManifest(manifest, onDisk),
  ];
  if (problems.length)
    throw new Error(
      `data does not match manifest (${problems.length} problems):\n${problems.join("\n")}`,
    );
  console.log(
    `Manifest verification OK: ${onDisk.length} files byte-identical to ${MANIFEST_PATH}`,
  );
  return manifest;
}

// ---------------------------------------------------------------------------
// Live model runs over the official prompts.
// ---------------------------------------------------------------------------

type TaskRun = {
  score: TaskScore;
  gpt4_balanced_accuracy: number;
  usage: NormalizedLlmUsage;
  latencyMs: number;
  estimatedCostUsd: number | null;
  tracePath: string;
};

const sumUsage = (usages: (NormalizedLlmUsage | undefined)[]): NormalizedLlmUsage => {
  const sum = (pick: (u: NormalizedLlmUsage) => number | null) => {
    const known = usages
      .map((usage) => (usage ? pick(usage) : null))
      .filter((value): value is number => value !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };
  return {
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    reasoningTokens: sum((u) => u.reasoningTokens),
    cacheReadInputTokens: sum((u) => u.cacheReadInputTokens),
    cacheWriteInputTokens: sum((u) => u.cacheWriteInputTokens),
  };
};

async function runTask(args: {
  manifest: LegalBenchManifest;
  manifestBytes: Buffer;
  taskName: string;
  model: string;
  effort?: string;
  limit: number;
  runDir: string;
}): Promise<TaskRun> {
  const task = legalBenchTask(args.taskName);
  const pinned = args.manifest.tasks.find((t) => t.task === task.task)!;
  const template = readFileSync(
    path.join(LEGALBENCH_DATA_DIR, pinned.prompt.path),
    "utf8",
  );
  const { rows } = taskDataSchema.parse(
    JSON.parse(
      readFileSync(path.join(LEGALBENCH_DATA_DIR, pinned.data.path), "utf8"),
    ),
  );
  const selected = selectStratifiedRows(rows, args.limit);
  const prompts = selected.map((row) => fillPromptTemplate(template, row));

  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  const results = new Array<{ fullText: string; usage?: NormalizedLlmUsage }>(
    prompts.length,
  );
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, prompts.length) }, async () => {
      while (next < prompts.length) {
        const index = next++;
        results[index] = await streamChatWithTools({
          model: args.model,
          reasoningEffort: args.effort,
          systemPrompt: "",
          messages: [{ role: "user", content: prompts[index] }],
        });
      }
    }),
  );
  const latencyMs = performance.now() - startedMs;

  const score = scoreTask(
    task,
    selected.map((row, index) => ({
      index: Number(row.index ?? index),
      gold: String(row.answer),
      generation: results[index].fullText,
    })),
  );
  const usage = sumUsage(results.map((result) => result.usage));
  const estimatedCostUsd = estimateCostUsd(args.model, usage);

  const taskDir = path.join(args.runDir, task.task);
  mkdirSync(taskDir, { recursive: true });
  const generationsPath = path.join(taskDir, "generations.jsonl");
  writeFileSync(
    generationsPath,
    `${score.examples
      .map((example, index) =>
        JSON.stringify({ ...example, generation: results[index].fullText }),
      )
      .join("\n")}\n`,
  );
  const git = gitRunState(__dirname);
  const tracePath = writeRunTrace(
    {
      schema_version: "1",
      run_id: randomUUID(),
      task_id: `LEGALBENCH-${task.task}`,
      arm: "bare_model",
      started_at: startedAt,
      git_commit: git.git_commit,
      dirty_worktree: git.dirty_worktree,
      provider: providerForModel(args.model),
      model: args.model,
      effort: null,
      context_strategy: "official_base_prompt",
      cache_strategy: "none",
      prompt_hash: sha256Hex(template),
      source_manifest_hash: sha256Hex(args.manifestBytes),
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cached_input_tokens: usage.cacheReadInputTokens,
      cache_write_tokens: usage.cacheWriteInputTokens,
      latency_ms: latencyMs,
      estimated_cost: estimatedCostUsd ?? null,
      retrieved_source_ids: [],
      artifact_paths: [repoRelative(generationsPath)],
      artifact_hashes: [sha256Hex(readFileSync(generationsPath))],
      fatal_errors: [],
      all_pass: null,
      score: {
        n: score.n,
        correct: score.correct,
        accuracy: score.accuracy,
        balanced_accuracy: score.balanced_accuracy,
        unparsed: score.unparsed,
        gpt4_balanced_accuracy: task.gpt4_balanced_accuracy,
      },
      scoring_version: SCORING_VERSION,
      manual_review_minutes: null,
    },
    taskDir,
  );
  return {
    score,
    gpt4_balanced_accuracy: task.gpt4_balanced_accuracy,
    usage,
    latencyMs,
    estimatedCostUsd,
    tracePath,
  };
}

const pct = (fraction: number) => (fraction * 100).toFixed(1);

function markdown(model: string, runs: Map<string, TaskRun>): string {
  const lines = [
    "# LegalBench — official base prompts, official test split",
    "",
    `- model: ${model}; scoring_version: ${SCORING_VERSION}`,
    "- GPT-4 column: published balanced accuracy from arXiv:2308.11462 (full test split).",
    "- Limited runs score a deterministic class-stratified prefix of the official split (selectStratifiedRows), so our n may be smaller than the paper's.",
    "",
    "| task | n | accuracy | balanced acc | GPT-4 (paper) | unparsed | in tok | out tok | est. cost |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, run] of runs) {
    lines.push(
      `| ${name} | ${run.score.n} | ${pct(run.score.accuracy)} | ${pct(run.score.balanced_accuracy)} | ` +
        `${run.gpt4_balanced_accuracy.toFixed(1)} | ${run.score.unparsed} | ` +
        `${run.usage.inputTokens ?? "—"} | ${run.usage.outputTokens ?? "—"} | ` +
        `${run.estimatedCostUsd === null ? "—" : `$${run.estimatedCostUsd.toFixed(4)}`} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const manifest = await ensureData();
  if (has("setup-only")) return;
  if (!LIVE) {
    console.error(
      "Refusing to run: live model calls only run with EVAL_LIVE=1 " +
        "(unit tests cover scoring without network).",
    );
    process.exit(2);
  }
  const model = flag("model", "gpt-5-mini");
  const effort = flag("effort", "") || undefined;
  const limitRaw = flag("limit", "25");
  const limit = limitRaw === "all" ? 0 : Number.parseInt(limitRaw, 10);
  if (Number.isNaN(limit) || limit < 0)
    throw new Error(`bad --limit ${limitRaw}`);
  const taskArg = flag("task", "all");
  const taskNames =
    taskArg === "all"
      ? LEGALBENCH_TASKS.map((task) => task.task)
      : taskArg.split(",").map((name) => legalBenchTask(name).task);

  const manifestBytes = readFileSync(MANIFEST_PATH);
  const runDir = path.join(
    LEGALBENCH_RESULTS_DIR,
    `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(runDir, { recursive: true });

  const runs = new Map<string, TaskRun>();
  for (const taskName of taskNames) {
    console.log(`\nRunning ${taskName} (limit ${limit || "all"})...`);
    const run = await runTask({
      manifest,
      manifestBytes,
      taskName,
      model,
      effort,
      limit,
      runDir,
    });
    runs.set(taskName, run);
    console.log(
      `${taskName}: ${run.score.correct}/${run.score.n} correct, ` +
        `balanced acc ${pct(run.score.balanced_accuracy)} vs GPT-4 ${run.gpt4_balanced_accuracy.toFixed(1)}, ` +
        `${run.score.unparsed} unparsed`,
    );
  }

  const report = markdown(model, runs);
  writeFileSync(path.join(runDir, "report.md"), report);
  writeFileSync(
    path.join(runDir, "report.json"),
    `${JSON.stringify(
      Object.fromEntries(
        [...runs].map(([name, run]) => [
          name,
          {
            score: run.score,
            gpt4_balanced_accuracy: run.gpt4_balanced_accuracy,
            usage: run.usage,
            latency_ms: run.latencyMs,
            estimated_cost_usd: run.estimatedCostUsd,
          },
        ]),
      ),
      null,
      2,
    )}\n`,
  );
  console.log(`\n${report}`);
  console.log(`Run directory: ${runDir}`);
}

main().catch((error) => {
  console.error("[legalbench-run]", error);
  process.exit(1);
});
