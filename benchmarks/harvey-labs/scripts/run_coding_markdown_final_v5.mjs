#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, "..", "..", "..");
const lab = path.join(root, "benchmarks", "harvey-labs");
const results = path.join(lab, "results");

const suiteArgument = process.argv.indexOf("--suite");
const suiteName = suiteArgument === -1 ? "current" : process.argv[suiteArgument + 1];
const suites = {
  current: {
    campaign: "coding-agent-defaults-v1-auto-v1",
    directory: "auto-v1",
    runPrefix: "coding-agent-defaults-v1",
  },
  additions: {
    campaign: "coding-agent-defaults-v1-core-additions-v1",
    directory: "core-additions-v1",
    runPrefix: "coding-agent-core-additions-v1",
  },
  expansion: {
    campaign: "coding-agent-defaults-v1-expansion-v1",
    directory: "expansion-v1",
    runPrefix: "coding-agent-expansion-v1",
  },
  redlines: {
    campaign: "coding-agent-defaults-v1-redlines-v1",
    directory: "redlines-v1",
    runPrefix: "coding-agent-redlines-v1",
  },
  "data-room": {
    campaign: "coding-agent-defaults-v1-data-room-v1",
    directory: "data-room-v1",
    runPrefix: "coding-agent-data-room-v1",
  },
};
const suite = suites[suiteName];
if (!suite) {
  throw new Error(`Unknown --suite ${String(suiteName)}; expected current, additions, expansion, redlines, or data-room`);
}
const campaignRoot = path.join(
  lab,
  "run-logs",
  "coding-agent-defaults-v1",
  suite.directory,
);
const ledgerPath = path.join(campaignRoot, "ledger.json");
const campaignLog = path.join(campaignRoot, "campaign.log");
const lockPath = path.join(campaignRoot, "campaign.lock");
const workersPerLane = 10;
const retriesPerCell = 1;
const dryRun = process.argv.includes("--dry-run");

const worktree = path.join(root, ".tmp", "treatment-transfer-worktree");
const sourceRoot = existsSync(
  path.join(worktree, "backend", "scripts", "lab-beaver-arm.ts"),
)
  ? worktree
  : root;
const backend = path.join(sourceRoot, "backend");
const runner = path.join(backend, "scripts", "lab-beaver-arm.ts");
const tsx = path.join(backend, "node_modules", "tsx", "dist", "cli.mjs");
const python = path.join(lab, ".venv", "Scripts", "python.exe");

const tasks = {
  closing: "capital-markets/compare-closing-documents-against-closing-checklist",
  covenants: "banking-finance/extract-credit-agreement-covenants",
  dpa: "white-collar-defense-investigations/analyze-counterparty-markup-of-deferred-prosecution-agreement",
  protective: "antitrust-competition/analyze-counterparty-markup-of-protective-order",
  psa: "real-estate/extract-psa-key-terms/scenario-01",
  arbitrationMarkup:
    "arbitration-international-dispute-resolution/identify-arbitration-agreement-markup",
  indenture: "capital-markets/draft-indenture-for-senior-secured-notes-offering",
  acquisitionDiligence: "corporate-ma/draft-acquisition-due-diligence",
  aerospaceDataRoom: "diligence/aerospace-vertical-integration",
  antitrustRisk: "antitrust-competition/prepare-antitrust-risk-assessment",
  criticalVendors:
    "bankruptcy-restructuring/extract-critical-vendor-terms-from-supply-contracts",
  covenantCompliance:
    "banking-finance/compare-compliance-certificate-against-financial-covenants",
  planDistributions:
    "bankruptcy-restructuring/compare-distribution-amounts-against-plan-requirements",
  conventionEnforcement:
    "arbitration-international-dispute-resolution/analyze-arbitration-award-for-new-york-convention-enforcement-defenses",
  flsaClassification:
    "corporate-governance/analyze-flsa-overtime-rule-gap-against-current-employee-classifications",
  ofacInvestigation:
    "international-trade-sanctions/analyze-ofac-investigative-demand-and-related-transaction-records",
  transferPricing: "tax/draft-transfer-pricing-documentation",
};

const currentCells = [
  ["01", tasks.closing, "mike_upstream_native_v1", 1],
  ["03", tasks.dpa, "coding_markdown_final_v5", 1],
  ["04", tasks.protective, "mike_upstream_native_v1", 1],
  ["06", tasks.covenants, "coding_markdown_final_v5", 1],
  ["07", tasks.dpa, "mike_upstream_native_v1", 1],
  ["09", tasks.closing, "coding_markdown_final_v5", 1],
  ["10", tasks.covenants, "mike_upstream_native_v1", 1],
  ["12", tasks.protective, "coding_markdown_final_v5", 1],
  ["13", tasks.closing, "coding_markdown_final_v5", 2],
  ["14", tasks.covenants, "mike_upstream_native_v1", 2],
].map(([order, task, arm, replicate]) => ({ order, task, arm, replicate }));

function pairedCells(taskList) {
  return taskList.flatMap((task, index) => {
    const first = String(index * 2 + 1).padStart(2, "0");
    const second = String(index * 2 + 2).padStart(2, "0");
    return [
      { order: first, task, arm: "mike_upstream_native_v1", replicate: 1 },
      { order: second, task, arm: "coding_markdown_final_v5", replicate: 1 },
    ];
  });
}

const cells =
  suiteName === "current"
    ? currentCells
    : suiteName === "additions"
      ? pairedCells([
          tasks.psa,
          tasks.arbitrationMarkup,
          tasks.indenture,
          tasks.acquisitionDiligence,
        ])
      : suiteName === "expansion"
        ? pairedCells([
            tasks.antitrustRisk,
            tasks.criticalVendors,
            tasks.covenantCompliance,
            tasks.planDistributions,
            tasks.conventionEnforcement,
            tasks.flsaClassification,
            tasks.ofacInvestigation,
            tasks.transferPricing,
          ])
      : suiteName === "redlines"
        ? pairedCells([tasks.dpa, tasks.protective])
        : pairedCells([tasks.aerospaceDataRoom]);

const lanes = [
  {
    id: "deepseek",
    performerModel: "deepseek-v4-flash",
    judgeModel: "deepseek-v4-flash",
    effort: "high",
  },
  {
    id: "luna",
    performerModel: "codex:gpt-5.6-luna",
    judgeModel: "codex/gpt-5.6-luna",
    effort: "high",
  },
];

for (const required of [lab, runner, tsx, python]) {
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

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(campaignLog, line, "utf8");
  process.stdout.write(line);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const handle = openSync(lockPath, "wx");
    writeFileSync(handle, `${process.pid}\n`, "utf8");
    closeSync(handle);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    if (processAlive(owner)) {
      throw new Error(`Campaign already running as PID ${owner}`);
    }
    unlinkSync(lockPath);
    return acquireLock();
  }
}

function releaseLock() {
  try {
    if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) {
      unlinkSync(lockPath);
    }
  } catch {
    // Already released.
  }
}

if (!dryRun) {
  acquireLock();
  process.once("exit", releaseLock);
}

const ledger = readJson(ledgerPath) ?? {
  campaign: suite.campaign,
  created_at: new Date().toISOString(),
  cells: {},
};

function saveLedger() {
  ledger.updated_at = new Date().toISOString();
  ledger.workers_per_lane = workersPerLane;
  ledger.source_root = sourceRoot;
  atomicJson(ledgerPath, ledger);
}

function safeModel(model) {
  return model.replace(/[:./]/gu, "-");
}

function cellKey(lane, cell) {
  return `${lane.id}|${cell.order}|${cell.task}|${cell.arm}|r${cell.replicate}`;
}

function runDirectory(runId) {
  return path.join(results, ...runId.split("/"));
}

const deliverablesByTask = new Map();
function requiredDeliverables(task) {
  if (!deliverablesByTask.has(task)) {
    const taskConfig = readJson(path.join(lab, "tasks", ...task.split("/"), "task.json"));
    const deliverables = Object.keys(taskConfig?.deliverables ?? {});
    if (!deliverables.length) throw new Error(`Task has no deliverables: ${task}`);
    deliverablesByTask.set(task, deliverables);
  }
  return deliverablesByTask.get(task);
}

function validDocx(file) {
  if (!existsSync(file) || statSync(file).size < 4) return false;
  return readFileSync(file).subarray(0, 2).toString("ascii") === "PK";
}

function usableRun(runId, lane, cell) {
  if (
    suiteName === "redlines" &&
    !runId.split("/").at(-1)?.startsWith(`${suite.runPrefix}-`)
  ) {
    return false;
  }
  const directory = runDirectory(runId);
  const config = readJson(path.join(directory, "config.json"));
  if (
    config?.task !== cell.task ||
    config?.arm !== cell.arm ||
    config?.model !== lane.performerModel ||
    config?.reasoning_effort !== lane.effort
  ) {
    return false;
  }
  const metrics = readJson(path.join(directory, "metrics.json"));
  const mapping = metrics?.required_deliverable_mapping ?? {};
  return requiredDeliverables(cell.task).every((name) =>
    validDocx(path.join(directory, "output", mapping[name] || name)),
  );
}

function judgeComplete(runId, lane) {
  const score = readJson(path.join(runDirectory(runId), "scores.json"));
  const recordedModel = lane.judgeModel.replace(/^codex\//u, "");
  return (
    [lane.judgeModel, recordedModel].includes(score?.judge_model) &&
    score?.judge_effort === lane.effort
  );
}

function runsFor(cell, lane) {
  const surfaceRoot = path.join(
    results,
    ...cell.task.split("/"),
    `beaver-${cell.arm}-${safeModel(lane.performerModel)}`,
  );
  if (!existsSync(surfaceRoot)) return [];
  const found = [];
  for (const run of readdirSync(surfaceRoot, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    if (!new RegExp(`(?:^|-)r${cell.replicate}(?:-|$)`, "u").test(run.name)) {
      continue;
    }
    const directory = path.join(surfaceRoot, run.name);
    const runId = path.relative(results, directory).split(path.sep).join("/");
    if (usableRun(runId, lane, cell)) {
      found.push({ runId, modified: statSync(directory).mtimeMs });
    }
  }
  return found.sort((a, b) => b.modified - a.modified).map((entry) => entry.runId);
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
  return (work) =>
    new Promise((resolve) => {
      queue.push({ work, resolve });
      pump();
    });
}

function childEnvironment() {
  const environment = {
    ...process.env,
    LAB_SANDBOX_ENGINE: "docker",
    LAB_BEAVER_TRANSPORT_RELAUNCH: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (suiteName === "data-room") {
    // The LAB app is process-local; lift its HTTP guards so a real data room
    // is not cut off at the normal interactive upload limits.
    environment.LAB_BEAVER_LIBRARY_SCOPE = "1";
    environment.RATE_LIMIT_GENERAL_MAX = "10000";
    environment.RATE_LIMIT_UPLOAD_MAX = "10000";
  }
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

const judgePools = new Map(lanes.map((lane) => [lane.id, pool(workersPerLane)]));
const judgePromises = [];
const scheduledJudges = new Set();

function scheduleJudge(lane, cell, runId) {
  if (scheduledJudges.has(runId) || judgeComplete(runId, lane)) return;
  scheduledJudges.add(runId);
  const key = cellKey(lane, cell);
  const entry = (ledger.cells[key] ??= {});
  entry.judge_status = "queued";
  saveLedger();
  const promise = judgePools.get(lane.id)(async () => {
    if (judgeComplete(runId, lane)) return { ok: true };
    entry.judge_status = "running";
    saveLedger();
    log(`${lane.id} JUDGE START ${runId}`);
    const logFile = path.join(campaignRoot, lane.id, "judges", `${cell.order}-r${cell.replicate}.log`);
    let result;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      result = await runProcess(
        python,
        [
          "-m",
          "evaluation.run_eval",
          "--run-id",
          runId,
          "--task",
          cell.task,
          "--judge-model",
          lane.judgeModel,
          "--judge-effort",
          lane.effort,
          "--parallel",
          "1",
        ],
        lab,
        logFile,
      );
      if (result.code === 0 && judgeComplete(runId, lane)) break;
      log(`${lane.id} JUDGE RETRY ${attempt}/2 ${runId}`);
    }
    const ok = judgeComplete(runId, lane);
    entry.judge_status = ok ? "completed" : "failed";
    entry.judge_exit_code = result?.code ?? null;
    saveLedger();
    log(`${lane.id} JUDGE ${ok ? "DONE" : "FAIL"} ${runId}`);
    return { ok };
  });
  judgePromises.push(promise);
}

function nextRunId(lane, cell) {
  const parent = `${cell.task}/beaver-${cell.arm}-${safeModel(lane.performerModel)}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const leaf = `${suite.runPrefix}-${lane.id}-o${cell.order}-r${cell.replicate}-a${attempt}`;
    const runId = `${parent}/${leaf}`;
    if (!existsSync(runDirectory(runId))) return { runId, attempt };
  }
  throw new Error(`Too many attempts for ${cellKey(lane, cell)}`);
}

async function runCell(lane, cell) {
  const key = cellKey(lane, cell);
  const entry = (ledger.cells[key] ??= { attempts: [] });
  for (let retry = 0; retry <= retriesPerCell; retry += 1) {
    const { runId, attempt } = nextRunId(lane, cell);
    const logFile = path.join(
      campaignRoot,
      lane.id,
      "performers",
      `${cell.order}-${cell.arm}-r${cell.replicate}-a${attempt}.log`,
    );
    entry.inference_status = "running";
    entry.run_id = runId;
    entry.attempts ??= [];
    entry.attempts.push({ run_id: runId, status: "running", started_at: new Date().toISOString() });
    saveLedger();
    log(`${lane.id} RUN START ${key}`);
    if (dryRun) {
      entry.inference_status = "dry_run";
      saveLedger();
      return false;
    }
    const result = await runProcess(
      process.execPath,
      [
        tsx,
        runner,
        "--task",
        cell.task,
        "--arm",
        cell.arm,
        "--model",
        lane.performerModel,
        "--effort",
        lane.effort,
        ...(suiteName === "data-room" ? ["--office-pdf", "lazy"] : []),
        "--lab-root",
        lab,
        "--run-id",
        runId,
      ],
      backend,
      logFile,
    );
    const usable = usableRun(runId, lane, cell);
    Object.assign(entry.attempts.at(-1), {
      status: usable ? "usable" : "failed",
      exit_code: result.code,
      finished_at: new Date().toISOString(),
    });
    if (usable) {
      entry.inference_status = "completed";
      saveLedger();
      log(`${lane.id} RUN DONE ${key}${result.code === 0 ? "" : ` (exit ${result.code}; output usable)`}`);
      scheduleJudge(lane, cell, runId);
      return true;
    }
    entry.inference_status = retry < retriesPerCell ? "retrying" : "failed";
    saveLedger();
    log(`${lane.id} RUN ${retry < retriesPerCell ? "RETRY" : "FAIL"} ${key} exit=${result.code}`);
  }
  return false;
}

function summarize() {
  return lanes
    .map((lane) => {
      const entries = cells.map((cell) => ledger.cells[cellKey(lane, cell)] ?? {});
      const count = (field, value) => entries.filter((entry) => entry[field] === value).length;
      return `${lane.id}: inference ${count("inference_status", "reused") + count("inference_status", "completed")}/${cells.length}, judges ${count("judge_status", "completed")}/${cells.length}`;
    })
    .join(" | ");
}

const claimedRuns = new Set();
const missingByLane = new Map(lanes.map((lane) => [lane.id, []]));
for (const lane of lanes) {
  for (const cell of cells) {
    const key = cellKey(lane, cell);
    const entry = (ledger.cells[key] ??= { attempts: [] });
    const candidates = [
      entry.run_id,
      ...(cell.arm === "mike_upstream_native_v1" ? runsFor(cell, lane) : []),
    ].filter(Boolean);
    const runId = candidates.find(
      (candidate) => !claimedRuns.has(candidate) && usableRun(candidate, lane, cell),
    );
    if (runId) {
      claimedRuns.add(runId);
      entry.run_id = runId;
      entry.inference_status = "reused";
      entry.judge_status = judgeComplete(runId, lane) ? "completed" : "queued";
      scheduleJudge(lane, cell, runId);
    } else {
      missingByLane.get(lane.id).push(cell);
    }
  }
}
saveLedger();

for (const lane of lanes) {
  log(`${lane.id} INVENTORY reused=${cells.length - missingByLane.get(lane.id).length} missing=${missingByLane.get(lane.id).length}`);
}

const heartbeat = setInterval(() => log(`HEARTBEAT ${summarize()}`), 30_000);
const inferencePromises = [];
for (const lane of lanes) {
  const run = pool(workersPerLane);
  for (const cell of missingByLane.get(lane.id)) {
    inferencePromises.push(run(() => runCell(lane, cell)));
  }
}

try {
  await Promise.all(inferencePromises);
  await Promise.all(judgePromises);
} finally {
  clearInterval(heartbeat);
  saveLedger();
  if (!dryRun) releaseLock();
}

let incomplete = 0;
for (const lane of lanes) {
  for (const cell of cells) {
    const runId = ledger.cells[cellKey(lane, cell)]?.run_id;
    if (!runId || !usableRun(runId, lane, cell) || !judgeComplete(runId, lane)) incomplete += 1;
  }
}
log(`CAMPAIGN ${incomplete ? `INCOMPLETE (${incomplete} cells)` : "COMPLETE"} ${summarize()}`);
process.exitCode = incomplete ? 1 : 0;
