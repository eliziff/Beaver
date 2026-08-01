/**
 * docx-edit-bench data model.
 *
 * Tasks are DATA (tasks.jsonl). Nothing here knows about any particular tool
 * surface: a surface is named in a run's configuration, not in a task.
 */

export const TASK_SCHEMA = "mike.docx-edit.task.v1";
export const MANIFEST_SCHEMA = "mike.docx-edit.manifest.v1";
export const RECEIPT_SCHEMA = "mike.docx-edit.receipt.v1";
export const BENCH_VERSION = "docx-edit-bench-v2";

/**
 * Task sets are ADDITIVE. v1's tasks, fixtures and checks are frozen so its
 * published result stays comparable; v2 adds tasks and fixtures in their own
 * files and never edits v1's. A run selects a set, and a receipt records
 * which one it scored.
 */
export const TASK_SETS = ["v1", "v2"] as const;
export type TaskSet = (typeof TASK_SETS)[number];

export type FixtureId = string;

/** A window of the resulting document a predicate is evaluated over. */
export type Window = {
  /** Literal text; the window starts at the END of its first occurrence. */
  after?: string;
  /** Literal text; the window ends at the START of its first occurrence
   *  at or after `after`. Omit for end-of-document. */
  before?: string;
};

/**
 * One scored site. `pattern` is a JavaScript regular expression source,
 * evaluated with the `u` flag (plus `g` for counting) over the window.
 *
 * A site is SATISFIED when the number of matches equals `count`
 * (default: at least 1 when `count` is omitted and `min_count` is absent).
 */
export type Site = {
  id: string;
  /** Free text: what this site means. Printed in failure output. */
  note?: string;
  window?: Window;
  pattern: string;
  /** Exact match count required. */
  count?: number;
  /** Lower bound when an exact count would over-specify. */
  min_count?: number;
  /** Match case-insensitively. Default false. */
  ignore_case?: boolean;
  /** Which document this site is evaluated in. Defaults to target_fixture. */
  fixture?: FixtureId;
};

export type Checks = {
  /** Sites that MUST hold in the resulting document — the positive half. */
  targets: Site[];
  /** Sites that MUST hold too, but that a correct edit never touches — the
   *  negative half. Split from targets so partial credit can distinguish
   *  "missed a site" from "damaged a site". */
  guards: Site[];
  /**
   * Fixtures that must come back byte-for-byte in their normalised text —
   * the read-only sources in a cross-document task.
   */
  unchanged_documents?: FixtureId[];
  /**
   * Regular expression the assistant's final answer must match. Used only
   * where the deliverable is a statement rather than an edit (refusals).
   */
  answer_must_match?: string;
  /** Regular expression the assistant's final answer must NOT match. */
  answer_must_not_match?: string;
  /**
   * Original lines the model may destroy beyond those the reference solution
   * destroys. Default 0 — this is the whole-document-rewrite shortcut blocker.
   */
  allow_foreign_line_removals?: number;
  /**
   * Lines the model may add beyond those the reference solution adds.
   * Default 0.
   */
  allow_foreign_line_additions?: number;
};

/** A literal substitution used to synthesise a reference or near-miss result. */
export type SynthEdit = {
  find: string;
  replace: string;
  /** Occurrences to replace. Default: all. */
  count?: number;
  /** Which document the edit lands in. Defaults to target_fixture. */
  fixture?: FixtureId;
};

export type NearMiss = {
  id: string;
  /** What wrong behaviour this simulates. */
  why: string;
  edits: SynthEdit[];
  /** Assistant answer to score alongside, when the task checks the answer. */
  answer?: string;
};

export type Task = {
  schema: typeof TASK_SCHEMA;
  id: string;
  /** Which additive task set this belongs to. Set by the loader from the file. */
  set?: TaskSet;
  /** Bumped whenever instruction or checks change. */
  version: number;
  /**
   * Jurisdiction the task is drawn from, for breadth reporting:
   * "CA-federal", "CA-ON", "CA-QC", "CA-BC", "US-federal", "US-DE",
   * "US-NY", "neutral". Free text; the report groups on it.
   */
  jurisdiction?: string;
  /** Practice area, for breadth reporting. Free text. */
  practice_area?: string;
  /** Documents loaded into the model's library, in order. */
  fixtures: FixtureId[];
  /** The document that is scored. */
  target_fixture: FixtureId;
  /** The semantic instruction, verbatim, exactly as played to the model. */
  instruction: string;
  difficulty: "floor" | "easy" | "medium" | "hard" | "devious";
  /** True when the task exists to establish a floor, not to discriminate. */
  floor_task?: boolean;
  categories: string[];
  /** What the task probes, and why it is hard. Required. */
  why: string;
  /**
   * True when a route using only tools a surface always keeps resident can
   * solve the task. Recorded so a progressive-disclosure result reads
   * correctly: where this is true, a run that failed for want of a deferred
   * tool failed to DISCOVER a route, not for want of a capability.
   */
  resident_route_exists?: boolean;
  /**
   * Tool domains a natural alternative route reaches for. On a surface that
   * defers those domains, this is what the model has to know to ask for.
   */
  alternative_route_domains?: string[];
  /** "edit" — the document must change. "refuse" — it must not. */
  expected: "edit" | "refuse";
  checks: Checks;
  /**
   * The demonstrated solution: applying these to the fixture text yields a
   * document the checker passes. A task without one does not ship.
   */
  reference_edits: SynthEdit[];
  /** Answer text scored alongside the reference result, for answer checks. */
  reference_answer?: string;
  /** Deliberately wrong results the checker must reject. */
  near_misses: NearMiss[];
};

export type SiteResult = {
  id: string;
  kind: "target" | "guard";
  ok: boolean;
  matches: number;
  expected: string;
  note?: string;
};

export type Score = {
  task_id: string;
  pass: boolean;
  /** Partial credit, in the shape the brief asks for. */
  sites_correct: number;
  sites_wrong: number;
  sites_missed: number;
  targets_total: number;
  guards_total: number;
  foreign_line_removals: number;
  foreign_line_additions: number;
  unchanged_document_violations: string[];
  answer_check: "pass" | "fail" | "not_applicable";
  document_changed: boolean;
  sites: SiteResult[];
  failures: string[];
};
