#!/usr/bin/env node

/**
 * Light central runner for the a2aj_decision_roster_qwen harness.
 *
 * One command launches every process in this experiment; the subprocess name
 * is the first argument, all remaining arguments are forwarded. The tsx
 * loader URL is resolved here once (backend node_modules first, then the
 * loader this script itself was launched with), so callers never hand-spin
 * the `node --import <loader>` syntax.
 *
 * Usage:
 *   node harness.mjs capture --seed 9 --n 1000 --scope SCC [--fresh] [--verbose]
 *   node harness.mjs verify [--seeds 1,4|all] [--scope SCC] [--fresh]
 *   node harness.mjs runner --provider dry --seed 1 --sample-size 5
 *   node harness.mjs codex --document-ids 123,456 [--workers 8] [--out receipt.json]
 *   node harness.mjs decision --document-ids 123,456 [--workers 5] [--out receipt.json]
 *   node harness.mjs decision-two-stage --document-ids 123,456 --model gpt-5.6-luna --effort high [--workers 5] [--out receipt.json]
 *   node harness.mjs audit --receipt-stream prior.receipts.jsonl [--workers 8] [--resume]
 *   node harness.mjs audit --per-dataset 50 --seed 9 [--workers 8]
 *   node harness.mjs revalidate --receipt-stream run.receipts.jsonl [--resume]
 *   node harness.mjs manifest --seed 123 --sample-size 30000 --scope ALL
 *   node harness.mjs manifest --needs-llm --seed 123 --sample-size 15000 --scope ALL
 *   node harness.mjs dashboard [--port 8796] [--frontend-url http://127.0.0.1:3000]
 *   node harness.mjs poolworkers | poolbatch | stageprofile | diffclaims
 *   node harness.mjs prompt-compare pairs.json --compare --arms baseline=a.outputs.jsonl,... --out runs/comparison --call-ledger runs/model-call-ledger.jsonl
 *   node harness.mjs target-analyze run.receipts.jsonl pairs.json
 *   node harness.mjs noopmeasure
 *
 * All subprocesses inherit stdio and propagate exit codes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const COMMANDS = {
  capture: { script: "seedcheck.ts", forward: true },
  verify: { script: "seedcheck.ts", forward: true },
  annotate: { script: "seedcheck.ts", forward: true },
  run: { script: "runner.ts", forward: true },
  codex: { script: "runner.ts", forward: true },
  decision: { script: "runner.ts", prefix: ["codex", "--decision-mvp"] },
  "decision-two-stage": { script: "scratch/decision_two_stage.ts", forward: false },
  audit: { script: "runner.ts", forward: true },
  revalidate: { script: "runner.ts", forward: true },
  manifest: { script: "runner.ts", forward: true },
  dashboard: { script: "dashboard.mjs", forward: false },
  "self-test": { script: "runner.ts", forward: true },
  compare: { script: "runner.ts", forward: true },
  poolworkers: { script: "scratch/poolworkers.ts", forward: false },
  poolbatch: { script: "scratch/poolbatch.ts", forward: false },
  stageprofile: { script: "scratch/stageprofile.ts", forward: false },
  diffclaims: { script: "scratch/diffclaims.ts", forward: false },
  "gold-eval": { script: "scratch/silver_case_target_eval.ts", forward: false },
  "decision-gold": { script: "scratch/decision_gold.ts", forward: false },
  "decision-benchmark": { script: "scratch/decision_benchmark.ts", forward: false },
  "prompt-compare": { script: "scratch/silver_case_target_eval.ts", forward: false },
  "repair-eval": { script: "scratch/case_target_repair_eval.ts", forward: false },
  "target-revalidate": { script: "scratch/revalidate_case_target_run.ts", forward: false },
  "target-analyze": { script: "scratch/analyze_case_target_run.ts", forward: false },
  noopmeasure: { script: "scratch/noopmeasure.ts", forward: false },
  poolmeasure: { script: "scratch/poolmeasure.ts", forward: false },
};

function resolveLoaderUrl() {
  const backendTsx = path.join(HERE, "..", "..", "backend", "node_modules", "tsx", "dist", "loader.mjs");
  if (existsSync(backendTsx)) return pathToFileURL(backendTsx).href;
  for (const arg of process.execArgv) {
    if (!arg.startsWith("file://") || !arg.includes("tsx")) continue;
    return arg;
  }
  return null;
}

const [command, ...rawRest] = process.argv.slice(2);
const belowNormal = rawRest.includes("--below-normal");
const rest = rawRest.filter((arg) => arg !== "--below-normal");
if (belowNormal && process.platform === "win32") {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
}
const entry = COMMANDS[command];
if (!entry) {
  console.error(`usage: node harness.mjs <command> [args...]`);
  console.error(`commands: ${Object.keys(COMMANDS).join(", ")}`);
  process.exit(2);
}
const loaderUrl = resolveLoaderUrl();
if (!loaderUrl) {
  console.error("cannot resolve a tsx loader (backend/node_modules/tsx missing)");
  process.exit(2);
}

const child = spawn(
  process.execPath,
  [
    "--import",
    loaderUrl,
    path.join(HERE, entry.script),
    ...(entry.prefix ?? (entry.forward ? [command] : [])),
    ...rest,
  ],
  { stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`killed by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
