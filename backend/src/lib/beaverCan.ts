/**
 * Beaver-CAN task and gold contracts (docs/beaver-evaluation-context-plan.md
 * §5–6, Issue 2).
 *
 * These zod schemas are the single source of truth for the Beaver-CAN task
 * packet format. `benchmarks/beaver_can/task.schema.json` and
 * `gold.schema.json` are generated from them (`beaverCanJsonSchemas`) and a
 * test keeps the committed copies in sync. Like `runTrace.ts`, everything is
 * strict and parse-or-throw: unknown keys are rejected and a fixture that
 * drifts from its schema, its source packet, or its source text fails loudly.
 *
 * Format decisions where the plan is silent (recorded in
 * benchmarks/beaver_can/README.md): task/gold/manifest files are JSON, not
 * YAML (no YAML parser in the tree; benchmarks/gold_contract already uses a
 * JSON contract); source packets reference the committed A2AJ fixtures by
 * repo-relative path plus content hash instead of duplicating them; case
 * pinpoints are integers (paragraph numbers), statute pinpoints are strings
 * (section labels such as "231(5)").
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod/v4";
import { sourceDocBlockText, type SourceDoc } from "./sourceDoc";
import { compileA2AJSourceDoc } from "./sourceDocA2AJ";

const TASK_ID = /^CAN-[A-Z]+-\d{3}$/u;
const SOURCE_ID = /^SRC-\d{3}$/u;
const GOLD_ID = /^(ISSUE|PROP|CONCLUSION|CLAIM)-\d{2}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

const sourceId = z.string().regex(SOURCE_ID, "SRC-000");
/** Case paragraph number (integer) or statute section label ("231(5)"). */
const pinpoint = z.union([
  z.int().positive(),
  z.string().regex(/^\d+[\d.()a-z]*$/u, 'statute section label like "231(5)"'),
]);
const pinpoints = z.array(pinpoint).min(1);

export const beaverCanTaskSchema = z.strictObject({
  id: z.string().regex(TASK_ID, "CAN-TRACK-000"),
  jurisdiction: z.string().regex(/^CA(-[A-Z]{2})?$/u, "CA or CA-XX"),
  law_as_of: z.iso.date(),
  task_type: z.enum(["closed_source_research", "retrieval", "long_thread"]),
  deliverable: z.strictObject({
    type: z.enum(["memorandum", "ranked_authorities"]),
    maximum_words: z.int().positive().optional(),
    required_filename: z.string().regex(/^[\w.-]+$/u, "plain filename"),
  }),
  source_ids: z.array(sourceId).min(1),
  fatal_errors: z
    .array(
      z.enum([
        "fabricated_authority",
        "fabricated_quotation",
        "invalid_pinpoint",
        "wrong_jurisdiction",
        "outside_source_packet",
        "superseded_instruction",
        "seeded_identifier_leak",
        "missing_artifact",
      ]),
    )
    .min(1),
});

export const beaverCanGoldSchema = z.strictObject({
  required_issues: z.array(z.string().regex(/^ISSUE-\d{2}$/u)).min(1),
  required_authorities: z
    .array(
      z.strictObject({
        source_id: sourceId,
        proposition_id: z.string().regex(/^PROP-\d{2}$/u),
        acceptable_pinpoints: pinpoints,
      }),
    )
    .min(1),
  acceptable_alternative_authorities: z.array(
    z.strictObject({
      source_id: sourceId,
      proposition_id: z.string().regex(/^PROP-\d{2}$/u),
    }),
  ),
  required_conclusions: z
    .array(
      z.strictObject({
        id: z.string().regex(/^CONCLUSION-\d{2}$/u),
        acceptable: z
          .array(z.enum(["yes", "qualified_yes", "no", "qualified_no"]))
          .min(1),
      }),
    )
    .min(1),
  forbidden_claims: z.array(z.string().regex(/^CLAIM-\d{2}$/u)),
  /** §4 vertical slice: a quotation/pinpoint that must survive to the output. */
  required_quotations: z
    .array(
      z.strictObject({
        source_id: sourceId,
        quote: z.string().min(20),
        acceptable_pinpoints: pinpoints,
      }),
    )
    .optional(),
  /** Seeded sensitive strings whose disclosure is a fatal error (§2, §9). */
  seeded_identifiers: z.array(z.string().min(8)).optional(),
  /** Headings the deliverable must contain verbatim (Issue-3 runner binding). */
  required_headings: z.array(z.string().min(1)).min(1).optional(),
  /**
   * Human definition of every ISSUE/PROP/CONCLUSION/CLAIM id used above, so
   * gold is reviewable without an external key. Exact two-way match enforced.
   */
  definitions: z.record(z.string().regex(GOLD_ID), z.string().min(1)),
});

export const beaverCanSourceManifestSchema = z.strictObject({
  task_id: z.string().regex(TASK_ID),
  sources: z
    .array(
      z.strictObject({
        source_id: sourceId,
        /** a2aj_fixture: repo-relative committed fixture; task_local: file in sources/. */
        kind: z.enum(["a2aj_fixture", "task_local"]),
        path: z.string().min(1),
        sha256: z.string().regex(SHA256),
        /** Scoring metadata only — never shown to the model. */
        role: z.enum(["authority", "distractor", "matter_document"]),
        citation: z.string().min(1),
        superseded_by: sourceId.optional(),
      }),
    )
    .min(1),
});

export type BeaverCanTask = z.infer<typeof beaverCanTaskSchema>;
export type BeaverCanGold = z.infer<typeof beaverCanGoldSchema>;
export type BeaverCanSourceManifest = z.infer<
  typeof beaverCanSourceManifestSchema
>;

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
export const BEAVER_CAN_DIR = path.join(REPO_ROOT, "benchmarks", "beaver_can");
export const BEAVER_CAN_DEV_TASKS_DIR = path.join(
  BEAVER_CAN_DIR,
  "tasks",
  "dev",
);

/** JSON Schema mirrors of the zod contracts, for the committed .schema.json files. */
export function beaverCanJsonSchemas(): {
  task: unknown;
  gold: unknown;
  source_manifest: unknown;
} {
  return {
    task: z.toJSONSchema(beaverCanTaskSchema),
    gold: z.toJSONSchema(beaverCanGoldSchema),
    source_manifest: z.toJSONSchema(beaverCanSourceManifestSchema),
  };
}

/**
 * Hash file content with CRLF normalized to LF, so checkouts with different
 * git line-ending settings produce the same source hash.
 */
export function beaverCanContentHash(raw: string): string {
  return createHash("sha256").update(raw.replaceAll("\r\n", "\n")).digest("hex");
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

export type LoadedBeaverCanSource = {
  source_id: string;
  kind: "a2aj_fixture" | "task_local";
  role: "authority" | "distractor" | "matter_document";
  citation: string;
  text: string;
  /** Compiled source document for pinpoint checks; null for task_local files. */
  doc: SourceDoc | null;
};

function fail(taskDir: string, message: string): never {
  throw new Error(`${path.basename(taskDir)}: ${message}`);
}

function readJson(taskDir: string, file: string): unknown {
  const filePath = path.join(taskDir, file);
  if (!existsSync(filePath)) fail(taskDir, `missing ${file}`);
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** Resolve, hash-check, and load every packet source named by the manifest. */
export function loadBeaverCanSources(
  taskDir: string,
  task: BeaverCanTask,
  manifest: BeaverCanSourceManifest,
): LoadedBeaverCanSource[] {
  if (manifest.task_id !== task.id)
    fail(taskDir, `manifest task_id ${manifest.task_id} != task id ${task.id}`);
  const manifestIds = manifest.sources.map((entry) => entry.source_id);
  if (new Set(manifestIds).size !== manifestIds.length)
    fail(taskDir, "duplicate source_id in manifest");
  const expected = [...task.source_ids].sort().join(",");
  if ([...manifestIds].sort().join(",") !== expected)
    fail(taskDir, `manifest sources [${manifestIds}] != task source_ids`);

  return manifest.sources.map((entry) => {
    if (entry.superseded_by && !manifestIds.includes(entry.superseded_by))
      fail(taskDir, `${entry.source_id} superseded_by unknown source`);
    const filePath =
      entry.kind === "a2aj_fixture"
        ? path.join(REPO_ROOT, entry.path)
        : path.join(taskDir, "sources", entry.path);
    if (!existsSync(filePath))
      fail(taskDir, `${entry.source_id} file not found: ${entry.path}`);
    const raw = readFileSync(filePath, "utf8");
    const hash = beaverCanContentHash(raw);
    if (hash !== entry.sha256)
      fail(
        taskDir,
        `${entry.source_id} content hash ${hash} != manifest sha256 ${entry.sha256}`,
      );
    if (entry.kind === "task_local")
      return {
        source_id: entry.source_id,
        kind: entry.kind,
        role: entry.role,
        citation: entry.citation,
        text: raw,
        doc: null,
      };
    const fixture = JSON.parse(raw) as {
      citation: string;
      docType: "cases" | "laws";
      dataset: string;
      name: string | null;
      url: string;
      text: string;
    };
    return {
      source_id: entry.source_id,
      kind: entry.kind,
      role: entry.role,
      citation: entry.citation,
      text: fixture.text,
      doc: compileA2AJSourceDoc({
        citation: fixture.citation,
        docType: fixture.docType,
        text: fixture.text,
        url: fixture.url,
        dataset: fixture.dataset,
        name: fixture.name,
      }),
    };
  });
}

/** Case paragraphs are labeled `par42`; statute sections `sec231(5)`. */
const pinpointLabel = (value: number | string) =>
  typeof value === "number" ? `par${value}` : `sec${value}`;

function pinpointBlockText(
  taskDir: string,
  where: string,
  source: LoadedBeaverCanSource,
  value: number | string,
): string {
  if (!source.doc)
    fail(
      taskDir,
      `${where}: ${source.source_id} is a task_local source and cannot support pinpoints`,
    );
  const label = pinpointLabel(value);
  const block = source.doc.blocks.find((candidate) => candidate.label === label);
  if (!block)
    fail(
      taskDir,
      `${where}: pinpoint ${value} (${label}) does not exist in ${source.source_id}`,
    );
  return sourceDocBlockText(source.doc, block);
}

/** Cross-checks between gold, its task, and the loaded source packet. */
export function checkBeaverCanGold(
  taskDir: string,
  task: BeaverCanTask,
  gold: BeaverCanGold,
  sources: LoadedBeaverCanSource[],
): void {
  const byId = new Map(sources.map((source) => [source.source_id, source]));
  const packetSource = (where: string, id: string) => {
    const source = byId.get(id);
    if (!source) fail(taskDir, `${where}: ${id} is not in the source packet`);
    return source;
  };

  for (const authority of gold.required_authorities) {
    const source = packetSource("required_authorities", authority.source_id);
    for (const value of authority.acceptable_pinpoints)
      pinpointBlockText(taskDir, authority.proposition_id, source, value);
  }
  for (const alternative of gold.acceptable_alternative_authorities)
    packetSource("acceptable_alternative_authorities", alternative.source_id);

  for (const quotation of gold.required_quotations ?? []) {
    const source = packetSource("required_quotations", quotation.source_id);
    const quote = normalize(quotation.quote);
    const found = quotation.acceptable_pinpoints.some((value) =>
      normalize(pinpointBlockText(taskDir, "required_quotations", source, value))
        .includes(quote),
    );
    if (!found)
      fail(
        taskDir,
        `required_quotations: quote not found at any acceptable pinpoint of ${quotation.source_id}: "${quotation.quote.slice(0, 60)}..."`,
      );
  }

  for (const identifier of gold.seeded_identifiers ?? []) {
    if (!sources.some((source) => source.text.includes(identifier)))
      fail(
        taskDir,
        `seeded_identifiers: "${identifier}" is not seeded in any packet source`,
      );
  }

  const referenced = new Set<string>([
    ...gold.required_issues,
    ...gold.required_authorities.map((entry) => entry.proposition_id),
    ...gold.acceptable_alternative_authorities.map(
      (entry) => entry.proposition_id,
    ),
    ...gold.required_conclusions.map((entry) => entry.id),
    ...gold.forbidden_claims,
  ]);
  for (const id of referenced)
    if (!(id in gold.definitions))
      fail(taskDir, `definitions: missing definition for ${id}`);
  for (const id of Object.keys(gold.definitions))
    if (!referenced.has(id))
      fail(taskDir, `definitions: ${id} is defined but never referenced`);
}

export type LoadedBeaverCanTask = {
  task: BeaverCanTask;
  gold: BeaverCanGold;
  prompt: string;
  sources: LoadedBeaverCanSource[];
};

/** Load and fully validate one task directory; throws on any defect. */
export function loadBeaverCanTaskDir(taskDir: string): LoadedBeaverCanTask {
  const task = beaverCanTaskSchema.parse(readJson(taskDir, "task.json"));
  if (task.id !== path.basename(taskDir))
    fail(taskDir, `task id ${task.id} != directory name`);

  const promptPath = path.join(taskDir, "prompt.md");
  if (!existsSync(promptPath)) fail(taskDir, "missing prompt.md");
  const prompt = readFileSync(promptPath, "utf8");
  if (!normalize(prompt)) fail(taskDir, "prompt.md is empty");
  if (task.task_type === "long_thread") {
    const turns = prompt.match(/^## TURN-\d{2}/gmu) ?? [];
    if (turns.length < 2)
      fail(taskDir, "long_thread prompt.md must script at least two ## TURN-nn headings");
  }

  const manifest = beaverCanSourceManifestSchema.parse(
    readJson(taskDir, path.join("sources", "manifest.json")),
  );
  const sources = loadBeaverCanSources(taskDir, task, manifest);
  const gold = beaverCanGoldSchema.parse(readJson(taskDir, "gold.json"));
  checkBeaverCanGold(taskDir, task, gold, sources);
  return { task, gold, prompt, sources };
}

/** Every visible development task directory, sorted by id. */
export function listBeaverCanDevTaskDirs(): string[] {
  return readdirSync(BEAVER_CAN_DEV_TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(BEAVER_CAN_DEV_TASKS_DIR, entry.name))
    .sort();
}
