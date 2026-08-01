/**
 * Run a whole matrix: every selected task x every named surface x N
 * replicates. Resumable — a cell already present in receipts.jsonl is
 * skipped, so an interrupted campaign continues where it stopped.
 *
 *   npx tsx ../benchmarks/docx_edit/src/campaign.ts \
 *     --surfaces beaver-legacy,beaver-address --reps 2 \
 *     --model codex:gpt-5.6-sol --out <dir> [--lane 0 --lanes 2] [--task a,b]
 *
 * Lanes exist so two shells can share one output directory without either
 * running the other's cells; keep the lane count modest.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { selectTasks } from "./tasks";

const argOf = (name: string, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};
const listArg = (name: string) =>
  argOf(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

function done(outDir: string): Set<string> {
  const file = path.join(outDir, "receipts.jsonl");
  if (!existsSync(file)) return new Set();
  const keys = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as {
        surface: string;
        task: string;
        replicate: number;
        run_error: string | null;
      };
      if (!row.run_error) keys.add(`${row.surface}|${row.task}|${row.replicate}`);
    } catch {}
  }
  return keys;
}

function main() {
  const outDir = argOf("out");
  if (!outDir) throw new Error("--out is required");
  const surfaces = listArg("surfaces");
  if (!surfaces.length) throw new Error("--surfaces is required");
  const reps = Number(argOf("reps", "2"));
  const model = argOf("model", "codex:gpt-5.6-sol");
  const effort = argOf("effort", "medium");
  const lane = Number(argOf("lane", "0"));
  const lanes = Number(argOf("lanes", "1"));
  const tasks = selectTasks({ ids: listArg("task") });

  const cells: { surface: string; task: string; rep: number }[] = [];
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const [index, task] of tasks.entries()) {
      if (index % lanes !== lane) continue;
      for (const surface of surfaces) cells.push({ surface, task: task.id, rep });
    }
  }

  const completed = done(outDir);
  const tsxCli = require.resolve("tsx/cli", {
    paths: [path.join(__dirname, "..", "..", "..", "backend")],
  });
  const runner = path.join(__dirname, "run.ts");
  let ran = 0;
  let skipped = 0;
  for (const cell of cells) {
    const key = `${cell.surface}|${cell.task}|${cell.rep}`;
    if (completed.has(key)) {
      skipped += 1;
      continue;
    }
    const result = spawnSync(
      process.execPath,
      [
        tsxCli,
        runner,
        "--surface", cell.surface,
        "--task", cell.task,
        "--model", model,
        "--effort", effort,
        "--rep", String(cell.rep),
        "--out", outDir,
      ],
      { stdio: "inherit", timeout: 45 * 60_000 },
    );
    ran += 1;
    if (result.status !== 0) console.error(`  (cell failed: ${key})`);
  }
  console.log(`lane ${lane}/${lanes}: ${ran} cells run, ${skipped} already present`);
}

main();
