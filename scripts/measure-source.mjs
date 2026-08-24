import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "3382734de884b763630b4670764e0f246d48469f";
const jsonOnly = process.argv.includes("--json");
const sourceExtensions = new Set([
  ".bat", ".c", ".cc", ".cjs", ".clj", ".cljs", ".cmd", ".cpp", ".cs",
  ".css", ".dart", ".erl", ".ex", ".exs", ".fs", ".fsx", ".go", ".gradle",
  ".groovy", ".h", ".hpp", ".hrl", ".html", ".java", ".js", ".jsx", ".kt",
  ".kts", ".lua", ".mjs", ".php", ".pl", ".ps1", ".py", ".r", ".rb", ".rs",
  ".scala", ".sh", ".sql", ".svelte", ".swift", ".toml", ".ts", ".tsx", ".vue", ".zig",
]);
const fixtureExtensions = new Set([
  ...sourceExtensions,
  ".csv", ".json", ".md", ".txt", ".xml", ".yaml", ".yml",
]);
const appRoots = ["backend/src", "frontend/src"];
const relocatedFeatureFiles = [
  "backend/experiments/passage-retrieval/retrievalRerank.ts",
  "backend/experiments/passage-retrieval/passageRetrieval.ts",
  "backend/experiments/passage-retrieval/a2ajPassageSearch.ts",
  "backend/experiments/docx-analysis/numbering.ts",
  "backend/experiments/docx-analysis/stories.ts",
];

const git = (args, cwd = root) =>
  execFileSync("git", cwd === root ? args : ["-c", `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 128 << 20,
  });
const lines = (text) => text.split(/\r\n|\n|\r/u).filter((line) => line !== "").length;
const listed = (args, cwd = root) =>
  git(args, cwd).split(/\r?\n/u).filter(Boolean).map((name) => name.replaceAll("\\", "/"));
const isTest = (name) =>
  name.includes("/__tests__/") || /\.(?:test|spec)\.[^/]+$/u.test(name);
const isGenerated = (name) =>
  name.includes("/generated/") || /\.generated\.[^/]+$/u.test(name);
const extension = (name) => path.posix.extname(name).toLowerCase();
const isExperiment = (name) =>
  /(?:^|\/)(?:experiments?|benchmarks?)(?:\/|$)/u.test(name);
const isTooling = (name) =>
  /(?:^|\/)(?:scripts?|build-scripts)(?:\/|$)/u.test(name);
const isVendored = (name) => /(?:^|\/)(?:vendor|third_party)(?:\/|$)/u.test(name);

function authoredCategory(name) {
  if (isGenerated(name)) return "generated";
  if (isVendored(name)) return "vendor";
  if (isTest(name) || /(?:^|\/)(?:tests?|e2e)(?:\/|$)/u.test(name)) return "tests";
  if (isExperiment(name)) return "experiments";
  if (isTooling(name)) return "tooling";
  return "production";
}

function authoredReceiptFromCounts(names, lineCount) {
  const areas = {};
  for (const name of names.filter((file) => sourceExtensions.has(extension(file)))) {
    const area = authoredCategory(name);
    areas[area] ??= { files: 0, lines: 0 };
    areas[area].files++;
    areas[area].lines += lineCount(name);
  }
  const count = (area) => areas[area]?.lines ?? 0;
  const production = count("production");
  const tests = count("tests");
  const experiments = count("experiments");
  const tooling = count("tooling");
  const vendor = count("vendor");
  const generated = count("generated");
  return {
    areas,
    production,
    tests,
    productionAndTests: production + tests,
    // Count every source line in the repository-level total.  Categorising
    // vendor/generated code remains useful, but moving maintained code there
    // must not make the whole-project guardrail smaller.
    authored: production + tests + experiments + tooling + vendor + generated,
  };
}

function authoredReceipt(directory, names) {
  return authoredReceiptFromCounts(
    names,
    (name) => lines(readFileSync(path.join(directory, name), "utf8")),
  );
}

if (process.argv.includes("--self-test")) {
  assert.equal(authoredCategory("backend/src/example.ts"), "production");
  assert.equal(authoredCategory("backend/src/example.test.ts"), "tests");
  assert.equal(authoredCategory("backend/experiments/example.ts"), "experiments");
  assert.equal(authoredCategory("scripts/example.cmd"), "tooling");
  assert.equal(authoredCategory("vendor/example.rs"), "vendor");
  assert.equal(authoredCategory("backend/src/generated/example.ts"), "generated");
  assert.equal(sourceExtensions.has(".cmd"), true);
  assert.equal(sourceExtensions.has(".toml"), true);
  const relocationProof = authoredReceiptFromCounts([
    "src/production.ts",
    "vendor/relocated.ts",
    "src/generated/relocated.ts",
  ], () => 1);
  assert.equal(relocationProof.authored, 3);
  assert.equal(relocationProof.production, 1);
  console.log("source guardrail self-test passed");
  process.exit(0);
}

function category(name) {
  const side = name.startsWith("backend/src/")
    ? "backend"
    : name.startsWith("frontend/src/")
      ? "frontend"
      : null;
  if (!side || name.endsWith(".d.ts")) return null;
  if (isTest(name)) return fixtureExtensions.has(extension(name)) ? `${side} tests` : null;
  if (isGenerated(name)) return sourceExtensions.has(extension(name)) ? `${side} generated` : null;
  return sourceExtensions.has(extension(name)) ? `${side} production` : null;
}

function refLineCounts(ref, names, directory = root) {
  const counts = new Map(names.map((name) => [name, 0]));
  const pathspecs = [...sourceExtensions].map((suffix) => `:(glob)**/*${suffix}`);
  // Ask Git for one count per blob.  Emitting every matching source line made
  // the guard itself corpus-sized and needlessly slow.
  const output = git(["grep", "-I", "-c", "-e", ".", ref, "--", ...pathspecs], directory);
  const prefix = `${ref}:`;
  for (const row of output.split(/\r?\n/u)) {
    const match = row.slice(prefix.length).match(/^(.+?):(\d+)$/u);
    if (match && counts.has(match[1])) counts.set(match[1], Number(match[2]));
  }
  return counts;
}

function authoredReceiptAtRef(directory, ref) {
  const names = listed(["ls-tree", "-r", "--name-only", ref], directory)
    .filter((name) => sourceExtensions.has(extension(name)));
  const counts = refLineCounts(ref, names, directory);
  return authoredReceiptFromCounts(names, (name) => counts.get(name) ?? 0);
}

function summarize(names, lineCounts) {
  const areas = {};
  const files = [];
  for (const name of names) {
    const area = category(name);
    if (!area) continue;
    const count = lineCounts.get(name) ?? 0;
    areas[area] ??= { files: 0, lines: 0 };
    areas[area].files++;
    areas[area].lines += count;
    if (area.endsWith("production")) files.push({ path: name, lines: count });
  }
  const production = ["backend production", "frontend production"]
    .reduce((sum, key) => sum + (areas[key]?.lines ?? 0), 0);
  const tests = ["backend tests", "frontend tests"]
    .reduce((sum, key) => sum + (areas[key]?.lines ?? 0), 0);
  return { areas, production, tests, total: production + tests, files };
}

const currentNames = listed(["ls-files", "--cached", "--others", "--exclude-standard", "--", ...appRoots])
  .filter((name) => existsSync(path.join(root, name)));
const currentCounts = new Map(currentNames.map((name) => [
  name,
  lines(readFileSync(path.join(root, name), "utf8")),
]));
const upstreamNames = listed(["ls-tree", "-r", "--name-only", upstream, "--", ...appRoots]);
const current = summarize(currentNames, currentCounts);
const pinned = summarize(upstreamNames, refLineCounts(upstream, upstreamNames));
if (pinned.production !== 91_699) {
  throw new Error(`Pinned upstream metric changed: expected 91699, got ${pinned.production}`);
}

const experimentNames = listed([
  "ls-files", "--cached", "--others", "--exclude-standard", "--",
  "experiments", "backend/experiments", "frontend/experiments",
]).filter((name) => existsSync(path.join(root, name)));
const experiments = experimentNames
  .filter((name) => sourceExtensions.has(extension(name)))
  .reduce((sum, name) => ({
    files: sum.files + 1,
    lines: sum.lines + lines(readFileSync(path.join(root, name), "utf8")),
  }), { files: 0, lines: 0 });
const relocatedFeatureLines = relocatedFeatureFiles.reduce((sum, name) => {
  const file = path.join(root, name);
  if (!existsSync(file)) throw new Error(`Relocated feature missing: ${name}`);
  return sum + lines(readFileSync(file, "utf8"));
}, 0);
const honestProduction = current.production + relocatedFeatureLines;

const lock = JSON.parse(readFileSync(path.join(root, "subrepos.lock.json"), "utf8"));
const subrepos = Object.fromEntries(Object.entries(lock.repositories).map(([name, pin]) => {
  const directory = path.join(root, name);
  const gitlink = pin.remote
    ? git(["ls-files", "--stage", "--", name]).trim().split(/\s+/)[1]
    : pin.commit;
  if (!existsSync(path.join(directory, ".git"))) {
    return [name, { ...pin, commit: gitlink, available: false }];
  }
  const names = listed(["ls-files", "--cached", "--others", "--exclude-standard"], directory)
    .filter((file) => existsSync(path.join(directory, file)));
  const head = git(["rev-parse", "HEAD"], directory).trim();
  const receipt = authoredReceipt(directory, names);
  return [name, {
    commit: gitlink,
    head,
    pinMatches: head === gitlink,
    dirty: git(["status", "--porcelain"], directory).trim() !== "",
    ...receipt,
  }];
}));

const nestedRepositoryPaths = [root, path.join(root, "subrepos")]
  .filter(existsSync)
  .flatMap((parent) => readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .filter((directory) => existsSync(path.join(directory, ".git"))));
const lockedPaths = new Set(Object.keys(lock.repositories)
  .map((name) => path.resolve(root, name).toLowerCase()));
const unlockedRepositories = Object.fromEntries(nestedRepositoryPaths
  .filter((directory) => !lockedPaths.has(path.resolve(directory).toLowerCase()))
  .map((directory) => {
    const name = path.relative(root, directory).replaceAll("\\", "/");
    const names = listed(["ls-files", "--cached", "--others", "--exclude-standard"], directory)
      .filter((file) => existsSync(path.join(directory, file)));
    return [name, {
      head: git(["rev-parse", "HEAD"], directory).trim(),
      dirty: git(["status", "--porcelain"], directory).trim() !== "",
      ...authoredReceipt(directory, names),
    }];
  }));

const rootAuthoredNames = listed(["ls-files", "--cached", "--others", "--exclude-standard"])
  .filter((name) => existsSync(path.join(root, name)));
const projectRepositories = {
  root: authoredReceipt(root, rootAuthoredNames),
  ...Object.fromEntries(Object.entries(subrepos)
    .filter(([, value]) => value.available !== false)
    .map(([name, value]) => [name, value])),
  ...Object.fromEntries(Object.entries(unlockedRepositories)
    .map(([name, value]) => [`unlocked:${name}`, value])),
};
const projectMetric = (key) => Object.values(projectRepositories)
  .reduce((sum, repository) => sum + (repository[key] ?? 0), 0);
const wholeProject = {
  repositories: projectRepositories,
  production: projectMetric("production"),
  tests: projectMetric("tests"),
  productionAndTests: projectMetric("productionAndTests"),
  authored: projectMetric("authored"),
};

const dependencies = Object.fromEntries(["package.json", "backend/package.json", "frontend/package.json"].map((name) => {
  const value = JSON.parse(readFileSync(path.join(root, name), "utf8"));
  return [name, {
    runtime: Object.keys(value.dependencies ?? {}).length,
    development: Object.keys(value.devDependencies ?? {}).length,
  }];
}));
const largestFiles = [...current.files].sort((a, b) => b.lines - a.lines).slice(0, 15);
const directoryMap = new Map();
for (const file of current.files) {
  const parts = file.path.split("/");
  const name = parts.slice(0, Math.min(4, parts.length - 1)).join("/");
  directoryMap.set(name, (directoryMap.get(name) ?? 0) + file.lines);
}
const largestDirectories = [...directoryMap].map(([path, lines]) => ({ path, lines }))
  .sort((a, b) => b.lines - a.lines).slice(0, 15);
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  commit: git(["rev-parse", "HEAD"]).trim(),
  upstream,
  current: { ...current, files: undefined },
  pinnedUpstream: { ...pinned, files: undefined },
  deltaToUpstream: current.production - pinned.production,
  designTarget: 70_000,
  deltaToDesignTarget: current.production - 70_000,
  relocatedFeatureLines,
  honestProduction,
  honestDeltaToDesignTarget: honestProduction - 70_000,
  experiments,
  dependencies,
  subrepos,
  unlockedRepositories,
  wholeProject,
  largestFiles,
  largestDirectories,
};

const checkIndex = process.argv.indexOf("--check");
const budgetPath = checkIndex >= 0
  ? path.resolve(root, process.argv[checkIndex + 1] ?? "scripts/legal-structure-guardrails.json")
  : null;
const failures = [];
if (budgetPath) {
  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const baselineSubrepos = budget.baselineSubrepos ?? Object.fromEntries(
    Object.entries(subrepos).map(([name, repository]) => [name, repository.commit]),
  );
  if (Object.keys(baselineSubrepos).sort().join("\0") !== Object.keys(lock.repositories).sort().join("\0")) {
    failures.push("baseline subrepository set does not match the current locked set");
  }
  const baselineRepositories = {
    root: authoredReceiptAtRef(root, budget.baselineCommit),
    ...Object.fromEntries(Object.entries(baselineSubrepos).map(([name, commit]) => [
      name,
      authoredReceiptAtRef(path.join(root, name), commit),
    ])),
  };
  const baseline = Object.fromEntries([
    "production", "tests", "productionAndTests", "authored",
  ].map((metric) => [metric, Object.values(baselineRepositories)
    .reduce((sum, repository) => sum + repository[metric], 0)]));
  report.baselineWholeProject = { commit: budget.baselineCommit, repositories: baselineRepositories, ...baseline };
  for (const [metric, maximum] of Object.entries(budget.maximums ?? {})) {
    const actual = wholeProject[metric];
    if (!Number.isFinite(actual)) failures.push(`unknown whole-project metric: ${metric}`);
    else if (actual > maximum) failures.push(`${metric}: ${actual} exceeds ${maximum}`);
    if (baseline[metric] !== maximum) {
      failures.push(`${metric}: configured maximum ${maximum} != measured baseline ${baseline[metric]}`);
    }
  }
  for (const [name, repository] of Object.entries(subrepos)) {
    if (repository.available === false) failures.push(`${name}: locked subrepository unavailable`);
    else if (!repository.pinMatches) failures.push(`${name}: HEAD ${repository.head} != pin ${repository.commit}`);
    else if (repository.dirty) failures.push(`${name}: dirty subrepository`);
  }
  for (const name of Object.keys(unlockedRepositories)) {
    failures.push(`${name}: nested repository is not pinned in subrepos.lock.json`);
  }
  report.budget = { path: path.relative(root, budgetPath).replaceAll("\\", "/"), failures };
}

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failures.length ? 1 : 0);
}

console.log(`Beaver source receipt at ${report.commit.slice(0, 8)}`);
console.table(Object.fromEntries(Object.entries(current.areas).map(([name, value]) => [name, value])));
console.table({
  "Beaver production": { lines: current.production },
  "Pinned upstream production": { lines: pinned.production },
  "Excess over upstream": { lines: report.deltaToUpstream },
  "Excess over 70k target": { lines: report.deltaToDesignTarget },
  "Beaver production + tests": { lines: current.total },
  "Intact features moved to experiments": { lines: relocatedFeatureLines },
  "Honest production": { lines: honestProduction },
  "Honest excess over 70k target": { lines: report.honestDeltaToDesignTarget },
});
console.log("\nDependencies");
console.table(dependencies);
console.log("\nLargest production files");
console.table(largestFiles);
console.log("\nLargest production directories");
console.table(largestDirectories);
console.log("\nExperiments and pinned subrepositories (excluded from app total)");
console.table({ experiments, ...subrepos });
console.log("\nWhole project (root plus every locked subrepository)");
console.table(Object.fromEntries(Object.entries(projectRepositories).map(([name, value]) => [name, {
  production: value.production,
  tests: value.tests,
  productionAndTests: value.productionAndTests,
  authored: value.authored,
}])));
console.table({ total: wholeProject });
if (failures.length) {
  console.error(`\nSource budget failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
