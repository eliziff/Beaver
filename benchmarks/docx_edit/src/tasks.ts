/**
 * Task loading and structural validation for docx-edit-bench.
 *
 * Tasks are data. This file is the only thing that reads tasks.jsonl, and it
 * refuses a task that is missing anything the harness or the honesty
 * requirements depend on — so a badly formed task fails at load rather than
 * quietly scoring as a pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { FIXTURES } from "./fixtures";
import { TASK_SCHEMA, type Task } from "./types";

const TASKS_PATH = path.join(__dirname, "..", "tasks.jsonl");

const KNOWN_FIXTURES = new Set(FIXTURES.map((entry) => entry.id));

function validate(task: Task, line: number): string[] {
  const problems: string[] = [];
  const at = (message: string) => `tasks.jsonl:${line} (${task.id ?? "?"}): ${message}`;
  if (task.schema !== TASK_SCHEMA) problems.push(at(`schema must be ${TASK_SCHEMA}`));
  if (!task.id) problems.push(at("id is required"));
  if (typeof task.version !== "number") problems.push(at("version must be a number"));
  if (!task.instruction?.trim()) problems.push(at("instruction is required"));
  if (!task.why?.trim()) problems.push(at("why is required — record what the task probes"));
  if (!Array.isArray(task.categories) || !task.categories.length) {
    problems.push(at("at least one category is required"));
  }
  if (!["floor", "easy", "medium", "hard", "devious"].includes(task.difficulty)) {
    problems.push(at(`unknown difficulty '${task.difficulty}'`));
  }
  if (!Array.isArray(task.fixtures) || !task.fixtures.length) {
    problems.push(at("fixtures is required"));
  }
  for (const id of task.fixtures ?? []) {
    if (!KNOWN_FIXTURES.has(id)) problems.push(at(`unknown fixture '${id}'`));
  }
  if (!task.fixtures?.includes(task.target_fixture)) {
    problems.push(at("target_fixture must be one of fixtures"));
  }
  if (task.expected !== "edit" && task.expected !== "refuse") {
    problems.push(at("expected must be 'edit' or 'refuse'"));
  }
  if (!Array.isArray(task.checks?.targets) || !Array.isArray(task.checks?.guards)) {
    problems.push(at("checks.targets and checks.guards are required arrays"));
  }
  if (!Array.isArray(task.near_misses) || !task.near_misses.length) {
    problems.push(at("at least one near miss is required — a check never seen to fail is not a check"));
  }
  if (task.expected === "edit") {
    if (!task.reference_edits?.length) {
      problems.push(at("an edit task needs reference_edits: the demonstrated solution"));
    }
    if (!task.checks.targets.length) {
      problems.push(at("an edit task needs at least one target site"));
    }
    if (!task.checks.guards.length) {
      problems.push(
        at("an edit task needs at least one guard — the negative half blocks the rewrite shortcut"),
      );
    }
  } else {
    if (task.reference_edits?.length) {
      problems.push(at("a refusal task must have no reference_edits"));
    }
    if (!task.checks.unchanged_documents?.length) {
      problems.push(at("a refusal task must name the documents that must not change"));
    }
    if (!task.checks.answer_must_match) {
      problems.push(at("a refusal task must check the answer, or it scores silence as success"));
    }
  }
  for (const site of [...(task.checks?.targets ?? []), ...(task.checks?.guards ?? [])]) {
    try {
      new RegExp(site.pattern, "gu");
    } catch (error) {
      problems.push(at(`site '${site.id}' has an invalid pattern: ${String(error)}`));
    }
    if (site.fixture && !task.fixtures.includes(site.fixture)) {
      problems.push(at(`site '${site.id}' names a fixture not in the task`));
    }
  }
  return problems;
}

let cached: Task[] | null = null;

export function loadTasks(): Task[] {
  if (cached) return cached;
  const problems: string[] = [];
  const tasks: Task[] = [];
  const seen = new Set<string>();
  const lines = readFileSync(TASKS_PATH, "utf8").split(/\r?\n/u);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: Task;
    try {
      parsed = JSON.parse(line) as Task;
    } catch (error) {
      problems.push(`tasks.jsonl:${index + 1}: ${String(error)}`);
      return;
    }
    problems.push(...validate(parsed, index + 1));
    if (seen.has(parsed.id)) problems.push(`tasks.jsonl:${index + 1}: duplicate id '${parsed.id}'`);
    seen.add(parsed.id);
    tasks.push(parsed);
  });
  if (problems.length) {
    throw new Error(`docx-edit-bench task validation failed:\n  ${problems.join("\n  ")}`);
  }
  cached = tasks;
  return tasks;
}

export function taskById(id: string): Task {
  const found = loadTasks().find((task) => task.id === id);
  if (!found) throw new Error(`unknown task: ${id}`);
  return found;
}

export function selectTasks(filter: {
  ids?: string[];
  difficulty?: string[];
  category?: string[];
  fixture?: string[];
  includeFloor?: boolean;
}): Task[] {
  return loadTasks().filter((task) => {
    if (filter.ids?.length && !filter.ids.includes(task.id)) return false;
    if (filter.difficulty?.length && !filter.difficulty.includes(task.difficulty)) return false;
    if (filter.category?.length && !task.categories.some((c) => filter.category!.includes(c)))
      return false;
    if (filter.fixture?.length && !task.fixtures.some((f) => filter.fixture!.includes(f)))
      return false;
    if (filter.includeFloor === false && task.floor_task) return false;
    return true;
  });
}
