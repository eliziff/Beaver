#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..", "..", "..");
const lab = path.join(root, "benchmarks", "harvey-labs");
const results = path.join(lab, "results");
const python = path.join(lab, ".venv", "Scripts", "python.exe");
const nativeRunner = path.join(lab, "harness", "native_codex.py");
const campaignRoot = path.join(lab, "run-logs", "native-codex-reference-v1");
const ledgerPath = path.join(campaignRoot, "ledger.json");
const campaignLog = path.join(campaignRoot, "campaign.log");
const workersPerLane = 10;

const tasks = [
  "capital-markets/compare-closing-documents-against-closing-checklist",
  "banking-finance/extract-credit-agreement-covenants",
  "white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement",
  "antitrust-competition/analyze-counterparty-markup-of-protective-order",
  "real-estate/extract-psa-key-terms/scenario-01",
  "arbitration-international-dispute-resolution/identify-arbitration-agreement-markup",
  "capital-markets/draft-indenture-for-senior-secured-notes-offering",
  "corporate-ma/draft-acquisition-due-diligence",
];

const lanes = [
  { id: "luna-high", effort: "high" },
  { id: "luna-max", effort: "max" },
];
const model = "gpt-5.6-luna";
const judgeModel = "codex/gpt-5.6-luna";

for (const required of [python, nativeRunner]) {
  if (!existsSync(required)) throw new Error(`Missing required path: ${required}`);
}
mkdirSync(campaignRoot, { recursive: true });

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const ledger = readJson(ledgerPath) ?? {
  campaign: "native-codex-reference-v1",
  surface: "codex_native_v1",
  model,
  tasks,
  lanes: lanes.map(({ id, effort }) => ({ id, effort })),
  cells: {},
};

function saveLedger() {
  const temporary = `${ledgerPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(temporary, ledgerPath);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  appendFileSync(campaignLog, line, "utf8");
  process.stdout.write(line);
}

function pool(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < limit && queue.length) {
      const { work, resolve } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(work)
        .then(resolve, (error) => resolve({ ok: false, error: String(error) }))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };
  return (work) => new Promise((resolve) => {
    queue.push({ work, resolve });
    pump();
  });
}

function childEnvironment() {
  const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  return environment;
}

async function runProcess(executable, args, cwd, logFile) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const output = createWriteStream(logFile, { flags: "a" });
  const child = spawn(executable, args, {
    cwd,
    env: childEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: -1, error: error.message }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve) => output.end(resolve));
  return { ...result, pid: child.pid };
}

function taskSlug(task) {
  return task.split("/").at(-1).replaceAll(/[^a-z0-9]+/gu, "-");
}

function cellKey(lane, task) {
  return `${lane.id}:${task}`;
}

function runDirectory(runId) {
  return path.join(results, ...runId.split("/"));
}

function usable(runId, lane, task) {
  const directory = runDirectory(runId);
  const config = readJson(path.join(directory, "config.json"));
  const metrics = readJson(path.join(directory, "metrics.json"));
  return config?.surface === "codex_native_v1"
    && config?.task === task
    && config?.model === model
    && config?.reasoning_effort === lane.effort
    && metrics?.finished_cleanly === true
    && Number(metrics?.deliverable_count) > 0;
}

function judged(runId, lane) {
  const score = readJson(path.join(runDirectory(runId), "scores.json"));
  return [judgeModel, model].includes(score?.judge_model)
    && score?.judge_effort === lane.effort;
}

function nextRunId(lane, task) {
  const parent = `${task}/codex-native-v1-gpt-5-6-luna`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const leaf = `native-reference-v1-${lane.id}-${taskSlug(task)}-a${attempt}`;
    const runId = `${parent}/${leaf}`;
    if (!existsSync(runDirectory(runId))) return runId;
  }
  throw new Error(`Too many attempts for ${lane.id}:${task}`);
}

const inferencePools = new Map(lanes.map((lane) => [lane.id, pool(workersPerLane)]));
const judgePools = new Map(lanes.map((lane) => [lane.id, pool(workersPerLane)]));

async function judge(lane, task, runId, entry) {
  if (judged(runId, lane)) return true;
  entry.judge_status = "running";
  saveLedger();
  log(`${lane.id} JUDGE START ${task}`);
  const result = await runProcess(
    python,
    [
      "-m", "evaluation.run_eval",
      "--run-id", runId,
      "--task", task,
      "--judge-model", judgeModel,
      "--judge-effort", lane.effort,
      "--parallel", "1",
    ],
    lab,
    path.join(campaignRoot, lane.id, "judges", `${taskSlug(task)}.log`),
  );
  const ok = result.code === 0 && judged(runId, lane);
  entry.judge_status = ok ? "completed" : "failed";
  entry.judge_exit_code = result.code;
  saveLedger();
  log(`${lane.id} JUDGE ${ok ? "DONE" : "FAIL"} ${task}`);
  return ok;
}

async function infer(lane, task, entry) {
  if (entry.run_id && usable(entry.run_id, lane, task)) return entry.run_id;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const runId = nextRunId(lane, task);
    entry.run_id = runId;
    entry.inference_status = "running";
    saveLedger();
    log(`${lane.id} RUN START ${task} a${attempt}`);
    const result = await runProcess(
      python,
      [
        "-m", "harness.native_codex",
        "--task", task,
        "--run-id", runId,
        "--model", model,
        "--effort", lane.effort,
      ],
      lab,
      path.join(campaignRoot, lane.id, "performers", `${taskSlug(task)}-a${attempt}.log`),
    );
    if (usable(runId, lane, task)) {
      entry.inference_status = "completed";
      entry.inference_exit_code = result.code;
      saveLedger();
      log(`${lane.id} RUN DONE ${task}`);
      return runId;
    }
    entry.inference_status = attempt === 1 ? "retrying" : "failed";
    entry.inference_exit_code = result.code;
    saveLedger();
    log(`${lane.id} RUN ${attempt === 1 ? "RETRY" : "FAIL"} ${task}`);
  }
  return null;
}

const judgePromises = [];
const inferencePromises = [];
for (const lane of lanes) {
  for (const task of tasks) {
    const entry = (ledger.cells[cellKey(lane, task)] ??= {});
    if (entry.run_id && usable(entry.run_id, lane, task)) {
      entry.inference_status = "reused";
      judgePromises.push(judgePools.get(lane.id)(() => judge(lane, task, entry.run_id, entry)));
      continue;
    }
    inferencePromises.push(inferencePools.get(lane.id)(async () => {
      const runId = await infer(lane, task, entry);
      if (runId) judgePromises.push(judgePools.get(lane.id)(() => judge(lane, task, runId, entry)));
    }));
  }
}
saveLedger();

const heartbeat = setInterval(() => {
  const values = Object.values(ledger.cells);
  const inference = values.filter((entry) => ["completed", "reused"].includes(entry.inference_status)).length;
  const judges = values.filter((entry) => entry.judge_status === "completed").length;
  log(`HEARTBEAT inference=${inference}/${tasks.length * lanes.length} judges=${judges}/${tasks.length * lanes.length}`);
}, 30_000);

try {
  await Promise.all(inferencePromises);
  await Promise.all(judgePromises);
} finally {
  clearInterval(heartbeat);
  saveLedger();
}

const entries = Object.values(ledger.cells);
const complete = entries.filter((entry) => entry.judge_status === "completed").length;
log(`COMPLETE judged=${complete}/${tasks.length * lanes.length}`);
process.exitCode = complete === tasks.length * lanes.length ? 0 : 1;
