/**
 * Four-arm evaluation runner for Beaver-CAN tasks
 * (docs/beaver-evaluation-context-plan.md §7–§9, Issue 3).
 *
 * One `runEval` call executes the selected arms over one task, writes an
 * isolated output directory plus a validated Issue-1 run trace per arm, and
 * emits a comparison report (report.json + comparison.md) covering all-pass,
 * fatal errors, diagnostic submetrics, cost, and latency. Everything lands
 * under `benchmarks/beaver_can/private_results/` (git-ignored).
 *
 * Scoring binds the Issue-4 deterministic validator primitives to the gold
 * contract. A gold field with no validator primitive yet is recorded as an
 * explicit `null` (unscored), never faked: `all_pass` is `true` only when
 * every criterion is deterministically checked and passes, `false` on any
 * fatal error or failed criterion, otherwise `null`.
 *
 * Arm inputs (§7):
 * - `bare_model`        — ONLY the task prompt, direct model call.
 * - `oracle_sources`    — the task prompt plus the full source-packet text
 *                         inlined (roles/supersession metadata never shown).
 * - `beaver_baseline` / `beaver_candidate` — the real local chat transport,
 *   driven in-process by the executor supplied from scripts/eval-run.ts. The
 *   arms differ only by the frozen-baseline metadata recorded in the report;
 *   with no configuration delta supplied, candidate == current tree and the
 *   report says so.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BEAVER_CAN_DEV_TASKS_DIR,
  BEAVER_CAN_DIR,
  beaverCanContentHash,
  loadBeaverCanTaskDir,
  type LoadedBeaverCanTask,
} from "./beaverCan";
import {
  forbiddenSources,
  missingHeadings,
  quotationOccurs,
  seededIdentifierLeaks,
} from "./evalValidators";
import {
  providerForModel,
  streamChatWithTools,
  type NormalizedLlmUsage,
} from "./llm";
import { gitRunState, sha256Hex, writeRunTrace } from "./runTrace";

export const EVAL_ARMS = [
  "bare_model",
  "oracle_sources",
  "beaver_baseline",
  "beaver_candidate",
] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

export const SCORING_VERSION = "beaver-can-arm-scoring-1";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const repoRelative = (file: string) =>
  path.relative(REPO_ROOT, file).split(path.sep).join("/");

export function beaverCanTaskDir(taskId: string): string {
  return path.join(BEAVER_CAN_DEV_TASKS_DIR, taskId);
}

// ---------------------------------------------------------------------------
// Scoring: bind Issue-4 validator primitives to the gold contract.
// ---------------------------------------------------------------------------

/** null = no deterministic validator bound yet — unscored, never faked. */
export type CriterionResult = {
  pass: boolean;
  evidence: Record<string, unknown>;
} | null;

export type BeaverCanScore = {
  scoring_version: string;
  criteria: Record<string, CriterionResult>;
  /** One entry per task fatal_errors name: fired / clean / null (no validator). */
  fatal_errors: Record<string, boolean | null>;
  fired_fatal_errors: string[];
  all_pass: boolean | null;
  /** Numeric submetrics for the run-trace `score` field. */
  numeric: Record<string, number>;
};

export function scoreBeaverCanOutput(
  loaded: LoadedBeaverCanTask,
  outputText: string,
): BeaverCanScore {
  const { task, gold } = loaded;
  const citedSourceIds = [
    ...new Set(
      (outputText.match(/SRC-\d{3}/giu) ?? []).map((id) => id.toUpperCase()),
    ),
  ];
  const outsidePacket = forbiddenSources(citedSourceIds, task.source_ids);
  const leaks = gold.seeded_identifiers
    ? seededIdentifierLeaks(outputText, gold.seeded_identifiers)
    : null;
  const quoteChecks = gold.required_quotations
    ? gold.required_quotations.map((quotation) => ({
        source_id: quotation.source_id,
        quote_prefix: quotation.quote.slice(0, 60),
        ...quotationOccurs(outputText, quotation.quote),
      }))
    : null;
  const headingsMissing = gold.required_headings
    ? missingHeadings(outputText, gold.required_headings)
    : null;

  const criteria: Record<string, CriterionResult> = {
    packet_sources_only: {
      pass: outsidePacket.length === 0,
      evidence: {
        cited_source_ids: citedSourceIds,
        outside_packet: outsidePacket,
      },
    },
    // Gold fields with no validator primitive yet (Issue 4): unscored.
    required_issues: null,
    required_authorities: null,
    pinpoints_valid: null,
    required_conclusions: null,
    forbidden_claims: null,
  };
  if (quoteChecks) {
    criteria.required_quotations = {
      pass: quoteChecks.every((check) => check.found),
      evidence: { checks: quoteChecks },
    };
  }
  if (leaks) {
    criteria.no_seeded_identifier_leak = {
      pass: leaks.length === 0,
      evidence: { leaked: leaks },
    };
  }
  if (headingsMissing) {
    criteria.required_headings = {
      pass: headingsMissing.length === 0,
      evidence: { missing: headingsMissing },
    };
  }

  const fatal_errors: Record<string, boolean | null> = {};
  for (const name of task.fatal_errors) {
    fatal_errors[name] =
      name === "outside_source_packet"
        ? outsidePacket.length > 0
        : name === "seeded_identifier_leak"
          ? leaks
            ? leaks.length > 0
            : null
          : null;
  }
  const fired_fatal_errors = Object.entries(fatal_errors)
    .filter(([, fired]) => fired === true)
    .map(([name]) => name);

  const results = Object.values(criteria);
  const anyFail =
    fired_fatal_errors.length > 0 ||
    results.some((result) => result !== null && !result.pass);
  const all_pass = anyFail
    ? false
    : results.every((result) => result?.pass)
      ? true
      : null;

  return {
    scoring_version: SCORING_VERSION,
    criteria,
    fatal_errors,
    fired_fatal_errors,
    all_pass,
    numeric: {
      cited_source_id_count: citedSourceIds.length,
      outside_packet_citations: outsidePacket.length,
      ...(quoteChecks && {
        required_quotations_total: quoteChecks.length,
        required_quotations_found: quoteChecks.filter((c) => c.found).length,
      }),
      ...(leaks && { seeded_identifier_leaks: leaks.length }),
      ...(headingsMissing && {
        missing_required_headings: headingsMissing.length,
      }),
      output_chars: outputText.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Cost (§9: report estimated cost and cost per passing task).
// ---------------------------------------------------------------------------

/** USD per 1M tokens; OpenAI published pricing, checked 2026-07. */
const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
};

export function estimateCostUsd(
  model: string | null,
  usage: NormalizedLlmUsage | null,
): number | null {
  if (!model || !usage) return null;
  const pricing = MODEL_PRICING_USD_PER_MTOK[model];
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null)
    return null;
  const cached = usage.cacheReadInputTokens ?? 0;
  return (
    ((usage.inputTokens - cached) * pricing.input +
      cached * pricing.cachedInput +
      usage.outputTokens * pricing.output) /
    1e6
  );
}

// ---------------------------------------------------------------------------
// Arm executors.
// ---------------------------------------------------------------------------

export type ArmContext = {
  loaded: LoadedBeaverCanTask;
  arm: EvalArm;
  /** Per-arm output directory; already created, isolated per arm. */
  armDir: string;
  model: string;
};

export type ArmExecution = {
  outputText: string;
  provider: string | null;
  model: string | null;
  usage: NormalizedLlmUsage | null;
  /** Packet source ids actually supplied to the arm as inputs. */
  retrievedSourceIds: string[];
  /** Text whose sha256 becomes the trace prompt_hash. */
  promptHashInput: string;
  /** Optional raw receipts, written to receipts.json in the arm directory. */
  receipts?: unknown;
};

export type ArmExecutor = (context: ArmContext) => Promise<ArmExecution>;

/** The full user message for the two direct-model arms. */
export function modelArmPrompt(
  loaded: LoadedBeaverCanTask,
  arm: "bare_model" | "oracle_sources",
): string {
  if (arm === "bare_model") return loaded.prompt;
  // Oracle: inline the complete packet text. Scoring metadata (role,
  // supersession) is never shown to the model.
  const packet = loaded.sources
    .map(
      (source) =>
        `## ${source.source_id} — ${source.citation}\n\n${source.text}`,
    )
    .join("\n\n---\n\n");
  return `${loaded.prompt}\n\n---\n\n# SOURCE PACKET (full text)\n\n${packet}`;
}

/** bare_model / oracle_sources: one direct model call, no tools. */
export const modelArmExecutor: ArmExecutor = async ({ loaded, arm, model }) => {
  if (arm !== "bare_model" && arm !== "oracle_sources")
    throw new Error(`modelArmExecutor cannot run arm ${arm}`);
  const content = modelArmPrompt(loaded, arm);
  const result = await streamChatWithTools({
    model,
    systemPrompt: "",
    messages: [{ role: "user", content }],
  });
  return {
    outputText: result.fullText,
    provider: providerForModel(model),
    model,
    usage: result.usage ?? null,
    retrievedSourceIds:
      arm === "oracle_sources" ? [...loaded.task.source_ids] : [],
    promptHashInput: content,
  };
};

const CONTEXT_STRATEGY: Record<EvalArm, string> = {
  bare_model: "bare_prompt",
  oracle_sources: "prompt_plus_full_source_packet",
  beaver_baseline: "product_default_full_history",
  beaver_candidate: "product_default_full_history",
};

// ---------------------------------------------------------------------------
// Beaver transport turn script (shared by scripts/eval-beaver-arm.ts).
// ---------------------------------------------------------------------------

export type BeaverTurn = {
  text: string;
  /** task_local matter documents to upload before sending this turn. */
  uploadSourceIds: string[];
};

/**
 * long_thread prompts script turns as `## TURN-nn` headings; the preamble is
 * harness stage direction and is not played. A task_local matter document is
 * uploaded immediately before the first turn that mentions its source id.
 * Other task types play the whole prompt as a single turn.
 */
export function beaverTurnScript(loaded: LoadedBeaverCanTask): BeaverTurn[] {
  const taskLocal = loaded.sources
    .filter((source) => source.kind === "task_local")
    .map((source) => source.source_id);
  if (loaded.task.task_type !== "long_thread") {
    return [{ text: loaded.prompt.trim(), uploadSourceIds: taskLocal }];
  }
  const bodies = loaded.prompt
    .split(/^## TURN-\d{2}[^\n]*\r?\n/mu)
    .slice(1)
    .map((body) => body.trim())
    .filter(Boolean);
  const uploaded = new Set<string>();
  return bodies.map((text) => {
    const uploadSourceIds = (text.match(/SRC-\d{3}/gu) ?? []).filter(
      (id) => taskLocal.includes(id) && !uploaded.has(id) && uploaded.add(id),
    );
    return { text, uploadSourceIds };
  });
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

export type ArmReport = {
  arm: EvalArm;
  all_pass: boolean | null;
  fatal_errors: Record<string, boolean | null>;
  fired_fatal_errors: string[];
  criteria: Record<string, CriterionResult>;
  diagnostics: {
    provider: string | null;
    model: string | null;
    input_tokens: number | null;
    cached_input_tokens: number | null;
    output_tokens: number | null;
    reasoning_tokens: number | null;
    latency_ms: number;
    estimated_cost_usd: number | null;
  };
  output_path: string;
  trace_path: string;
};

export type EvalComparisonReport = {
  schema_version: "1";
  task_id: string;
  generated_at: string;
  git_commit: string;
  dirty_worktree: boolean;
  model: string;
  scoring_version: string;
  /** §7 frozen-baseline metadata; present whenever a beaver arm ran. */
  baseline: {
    git_commit: string;
    dirty_worktree: boolean;
    config: Record<string, string | null>;
    candidate_config_delta: null;
  } | null;
  arms: ArmReport[];
  totals: {
    estimated_cost_usd: number | null;
    all_pass_count: number;
    cost_per_passing_task_usd: number | null;
  };
  notes: string[];
};

const formatCost = (cost: number | null) =>
  cost === null ? "—" : `$${cost.toFixed(6)}`;
const formatPass = (pass: boolean | null) =>
  pass === null ? "null (unscored criteria remain)" : String(pass);

export function renderComparisonMarkdown(report: EvalComparisonReport): string {
  const lines: string[] = [
    `# ${report.task_id} — arm comparison`,
    "",
    `- generated_at: ${report.generated_at}`,
    `- git_commit: ${report.git_commit}${report.dirty_worktree ? " (dirty worktree)" : ""}`,
    `- model: ${report.model}`,
    `- scoring_version: ${report.scoring_version}`,
    "",
    "| arm | all_pass | fatal errors | input tok | cached | output tok | latency ms | est. cost |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of report.arms) {
    const d = arm.diagnostics;
    lines.push(
      `| ${arm.arm} | ${formatPass(arm.all_pass)} | ${
        arm.fired_fatal_errors.join(", ") || "none fired"
      } | ${d.input_tokens ?? "—"} | ${d.cached_input_tokens ?? "—"} | ${
        d.output_tokens ?? "—"
      } | ${Math.round(d.latency_ms)} | ${formatCost(d.estimated_cost_usd)} |`,
    );
  }
  lines.push(
    "",
    `Totals: estimated cost ${formatCost(report.totals.estimated_cost_usd)}, ` +
      `all-pass ${report.totals.all_pass_count}/${report.arms.length}, ` +
      `cost per passing task ${formatCost(report.totals.cost_per_passing_task_usd)}.`,
  );
  for (const arm of report.arms) {
    lines.push("", `## ${arm.arm}`, "");
    for (const [name, result] of Object.entries(arm.criteria)) {
      lines.push(
        result === null
          ? `- ${name}: null (no deterministic validator yet)`
          : `- ${name}: ${result.pass ? "pass" : "FAIL"} — ${JSON.stringify(result.evidence)}`,
      );
    }
    lines.push(
      `- fatal: ${Object.entries(arm.fatal_errors)
        .map(([name, fired]) => `${name}=${fired === null ? "null" : fired}`)
        .join(", ")}`,
      `- output: ${arm.output_path}`,
      `- trace: ${arm.trace_path}`,
    );
  }
  if (report.baseline) {
    lines.push(
      "",
      "## Frozen baseline",
      "",
      `- git_commit: ${report.baseline.git_commit}${report.baseline.dirty_worktree ? " (dirty worktree)" : ""}`,
      `- config: ${JSON.stringify(report.baseline.config)}`,
      `- candidate_config_delta: null`,
    );
  }
  lines.push("", "## Notes", "");
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

export type EvalRunOptions = {
  taskDir: string;
  arms: EvalArm[];
  model: string;
  /** Defaults to benchmarks/beaver_can/private_results (git-ignored). */
  resultsRoot?: string;
  /** Per-arm executor overrides; beaver arms REQUIRE one (transport lives in
   * scripts/eval-run.ts so supertest/app stay out of the library). */
  executors?: Partial<Record<EvalArm, ArmExecutor>>;
};

export async function runEval(options: EvalRunOptions): Promise<{
  runDir: string;
  reportPath: string;
  report: EvalComparisonReport;
}> {
  if (options.arms.length === 0) throw new Error("no arms selected");
  const loaded = loadBeaverCanTaskDir(options.taskDir);
  const git = gitRunState(__dirname);
  const generatedAt = new Date().toISOString();
  const runDir = path.join(
    options.resultsRoot ?? path.join(BEAVER_CAN_DIR, "private_results"),
    loaded.task.id,
    `${generatedAt.replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`,
  );
  const sourceManifestHash = beaverCanContentHash(
    readFileSync(path.join(options.taskDir, "sources", "manifest.json"), "utf8"),
  );

  const armReports: ArmReport[] = [];
  for (const arm of options.arms) {
    const armDir = path.join(runDir, arm);
    mkdirSync(armDir, { recursive: true });
    const executor =
      options.executors?.[arm] ??
      (arm === "bare_model" || arm === "oracle_sources"
        ? modelArmExecutor
        : null);
    if (!executor)
      throw new Error(
        `${arm}: no executor supplied — beaver arms need the transport executor from scripts/eval-run.ts`,
      );
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    const execution = await executor({ loaded, arm, armDir, model: options.model });
    const latencyMs = performance.now() - startedMs;

    const outputPath = path.join(armDir, "output.md");
    writeFileSync(outputPath, `${execution.outputText}\n`, "utf8");
    if (execution.receipts !== undefined) {
      writeFileSync(
        path.join(armDir, "receipts.json"),
        `${JSON.stringify(execution.receipts, null, 2)}\n`,
        "utf8",
      );
    }
    const score = scoreBeaverCanOutput(loaded, execution.outputText);
    const estimatedCost = estimateCostUsd(execution.model, execution.usage);
    const tracePath = writeRunTrace(
      {
        schema_version: "1",
        run_id: randomUUID(),
        task_id: loaded.task.id,
        arm,
        started_at: startedAt,
        git_commit: git.git_commit,
        dirty_worktree: git.dirty_worktree,
        provider: execution.provider,
        model: execution.model,
        effort: null,
        context_strategy: CONTEXT_STRATEGY[arm],
        cache_strategy: "none",
        prompt_hash: sha256Hex(execution.promptHashInput),
        source_manifest_hash: sourceManifestHash,
        input_tokens: execution.usage?.inputTokens ?? null,
        output_tokens: execution.usage?.outputTokens ?? null,
        cached_input_tokens: execution.usage?.cacheReadInputTokens ?? null,
        cache_write_tokens: execution.usage?.cacheWriteInputTokens ?? null,
        latency_ms: latencyMs,
        estimated_cost: estimatedCost ?? null,
        retrieved_source_ids: execution.retrievedSourceIds,
        artifact_paths: [repoRelative(outputPath)],
        artifact_hashes: [sha256Hex(execution.outputText)],
        fatal_errors: score.fired_fatal_errors,
        all_pass: score.all_pass,
        score: score.numeric,
        scoring_version: score.scoring_version,
        manual_review_minutes: null,
      },
      armDir,
    );

    armReports.push({
      arm,
      all_pass: score.all_pass,
      fatal_errors: score.fatal_errors,
      fired_fatal_errors: score.fired_fatal_errors,
      criteria: score.criteria,
      diagnostics: {
        provider: execution.provider,
        model: execution.model,
        input_tokens: execution.usage?.inputTokens ?? null,
        cached_input_tokens: execution.usage?.cacheReadInputTokens ?? null,
        output_tokens: execution.usage?.outputTokens ?? null,
        reasoning_tokens: execution.usage?.reasoningTokens ?? null,
        latency_ms: latencyMs,
        estimated_cost_usd: estimatedCost,
      },
      output_path: repoRelative(outputPath),
      trace_path: repoRelative(tracePath),
    });
  }

  const beaverSelected = options.arms.some((arm) => arm.startsWith("beaver_"));
  const notes = [
    "Criteria and fatal entries recorded as null have no deterministic validator bound yet (Issue 4); they are unscored, not passed.",
  ];
  if (options.arms.includes("beaver_candidate")) {
    notes.push(
      "beaver_candidate == beaver_baseline: no configuration delta was supplied, so the candidate arm ran the same current working tree and configuration as the frozen baseline.",
    );
  }
  if (git.dirty_worktree) {
    notes.push(
      "Worktree was dirty at run time; the recorded commit does not fully identify the code.",
    );
  }

  const knownCosts = armReports
    .map((arm) => arm.diagnostics.estimated_cost_usd)
    .filter((cost): cost is number => cost !== null);
  const totalCost = knownCosts.length
    ? knownCosts.reduce((sum, cost) => sum + cost, 0)
    : null;
  const allPassCount = armReports.filter((arm) => arm.all_pass === true).length;
  const report: EvalComparisonReport = {
    schema_version: "1",
    task_id: loaded.task.id,
    generated_at: generatedAt,
    git_commit: git.git_commit,
    dirty_worktree: git.dirty_worktree,
    model: options.model,
    scoring_version: SCORING_VERSION,
    baseline: beaverSelected
      ? {
          git_commit: git.git_commit,
          dirty_worktree: git.dirty_worktree,
          config: {
            model: options.model,
            reasoning_effort: null,
            auth_mode: "anonymous",
            context_strategy: CONTEXT_STRATEGY.beaver_baseline,
            transport: "in-process express /chat (anonymous local mode)",
          },
          candidate_config_delta: null,
        }
      : null,
    arms: armReports,
    totals: {
      estimated_cost_usd: totalCost,
      all_pass_count: allPassCount,
      cost_per_passing_task_usd:
        totalCost !== null && allPassCount > 0 ? totalCost / allPassCount : null,
    },
    notes,
  };

  const reportPath = path.join(runDir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(
    path.join(runDir, "comparison.md"),
    renderComparisonMarkdown(report),
    "utf8",
  );
  return { runDir, reportPath, report };
}
