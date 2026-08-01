/**
 * Deterministic pilot-task selector for the Harvey LAB harness-comparison
 * experiment (benchmarks/lab/PROTOCOL.md). Enumerates visible dev LAB tasks, keeps those
 * whose deliverables the Beaver arm can produce (docx/md/txt only), and
 * round-robins a seeded-hash-ordered pick across practice-area strata so both
 * arms run the identical list.
 *
 *   npx tsx scripts/lab-select-tasks.ts [--n 12] [--seed lab-pilot-1]
 *     [--max-files 40] [--lab-root <lab-root>]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const labRoot = argument("lab-root", process.env.LAB_ROOT || "");
const n = Number(argument("n", "12"));
const seed = argument("seed", "lab-pilot-1");
const maxFiles = Number(argument("max-files", "40"));

type Candidate = {
  id: string;
  area: string;
  workType: string;
  deliverables: string[];
  order: string;
  genre: string;
  files: number;
  bytes: number;
  sha256: string;
};

type SplitEntry = {
  task: string;
  tier: string;
  genre: string;
  files: number;
  bytes: number;
  sha256: string;
};

const split = JSON.parse(
  readFileSync(path.join(labRoot, "..", "lab", "corpus-split.json"), "utf8"),
) as { tasks: SplitEntry[] };
const visibleDev = new Map(
  split.tasks
    .filter((entry) => entry.tier === "dev")
    .map((entry) => [entry.task, entry]),
);

function findTasks(dir: string, rel: string[]): Candidate[] {
  const config = path.join(dir, "task.json");
  if (existsSync(config)) {
    const parsed = JSON.parse(readFileSync(config, "utf8")) as {
      work_type?: string;
      criteria?: { deliverables?: string[] }[];
    };
    const id = rel.join("/");
    const splitEntry = visibleDev.get(id);
    if (!splitEntry) return [];
    const deliverables = [
      ...new Set((parsed.criteria ?? []).flatMap((c) => c.deliverables ?? [])),
    ];
    return [
      {
        id,
        area: rel[0],
        workType: parsed.work_type ?? "unknown",
        deliverables,
        order: createHash("sha256").update(`${seed}:${id}`).digest("hex"),
        genre: splitEntry.genre,
        files: splitEntry.files,
        bytes: splitEntry.bytes,
        sha256: splitEntry.sha256,
      },
    ];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "documents")
    .flatMap((entry) =>
      findTasks(path.join(dir, entry.name), [...rel, entry.name]),
    );
}

const all = findTasks(path.join(labRoot, "tasks"), []).filter(
  (task) => task.id.split("/").length >= 2,
);
const eligible = all.filter(
  (task) =>
    task.deliverables.length > 0 &&
    task.deliverables.every((name) => /\.(docx|md|txt)$/iu.test(name)) &&
    task.files <= maxFiles,
);

// Round-robin across practice areas in hash order for stratified coverage.
const byArea = new Map<string, Candidate[]>();
for (const task of eligible) {
  byArea.set(task.area, [...(byArea.get(task.area) ?? []), task]);
}
for (const tasks of byArea.values())
  tasks.sort((a, b) => a.order.localeCompare(b.order));
const areas = [...byArea.keys()].sort();

const picked: Candidate[] = [];
// Preserve every rare task shape before filling by practice area. The visible
// dev split is analyze-heavy; a plain area round-robin can accidentally erase
// the drafting/extraction/editing cases the experiment needs.
for (const genre of [...new Set(eligible.map((task) => task.genre))].sort()) {
  const candidate = eligible
    .filter((task) => task.genre === genre)
    .sort((a, b) => a.order.localeCompare(b.order))[0];
  if (candidate && picked.length < n) picked.push(candidate);
}
for (let round = 0; picked.length < n; round += 1) {
  let advanced = false;
  for (const area of areas) {
    const pool = byArea.get(area) ?? [];
    const candidate = pool[round];
    if (candidate && !picked.includes(candidate) && picked.length < n) {
      picked.push(candidate);
      advanced = true;
    }
  }
  if (!advanced) break;
}

console.log(
  JSON.stringify(
    {
      seed,
      total_tasks: all.length,
      eligible_tasks: eligible.length,
      tier: "dev",
      max_files: maxFiles,
      picked: picked.map((task) => ({
        id: task.id,
        genre: task.genre,
        work_type: task.workType,
        files: task.files,
        bytes: task.bytes,
        sha256: task.sha256,
        deliverables: task.deliverables,
      })),
    },
    null,
    2,
  ),
);
