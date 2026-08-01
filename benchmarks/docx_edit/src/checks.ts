/**
 * docx-edit-bench checker library.
 *
 * Given the text of the documents a run produced, score one task. Nothing
 * here knows how the documents were produced, so the same checker scores a
 * model run, a reference solution, and a deliberately wrong result.
 *
 * THE TWO HALVES. A task's positive half (`targets`) says what must now be
 * true. Its negative half (`guards`, `unchanged_documents`, and the foreign
 * line-removal budget) says what must still be true. Only the second half
 * blocks the obvious shortcut: a model that regenerates the document from
 * its own reading can satisfy any "X now says Y" assertion without ever
 * locating anything, and it will destroy original lines doing so.
 */
import type {
  Checks,
  Score,
  Site,
  SiteResult,
  SynthEdit,
  Task,
  Window,
} from "./types";

/** Content lines, with blank lines dropped so an emptied paragraph left
 *  behind by a deletion is not counted as a foreign change on its own. */
export function contentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/u, ""))
    .filter((line) => line.trim().length > 0);
}

/** [start, end) of the window in the document, or null when it does not open. */
export function windowBounds(
  text: string,
  window: Window | undefined,
): [number, number] | null {
  if (!window) return [0, text.length];
  let start = 0;
  if (window.after) {
    const at = text.indexOf(window.after);
    if (at < 0) return null;
    start = at + window.after.length;
  }
  if (!window.before) return [start, text.length];
  const end = text.indexOf(window.before, start);
  return end < 0 ? [start, text.length] : [start, end];
}

function windowOf(text: string, window: Window | undefined): string {
  const bounds = windowBounds(text, window);
  return bounds ? text.slice(bounds[0], bounds[1]) : "";
}

export function countMatches(text: string, site: Site): number {
  const flags = site.ignore_case ? "gui" : "gu";
  const re = new RegExp(site.pattern, flags);
  let count = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    count += 1;
    if (match.index === re.lastIndex) re.lastIndex += 1;
    if (count > 10_000) break;
  }
  return count;
}

function expectationOf(site: Site): string {
  if (typeof site.count === "number") return `exactly ${site.count}`;
  if (typeof site.min_count === "number") return `at least ${site.min_count}`;
  return "at least 1";
}

function siteSatisfied(matches: number, site: Site): boolean {
  if (typeof site.count === "number") return matches === site.count;
  if (typeof site.min_count === "number") return matches >= site.min_count;
  return matches >= 1;
}

function evaluate(
  site: Site,
  kind: "target" | "guard",
  texts: Map<string, string>,
  targetFixture: string,
): SiteResult {
  const fixtureId = site.fixture ?? targetFixture;
  const text = texts.get(fixtureId);
  if (text === undefined) {
    return {
      id: site.id,
      kind,
      ok: false,
      matches: -1,
      expected: expectationOf(site),
      note: `document '${fixtureId}' was not produced by the run`,
    };
  }
  const matches = countMatches(windowOf(text, site.window), site);
  return {
    id: site.id,
    kind,
    ok: siteSatisfied(matches, site),
    matches,
    expected: expectationOf(site),
    note: site.note,
  };
}

/** Multiset difference: how many of `from`'s lines are missing from `to`. */
function missingLines(from: string[], to: string[]): string[] {
  const pool = new Map<string, number>();
  for (const line of to) pool.set(line, (pool.get(line) ?? 0) + 1);
  const missing: string[] = [];
  for (const line of from) {
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    else missing.push(line);
  }
  return missing;
}

export function applySynthEdits(
  text: string,
  edits: SynthEdit[],
): { text: string; applied: number[] } {
  let out = text;
  const applied: number[] = [];
  for (const edit of edits) {
    let done = 0;
    const limit = edit.count ?? Number.POSITIVE_INFINITY;
    let at = out.indexOf(edit.find);
    while (at >= 0 && done < limit) {
      out = out.slice(0, at) + edit.replace + out.slice(at + edit.find.length);
      done += 1;
      at = out.indexOf(edit.find, at + edit.replace.length);
    }
    applied.push(done);
  }
  return { text: out, applied };
}

/** Edits grouped by the document they land in. */
export function editsByFixture(
  edits: SynthEdit[],
  targetFixture: string,
): Map<string, SynthEdit[]> {
  const grouped = new Map<string, SynthEdit[]>();
  for (const edit of edits) {
    const id = edit.fixture ?? targetFixture;
    const list = grouped.get(id) ?? [];
    list.push(edit);
    grouped.set(id, list);
  }
  return grouped;
}

/** Apply a task's reference (or near-miss) edits to the starting texts. */
export function synthesiseResult(
  originals: Map<string, string>,
  edits: SynthEdit[],
  targetFixture: string,
): { texts: Map<string, string>; unapplied: string[] } {
  const texts = new Map(originals);
  const unapplied: string[] = [];
  for (const [fixtureId, list] of editsByFixture(edits, targetFixture)) {
    const base = texts.get(fixtureId);
    if (base === undefined) {
      unapplied.push(`${fixtureId}: not in the task's fixtures`);
      continue;
    }
    const { text, applied } = applySynthEdits(base, list);
    applied.forEach((count, index) => {
      if (count === 0) unapplied.push(`${fixtureId}: '${list[index].find}' not found`);
      else if (list[index].count !== undefined && count < list[index].count!)
        unapplied.push(
          `${fixtureId}: '${list[index].find}' applied ${count}/${list[index].count} times`,
        );
    });
    texts.set(fixtureId, text);
  }
  return { texts, unapplied };
}

export type ScoreInput = {
  task: Task;
  /** Starting text of every fixture in the task. */
  originals: Map<string, string>;
  /** Text of every fixture after the run. */
  results: Map<string, string>;
  /** The assistant's final visible answer, when the task checks it. */
  answer?: string;
};

export function scoreTask(input: ScoreInput): Score {
  const { task, originals, results } = input;
  const checks: Checks = task.checks;
  const failures: string[] = [];

  const sites: SiteResult[] = [
    ...checks.targets.map((site) =>
      evaluate(site, "target", results, task.target_fixture),
    ),
    ...checks.guards.map((site) =>
      evaluate(site, "guard", results, task.target_fixture),
    ),
  ];
  const targets = sites.filter((site) => site.kind === "target");
  const guards = sites.filter((site) => site.kind === "guard");
  const sitesMissed = targets.filter((site) => !site.ok).length;
  const sitesWrong = guards.filter((site) => !site.ok).length;
  const sitesCorrect = targets.filter((site) => site.ok).length;
  for (const site of sites) {
    if (!site.ok) {
      failures.push(
        `${site.kind} '${site.id}': ${site.matches} matches, expected ${site.expected}` +
          (site.note ? ` (${site.note})` : ""),
      );
    }
  }

  // Reference solution as the yardstick for collateral damage: the lines it
  // destroys are the lines this task legitimately destroys, and every other
  // original line the run lost is damage.
  const reference = synthesiseResult(
    originals,
    task.reference_edits,
    task.target_fixture,
  ).texts;
  let foreignRemovals = 0;
  let foreignAdditions = 0;
  for (const [fixtureId, original] of originals) {
    const produced = results.get(fixtureId);
    if (produced === undefined) continue;
    const originalLines = contentLines(original);
    const referenceLines = contentLines(reference.get(fixtureId) ?? original);
    const producedLines = contentLines(produced);
    const allowedLost = missingLines(originalLines, referenceLines).length;
    const lost = missingLines(originalLines, producedLines).length;
    const allowedNew = missingLines(referenceLines, originalLines).length;
    const added = missingLines(producedLines, originalLines).length;
    foreignRemovals += Math.max(0, lost - allowedLost);
    foreignAdditions += Math.max(0, added - allowedNew);
  }
  const removalBudget = checks.allow_foreign_line_removals ?? 0;
  const additionBudget = checks.allow_foreign_line_additions ?? 0;
  if (foreignRemovals > removalBudget) {
    failures.push(
      `destroyed ${foreignRemovals} original line(s) the reference solution keeps (budget ${removalBudget})`,
    );
  }
  if (foreignAdditions > additionBudget) {
    failures.push(
      `added ${foreignAdditions} line(s) the reference solution does not (budget ${additionBudget})`,
    );
  }

  const unchangedViolations: string[] = [];
  for (const fixtureId of checks.unchanged_documents ?? []) {
    const before = originals.get(fixtureId);
    const after = results.get(fixtureId);
    if (before === undefined || after === undefined) continue;
    if (contentLines(before).join("\n") !== contentLines(after).join("\n")) {
      unchangedViolations.push(fixtureId);
      failures.push(`document '${fixtureId}' was modified but must not be`);
    }
  }

  let answerCheck: Score["answer_check"] = "not_applicable";
  if (checks.answer_must_match || checks.answer_must_not_match) {
    const answer = input.answer ?? "";
    let ok = true;
    if (checks.answer_must_match) {
      const re = new RegExp(checks.answer_must_match, "iu");
      if (!re.test(answer)) {
        ok = false;
        failures.push(`answer does not match /${checks.answer_must_match}/i`);
      }
    }
    if (checks.answer_must_not_match) {
      const re = new RegExp(checks.answer_must_not_match, "iu");
      if (re.test(answer)) {
        ok = false;
        failures.push(`answer matches the forbidden /${checks.answer_must_not_match}/i`);
      }
    }
    answerCheck = ok ? "pass" : "fail";
  }

  const targetOriginal = originals.get(task.target_fixture) ?? "";
  const targetResult = results.get(task.target_fixture) ?? targetOriginal;
  const documentChanged =
    contentLines(targetOriginal).join("\n") !== contentLines(targetResult).join("\n");
  if (task.expected === "refuse" && documentChanged) {
    failures.push("the target document was changed but the task expects no edit");
  }
  if (task.expected === "edit" && !documentChanged) {
    failures.push("the target document was not changed");
  }

  return {
    task_id: task.id,
    pass: failures.length === 0,
    sites_correct: sitesCorrect,
    sites_wrong: sitesWrong,
    sites_missed: sitesMissed,
    targets_total: targets.length,
    guards_total: guards.length,
    foreign_line_removals: foreignRemovals,
    foreign_line_additions: foreignAdditions,
    unchanged_document_violations: unchangedViolations,
    answer_check: answerCheck,
    document_changed: documentChanged,
    sites,
    failures,
  };
}

/**
 * Shortcut probes generated for EVERY task, so no task ships with an
 * unexercised negative half:
 *  - `no-edit`: the untouched document. Must fail every edit task.
 *  - `regenerate`: the reference result with the document's second half
 *    dropped, standing in for "the model rewrote the document from its own
 *    reading". Must fail every task.
 */
export function automaticNearMisses(
  originals: Map<string, string>,
  task: Task,
): { id: string; why: string; texts: Map<string, string>; answer: string }[] {
  const probes: {
    id: string;
    why: string;
    texts: Map<string, string>;
    answer: string;
  }[] = [];
  if (task.expected === "edit") {
    probes.push({
      id: "no-edit",
      why: "the run made no change at all",
      texts: new Map(originals),
      answer: "I did not change anything.",
    });
  }
  const reference = synthesiseResult(
    originals,
    task.reference_edits,
    task.target_fixture,
  ).texts;
  const regenerated = new Map(reference);
  const target = regenerated.get(task.target_fixture) ?? "";
  const lines = contentLines(target);
  // Keep the head so the positive half still passes: the point of the probe
  // is that only the negative half can catch a partial regeneration.
  regenerated.set(
    task.target_fixture,
    lines.slice(0, Math.max(1, Math.ceil(lines.length * 0.6))).join("\n"),
  );
  probes.push({
    id: "regenerate-partial",
    why: "the run rewrote the document and lost its tail",
    texts: regenerated,
    answer: task.reference_answer ?? "Done.",
  });
  return probes;
}
