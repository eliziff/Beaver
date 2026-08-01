/**
 * Aggregate docx-edit-bench receipts into a comparison table.
 *
 * Reports the within-arm run-to-run floor beside every between-arm
 * difference: with a set this size a difference inside the floor is noise,
 * and printing it without the floor invites the wrong reading.
 *
 *   npx tsx ../benchmarks/docx_edit/src/report.ts --out <receipts-dir> [--json]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadTasks } from "./tasks";

type Receipt = {
  surface: string;
  task: string;
  replicate: number;
  difficulty: string;
  floor_task: boolean;
  expected: string;
  run_error: string | null;
  wall_clock_seconds: number;
  provider_turns: number;
  tool_calls: number;
  tools_used: Record<string, number>;
  tool_failures: number;
  tool_errors: { name: string; error: string }[];
  scope_kinds: Record<string, number>;
  address_args: string[];
  retyped_arg_count: number;
  retyped_chars: number;
  misquoted_arg_count: number;
  misquoted_args: { path: string; value: string }[];
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  score: {
    pass: boolean;
    sites_correct: number;
    sites_wrong: number;
    sites_missed: number;
    targets_total: number;
    guards_total: number;
    foreign_line_removals: number;
  };
};

const argOf = (name: string, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
};

const mean = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

function main() {
  const dir = argOf("out");
  if (!dir) throw new Error("--out is required");
  const receipts = readFileSync(path.join(dir, "receipts.jsonl"), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Receipt);
  const tasks = loadTasks();
  const surfaces = [...new Set(receipts.map((r) => r.surface))].sort();

  // Within-arm floor: for each (surface, task) cell with >1 replicate, how
  // often did replicates of the SAME cell disagree on pass/fail?
  const cellDisagreements: Record<string, { cells: number; split: number }> = {};
  for (const surface of surfaces) cellDisagreements[surface] = { cells: 0, split: 0 };
  for (const surface of surfaces) {
    for (const task of tasks) {
      const cell = receipts.filter((r) => r.surface === surface && r.task === task.id);
      if (cell.length < 2) continue;
      cellDisagreements[surface].cells += 1;
      const passes = cell.filter((r) => r.score.pass).length;
      if (passes !== 0 && passes !== cell.length) cellDisagreements[surface].split += 1;
    }
  }

  const rows: Record<string, unknown>[] = [];
  console.log(`docx-edit-bench report — ${receipts.length} receipts\n`);
  const header = ["metric", ...surfaces];
  const table: string[][] = [header];
  const scoped = (surface: string, filter: (r: Receipt) => boolean) =>
    receipts.filter((r) => r.surface === surface && filter(r));

  const nonFloor = (r: Receipt) => !r.floor_task;
  const metric = (
    label: string,
    fn: (list: Receipt[]) => string,
    filter: (r: Receipt) => boolean = () => true,
  ) => table.push([label, ...surfaces.map((s) => fn(scoped(s, filter)))]);

  const passRate = (list: Receipt[]) =>
    list.length ? `${((list.filter((r) => r.score.pass).length / list.length) * 100).toFixed(0)}% (${list.filter((r) => r.score.pass).length}/${list.length})` : "-";

  metric("pass rate (all)", passRate);
  metric("pass rate (excl. floor)", passRate, nonFloor);
  metric("pass rate (devious)", passRate, (r) => r.difficulty === "devious");
  metric("pass rate (refusal)", passRate, (r) => r.expected === "refuse");
  metric("targets hit", (l) =>
    `${(mean(l.map((r) => r.score.sites_correct)) ).toFixed(2)}/${mean(l.map((r) => r.score.targets_total)).toFixed(2)}`);
  metric("guards broken / run", (l) => mean(l.map((r) => r.score.sites_wrong)).toFixed(2));
  metric("targets missed / run", (l) => mean(l.map((r) => r.score.sites_missed)).toFixed(2));
  metric("collateral line loss / run", (l) =>
    mean(l.map((r) => r.score.foreign_line_removals)).toFixed(2));
  metric("tool calls / run", (l) => mean(l.map((r) => r.tool_calls)).toFixed(1));
  metric("failed tool calls / run", (l) => mean(l.map((r) => r.tool_failures)).toFixed(2));
  metric("provider turns / run", (l) => mean(l.map((r) => r.provider_turns)).toFixed(1));
  metric("input tokens / run", (l) => Math.round(mean(l.map((r) => r.input_tokens))).toLocaleString("en-CA"));
  metric("output tokens / run", (l) => Math.round(mean(l.map((r) => r.output_tokens))).toLocaleString("en-CA"));
  metric("total tokens / run", (l) => Math.round(mean(l.map((r) => r.total_tokens))).toLocaleString("en-CA"));
  metric("wall clock s / run", (l) => mean(l.map((r) => r.wall_clock_seconds)).toFixed(1));
  metric("retyped doc strings / run", (l) => mean(l.map((r) => r.retyped_arg_count)).toFixed(1));
  metric("retyped chars / run", (l) => Math.round(mean(l.map((r) => r.retyped_chars))).toLocaleString("en-CA"));
  metric("MISQUOTED doc strings / run", (l) => mean(l.map((r) => r.misquoted_arg_count)).toFixed(2));
  metric("runs with a misquote", (l) =>
    `${l.filter((r) => r.misquoted_arg_count > 0).length}/${l.length}`);
  metric("run errors", (l) => `${l.filter((r) => r.run_error).length}/${l.length}`);
  table.push([
    "replicate disagreement (floor)",
    ...surfaces.map((s) => {
      const cell = cellDisagreements[s];
      return cell.cells
        ? `${((cell.split / cell.cells) * 100).toFixed(0)}% of cells (${cell.split}/${cell.cells})`
        : "n/a";
    }),
  ]);

  const widths = header.map((_, index) =>
    Math.max(...table.map((row) => (row[index] ?? "").length)),
  );
  for (const row of table) {
    console.log(row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  "));
  }

  console.log("\nTool usage per surface (calls per run):");
  for (const surface of surfaces) {
    const list = scoped(surface, () => true);
    const totals: Record<string, number> = {};
    for (const receipt of list) {
      for (const [name, count] of Object.entries(receipt.tools_used)) {
        totals[name] = (totals[name] ?? 0) + count;
      }
    }
    const line = Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} ${(count / Math.max(1, list.length)).toFixed(2)}`)
      .join("  ");
    console.log(`  ${surface}: ${line || "(none)"}`);
    const scopes: Record<string, number> = {};
    for (const receipt of list) {
      for (const [kind, count] of Object.entries(receipt.scope_kinds)) {
        scopes[kind] = (scopes[kind] ?? 0) + count;
      }
    }
    console.log(
      `    edit scope kinds: ${Object.entries(scopes)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ") || "(none)"}`,
    );
    const unused = ["library_links", "library_outline", "library_find", "library_apply_text_ops"].filter(
      (name) => !totals[name],
    );
    if (unused.length) console.log(`    never used: ${unused.join(", ")}`);
  }

  console.log("\nPer-task pass, by surface:");
  for (const task of tasks) {
    const cells = surfaces.map((surface) => {
      const list = receipts.filter((r) => r.surface === surface && r.task === task.id);
      if (!list.length) return "  - ";
      return ` ${list.filter((r) => r.score.pass).length}/${list.length}`;
    });
    console.log(
      `  ${task.id.padEnd(28)} ${task.difficulty.padEnd(8)}${task.floor_task ? " [floor]" : "       "} ${cells.join("  ")}`,
    );
    rows.push({ task: task.id, difficulty: task.difficulty, cells });
  }

  // Why runs failed, in the surface's own words. This is the half of the
  // result that says what an editing schema should look like: an address
  // that would not resolve and a retyped string that was not in the document
  // are different diseases and want different fixes.
  console.log("\nTool-error census (distinct error text, count), per surface:");
  for (const surface of surfaces) {
    const census = new Map<string, { count: number; tools: Set<string> }>();
    for (const receipt of scoped(surface, () => true)) {
      for (const entry of receipt.tool_errors) {
        const key = entry.error.replace(/'[^']{0,80}'/gu, "'…'").slice(0, 150);
        const row = census.get(key) ?? { count: 0, tools: new Set<string>() };
        row.count += 1;
        row.tools.add(entry.name);
        census.set(key, row);
      }
    }
    console.log(`  ${surface}:`);
    if (!census.size) console.log("    (no tool errors)");
    for (const [text, row] of [...census.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`    ${String(row.count).padStart(3)}x [${[...row.tools].join(",")}] ${text}`);
    }
  }

  console.log("\nMisquoted locating strings (retyping that was wrong), per surface:");
  for (const surface of surfaces) {
    const list = scoped(surface, () => true).flatMap((receipt) =>
      receipt.misquoted_args.map((entry) => ({ task: receipt.task, ...entry })),
    );
    console.log(`  ${surface}: ${list.length} across ${scoped(surface, () => true).length} runs`);
    for (const entry of list.slice(0, 25)) {
      console.log(`    ${entry.task} ${entry.path}: ${JSON.stringify(entry.value)}`);
    }
  }

  console.log("\nAddress arguments used, per surface (form -> count):");
  for (const surface of surfaces) {
    const forms = new Map<string, number>();
    for (const receipt of scoped(surface, () => true)) {
      for (const raw of receipt.address_args) {
        // Keep the parameter and the SHAPE of its value, not the value.
        const [head, ...rest] = raw.split("=");
        const value = rest.join("=");
        const shape = !value
          ? "(empty)"
          : /^off:\d+$/u.test(value)
            ? "off:N"
            : /^(pdf|printed):/u.test(value)
              ? value.split(":")[0] + ":N"
              : /^\d+$/u.test(value)
                ? "N"
                : /^(sec|art|part|sched)/iu.test(value)
                  ? "handle"
                  : /^\d+\.\d+/u.test(value)
                    ? "N.NN"
                    : "text";
        const key = `${head}=${shape}`;
        forms.set(key, (forms.get(key) ?? 0) + 1);
      }
    }
    console.log(
      `  ${surface}: ${[...forms.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([form, count]) => `${form} ${count}`)
        .join("  ") || "(none)"}`,
    );
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ surfaces, rows }, null, 1));
  }
}

main();
