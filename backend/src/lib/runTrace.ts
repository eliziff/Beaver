/**
 * Common run-trace contract (docs/beaver-evaluation-context-plan.md §8,
 * Issue 1).
 *
 * Every benchmark/model run emits exactly one machine-readable record into an
 * ignored local directory (`benchmarks/traces/`). The schema is strict:
 * unknown keys are rejected, so prompts, retrieved passages, or client text
 * cannot leak into traces by default — only hashes, identifiers, counts, and
 * repo-relative artifact paths belong here. Fields a run cannot supply (a
 * deterministic benchmark has no model, tokens, or cost) are recorded as
 * explicit nulls, never omitted.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u, "lowercase sha256 hex");
const tokenCount = z.number().int().nonnegative().nullable();

export const runTraceSchema = z
  .object({
    schema_version: z.literal("1"),
    run_id: z.string().uuid(),
    task_id: z.string().min(1),
    arm: z.enum([
      "bare_model",
      "oracle_sources",
      "beaver_baseline",
      "beaver_candidate",
    ]),
    started_at: z.string().datetime(),
    git_commit: z.string().regex(/^[0-9a-f]{40}$/u, "full git sha"),
    dirty_worktree: z.boolean(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    context_strategy: z.string().nullable(),
    cache_strategy: z.string().nullable(),
    prompt_hash: sha256.nullable(),
    source_manifest_hash: sha256.nullable(),
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    cached_input_tokens: tokenCount,
    cache_write_tokens: tokenCount,
    latency_ms: z.number().nonnegative(),
    estimated_cost: z.number().nonnegative().nullable(),
    retrieved_source_ids: z.array(z.string()),
    artifact_paths: z.array(z.string()),
    artifact_hashes: z.array(sha256),
    fatal_errors: z.array(z.string()),
    all_pass: z.boolean().nullable(),
    score: z.record(z.number()).nullable(),
    scoring_version: z.string().nullable(),
    manual_review_minutes: z.number().nonnegative().nullable(),
  })
  .strict();

export type RunTrace = z.infer<typeof runTraceSchema>;

/** Ignored local trace directory shared by every benchmark (never commit). */
export const TRACE_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "benchmarks",
  "traces",
);

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Full commit SHA and dirty flag of the repository containing `cwd`. */
export function gitRunState(cwd: string = __dirname): {
  git_commit: string;
  dirty_worktree: boolean;
} {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  return {
    git_commit: git("rev-parse", "HEAD"),
    dirty_worktree: git("status", "--porcelain").length > 0,
  };
}

/** Parse-or-throw. Malformed records must fail loudly, not degrade. */
export function validateRunTrace(record: unknown): RunTrace {
  return runTraceSchema.parse(record);
}

/**
 * Validate and write one trace record; returns the file path. A malformed
 * record throws before anything touches disk.
 */
export function writeRunTrace(
  record: unknown,
  directory: string = TRACE_DIR,
): string {
  const trace = validateRunTrace(record);
  mkdirSync(directory, { recursive: true });
  const file = path.join(
    directory,
    `${trace.task_id}-${trace.started_at.replace(/[:.]/gu, "-")}-${trace.run_id.slice(0, 8)}.json`,
  );
  writeFileSync(file, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
  return file;
}
