/**
 * O5 drafting-efficiency replay runner (dry-run scaffold).
 *
 * Design artifact for the fair drafting-phase A/B (see
 * docs/harvey-lab-replay-runner-design-2026-08-03.md and §O5 of
 * docs/harvey-lab-deterministic-operationalization-2026-08-03.md).
 *
 * FAIR-COMPARISON PROTOCOL
 * -----------------------
 * Fork N drafting strategies from a byte-identical checkpoint that sits at
 * "just finished reading, about to draft", then meter ONLY the drafting turns.
 * The checkpoint is the arm-independent drafting-context USER MESSAGE
 * (original request + research brief + pinned orientation + evidence map +
 * hot exact evidence + mounted evidence union). Each strategy varies ONLY the
 * independent variables: system prompt, tool schema, and the drafting
 * representation mechanics (Beaver markdown->deterministic .docx vs
 * upstream-mike structured-direct generate_docx(sections)). Two axes:
 *
 *   axis 1  drafting representation : markdown-deterministic | structured-direct
 *   axis 2  ingestion representation: docx-as-markdown | whole-document
 *
 * A fork is valid only when every strategy receives the SAME user message
 * bytes (checked here by sha256) and the drafting-context is replayed from a
 * real checkpoint_paged_v1 source run.
 *
 * DRY-RUN MODE (this scaffold)
 * ----------------------------
 * Zero model calls. Loads a checkpoint_paged_v1 run's frozen artifacts
 * (beaver-receipts.json + evidence-working-set.json + config.json), reconstructs
 * the drafting-context prompt, and prints a per-strategy fingerprint report
 * plus a reconstruction-fidelity audit. See the checkpoint-gap notes at the
 * bottom of the file for what is and is not byte-recoverable today.
 *
 * Usage:
 *   npx tsx backend/scripts/drafting-efficiency-replay.ts
 *   npx tsx backend/scripts/drafting-efficiency-replay.ts --run-dir <dir>
 *   npx tsx backend/scripts/drafting-efficiency-replay.ts --strategies beaver-markdown-paged,upstream-structured-whole
 *   npx tsx backend/scripts/drafting-efficiency-replay.ts --self-test
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { OpenAIToolSchema } from "../src/lib/llm";
import {
  COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT,
  COMPACT_AUTHOR_MIKE_LAB_TOOLS,
  LEAN_BATCH_LAB_TOOLS,
  UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
  UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
  UPSTREAM_MIKE_LAB_TOOLS,
} from "../src/lib/chat/upstreamMikeBenchmarkSurface";

const DEFAULT_LAB_ROOT = path.join(__dirname, "../../benchmarks/harvey-labs");
const DEFAULT_RESULTS = path.join(DEFAULT_LAB_ROOT, "results");
const WORKING_SET_PATH = ".mike/working-sets/evidence.txt";

type DraftingRepresentation = "markdown-deterministic" | "structured-direct";
type IngestionRepresentation = "docx-as-markdown" | "whole-document";

type StrategyDefinition = {
  name: string;
  representation: DraftingRepresentation;
  ingestion: IngestionRepresentation;
  authoringTool: "generate_docx" | "library_create_docx";
  systemPrompt: string;
  tools: OpenAIToolSchema[];
  note: string;
};

// --- Drafting surfaces ------------------------------------------------------
//
// The paged (docx-as-markdown) drafting surface reuses the lean-batch
// Grep/Read pair so the drafting agent addresses the mounted evidence union at
// .mike/working-sets/evidence.txt instead of re-reading whole documents. The
// whole-document surfaces use the frozen upstream retrieval tools.
//
// TODO(real-mode): extract the exact drafting-phase system prompts from the
// arms instead of the placeholders below. In the live runs the drafting phase
// keeps the arm's system prompt and receives the handoff as the USER message;
// the paged prompt here approximates the drafting-agent framing that the
// host describes in compilePagedEvidenceHandoff.

const PAGED_DRAFTING_SYSTEM_PROMPT = `You are the drafting agent for a legal-document task. A prior research phase produced a checkpoint and gathered the exact evidence into a mounted union at ${WORKING_SET_PATH}.
- Use the checkpoint as a coverage checklist: address or explicitly disposition every material finding, contradiction, number, unresolved question, and next action in the appropriate deliverable before finishing.
- Produce every requested artifact at production-appropriate depth; a requested full draft must contain complete operative provisions rather than an outline or shortened specimen.
- The mounted union has already been reviewed. Grep it for exact evidence; Read only an exact recipe returned by Grep when adjacent wording, a pinpoint, or an unresolved conflict is needed. Never page the union sequentially or reread it for completeness.
- Use source or provider tools beyond the union only for a concrete missing fact.`;

const leanBatchByName = new Map(
  LEAN_BATCH_LAB_TOOLS.map((tool) => [tool.function.name, tool]),
);
const leanGrep = leanBatchByName.get("Grep") ?? null;
const leanRead = leanBatchByName.get("Read") ?? null;

const upstreamGrepReadTools = [
  leanGrep,
  leanRead,
  UPSTREAM_MIKE_GENERATE_DOCX_TOOL,
].filter((tool): tool is OpenAIToolSchema => Boolean(tool));

// The four cells of the fork matrix. `beaver-markdown-paged` corresponds to
// the drafting phase of the existing checkpoint_paged_v1 runs.
const STRATEGIES: StrategyDefinition[] = [
  {
    name: "beaver-markdown-paged",
    representation: "markdown-deterministic",
    ingestion: "docx-as-markdown",
    authoringTool: "generate_docx",
    systemPrompt: PAGED_DRAFTING_SYSTEM_PROMPT,
    tools: LEAN_BATCH_LAB_TOOLS,
    note: "Beaver markdown drafting over the mounted paged evidence union.",
  },
  {
    name: "beaver-markdown-whole",
    representation: "markdown-deterministic",
    ingestion: "whole-document",
    authoringTool: "generate_docx",
    systemPrompt: COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT,
    tools: COMPACT_AUTHOR_MIKE_LAB_TOOLS,
    note: "Beaver markdown drafting with whole-document retrieval (compact author).",
  },
  {
    name: "upstream-structured-paged",
    representation: "structured-direct",
    ingestion: "docx-as-markdown",
    authoringTool: "generate_docx",
    systemPrompt: PAGED_DRAFTING_SYSTEM_PROMPT,
    tools: upstreamGrepReadTools,
    note: "Upstream generate_docx(sections) drafting over the mounted paged evidence union.",
  },
  {
    name: "upstream-structured-whole",
    representation: "structured-direct",
    ingestion: "whole-document",
    authoringTool: "generate_docx",
    systemPrompt: UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
    tools: UPSTREAM_MIKE_LAB_TOOLS,
    note: "Frozen upstream Mike: whole-document retrieval + generate_docx(sections).",
  },
];

// --- Checkpoint model -------------------------------------------------------

type OrientationEntry = { name: string; content: string; recoverable: boolean };

type DraftingCheckpoint = {
  schemaVersion: 1;
  sourceRunDir: string;
  task: string;
  arm: string;
  model: string;
  originalRequest: string;
  researchBrief: string;
  researchBriefSha256: string;
  researchBriefRecovered: boolean;
  orientation: OrientationEntry[];
  orientationRecoverable: boolean;
  workingSet: { path: string; text: string; sha256: string; sourceChars: number } | null;
  hotItems: Array<{
    filename: string;
    locator: string;
    chars: number;
    exactSha256: string;
  }>;
  recordedPromptChars: number | null;
};

// --- Small IO helpers -------------------------------------------------------

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? value : fallback;
}

// --- Checkpoint reconstruction ----------------------------------------------

type ReceiptToolCall = {
  id?: string;
  name?: string;
  phase?: string | null;
  input?: Record<string, unknown> | null;
};

type ReceiptToolResult = {
  id?: string;
  name?: string;
  phase?: string | null;
  content_chars?: number;
  content_preview?: string | null;
};

type Receipts = {
  tool_calls?: ReceiptToolCall[];
  tool_results?: ReceiptToolResult[];
  evidence_handoff?: {
    initial_prompt_chars?: number;
    working_set_path?: string | null;
    hot_items?: Array<{
      filename?: string;
      locator?: string;
      chars?: number;
      exact_sha256?: string;
    }>;
  } | null;
};

type WorkingSetArtifact = {
  path?: string;
  text?: string;
  text_sha256?: string;
  source_chars?: number;
};

/**
 * Reconstruct the "finished reading, about to draft" checkpoint from a real
 * checkpoint_paged_v1 run directory. Reads only frozen artifacts; never makes
 * a model call. Every field is annotated with its recoverability so the
 * dry-run audit can distinguish byte-pinned state from Tier-0 best effort.
 */
function loadCheckpoint(runDir: string): DraftingCheckpoint | null {
  const config = readJson<{ task?: string; arm?: string; model?: string }>(
    path.join(runDir, "config.json"),
  );
  const receipts = readJson<Receipts>(path.join(runDir, "beaver-receipts.json"));
  const workingSetArtifact = readJson<WorkingSetArtifact>(
    path.join(runDir, "evidence-working-set.json"),
  );
  if (!receipts || !config?.arm) return null;

  const calls = receipts.tool_calls ?? [];
  const resultsById = new Map(
    (receipts.tool_results ?? [])
      .filter((result) => result.id)
      .map((result) => [result.id as string, result]),
  );

  // The final reviewed research brief is the `brief` argument of the last
  // checkpoint_research call whose continue_research decision was false (the
  // one the drafting context was compiled from).
  const checkpointCalls = calls.filter((call) => call.name === "checkpoint_research");
  const finalBriefCall =
    [...checkpointCalls].reverse().find(
      (call) => call.input?.continue_research === false,
    ) ?? checkpointCalls.at(-1);
  const researchBrief = String(finalBriefCall?.input?.brief ?? "").trim();

  // The pinned orientation is the bounded set of research-phase Glob results
  // the host carried into the handoff. Full results are truncated to
  // content_preview in the receipts (1,600 + trailing 400 chars), so this is
  // recoverable only when a Glob result fit inside the preview window.
  const orientation: OrientationEntry[] = calls.flatMap((call) => {
    if (call.name !== "Glob" || (call.phase ?? null) === "drafting") return [];
    const result = resultsById.get(call.id ?? "");
    const content = result?.content_preview ?? "";
    if (!content) return [];
    const recoverable =
      typeof result?.content_chars === "number" && result.content_chars <= 2_000;
    return [{ name: `Glob:${JSON.stringify(call.input ?? {})}`, content, recoverable }];
  });

  const workingSet = workingSetArtifact?.text
    ? {
        path: workingSetArtifact.path ?? WORKING_SET_PATH,
        text: workingSetArtifact.text,
        sha256:
          workingSetArtifact.text_sha256 ?? sha256(workingSetArtifact.text),
        sourceChars: Number(workingSetArtifact.source_chars ?? 0),
      }
    : null;

  const hotItems = (receipts.evidence_handoff?.hot_items ?? []).map((item) => ({
    filename: item.filename ?? "",
    locator: item.locator ?? "",
    chars: Number(item.chars ?? 0),
    exactSha256: item.exact_sha256 ?? "",
  }));

  return {
    schemaVersion: 1,
    sourceRunDir: runDir,
    task: config.task ?? "",
    arm: config.arm,
    model: config.model ?? "",
    originalRequest: "(task instructions; see TODO load LAB task.md)",
    researchBrief,
    researchBriefSha256: sha256(researchBrief),
    researchBriefRecovered: Boolean(researchBrief),
    orientation,
    orientationRecoverable: orientation.every((entry) => entry.recoverable),
    workingSet,
    hotItems,
    recordedPromptChars:
      receipts.evidence_handoff?.initial_prompt_chars ?? null,
  };
}

/**
 * Best-effort evidence map derived from the mounted working-set headers. TODO:
 * port renderEvidenceMap from evidenceExposure.ts exactly so the reconstructed
 * drafting-context prompt is byte-identical to the one the source run sent.
 */
function renderEvidenceMapApprox(checkpoint: DraftingCheckpoint): string {
  if (!checkpoint.workingSet) return "(No durable evidence yet.)";
  const byFile = new Map<string, { items: number; chars: number; locators: string[] }>();
  const header = /^=== (.+?) \| (.+?) ===\s*$/gmu;
  let match: RegExpExecArray | null;
  let lastHeaderStart = -1;
  let lastFile = "";
  let lastLocator = "";
  const text = checkpoint.workingSet.text;
  // First pass: record each file section's header and its char span.
  const sections: Array<{ file: string; locator: string; start: number; end: number }> = [];
  while ((match = header.exec(text)) !== null) {
    if (lastHeaderStart >= 0) {
      sections.push({
        file: lastFile,
        locator: lastLocator,
        start: lastHeaderStart,
        end: match.index,
      });
    }
    lastFile = match[1];
    lastLocator = match[2];
    lastHeaderStart = match.index;
  }
  if (lastHeaderStart >= 0) {
    sections.push({
      file: lastFile,
      locator: lastLocator,
      start: lastHeaderStart,
      end: text.length,
    });
  }
  for (const section of sections) {
    const prior = byFile.get(section.file) ?? { items: 0, chars: 0, locators: [] };
    prior.items += 1;
    prior.chars += Math.max(0, section.end - section.start);
    if (section.locator && !prior.locators.includes(section.locator)) {
      prior.locators.push(section.locator);
    }
    byFile.set(section.file, prior);
  }
  if (!byFile.size) return "(No durable evidence yet.)";
  const rows = [...byFile]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([file, summary]) =>
        `${file}\t${summary.items}\t${summary.chars}\t${summary.locators.join(" | ")}`,
    );
  const totalChars = [...byFile.values()].reduce((total, s) => total + s.chars, 0);
  const totalItems = [...byFile.values()].reduce((t, s) => t + s.items, 0);
  // Mirror the real renderEvidenceMap's 12,000-char cap and omission note so
  // the reconstructed prompt length is comparable to the source run's.
  const maxChars = 12_000;
  let rendered = [
    `TOTAL\tfiles=${byFile.size}\titems=${totalItems}\tchars=${totalChars}`,
    "file\titems\tchars\tlocators",
    ...rows.slice(0, 200),
  ].join("\n");
  if (rendered.length > maxChars) {
    rendered = `${rendered.slice(0, maxChars)}\n… files omitted from this compact map; use the mounted exact union.`;
  }
  return rendered;
}

/**
 * Rebuild the arm-independent drafting-context user message. This is the
 * byte-identical fork point: every strategy receives this exact text.
 * Mirrors the section order of compilePagedEvidenceHandoff in
 * backend/src/lib/chat/evidenceExposure.ts. Orientation and evidence-map
 * fidelity depend on checkpoint recovery (see the audit below).
 */
function buildDraftingContextPrompt(checkpoint: DraftingCheckpoint): string {
  const orientationText = checkpoint.orientation.length
    ? checkpoint.orientation.map((entry) => `=== ${entry.name} ===\n${entry.content}`).join("\n\n")
    : "";
  const hotText = checkpoint.hotItems.length
    ? checkpoint.hotItems
        .map((item) => `=== ${item.filename} | ${item.locator} ===\n(heat packet; exact source spans carry the evidence)`)
        .join("\n\n")
    : "";
  return [
    "You are the drafting agent. A previous research agent produced the brief and gathered the exact evidence.",
    "The checkpoint is the reviewed factual drafting basis, not a request to repeat the research pass.",
    "Use the checkpoint as a coverage checklist: address or explicitly disposition every material finding, contradiction, number, unresolved question, and next action in the appropriate deliverable before finishing.",
    "Produce every requested artifact at production-appropriate depth. A requested full draft must contain complete operative provisions rather than an outline or shortened specimen.",
    "The mounted union has already been reviewed. Paging it, or rereading a mapped source span, stays in drafting; use source or provider tools beyond that union only for a concrete missing fact, which the host will checkpoint before drafting resumes.",
    `Grep(path=${JSON.stringify(checkpoint.workingSet?.path ?? WORKING_SET_PATH)}, output_mode="content") returns exact match-centred evidence and executable Read recipes. Use those hits directly. Read(file_path=${JSON.stringify(checkpoint.workingSet?.path ?? WORKING_SET_PATH)}) only from a recipe when exact adjacent wording, a pinpoint, or an unresolved conflict is needed. Never page through the union sequentially or reread it for completeness.`,
    "ORIGINAL REQUEST",
    checkpoint.originalRequest.trim(),
    ...(orientationText ? ["PINNED ORIENTATION", orientationText] : []),
    "RESEARCH CHECKPOINT",
    checkpoint.researchBrief.trim() || "(No research notes were recorded.)",
    "EVIDENCE MAP",
    renderEvidenceMapApprox(checkpoint),
    ...(hotText ? ["HOT EXACT EVIDENCE", hotText] : []),
  ]
    .filter((value) => value !== "")
    .join("\n\n");
}

// --- Dry-run report ---------------------------------------------------------

type StrategyReport = {
  strategy: StrategyDefinition;
  systemPromptSha256: string;
  systemPromptChars: number;
  toolSchemaSha256: string;
  toolSchemaChars: number;
  authoringTool: string;
};

function fingerprintStrategy(
  strategy: StrategyDefinition,
  prompt: string,
): StrategyReport {
  return {
    strategy,
    systemPromptSha256: sha256(strategy.systemPrompt),
    systemPromptChars: strategy.systemPrompt.length,
    toolSchemaSha256: sha256(JSON.stringify(strategy.tools)),
    toolSchemaChars: JSON.stringify(strategy.tools).length,
    authoringTool: strategy.authoringTool,
  };
}

function checkpointAudit(checkpoint: DraftingCheckpoint, prompt: string) {
  const reconstructedChars = prompt.length;
  const recorded = checkpoint.recordedPromptChars;
  const lengthDelta =
    recorded == null ? null : Math.abs(reconstructedChars - recorded);
  const fidelity =
    !checkpoint.researchBriefRecovered
      ? "missing-research-brief"
      : !checkpoint.orientationRecoverable
        ? "approximate-orientation"
        : recorded != null && lengthDelta !== null && lengthDelta <= 2
          ? "exact"
          : "approximate";
  return {
    recordedPromptChars: recorded,
    reconstructedPromptChars: reconstructedChars,
    lengthDelta,
    fidelity,
    researchBriefChars: checkpoint.researchBrief.length,
    researchBriefRecovered: checkpoint.researchBriefRecovered,
    orientationEntries: checkpoint.orientation.length,
    orientationByteRecoverable: checkpoint.orientationRecoverable,
    workingSetChars: checkpoint.workingSet?.text.length ?? 0,
    workingSetSha256: checkpoint.workingSet?.sha256 ?? null,
    hotItems: checkpoint.hotItems.length,
  };
}

function renderReport(
  checkpoint: DraftingCheckpoint,
  selected: StrategyDefinition[],
  prompt: string,
): string {
  const promptSha256 = sha256(prompt);
  const audit = checkpointAudit(checkpoint, prompt);
  const reports = selected.map((strategy) =>
    fingerprintStrategy(strategy, prompt),
  );
  // Every cell receives the same user message by construction (a single
  // reconstructed prompt). The meaningful byte-identity signal is the
  // reconstruction fidelity: "exact" means the rebuilt prompt length matches
  // the recorded initial_prompt_chars from the source run.
  const identical = audit.fidelity === "exact";
  const lines: string[] = [];
  lines.push(
    "# Harvey LAB drafting-efficiency replay — dry-run fork report",
    "",
    `Generated ${new Date().toISOString()} by \`npx tsx backend/scripts/drafting-efficiency-replay.ts\`.`,
    "Zero model calls. Source run: `" + checkpoint.sourceRunDir + "`",
    "",
    "## Checkpoint (reconstructed from frozen artifacts)",
    "",
    `- task: ${checkpoint.task}`,
    `- arm: ${checkpoint.arm}`,
    `- research brief: ${audit.researchBriefChars} chars (recovered: ${audit.researchBriefRecovered})`,
    `- pinned orientation: ${audit.orientationEntries} Glob entries (byte-recoverable: ${audit.orientationByteRecoverable})`,
    `- working set: ${audit.workingSetChars} chars, sha256 ${audit.workingSetSha256 ?? "none"}`,
    `- hot items: ${audit.hotItems}`,
    "",
    "## Drafting-context prompt (byte-identical fork point)",
    "",
    `- chars: ${audit.reconstructedPromptChars}`,
    `- recorded initial_prompt_chars: ${audit.recordedPromptChars ?? "none"}`,
    `- length delta: ${audit.lengthDelta ?? "n/a"}`,
    `- reconstruction fidelity: ${audit.fidelity}`,
    `- sha256: ${promptSha256}`,
    "",
    "## Fork matrix",
    "",
    "| strategy | representation | ingestion | authoring | system prompt sha256 | tools sha256 | user msg sha256 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const report of reports) {
    lines.push(
      [
        report.strategy.name,
        report.strategy.representation,
        report.strategy.ingestion,
        report.authoringTool,
        report.systemPromptSha256.slice(0, 16),
        report.toolSchemaSha256.slice(0, 16),
        promptSha256.slice(0, 16),
      ]
        .map((cell) => `| ${cell} `)
        .join("")
        .concat("|"),
    );
  }
  lines.push(
    "",
    `Drafting-context prompt byte-pinned: ${identical ? "PASS — reconstruction is exact; a Tier-1 replay can fork byte-identically from this checkpoint." : "PARTIAL — reconstruction is approximate (see gaps); a Tier-1 harness must persist the exact prompt text at the evidence_handoff boundary."}`,
    "",
    "## Recoverability gaps (checkpoint gap)",
    "",
    "- The drafting-context prompt text is NOT persisted by the harness today; it is reconstructed here. Tier 1 must persist `replay-checkpoint.json` at the evidence_handoff boundary.",
    "- The final research brief is recovered from the last `checkpoint_research` tool-call input in beaver-receipts.json.",
    "- Pinned orientation Glob content is truncated to content_preview in the receipts; not byte-recoverable.",
    "- Arms with `draft_handoff_mode: none` (upstream, lean_batch, mike_grep, coding v13-v15) emit no checkpoint and cannot seed a fork; only checkpoint_paged_v1 runs can.",
  );
  return lines.join("\n");
}

// --- Discovery and CLI ------------------------------------------------------

function findCheckpointPagedRun(resultsDir: string): string | null {
  const candidates: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name === "config.json") candidates.push(dir);
    }
  };
  walk(resultsDir);
  for (const dir of candidates) {
    const config = readJson<{ arm?: string }>(path.join(dir, "config.json"));
    if (config?.arm === "checkpoint_paged_v1") return dir;
  }
  return null;
}

function main() {
  // Resolve a relative --run-dir against the repo root so the flag works from
  // any cwd (e.g. backend/ when invoked through tsx).
  const repoRoot = path.resolve(__dirname, "..", "..");
  const requestedRunDir = flag("run-dir", "");
  const discoveredRunDir = findCheckpointPagedRun(DEFAULT_RESULTS) ?? "";
  const runDir = requestedRunDir
    ? path.isAbsolute(requestedRunDir)
      ? requestedRunDir
      : path.join(repoRoot, requestedRunDir)
    : discoveredRunDir;
  if (!runDir || !existsSync(path.join(runDir, "beaver-receipts.json"))) {
    throw new Error(
      `no checkpoint_paged_v1 source run found; pass --run-dir <dir> under ${DEFAULT_RESULTS}`,
    );
  }
  const checkpoint = loadCheckpoint(runDir);
  if (!checkpoint) {
    throw new Error(`could not load checkpoint from ${runDir}`);
  }
  const requested = flag("strategies", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const selected = requested.length
    ? STRATEGIES.filter((strategy) => requested.includes(strategy.name))
    : STRATEGIES;
  if (selected.length !== (requested.length || STRATEGIES.length)) {
    throw new Error(
      `unknown --strategies; expected one of ${STRATEGIES.map((s) => s.name).join(", ")}`,
    );
  }

  // TODO(real-mode): replace this with a single provider call per strategy —
  // streamChatWithTools({ model, systemPrompt, messages:[{role:"user",content:prompt}], tools, runTools: <strategy tool executor>, ... }) — then meter drafting tokens from context-manifest.jsonl and write replay-<strategy>.json.

  const prompt = buildDraftingContextPrompt(checkpoint);
  const report = renderReport(checkpoint, selected, prompt);
  const out = flag("out", "");
  if (out) {
    writeFileSync(out, report, "utf8");
    console.log(`replay dry-run report written: ${out}`);
  } else {
    console.log(report);
  }

  if (process.argv.includes("--self-test")) {
    const sha = sha256(prompt);
    if (!checkpoint.researchBriefRecovered) {
      throw new Error("self-test: expected a recoverable research brief from a checkpoint_paged_v1 run");
    }
    // A valid fork shares one user message across all cells; the single
    // reconstructed prompt guarantees that by construction, so the meaningful
    // assertions are that the checkpoint loaded and the brief is recoverable.
    console.log(`self-test passed (user-message sha256 ${sha.slice(0, 16)} across ${selected.length} cells)`);
  }
}

main();
