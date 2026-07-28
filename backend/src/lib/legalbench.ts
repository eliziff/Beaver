/**
 * LegalBench external-benchmark adapter (first external benchmark).
 *
 * Upstream: Stanford LegalBench — github.com/HazyResearch/legalbench and the
 * HuggingFace dataset nguha/legalbench (arXiv:2308.11462). Nine tasks chosen
 * because they test capabilities the product actually claims — rule
 * application / rule QA (abercrombie, hearsay, personal_jurisdiction,
 * ucc_v_common_law), issue spotting (corporate_lobbying), contract and merger
 * clause understanding (contract_qa, cuad_anti-assignment,
 * maud_specific_performance), and citation support
 * (citation_prediction_classification) — and because each has a published
 * GPT-4 baseline in the paper's appendix, so our numbers stand next to
 * something. Every task uses its official test split and the upstream
 * base_prompt.txt verbatim; prompts are never invented here.
 *
 * Scoring is the official exact-match balanced accuracy. normalizeLegalBench
 * is a TypeScript port of normalize() in HazyResearch/legalbench
 * evaluation.py (remove Python string.punctuation, strip, lowercase), and
 * balancedAccuracy matches sklearn.metrics.balanced_accuracy_score (mean
 * per-gold-class recall). The official pipeline scored bare completions cut
 * off by stop sequences; chat models instead wrap labels ("Answer: Yes."), so
 * extractLabel deterministically tries the normalized full text, the text
 * after the last answer cue, the first line, then a unique whole-word label
 * match — anything still ambiguous scores as wrong, never as a guess.
 *
 * Nothing downloaded is committed: task rows (HF datasets-server) and the
 * upstream prompt files live under git-ignored benchmarks/legalbench/data/;
 * the committed manifest.json pins the task list, row counts, per-task
 * license, GPT-4 baselines with table citations, and sha256 of every derived
 * file. Excluded on purpose: the Learned Hands issue-spotting family
 * (CC BY-NC-SA 4.0 — noncommercial) and rule_qa (manual evaluation only).
 */
import path from "node:path";
import { z } from "zod/v4";
import { sha256Hex } from "./runTrace";

export const LEGALBENCH_DIR = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "benchmarks",
  "legalbench",
);
export const LEGALBENCH_DATA_DIR = path.join(LEGALBENCH_DIR, "data");
export const LEGALBENCH_RESULTS_DIR = path.join(LEGALBENCH_DIR, "results");
export const MANIFEST_PATH = path.join(LEGALBENCH_DIR, "manifest.json");

export const SCORING_VERSION = "legalbench-em-balanced-acc-1";

// ---------------------------------------------------------------------------
// Task registry. gpt4 numbers are the paper's per-task GPT-4 balanced
// accuracies (arXiv:2308.11462v2 appendix, "Commercial models on … tasks").
// ---------------------------------------------------------------------------

export type LegalBenchTask = {
  /** Upstream directory name == HuggingFace config name. */
  task: string;
  /** Product capability this task tests. */
  capability: string;
  /** Official label space, verbatim as it appears in gold answers. */
  labels: readonly string[];
  license: string;
  /** Published GPT-4 balanced accuracy, 0–100 scale. */
  gpt4_balanced_accuracy: number;
  /** Paper table the number is copied from. */
  gpt4_source: string;
};

const YES_NO = ["Yes", "No"] as const;
const PAPER = "arXiv:2308.11462";
const CC_BY = "CC BY 4.0";

export const LEGALBENCH_TASKS: readonly LegalBenchTask[] = [
  {
    task: "abercrombie",
    capability: "rule application (trademark distinctiveness spectrum)",
    labels: ["generic", "descriptive", "suggestive", "arbitrary", "fanciful"],
    license: CC_BY,
    gpt4_balanced_accuracy: 85.3,
    gpt4_source: `${PAPER} Table 63 (commercial models on rule-conclusion tasks)`,
  },
  {
    task: "hearsay",
    capability: "rule application (hearsay determination)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 83.8,
    gpt4_source: `${PAPER} Table 63 (commercial models on rule-conclusion tasks)`,
  },
  {
    task: "personal_jurisdiction",
    capability: "rule application (personal jurisdiction)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 91.4,
    gpt4_source: `${PAPER} Table 63 (commercial models on rule-conclusion tasks)`,
  },
  {
    task: "ucc_v_common_law",
    capability: "rule QA (UCC vs common-law governance)",
    labels: ["UCC", "Common Law"],
    license: CC_BY,
    gpt4_balanced_accuracy: 98.8,
    gpt4_source: `${PAPER} Table 63 (commercial models on rule-conclusion tasks)`,
  },
  {
    task: "corporate_lobbying",
    capability: "issue spotting (bill relevance to a company)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 81.7,
    gpt4_source: `${PAPER} Table 59 (commercial models on issue-spotting tasks)`,
  },
  {
    task: "contract_qa",
    capability: "contract clause understanding (clause-content QA)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 96.2,
    gpt4_source: `${PAPER} Table 71 (commercial models on interpretation tasks)`,
  },
  {
    task: "cuad_anti-assignment",
    capability: "contract clause understanding (CUAD anti-assignment)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 91.4,
    gpt4_source: `${PAPER} Table 71 (commercial models on interpretation tasks)`,
  },
  {
    task: "maud_specific_performance",
    capability: "merger agreement understanding (MAUD specific performance)",
    labels: ["A", "B"],
    license: CC_BY,
    gpt4_balanced_accuracy: 51.5,
    gpt4_source: `${PAPER} Table 71 (commercial models on interpretation tasks)`,
  },
  {
    task: "citation_prediction_classification",
    capability: "citation support (does the case support the text)",
    labels: YES_NO,
    license: CC_BY,
    gpt4_balanced_accuracy: 71.3,
    gpt4_source: `${PAPER} Table 55 (commercial models on rule-recall tasks)`,
  },
];

export function legalBenchTask(name: string): LegalBenchTask {
  const task = LEGALBENCH_TASKS.find((entry) => entry.task === name);
  if (!task)
    throw new Error(
      `unknown LegalBench task ${name}; known: ${LEGALBENCH_TASKS.map((t) => t.task).join(", ")}`,
    );
  return task;
}

// ---------------------------------------------------------------------------
// Official prompt assembly (port of utils.py generate_prompts).
// ---------------------------------------------------------------------------

export function fillPromptTemplate(
  template: string,
  row: Record<string, unknown>,
): string {
  if (!template.includes("{{"))
    throw new Error("prompt template has no fields to fill");
  let prompt = template;
  for (const [key, value] of Object.entries(row))
    prompt = prompt.replaceAll(`{{${key}}}`, String(value));
  if (prompt.includes("{{"))
    throw new Error(`unfilled prompt field: ${prompt.slice(0, 200)}`);
  return prompt;
}

// ---------------------------------------------------------------------------
// Official normalization + deterministic chat-output label extraction.
// ---------------------------------------------------------------------------

/** Python string.punctuation, as removed by evaluation.py normalize(). */
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/gu;

/**
 * Port of normalize(text, stem=False) in HazyResearch/legalbench
 * evaluation.py: remove punctuation, strip, lowercase.
 */
export function normalizeLegalBench(text: string): string {
  return text.replace(PUNCTUATION, "").trim().toLowerCase();
}

/** The label-introducing cues used by the shipped base prompts. */
const ANSWER_CUE = /\b(?:final answer|governed by|answer|label|a)\s*:/giu;

/**
 * Deterministically map a chat generation onto the task label space, or null
 * when no unambiguous label is present (scored as wrong, never guessed).
 */
export function extractLabel(
  generation: string,
  labels: readonly string[],
): string | null {
  const normalizedLabels = labels.map((label) => normalizeLegalBench(label));
  const exact = (text: string): string | null => {
    const index = normalizedLabels.indexOf(normalizeLegalBench(text));
    return index >= 0 ? labels[index] : null;
  };
  const firstLine = (text: string): string =>
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const cues = [...generation.matchAll(ANSWER_CUE)];
  const lastCue = cues.at(-1);
  const afterCue = lastCue
    ? generation.slice(lastCue.index + lastCue[0].length)
    : null;
  for (const candidate of [
    generation,
    afterCue,
    afterCue === null ? null : firstLine(afterCue),
    firstLine(generation),
  ]) {
    if (candidate === null) continue;
    const label = exact(candidate);
    if (label !== null) return label;
  }
  // Chat models often bold their verdict ("Supportive? **Yes.**") inside a
  // longer analysis that mentions other labels in passing; bolded spans are
  // an explicit answer marker, honoured only when unambiguous.
  const bolded = new Set(
    [...generation.matchAll(/\*\*([^*\n]+)\*\*/gu)]
      .map((match) => exact(match[1]))
      .filter((label): label is string => label !== null),
  );
  if (bolded.size === 1) return [...bolded][0];
  const padded = ` ${normalizeLegalBench(generation)} `;
  const present = labels.filter((_, index) =>
    padded.includes(` ${normalizedLabels[index]} `),
  );
  return present.length === 1 ? present[0] : null;
}

// ---------------------------------------------------------------------------
// Scoring (evaluation.py evaluate_exact_match_balanced_accuracy).
// ---------------------------------------------------------------------------

export type ScoredExample = {
  index: number;
  gold: string;
  extracted: string | null;
  correct: boolean;
};

export type TaskScore = {
  scoring_version: string;
  task: string;
  n: number;
  correct: number;
  /** Plain exact-match rate, 0–1. */
  accuracy: number;
  /** Mean per-gold-class recall, 0–1 (sklearn balanced_accuracy_score). */
  balanced_accuracy: number;
  /** Generations with no unambiguous label; always scored wrong. */
  unparsed: number;
  per_label: Record<string, { gold: number; correct: number }>;
  examples: ScoredExample[];
};

export function scoreTask(
  task: LegalBenchTask,
  rows: { index: number; gold: string; generation: string }[],
): TaskScore {
  const examples: ScoredExample[] = rows.map((row) => {
    const extracted = extractLabel(row.generation, task.labels);
    return {
      index: row.index,
      gold: row.gold,
      extracted,
      correct:
        extracted !== null &&
        normalizeLegalBench(extracted) === normalizeLegalBench(row.gold),
    };
  });
  const perLabel: Record<string, { gold: number; correct: number }> = {};
  for (const example of examples) {
    const key = normalizeLegalBench(example.gold);
    perLabel[key] ??= { gold: 0, correct: 0 };
    perLabel[key].gold += 1;
    if (example.correct) perLabel[key].correct += 1;
  }
  const recalls = Object.values(perLabel).map(
    (entry) => entry.correct / entry.gold,
  );
  const correct = examples.filter((example) => example.correct).length;
  return {
    scoring_version: SCORING_VERSION,
    task: task.task,
    n: examples.length,
    correct,
    accuracy: examples.length ? correct / examples.length : 0,
    balanced_accuracy: recalls.length
      ? recalls.reduce((a, b) => a + b, 0) / recalls.length
      : 0,
    unparsed: examples.filter((example) => example.extracted === null).length,
    per_label: perLabel,
    examples,
  };
}

/**
 * Deterministic subset for limited runs: a class-stratified prefix of the
 * official test split. The raw prefix is unusable for balanced accuracy —
 * several tasks group the split by gold label (cuad_anti-assignment's first
 * 586 rows are all "Yes") — so take up to ceil(limit / classes) earliest rows
 * per gold class, then fill any shortfall with the earliest unselected rows,
 * preserving official row order throughout. limit <= 0 means the full split.
 */
export function selectStratifiedRows<T extends Record<string, unknown>>(
  rows: T[],
  limit: number,
): T[] {
  if (limit <= 0 || limit >= rows.length) return rows;
  const classes = new Set(
    rows.map((row) => normalizeLegalBench(String(row.answer))),
  );
  const perClass = Math.ceil(limit / classes.size);
  const counts = new Map<string, number>();
  const chosen = new Set<number>();
  rows.forEach((row, index) => {
    if (chosen.size >= limit) return;
    const key = normalizeLegalBench(String(row.answer));
    const count = counts.get(key) ?? 0;
    if (count < perClass) {
      counts.set(key, count + 1);
      chosen.add(index);
    }
  });
  rows.forEach((_, index) => {
    if (chosen.size < limit) chosen.add(index);
  });
  return rows.filter((_, index) => chosen.has(index));
}

// ---------------------------------------------------------------------------
// Derived data files + pinned manifest (same discipline as legalbenchRag).
// ---------------------------------------------------------------------------

export const taskDataSchema = z.strictObject({
  task: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
});
export type TaskData = z.infer<typeof taskDataSchema>;

export function taskDataBytes(
  task: string,
  rows: Record<string, unknown>[],
): Buffer {
  return Buffer.from(`${JSON.stringify({ task, rows })}\n`, "utf8");
}

const fileEntry = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.int().nonnegative(),
});

export const legalBenchManifestSchema = z.strictObject({
  schema_version: z.literal("1"),
  name: z.literal("legalbench"),
  upstream: z.strictObject({
    repository: z.string(),
    prompts_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    hf_dataset: z.string(),
    hf_rows_api: z.string(),
    paper: z.string(),
    license_note: z.string(),
  }),
  scoring: z.strictObject({
    version: z.string(),
    normalization: z.string(),
  }),
  tasks: z.array(
    z.strictObject({
      task: z.string().min(1),
      capability: z.string().min(1),
      labels: z.array(z.string().min(1)).min(2),
      license: z.string().min(1),
      gpt4_balanced_accuracy: z.number().min(0).max(100),
      gpt4_source: z.string().min(1),
      test_rows: z.int().positive(),
      prompt: fileEntry,
      data: fileEntry,
    }),
  ),
});

export type LegalBenchManifest = z.infer<typeof legalBenchManifestSchema>;

export function validateLegalBenchManifest(record: unknown): LegalBenchManifest {
  return legalBenchManifestSchema.parse(record);
}

export function promptFilePath(task: string): string {
  return `prompts/${task}.base_prompt.txt`;
}
export function dataFilePath(task: string): string {
  return `tasks/${task}.json`;
}

export type ManifestFile = { path: string; bytes: Buffer };

/**
 * Compare on-disk derived files against the pinned manifest. Returns mismatch
 * strings (empty array = byte-identical) so callers can aggregate every
 * problem into one recoverable error.
 */
export function verifyAgainstManifest(
  manifest: LegalBenchManifest,
  derived: ManifestFile[],
): string[] {
  const pinned = new Map(
    manifest.tasks
      .flatMap((task) => [task.prompt, task.data])
      .map((entry) => [entry.path, entry]),
  );
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of derived) {
    seen.add(file.path);
    const entry = pinned.get(file.path);
    if (!entry) {
      problems.push(`unpinned derived file: ${file.path}`);
      continue;
    }
    const digest = sha256Hex(file.bytes);
    if (digest !== entry.sha256 || file.bytes.length !== entry.bytes) {
      problems.push(
        `hash mismatch: ${file.path} derived ${digest} (${file.bytes.length} B) != pinned ${entry.sha256} (${entry.bytes} B)`,
      );
    }
  }
  for (const entryPath of pinned.keys()) {
    if (!seen.has(entryPath)) problems.push(`pinned file missing: ${entryPath}`);
  }
  return problems;
}

/**
 * The registry above is the source of truth for the scientific claims; the
 * manifest re-records them next to the file pins. Returns disagreement
 * strings (empty array = consistent).
 */
export function verifyManifestMatchesRegistry(
  manifest: LegalBenchManifest,
): string[] {
  const problems: string[] = [];
  const byName = new Map(manifest.tasks.map((task) => [task.task, task]));
  for (const task of LEGALBENCH_TASKS) {
    const pinned = byName.get(task.task);
    if (!pinned) {
      problems.push(`task missing from manifest: ${task.task}`);
      continue;
    }
    byName.delete(task.task);
    if (
      pinned.gpt4_balanced_accuracy !== task.gpt4_balanced_accuracy ||
      pinned.gpt4_source !== task.gpt4_source ||
      pinned.license !== task.license ||
      pinned.capability !== task.capability ||
      JSON.stringify(pinned.labels) !== JSON.stringify(task.labels)
    ) {
      problems.push(`manifest disagrees with registry for ${task.task}`);
    }
  }
  for (const name of byName.keys())
    problems.push(`manifest task not in registry: ${name}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Official test-split download (HF datasets-server rows API).
// ---------------------------------------------------------------------------

export const HF_ROWS_API = "https://datasets-server.huggingface.co/rows";
const HF_DATASET = "nguha/legalbench";
const PAGE = 100;

export async function fetchTaskRows(
  task: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${HF_ROWS_API}?dataset=${encodeURIComponent(HF_DATASET)}` +
      `&config=${encodeURIComponent(task)}&split=test&offset=${offset}&length=${PAGE}`;
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(`HF rows request failed for ${task}: HTTP ${response.status}`);
    const body = (await response.json()) as {
      num_rows_total: number;
      rows: { row: Record<string, unknown> }[];
    };
    if (!body.rows.length)
      throw new Error(
        `HF rows stalled for ${task} at offset ${offset} (${rows.length}/${body.num_rows_total})`,
      );
    rows.push(...body.rows.map((entry) => entry.row));
    if (rows.length >= body.num_rows_total) {
      if (rows.length !== body.num_rows_total)
        throw new Error(
          `HF rows overrun for ${task}: ${rows.length} != ${body.num_rows_total}`,
        );
      return rows;
    }
  }
}
