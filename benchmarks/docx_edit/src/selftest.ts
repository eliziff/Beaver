/**
 * docx-edit-bench self-test: task validity and outcome validity, separately.
 *
 * TASK VALIDITY — is the task well posed and solvable? Every task carries a
 * reference solution as literal edits. Applying them must (a) find every
 * string it claims to find, and (b) produce a document the checker passes.
 * A task whose reference solution does not verify is not shipped.
 *
 * OUTCOME VALIDITY — can the checker actually fail? Every task carries at
 * least one hand-written near miss, and the harness generates two more for
 * free: the untouched document, and a partially regenerated document that
 * satisfies the positive half while destroying original lines. Each must be
 * rejected, and the report says WHICH check rejected it, so a check that has
 * never been observed to fire is visible.
 */
import {
  automaticNearMisses,
  scoreTask,
  synthesiseResult,
  windowBounds,
} from "./checks";
import { fixtureText } from "./fixtures";
import { loadTasks } from "./tasks";
import type { Score, Site, Task } from "./types";

/**
 * Synthetic sensitivity probe for one guard: take the reference result, find
 * what the guard is protecting, and damage exactly that. A guard that still
 * reports ok afterwards is not checking anything, and a guard the written
 * near misses happen never to touch would otherwise ship unexercised.
 *
 * Returns null when the guard's expectation is "this must NOT appear", which
 * cannot be broken by damaging a match that does not exist; those are
 * reported as not synthetically exercisable rather than silently counted.
 */
function damageGuard(
  texts: Map<string, string>,
  site: Site,
  targetFixture: string,
): Map<string, string> | null {
  const fixtureId = site.fixture ?? targetFixture;
  const text = texts.get(fixtureId);
  if (text === undefined) return null;
  if (site.count === 0) return null;
  const bounds = windowBounds(text, site.window);
  if (!bounds) return null;
  const scope = text.slice(bounds[0], bounds[1]);
  const re = new RegExp(site.pattern, site.ignore_case ? "gui" : "gu");
  const spans: [number, number][] = [];
  for (let match = re.exec(scope); match; match = re.exec(scope)) {
    spans.push([match.index, match.index + match[0].length]);
    if (match.index === re.lastIndex) re.lastIndex += 1;
  }
  if (!spans.length) return null;
  // Damage exactly as many matches as it takes to violate the stated
  // expectation: one is enough for an exact count, but a `min_count` guard
  // with slack is only broken by taking it below the floor.
  const needed =
    typeof site.count === "number"
      ? 1
      : typeof site.min_count === "number"
        ? Math.max(1, spans.length - site.min_count + 1)
        : spans.length;
  if (needed > spans.length) return null;
  let damaged = text;
  for (const [start, end] of spans.slice(0, needed).reverse()) {
    const at = bounds[0] + start;
    damaged =
      damaged.slice(0, at) + "[[guard-probe]]" + damaged.slice(bounds[0] + end);
  }
  const out = new Map(texts);
  out.set(fixtureId, damaged);
  return out;
}

export type CaseOutcome = {
  case_id: string;
  kind: "reference" | "near_miss" | "auto_probe";
  why?: string;
  expected: "pass" | "fail";
  actual: "pass" | "fail";
  ok: boolean;
  /** Which checks fired. Empty on a pass. */
  fired: string[];
  score: Score;
};

export type TaskSelfTest = {
  task_id: string;
  difficulty: Task["difficulty"];
  floor_task: boolean;
  categories: string[];
  /** (a) the reference solution applies cleanly and the checker passes it. */
  solvable: boolean;
  solvability_notes: string[];
  /** (b) every wrong result is rejected. */
  discriminating: boolean;
  cases: CaseOutcome[];
  /** Site ids observed failing at least once across the wrong results. */
  sites_exercised: string[];
  /** Site ids never observed failing — checks with no demonstrated sensitivity. */
  sites_never_fired: string[];
  /** Guards whose expectation cannot be broken by damaging a match. */
  sites_not_synthetically_exercisable: string[];
};

async function originalsFor(task: Task): Promise<Map<string, string>> {
  const originals = new Map<string, string>();
  for (const id of task.fixtures) originals.set(id, await fixtureText(id));
  return originals;
}

function firedIds(score: Score): string[] {
  const ids = score.sites.filter((site) => !site.ok).map((site) => `${site.kind}:${site.id}`);
  if (score.foreign_line_removals > 0) ids.push("collateral:line_removals");
  if (score.foreign_line_additions > 0) ids.push("collateral:line_additions");
  for (const doc of score.unchanged_document_violations) ids.push(`unchanged:${doc}`);
  if (score.answer_check === "fail") ids.push("answer");
  if (!score.document_changed) ids.push("document:unchanged");
  return ids;
}

export async function selfTestTask(task: Task): Promise<TaskSelfTest> {
  const originals = await originalsFor(task);
  const cases: CaseOutcome[] = [];

  // (a) task validity
  const reference = synthesiseResult(originals, task.reference_edits, task.target_fixture);
  const referenceScore = scoreTask({
    task,
    originals,
    results: reference.texts,
    answer: task.reference_answer ?? "",
  });
  cases.push({
    case_id: "reference",
    kind: "reference",
    expected: "pass",
    actual: referenceScore.pass ? "pass" : "fail",
    ok: referenceScore.pass,
    fired: firedIds(referenceScore),
    score: referenceScore,
  });
  const solvabilityNotes = [...reference.unapplied];
  if (!referenceScore.pass) solvabilityNotes.push(...referenceScore.failures);

  // (b) outcome validity
  const wrongResults: { id: string; kind: CaseOutcome["kind"]; why: string; texts: Map<string, string>; answer: string }[] =
    [];
  for (const nearMiss of task.near_misses) {
    const built = synthesiseResult(originals, nearMiss.edits, task.target_fixture);
    wrongResults.push({
      id: nearMiss.id,
      kind: "near_miss",
      why: nearMiss.why,
      texts: built.texts,
      answer: nearMiss.answer ?? task.reference_answer ?? "Done.",
    });
    if (built.unapplied.length && nearMiss.edits.length) {
      solvabilityNotes.push(`near miss '${nearMiss.id}': ${built.unapplied.join("; ")}`);
    }
  }
  for (const probe of automaticNearMisses(originals, task)) {
    wrongResults.push({
      id: probe.id,
      kind: "auto_probe",
      why: probe.why,
      texts: probe.texts,
      answer: probe.answer,
    });
  }
  const unexercisable: string[] = [];
  for (const guard of task.checks.guards) {
    const damaged = damageGuard(reference.texts, guard, task.target_fixture);
    if (!damaged) {
      unexercisable.push(`guard:${guard.id}`);
      continue;
    }
    wrongResults.push({
      id: `guard-probe:${guard.id}`,
      kind: "auto_probe",
      why: `the site guard '${guard.id}' protects was damaged`,
      texts: damaged,
      answer: task.reference_answer ?? "Done.",
    });
  }

  const exercised = new Set<string>();
  for (const wrong of wrongResults) {
    const score = scoreTask({
      task,
      originals,
      results: wrong.texts,
      answer: wrong.answer,
    });
    const fired = firedIds(score);
    for (const id of fired) exercised.add(id);
    cases.push({
      case_id: wrong.id,
      kind: wrong.kind,
      why: wrong.why,
      expected: "fail",
      actual: score.pass ? "pass" : "fail",
      ok: !score.pass,
      fired,
      score,
    });
  }

  const allSiteIds = [
    ...task.checks.targets.map((site) => `target:${site.id}`),
    ...task.checks.guards.map((site) => `guard:${site.id}`),
  ];
  return {
    task_id: task.id,
    difficulty: task.difficulty,
    floor_task: task.floor_task === true,
    categories: task.categories,
    solvable: referenceScore.pass && reference.unapplied.length === 0,
    solvability_notes: solvabilityNotes,
    discriminating: cases.filter((c) => c.expected === "fail").every((c) => c.ok),
    cases,
    sites_exercised: [...exercised].sort(),
    sites_never_fired: allSiteIds.filter((id) => !exercised.has(id)),
    sites_not_synthetically_exercisable: unexercisable,
  };
}

export async function selfTestAll(taskIds?: string[]): Promise<TaskSelfTest[]> {
  const tasks = loadTasks().filter((task) => !taskIds?.length || taskIds.includes(task.id));
  const out: TaskSelfTest[] = [];
  for (const task of tasks) out.push(await selfTestTask(task));
  return out;
}
