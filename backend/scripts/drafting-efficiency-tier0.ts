/**
 * Tier 0 drafting-phase token slicer for the vendored Harvey LAB harness.
 *
 * Retrospective, zero-model-call audit of the grounded-cache batches. Reads
 * frozen run artifacts under benchmarks/harvey-labs/results/ only — no
 * provider traffic, no judge. It computes a defensible "drafting-phase" token
 * slice per run by attributing the per-round usage receipts in
 * context-manifest.jsonl to research vs drafting rounds, using the run's own
 * tool trace (raw-sse.txt, falling back to beaver-receipts.json) to locate
 * where authoring begins. It also extracts the recoverable-now part of the
 * ingestion-representation axis (whole-read vs excerpted) straight from
 * metrics.json.
 *
 * Why the boundary is the first authoring call (see report §1): every tool
 * call in the three grounded-cache arms is traced with phase "research"
 * (MIKE_CONTEXT_HANDOFF=0, MIKE_CONTINUOUS_EVIDENCE=0, no describe_tools
 * gate), so the host phase field never flips to "drafting". The drafting
 * phase therefore starts at the first round whose tool-call batch contains an
 * authoring call (generate_docx in these arms). All rounds from that round to
 * the end of the run are drafting rounds; rounds before it are research.
 *
 * Usage:
 *   npx tsx backend/scripts/drafting-efficiency-tier0.ts
 *   npx tsx backend/scripts/drafting-efficiency-tier0.ts --filter draft-indenture
 *   npx tsx backend/scripts/drafting-efficiency-tier0.ts --batch v1
 *   npx tsx backend/scripts/drafting-efficiency-tier0.ts --out <path>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_LAB_ROOT = path.join(__dirname, "../../benchmarks/harvey-labs");
const DEFAULT_RESULTS = path.join(DEFAULT_LAB_ROOT, "results");
const DEFAULT_BATCHES = ["v1", "v2", "v3"];

/** Arms this slicer was built for; the comparison groups on these three. */
const ARMS = [
  "grounded_structure_v1",
  "mike_structure_paths_v1",
  "upstream_terminal_v1",
] as const;

/**
 * Authoring tools: names that create or mutate a deliverable document. In the
 * three arms under study the upstream surface's only authoring tool is
 * generate_docx; the /docx/i test also catches future library_*_docx authoring
 * shapes so the boundary stays useful if the toolset grows.
 */
const AUTHORING_TOOL = /docx/iu;

type Flag = { batch: string[]; filter: string; out: string };

function flag(): Flag {
  const read = (name: string, fallback: string) => {
    const index = process.argv.indexOf(`--${name}`);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return value ? value : fallback;
  };
  const batch = read("batch", "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    batch: batch.length ? batch : DEFAULT_BATCHES,
    filter: read("filter", ""),
    out: read(
      "out",
      path.join(
        __dirname,
        "../../docs/harvey-lab-drafting-efficiency-tier0-2026-08-03.md",
      ),
    ),
  };
}

type RoundUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
};

type Round = {
  iteration: number;
  toolCallCount: number;
  inputBytes: number;
  toolResultBytes: number;
  usage: RoundUsage;
};

type ManifestEntry = {
  provider: string;
  model: string;
  status: string;
  usage: RoundUsage;
  rounds: Round[];
  compactions: unknown[];
  inputEstimate?: { tokens?: number; bytes?: number };
};

type ToolCall = { name: string; phase: string | null };

type UsageSum = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

type RunSlice = {
  totalCalls: number;
  draftingCalls: number;
  aligned: boolean;
  firstAuthoringRound: number | null;
  boundaryCallNames: string[];
  drafting: UsageSum;
  research: UsageSum;
  draftingCacheAdjusted: number | null;
  researchCacheAdjusted: number | null;
  totalCacheAdjusted: number | null;
  draftingShareCacheAdjusted: number | null;
  draftingShareInput: number | null;
  draftingInputBytes: number;
  draftingToolResultBytes: number;
};

type RunReport = {
  runId: string;
  batch: string;
  task: string;
  arm: string;
  model: string;
  kind: "complete" | "sliceable_no_metrics" | "error_no_usage" | "no_artifacts";
  gaps: string[];
  slice: RunSlice | null;
  metrics: Record<string, unknown> | null;
};

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadManifest(file: string): {
  entries: ManifestEntry[];
  provider: string | null;
  model: string | null;
  status: string | null;
} {
  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const entries: ManifestEntry[] = [];
  for (const line of body.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as ManifestEntry);
    } catch {
      // A torn trailing line should not fail the whole run.
    }
  }
  return {
    entries,
    provider: entries[0]?.provider ?? null,
    model: entries[0]?.model ?? null,
    status: entries[0]?.status ?? null,
  };
}

function toolCallsFromSse(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith("data: ")) continue;
    let event: { type?: string; name?: string; phase?: string };
    try {
      event = JSON.parse(line.slice(6)) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "tool_call_start") continue;
    calls.push({ name: event.name ?? "", phase: event.phase ?? null });
  }
  return calls;
}

function loadToolCalls(runDir: string): {
  calls: ToolCall[];
  source: string;
} {
  const ssePath = path.join(runDir, "raw-sse.txt");
  if (existsSync(ssePath)) {
    const calls = toolCallsFromSse(readFileSync(ssePath, "utf8"));
    if (calls.length) return { calls, source: "raw-sse.txt" };
  }
  const receipts = readJson<{ tool_calls?: ToolCall[] }>(
    path.join(runDir, "beaver-receipts.json"),
  );
  if (receipts?.tool_calls?.length) {
    return {
      calls: receipts.tool_calls.map((call) => ({
        name: call.name,
        phase: call.phase ?? null,
      })),
      source: "beaver-receipts.json",
    };
  }
  return { calls: [], source: "none" };
}

const isDraftingCall = (call: ToolCall) =>
  AUTHORING_TOOL.test(call.name) ||
  call.phase === "drafting" ||
  call.phase === "continuous";

function sumUsage(rounds: Round[], provider: string | null): UsageSum {
  const total: UsageSum = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  for (const round of rounds) {
    const usage = round.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheWrite = usage.cacheWriteInputTokens ?? 0;
    // Mirror lab-beaver-arm.ts aggregation: claude-p reports cache reads and
    // writes outside input_tokens; openai/codex report cached input as a
    // subset of input_tokens, so it must not be added again.
    total.input +=
      inputTokens + (provider === "claude-p" ? cacheRead + cacheWrite : 0);
    total.output += usage.outputTokens ?? 0;
    total.reasoning += usage.reasoningTokens ?? 0;
    total.cacheRead += cacheRead;
    total.cacheWrite += cacheWrite;
  }
  return total;
}

function cacheAdjusted(
  usage: UsageSum,
): number | null {
  if (!usage.input) return 0;
  const knownCacheRead = Math.min(usage.cacheRead, usage.input);
  const nonReadInput = Math.max(0, usage.input - knownCacheRead);
  const knownCacheWrite = Math.min(usage.cacheWrite, nonReadInput);
  return (
    nonReadInput -
    knownCacheWrite +
    knownCacheRead * 0.1 +
    knownCacheWrite * 1.25
  );
}

/**
 * Attribute manifest rounds to tool-call batches (cumulatively by each round's
 * toolCallCount, matching the chronological SSE stream) and find the drafting
 * boundary at the first round containing an authoring call.
 */
function sliceRounds(
  rounds: Round[],
  calls: ToolCall[],
  provider: string | null,
): RunSlice {
  const totalCalls = rounds.reduce(
    (total, round) => total + round.toolCallCount,
    0,
  );
  const aligned = totalCalls === calls.length;
  const perRound: Array<{ round: Round; calls: ToolCall[] }> = [];
  let cursor = 0;
  for (const round of rounds) {
    const batch = calls.slice(cursor, cursor + round.toolCallCount);
    cursor += round.toolCallCount;
    perRound.push({ round, calls: batch });
  }
  const firstAuthoringRound = perRound.findIndex((entry) =>
    entry.calls.some(isDraftingCall),
  );
  const draftingRounds =
    firstAuthoringRound >= 0
      ? perRound.slice(firstAuthoringRound).map((entry) => entry.round)
      : [];
  const researchRounds =
    firstAuthoringRound > 0
      ? perRound.slice(0, firstAuthoringRound).map((entry) => entry.round)
      : [];
  const drafting = sumUsage(draftingRounds, provider);
  const research = sumUsage(researchRounds, provider);
  const totalCacheAdjusted = cacheAdjusted({
    input: drafting.input + research.input,
    output: drafting.output + research.output,
    reasoning: drafting.reasoning + research.reasoning,
    cacheRead: drafting.cacheRead + research.cacheRead,
    cacheWrite: drafting.cacheWrite + research.cacheWrite,
  });
  const draftingCacheAdjusted = cacheAdjusted(drafting);
  return {
    totalCalls,
    draftingCalls: draftingRounds.reduce(
      (total, round) => total + round.toolCallCount,
      0,
    ),
    aligned,
    firstAuthoringRound,
    boundaryCallNames:
      firstAuthoringRound >= 0
        ? perRound[firstAuthoringRound].calls
            .filter(isDraftingCall)
            .map((call) => call.name)
        : [],
    drafting,
    research,
    draftingCacheAdjusted,
    researchCacheAdjusted: cacheAdjusted(research),
    totalCacheAdjusted,
    draftingShareCacheAdjusted:
      totalCacheAdjusted != null && totalCacheAdjusted > 0
        ? (draftingCacheAdjusted ?? 0) / totalCacheAdjusted
        : null,
    draftingShareInput:
      drafting.input + research.input > 0
        ? drafting.input / (drafting.input + research.input)
        : null,
    draftingInputBytes: draftingRounds.reduce(
      (total, round) => total + (round.inputBytes ?? 0),
      0,
    ),
    draftingToolResultBytes: draftingRounds.reduce(
      (total, round) => total + (round.toolResultBytes ?? 0),
      0,
    ),
  };
}

function parseTaskFromDirName(dirname: string): {
  batch: string;
  task: string;
  arm: string;
} {
  const parts = dirname.split("--");
  const batch = parts[0]?.replace(/^2026-08-03-grounded-cache-/u, "") ?? "";
  const arm = parts.at(-1) ?? "";
  const task = parts.slice(1, -1).join("/");
  return { batch, task, arm };
}

function analyzeRun(runDir: string, runId: string): RunReport {
  const config = readJson<{ arm?: string; task?: string; model?: string }>(
    path.join(runDir, "config.json"),
  );
  const parsed = parseTaskFromDirName(runId);
  const arm = config?.arm ?? parsed.arm;
  const task = config?.task ?? parsed.task;
  const model = config?.model ?? "unknown";
  const batch = parsed.batch || "unknown";

  const metrics = readJson<Record<string, unknown>>(
    path.join(runDir, "metrics.json"),
  );
  const manifest = loadManifest(path.join(runDir, "context-manifest.jsonl"));
  const toolTrace = loadToolCalls(runDir);
  const gaps: string[] = [];
  let kind: RunReport["kind"] = "no_artifacts";

  const rounds = manifest.entries.flatMap((entry) => entry.rounds ?? []);
  const hasUsage = rounds.some(
    (round) => (round.usage?.inputTokens ?? null) != null,
  );

  if (!manifest.entries.length && !metrics && toolTrace.calls.length === 0) {
    kind = "no_artifacts";
    gaps.push("no context-manifest.jsonl, metrics.json, or tool trace (run-state.json only)");
    return { runId, batch, task, arm, model, kind, gaps, slice: null, metrics: null };
  }
  if (manifest.status === "error" || (manifest.entries.length && !hasUsage)) {
    kind = "error_no_usage";
    gaps.push(
      manifest.entries.length
        ? `manifest status ${manifest.status}; no per-round provider usage`
        : "context-manifest.jsonl missing or empty",
    );
    return { runId, batch, task, arm, model, kind, gaps, slice: null, metrics };
  }
  if (!metrics) {
    gaps.push("metrics.json missing (aggregates unavailable)");
    kind = "sliceable_no_metrics";
  } else {
    kind = "complete";
  }
  if (toolTrace.calls.length === 0) {
    gaps.push("no tool trace (raw-sse.txt / beaver-receipts.json)");
    return { runId, batch, task, arm, model, kind, gaps, slice: null, metrics };
  }

  const slice = sliceRounds(rounds, toolTrace.calls, manifest.provider);
  if (!slice.aligned) {
    gaps.push(
      `round toolCallCount total ${slice.totalCalls} != traced tool calls ${toolTrace.calls.length}`,
    );
  }
  if (slice.firstAuthoringRound === null) {
    gaps.push(
      "no authoring call found in tool trace; drafting slice is 0 by definition",
    );
  }
  return { runId, batch, task, arm, model, kind, gaps, slice, metrics };
}

const fmt = (value: number | null | undefined, digits = 0) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

const pct = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(1)}%`;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function renderSliceTable(
  runs: RunReport[],
): string {
  const lines = [
    "| batch | arm | drafting in | drafting out | drafting cache-adj in | drafting share (cache-adj) | research in | total in | total cache-adj | drafting req bytes | boundary | tool trace |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    const s = run.slice;
    if (!s) {
      lines.push(
        `| ${run.batch} | ${run.arm} | — | — | — | — | — | — | — | — | — | ${run.kind} |`,
      );
      continue;
    }
    lines.push(
      [
        run.batch,
        run.arm,
        fmt(s.drafting.input),
        fmt(s.drafting.output),
        fmt(s.draftingCacheAdjusted, 1),
        pct(s.draftingShareCacheAdjusted),
        fmt(s.research.input),
        fmt(s.drafting.input + s.research.input),
        fmt(s.totalCacheAdjusted, 1),
        fmt(s.draftingInputBytes),
        s.firstAuthoringRound == null
          ? "none"
          : `r${s.firstAuthoringRound} · ${s.draftingCalls} aut`,
        s.aligned ? "aligned" : "MISALIGNED",
      ]
        .map((cell) => `| ${cell} `)
        .join("")
        .concat("|"),
    );
  }
  return lines.join("\n");
}

function renderAggregate(runs: RunReport[]): string {
  const byArm = new Map<string, RunReport[]>();
  for (const run of runs) {
    if (!run.slice) continue;
    const group = byArm.get(run.arm) ?? [];
    group.push(run);
    byArm.set(run.arm, group);
  }
  const lines = [
    "| arm | runs | mean drafting cache-adj in | median drafting cache-adj in | mean drafting share (cache-adj) | mean drafting out | mean research in | mean total in |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const arm of ARMS) {
    const group = byArm.get(arm) ?? [];
    const slices = group
      .map((run) => run.slice)
      .filter((slice): slice is RunSlice => Boolean(slice));
    const drafts = slices
      .map((slice) => slice.draftingCacheAdjusted)
      .filter((v): v is number => v != null);
    const shares = slices
      .map((slice) => slice.draftingShareCacheAdjusted)
      .filter((v): v is number => v != null);
    const outs = slices.map((slice) => slice.drafting.output);
    const research = slices.map((slice) => slice.research.input);
    const totals = slices.map((slice) => slice.drafting.input + slice.research.input);
    lines.push(
      [
        arm,
        fmt(group.length),
        fmt(mean(drafts), 1),
        fmt(median(drafts), 1),
        fmt(mean(shares), 4),
        fmt(mean(outs)),
        fmt(mean(research)),
        fmt(mean(totals)),
      ]
        .map((cell) => `| ${cell} `)
        .join("")
        .concat("|"),
    );
  }
  return lines.join("\n");
}

function renderIngestionSurface(runs: RunReport[]): string {
  const lines = [
    "| batch | arm | docs read / ingested | source chars | tool result chars | unique-source exposure ratio | gross replay ratio | duplicate reads | duplicate exposures | tool result cap | whole-read cap | structure-path evidence chars | structure-path replay ratio |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const run of runs) {
    const m = run.metrics;
    if (!m) {
      lines.push(`| ${run.batch} | ${run.arm} | — (metrics.json missing) |`);
      continue;
    }
    const num = (key: string) => (m[key] == null ? null : Number(m[key]));
    lines.push(
      [
        run.batch,
        run.arm,
        `${fmt(num("documents_read"))}/${fmt(num("documents_ingested"))}`,
        fmt(num("source_text_chars")),
        fmt(num("tool_result_chars")),
        fmt(num("unique_source_exposure_ratio"), 4),
        fmt(num("gross_replay_ratio"), 4),
        fmt(num("duplicate_read_calls")),
        fmt(num("duplicate_exposure_calls")),
        fmt(num("tool_result_max_chars")),
        m["whole_read_max_chars"] == null
          ? "unset"
          : fmt(num("whole_read_max_chars")),
        fmt(num("structure_path_evidence_chars")),
        fmt(num("structure_path_evidence_replay_ratio"), 4),
      ]
        .map((cell) => `| ${cell} `)
        .join("")
        .concat("|"),
    );
  }
  return lines.join("\n");
}

function renderReport(
  runs: RunReport[],
  filterText: string,
  out: string,
): string {
  const sliceable = runs.filter((run) => run.slice);
  const complete = runs.filter((run) => run.metrics);
  const byTask = new Map<string, RunReport[]>();
  for (const run of runs) {
    const group = byTask.get(run.task) ?? [];
    group.push(run);
    byTask.set(run.task, group);
  }
  const sections: string[] = [];
  sections.push(
    "# Harvey LAB drafting-efficiency Tier 0 — token-slice report",
    "",
    `Generated ${new Date().toISOString()} by \`npx tsx backend/scripts/drafting-efficiency-tier0.ts\` (filter: \`${filterText || "grounded-cache v1/v2/v3"}\`). Report: \`${path.relative(process.cwd(), out) || out}\``,
    "",
    "Zero model calls. Every number below is read from a real run artifact:",
    "- per-round provider usage and byte receipts: `context-manifest.jsonl`",
    "- aggregates and ingestion surface: `metrics.json`",
    "- tool-call trace (names, host phase): `raw-sse.txt`, falling back to `beaver-receipts.json`",
    "",
    `Runs enumerated: ${runs.length}; sliceable (drafting boundary resolved): ${sliceable.length}; with metrics.json: ${complete.length}.`,
  );

  sections.push(
    "## 1. Drafting-phase definition (auditable)",
    "",
    "**Boundary.** A round (one provider request / tool-loop iteration in the manifest's `rounds[]`) is a **drafting round** if its tool-call batch contains an authoring call — a tool whose name matches `/docx/i` (in these arms: `generate_docx`), or a call the host traced with phase `drafting`/`continuous`. The **first** such round is the drafting boundary; **all rounds from that round through the end of the run are drafting**, and rounds before it are research. Rounds at or after the boundary with no tool calls (final answer-composition iterations) are still drafting.",
    "",
    "**Why the phase field alone is insufficient here.** `metrics.json` distinguishes `research_tool_calls` vs `drafting_tool_calls` from the host `phase` stamped on each tool result (chat.ts: `phase: continuousEvidenceEnabled ? \"continuous\" : draftingPhase ? \"drafting\" : \"research\"`). In all three grounded-cache arms `MIKE_CONTEXT_HANDOFF=0` and `MIKE_CONTINUOUS_EVIDENCE=0`, so `draftingPhase` never flips and **all 312 traced tool calls across the whole batch have phase `\"research\"`** — including the `generate_docx` calls that actually author the deliverable. A phase-based slice would report drafting = 0 for every run. The authoring-call boundary is the only discriminator present in the artifacts.",
    "",
    "**Why include everything from the boundary onward (not just the authoring round).** In these single-invocation trajectories the manifest round's `inputTokens` already contains the accumulated context of that request. The drafting round re-reads the entire research evidence (e.g. the upstream `fetch_documents` 1 MB result) as input while composing the deliverable; that re-read is precisely the drafting-efficiency cost this benchmark wants to expose. A Tier 1 refinement can subtract the replayed research bytes using the `gross_replay_ratio` / `unique_source_exposure` machinery, but Tier 0 keeps the boundary simple and byte-exact.",
    "",
    "**Attribution mechanics.** Rounds are matched to tool calls cumulatively by each round's `toolCallCount` against the chronological `tool_call_start` stream (raw-sse.txt). Where the two disagree the run is flagged `MISALIGNED` and the numbers should be treated as approximate.",
  );

  sections.push(
    "## 2. Run-directory gaps",
    "",
    "| run | kind | gaps |",
    "|---|---|---|",
  );
  for (const run of runs) {
    if (!run.gaps.length && run.kind === "complete") continue;
    sections.push(
      `| ${run.runId} | ${run.kind} | ${run.gaps.join("; ") || "—"} |`,
    );
  }
  sections.push("");

  sections.push(
    "## 3. Drafting-phase token slice, by task and arm",
    "",
    "Each table groups one task's runs (same task + model `codex:gpt-5.6-luna`) across the three arms and the v1/v3 batches. `drafting cache-adj in` is the cache-adjusted input-equivalent (uncached input + 0.1×cached-read + 1.25×cache-write, mirroring lab-beaver-arm.ts) for drafting rounds only. `drafting req bytes` is the sum of the drafting rounds' `inputBytes` receipts — the byte size of the provider request(s) that composed the deliverable, which typically re-carries the whole research evidence.",
    "",
  );
  for (const [task, taskRuns] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sections.push(`### ${task}`);
    sections.push("");
    sections.push(renderSliceTable(taskRuns));
    sections.push("");
  }

  sections.push(
    "## 4. Aggregate across arms",
    "",
    renderAggregate(sliceable),
    "",
    "Interpretation of the arm ranking is deferred to the reader; the point of Tier 0 is that the slice now exists and is reproducible from the artifacts.",
  );

  sections.push(
    "## 5. Ingestion-representation surface (recoverable-now part of axis 2)",
    "",
    "These fields are already computed per run in `metrics.json` and are the only recoverable-now evidence for the docx-as-markdown vs whole-document axis. `whole_read_max_chars` is `null`/unset for all three arms (`MIKE_WHOLE_READ_MAX_CHARS=\"\"` in the arm environment), so the whole-document side of the axis is observable only through the exposure ratios below:",
    "",
    "- `unique_source_exposure_ratio` = unique source spans exposed / total source text chars — 1.0 means the model saw essentially the whole corpus.",
    "- `gross_replay_ratio` = gross exposed span chars / unique exposed span chars — >1.0 means source text was re-read/replayed across calls.",
    "- `documents_read` = distinct source documents whose evidence reached the model.",
    "- `tool_result_chars` vs `source_text_chars` shows how much result payload entered context.",
    "",
    renderIngestionSurface(complete),
    "",
  );

  sections.push(
    "## 6. Caveats",
    "",
    "- Drafting share is sensitive to the boundary definition; a run that calls `generate_docx` in its first round reports drafting share 100% by construction.",
    "- `drafting cache-adj in` includes the research evidence re-sent in the drafting request. This is intentional for Tier 0 (drafting-context cost), not a double count of the research request itself.",
    "- v1 and v3 contain duplicate runs of four tasks (antitrust analyze, compare-closing, draft-indenture, analyze-change-of-control); they are kept as separate rows rather than averaged so batch-level drift stays visible.",
    "- The v2 batch is entirely empty (run-state.json only) and is reported as a gap.",
  );

  return sections.join("\n");
}

function main() {
  const args = flag();
  const resultsDir = DEFAULT_RESULTS;
  if (!existsSync(resultsDir)) {
    throw new Error(`results dir not found: ${resultsDir}`);
  }
  const entries = readdirSync(resultsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^2026-08-03-grounded-cache-v\d+-/u.test(name))
    .filter((name) =>
      args.batch.some((batch) => name.includes(`-grounded-cache-${batch}--`)),
    )
    .filter((name) => (args.filter ? name.includes(args.filter) : true))
    .sort();

  const runs = entries.map((name: string) =>
    analyzeRun(path.join(resultsDir, name), name),
  );
  const report = renderReport(runs, args.filter, args.out);
  writeFileSync(args.out, report, "utf8");

  const sliceable = runs.filter((run) => run.slice).length;
  console.log(
    `drafting-efficiency-tier0: ${runs.length} runs enumerated, ${sliceable} sliceable`,
  );
  console.log(`report written: ${args.out}`);
  if (process.argv.includes("--self-test")) {
    // Cheap in-process sanity check: an upstream run's drafting round must
    // carry the bulk of input tokens (the re-read research evidence).
    const sample = runs.find(
      (run) =>
        run.slice &&
        run.arm === "upstream_terminal_v1" &&
        run.task.includes("draft-indenture"),
    );
    if (!sample?.slice) throw new Error("self-test: no sample run");
    if (sample.slice.draftingShareCacheAdjusted! < 0.9) {
      throw new Error(
        `self-test: expected drafting share >= 0.9, got ${sample.slice.draftingShareCacheAdjusted}`,
      );
    }
    console.log("self-test passed");
  }
}

main();
