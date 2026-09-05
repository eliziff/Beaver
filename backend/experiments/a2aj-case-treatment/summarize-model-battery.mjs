import fs from "node:fs";
import path from "node:path";

const batteryDir = path.resolve(process.argv[2] ?? "");
if (!batteryDir || !fs.existsSync(path.join(batteryDir, "manifest.json"))) {
  throw new Error("usage: node summarize-model-battery.mjs <battery-run-directory>");
}

const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
const manifest = readJson(path.join(batteryDir, "manifest.json"));
const requestedConfigurations = Array.isArray(manifest.configurations)
  ? manifest.configurations
  : [manifest.configurations];
const runsDir = path.dirname(batteryDir);
const completed = [];
const missing = [];

for (const config of requestedConfigurations) {
  const runDir = path.join(runsDir, config.run_name);
  const marker = path.join(runDir, "run-complete.json");
  const summaryFile = path.join(runDir, "product-judge", "summary.json");
  if (!fs.existsSync(marker) || !fs.existsSync(summaryFile)) {
    missing.push(config.run_name);
    continue;
  }
  const structureFile = path.join(runDir, "structure-benchmark.json");
  completed.push({
    ...config,
    summary: readJson(summaryFile),
    structure: fs.existsSync(structureFile) ? readJson(structureFile) : null,
  });
}

const groups = new Map();
for (const run of completed) {
  const key = `${run.model}\t${run.effort}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}

const sum = (values) => values.reduce((total, value) => total + Number(value ?? 0), 0);
const rate = (passed, total) => total ? passed / total : 1;
const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const spread = (values) => ({
  median: median(values),
  min: values.length ? Math.min(...values) : null,
  max: values.length ? Math.max(...values) : null,
});

const configurations = [...groups.values()].map((runs) => {
  const structureCategory = (name) => {
    const passed = sum(runs.map(({ structure }) => structure?.structure_score?.categories?.[name]?.passed));
    const total = sum(runs.map(({ structure }) => structure?.structure_score?.categories?.[name]?.total));
    return { passed, total, score: rate(passed, total) };
  };
  const score = (name) => {
    const items = sum(runs.map(({ summary }) => summary[name]?.items));
    const earned = sum(runs.map(({ summary }) => summary[name]?.earned));
    return {
      items,
      earned,
      score: rate(earned, items),
      replicate_score: spread(runs.map(({ summary }) => Number(summary[name]?.score ?? 0))),
    };
  };
  return {
    model: runs[0].model,
    effort: runs[0].effort,
    completed_runs: runs.length,
    structure: {
      opinion_count_exact: structureCategory("opinion_count_exact"),
      boundaries_acceptable: structureCategory("boundaries_acceptable"),
      writers_exact: structureCategory("writers_exact"),
      full_joiners_exact: structureCategory("full_joiners_exact"),
      qualified_agreements_exact: structureCategory("qualified_agreements_exact"),
      opinion_results_exact: structureCategory("opinion_results_exact"),
      participant_votes_exact: structureCategory("participant_votes_exact"),
    },
    treatment: score("treatment"),
    direct_outcome: score("direct_outcome"),
    reported_history: score("reported_history"),
    overall: score("overall"),
    extras: score("extras"),
    cases: sum(runs.map(({ summary }) => summary.cases)),
    candidates: sum(runs.map(({ summary }) => summary.candidates)),
    judged: sum(runs.map(({ summary }) => summary.judged)),
    failed: sum(runs.map(({ summary }) => summary.failed)),
    benchmark_ready: runs.every(({ summary }) => summary.benchmark_ready === true),
    gold_challenges: sum(runs.map(({ summary }) => summary.gold_challenges)),
    extra_minor_errors: sum(runs.map(({ summary }) => summary.extra_minor_errors)),
    unsupported_extras: sum(runs.map(({ summary }) => summary.unsupported_extras)),
    major_errors: sum(runs.map(({ summary }) => summary.major_errors)),
  };
});

const effortOrder = new Map(["none", "low", "medium", "high", "xhigh", "max"].map((value, index) => [value, index]));
configurations.sort((a, b) => a.model.localeCompare(b.model) || effortOrder.get(a.effort) - effortOrder.get(b.effort));
const result = {
  generated_utc: new Date().toISOString(),
  requested_runs: requestedConfigurations.length,
  completed_runs: completed.length,
  missing_runs: missing,
  configurations,
};
fs.writeFileSync(path.join(batteryDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ requested_runs: result.requested_runs, completed_runs: result.completed_runs, missing_runs: missing.length }));
