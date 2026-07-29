/**
 * Arm C driver for the Harvey LAB harness-comparison experiment
 * (benchmarks/lab/PROTOCOL.md): headless Claude Code (`claude -p`) as the
 * agent harness, on the Claude subscription (flat rate — the same sanctioned
 * surface the claude-code judge provider uses; no per-token API spend).
 *
 * One LAB task per invocation: copies the task documents into a scratch
 * workspace, plays the task instructions as the prompt (Claude Code's own
 * system prompt and tools ARE the harness under test), harvests files the
 * agent authored, and writes LAB-layout results (config.json / metrics.json /
 * transcript.jsonl / output/) so evaluation.run_eval judges this arm exactly
 * like the others.
 *
 * Deviations, recorded in claude-receipts.json per run:
 *  - Executes on the host, not a sealed container: WebFetch/WebSearch are
 *    disallowed for Arm A network parity, but Bash could reach the network
 *    and the host toolchain (python/node/pandoc) is richer than the
 *    2-CPU/2-GB sandbox image.
 *  - ANTHROPIC_API_KEY is stripped from the child env so the CLI runs on
 *    subscription auth (the repo .env key is a non-functional stub anyway).
 *
 * Usage:
 *   npx tsx scripts/lab-claude-arm.ts \
 *     --task banking-finance/extract-credit-agreement-covenants \
 *     [--model claude-sonnet-4-6] [--run-id <id>] [--lab-root <dir>]
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

const DEFAULT_LAB_ROOT = "C:/Users/elias/Desktop/harvey-labs";
// Arm A's six workspace tools plus TodoWrite (planning-only). Granting these
// explicitly — rather than skipping permissions wholesale — keeps the nested
// agent scoped to the same inventory the LAB reference harness exposes.
const ALLOWED_TOOLS = "Bash,Glob,Grep,Read,Edit,Write,TodoWrite";
const DISALLOWED_TOOLS = "WebFetch,WebSearch";

type StreamLine = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  usage?: Record<string, number>;
  message?: { content?: Array<Record<string, unknown>> };
};

function main() {
  const task = argument("task");
  const model = argument("model", "claude-sonnet-4-6");
  const labRoot = argument("lab-root", DEFAULT_LAB_ROOT);
  const runId = argument(
    "run-id",
    `${task}/claude-code-${model}/${new Date()
      .toISOString()
      .replace(/[:.]/gu, "-")
      .slice(0, 19)}`,
  );

  const taskDir = path.join(labRoot, "tasks", ...task.split("/"));
  const config = JSON.parse(
    readFileSync(path.join(taskDir, "task.json"), "utf8"),
  ) as {
    title: string;
    instructions: string;
    criteria: { deliverables?: string[] }[];
  };
  const deliverables = [
    ...new Set(config.criteria.flatMap((c) => c.deliverables ?? [])),
  ];

  const docsDir = path.join(taskDir, "documents");
  const workspace = mkdtempSync(path.join(os.tmpdir(), "lab-claude-arm-"));
  const inputs: string[] = [];
  for (const rel of readdirSync(docsDir, { recursive: true, encoding: "utf8" })
    .map((r) => r.replace(/\\/gu, "/"))
    .sort()) {
    const source = path.join(docsDir, rel);
    const base = path.basename(rel);
    if (!readFileSync(source)) continue;
    copyFileSync(source, path.join(workspace, base));
    inputs.push(base);
  }

  const prompt = [
    "You are completing a legal benchmark task inside the current working " +
      "directory. The input documents are already here as files:",
    inputs.map((name) => `- ${name}`).join("\n"),
    config.instructions.trim(),
    "Requirements:",
    `- Write each required deliverable as a real file in the current ` +
      `directory with EXACTLY the filename the instructions specify. ` +
      `.docx deliverables must be valid Word documents (author them ` +
      `programmatically, e.g. python-docx or pandoc).`,
    "- Use only the provided documents; you have no internet research access.",
    "- There is no user available: never ask questions, complete the task " +
      "fully in this session.",
  ].join("\n\n");

  const environment = { ...process.env };
  delete environment.ANTHROPIC_API_KEY; // subscription auth, not the stub key

  const started = Date.now();
  const run = spawnSync(
    "claude",
    [
      "-p",
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--verbose",
      "--allowedTools",
      ALLOWED_TOOLS,
      "--disallowedTools",
      DISALLOWED_TOOLS,
    ],
    {
      cwd: workspace,
      env: environment,
      input: prompt,
      encoding: "utf8",
      shell: true, // resolves the npm .cmd shim on Windows; args carry no spaces
      timeout: 90 * 60_000,
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  const wallClock = (Date.now() - started) / 1000;
  if (run.error) throw run.error;

  const lines = (run.stdout ?? "")
    .split(/\r?\n/u)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line) as StreamLine;
      } catch {
        return null;
      }
    })
    .filter((line): line is StreamLine => line !== null);
  const envelope = lines.find((line) => line.type === "result");
  if (!envelope)
    throw new Error(
      `no result envelope (exit ${run.status}): ${String(run.stderr).slice(0, 500)}`,
    );
  if (envelope.is_error)
    throw new Error(`claude -p error result: ${String(envelope.result).slice(0, 500)}`);

  const runDir = path.join(labRoot, "results", ...runId.split("/"));
  const outputDir = path.join(runDir, "output");
  mkdirSync(outputDir, { recursive: true });

  // Harvest: every root-level file the agent authored (anything that is not
  // an input copy). The judge matches expected deliverables by filename.
  const authored = readdirSync(workspace, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !inputs.includes(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of authored)
    copyFileSync(path.join(workspace, name), path.join(outputDir, name));
  const missing = deliverables.filter((name) => !authored.includes(name));

  const usage = envelope.usage ?? {};
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;

  const assistantTurns = lines.filter((line) => line.type === "assistant");
  writeFileSync(
    path.join(runDir, "transcript.jsonl"),
    assistantTurns
      .map((line, index) => {
        const content = line.message?.content ?? [];
        const text = content
          .filter((block) => block.type === "text")
          .map((block) => String(block.text ?? ""))
          .join("");
        const calls = content
          .filter((block) => block.type === "tool_use")
          .map((block) => ({ name: String(block.name ?? "") }));
        return JSON.stringify({
          turn: index + 1,
          role: "assistant",
          text: text.slice(0, 500),
          tool_calls: calls.length ? calls : null,
        });
      })
      .join("\n") + "\n",
  );
  writeFileSync(path.join(runDir, "transcript-raw.jsonl"), run.stdout ?? "");
  writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify(
      {
        model: `claude-code:${model}`,
        task,
        run_id: runId,
        harness: "claude-code",
        max_turns: null,
        started_at: new Date(started).toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "metrics.json"),
    JSON.stringify(
      {
        model: `claude-code:${model}`,
        task,
        run_id: runId,
        turn_count: envelope.num_turns ?? assistantTurns.length,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        token_source: "claude_cli_usage_incl_cache_reads",
        wall_clock_seconds: Math.round(wallClock * 100) / 100,
        finished_cleanly: !envelope.is_error && missing.length === 0,
        completed_at: new Date().toISOString(),
        documents_read: inputs.length,
        total_documents: inputs.length,
        documents_skipped: 0,
        documents_read_list: inputs,
        documents_skipped_list: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "claude-receipts.json"),
    JSON.stringify(
      {
        cli_args: ["-p", "--model", model, "--output-format stream-json",
          `--allowedTools ${ALLOWED_TOOLS}`, `--disallowedTools ${DISALLOWED_TOOLS}`],
        prompt,
        workspace,
        inputs,
        authored,
        expected_deliverables: deliverables,
        missing_deliverables: missing,
        usage_envelope: usage,
        duration_api_ms: envelope.duration_api_ms ?? null,
        deviations: {
          host_execution_not_container: true,
          web_tools_disallowed_but_host_network_reachable: true,
          api_key_stripped_subscription_auth: true,
        },
      },
      null,
      2,
    ),
  );

  console.log(`claude arm complete: ${runId}`);
  console.log(`  turns: ${envelope.num_turns}, wall clock: ${Math.round(wallClock)}s`);
  console.log(`  tokens: in ${inputTokens} (incl cache reads), out ${outputTokens}`);
  console.log(`  authored: ${authored.join(", ") || "(none)"}`);
  if (missing.length) console.log(`  MISSING deliverables: ${missing.join(", ")}`);
  console.log(`  results: ${runDir}`);
  process.exit(missing.length ? 3 : 0);
}

try {
  main();
} catch (error) {
  console.error("[lab-claude-arm]", error);
  process.exit(1);
}
