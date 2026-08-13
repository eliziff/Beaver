import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = "3382734de884b763630b4670764e0f246d48469f";
const jsonOnly = process.argv.includes("--json");
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".mjs", ".cjs", ".php", ".ps1",
  ".py", ".rb", ".rs", ".sh", ".sql", ".ts", ".tsx",
]);
const fixtureExtensions = new Set([
  ...sourceExtensions,
  ".csv", ".json", ".md", ".txt", ".xml", ".yaml", ".yml",
]);
const appRoots = ["backend/src", "frontend/src"];

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

function refLineCounts(ref, names) {
  const counts = new Map(names.map((name) => [name, 0]));
  const output = git(["grep", "-I", "-n", "-e", ".", ref, "--", ...appRoots]);
  const prefix = `${ref}:`;
  for (const row of output.split(/\r?\n/u)) {
    const match = row.slice(prefix.length).match(/^(.+?):\d+:/u);
    if (match && counts.has(match[1])) counts.set(match[1], counts.get(match[1]) + 1);
  }
  return counts;
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

const lock = JSON.parse(readFileSync(path.join(root, "subrepos.lock.json"), "utf8"));
const subrepos = Object.fromEntries(Object.entries(lock.repositories).map(([name, pin]) => {
  const directory = path.join(root, name);
  if (!existsSync(path.join(directory, ".git"))) return [name, { ...pin, available: false }];
  const names = listed(["ls-files"], directory)
    .filter((file) => existsSync(path.join(directory, file)))
    .filter((file) => sourceExtensions.has(extension(file)));
  return [name, {
    commit: pin.commit,
    dirty: git(["status", "--porcelain", "--untracked-files=no"], directory).trim() !== "",
    files: names.length,
    lines: names.reduce((sum, file) => sum + lines(readFileSync(path.join(directory, file), "utf8")), 0),
  }];
}));

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
  designTarget: 87_000,
  deltaToDesignTarget: current.production - 87_000,
  experiments,
  dependencies,
  subrepos,
  largestFiles,
  largestDirectories,
};

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

console.log(`Beaver source receipt at ${report.commit.slice(0, 8)}`);
console.table(Object.fromEntries(Object.entries(current.areas).map(([name, value]) => [name, value])));
console.table({
  "Beaver production": { lines: current.production },
  "Pinned upstream production": { lines: pinned.production },
  "Excess over upstream": { lines: report.deltaToUpstream },
  "Excess over 87k target": { lines: report.deltaToDesignTarget },
  "Beaver production + tests": { lines: current.total },
});
console.log("\nDependencies");
console.table(dependencies);
console.log("\nLargest production files");
console.table(largestFiles);
console.log("\nLargest production directories");
console.table(largestDirectories);
console.log("\nExperiments and pinned subrepositories (excluded from app total)");
console.table({ experiments, ...subrepos });
