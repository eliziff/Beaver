/**
 * Deterministic pilot-task selector for the Harvey LAB harness-comparison
 * experiment (benchmarks/lab/PROTOCOL.md). Enumerates LAB tasks, keeps those
 * whose deliverables the Beaver arm can produce (docx/md/txt only), and
 * round-robins a seeded-hash-ordered pick across practice-area strata so both
 * arms run the identical list.
 *
 *   npx tsx scripts/lab-select-tasks.ts [--n 12] [--seed lab-pilot-1]
 *     [--lab-root <lab-root>]
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

type Candidate = {
  id: string;
  area: string;
  workType: string;
  deliverables: string[];
  order: string;
};

function findTasks(dir: string, rel: string[]): Candidate[] {
  const config = path.join(dir, "task.json");
  if (existsSync(config)) {
    const parsed = JSON.parse(readFileSync(config, "utf8")) as {
      work_type?: string;
      criteria?: { deliverables?: string[] }[];
    };
    const id = rel.join("/");
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
    task.deliverables.every((name) => /\.(docx|md|txt)$/iu.test(name)),
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
for (let round = 0; picked.length < n; round += 1) {
  let advanced = false;
  for (const area of areas) {
    const pool = byArea.get(area) ?? [];
    if (round < pool.length && picked.length < n) {
      picked.push(pool[round]);
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
      picked: picked.map((task) => ({
        id: task.id,
        work_type: task.workType,
        deliverables: task.deliverables,
      })),
    },
    null,
    2,
  ),
);
