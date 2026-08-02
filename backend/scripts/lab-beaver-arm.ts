/**
 * Arm B driver for the Harvey LAB harness-comparison experiment
 * (benchmarks/lab/PROTOCOL.md). Drives Beaver's real /chat route in-process
 * (express + supertest — the same transport as scripts/eval-beaver-arm.ts)
 * on one LAB task: uploads the task documents through /single-documents,
 * plays the task instructions as a single chat turn, and writes LAB-layout
 * results (config.json / metrics.json / transcript.jsonl / output/) so
 * harvey-labs' evaluation.run_eval judges this run exactly like a
 * reference-harness run.
 *
 * Deviations, recorded in beaver-receipts.json per run:
 *  - Documents outside ALLOWED_DOCUMENT_TYPES are wrapped as .docx before
 *    upload — content unchanged, Beaver has no ingester for them. Email is
 *    NOT one of these: .eml uploads natively and is decoded by
 *    lib/emailText.ts, because wrapping a quoted-printable message verbatim
 *    splits numbers mid-digit and changes the facts the task is scored on.
 *  - Deliverables prefer documents Beaver authored itself via its
 *    library_create_docx tool (the latest doc_created/doc_edited version is
 *    downloaded through the real /single-documents API); when the turn
 *    creates none, the answer text is exported to the required filename
 *    (.docx via the docx package, .md/.txt verbatim). Tasks needing
 *    spreadsheet/slide deliverables are out of scope for this arm.
 *  - Token counts are context-manifest estimates (bytes/4), not API usage —
 *    the chat SSE stream does not report usage.
 *
 * Usage (spawns itself into the isolated anonymous-mode environment):
 *   npx tsx scripts/lab-beaver-arm.ts \
 *     --task trusts-estates-private-client/extract-client-intake-facts/scenario-01 \
 *     --arm p0 --model codex:gpt-5.6-luna --effort max \
 *     [--lab-root <dir>] [--run-id <id>]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWED_DOCUMENT_TYPES } from "../src/lib/documentTypes";
import {
  UPSTREAM_MIKE_COMMIT,
  UPSTREAM_MIKE_SCHEMA_SHA256,
} from "../src/lib/chat/upstreamMikeBenchmarkSurface";
import { latestAuthoredDocuments } from "./lab-authored-documents";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return value;
}

const DEFAULT_LAB_ROOT = path.join(__dirname, "../../benchmarks/harvey-labs");

// Derived from the real gate rather than mirrored by hand: a stale copy is
// how .eml ended up wrapped as .docx long after Beaver could read it.
// Images are excluded because they can't carry LAB document content.
const IMAGE_TYPES = new Set(["jpg", "jpeg", "png", "gif", "webp"]);
const UPLOADABLE = new Set(
  [...ALLOWED_DOCUMENT_TYPES].filter((type) => !IMAGE_TYPES.has(type)),
);

type SseEvent = { type?: string; [key: string]: unknown };

function sseEvents(body: string): SseEvent[] {
  return body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

const visibleText = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "content_delta")
    .map((event) => String(event.text ?? ""))
    .join("");

const toolCalls = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "tool_call_start")
    .map((event) => ({
      id: String(event.id ?? ""),
      name: String(event.name ?? ""),
      input:
        event.input && typeof event.input === "object" ? event.input : null,
    }));

const toolResults = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "tool_call_result")
    .map((event) => ({
      id: String(event.id ?? ""),
      name: String(event.name ?? ""),
      ok: event.ok !== false,
      error: typeof event.error === "string" ? event.error : null,
      content_chars: Number(event.content_chars ?? 0),
      content_sha256:
        typeof event.content_sha256 === "string" ? event.content_sha256 : null,
      content_preview:
        typeof event.content_preview === "string" ? event.content_preview : null,
      zero_yield: event.zero_yield === true,
      already_read: event.already_read === true,
      already_exposed: event.already_exposed === true,
      unique_source_chars: Number(event.unique_source_chars ?? 0),
      suppressed_source_chars: Number(event.suppressed_source_chars ?? 0),
      projection:
        typeof event.projection === "string" ? event.projection : null,
      evidence_spans: Array.isArray(event.evidence_spans)
        ? event.evidence_spans.flatMap((span) =>
            Array.isArray(span) &&
            span.length === 2 &&
            Number.isFinite(Number(span[0])) &&
            Number.isFinite(Number(span[1]))
              ? [[Number(span[0]), Number(span[1])] as [number, number]]
              : [],
          )
        : [],
      evidence_segments: Array.isArray(event.evidence_segments)
        ? event.evidence_segments.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const segment = raw as Record<string, unknown>;
            const documentId = String(segment.document_id ?? "");
            const versionId = String(segment.version_id ?? "");
            const start = Number(segment.start);
            const end = Number(segment.end);
            return documentId && Number.isFinite(start) && Number.isFinite(end)
              ? [{ documentId, versionId, start, end }]
              : [];
          })
        : [],
    }));

function exposureMetrics(
  calls: ReturnType<typeof toolCalls>,
  results: ReturnType<typeof toolResults>,
  sourceAliases: ReadonlyMap<string, string>,
) {
  const byCall = new Map(calls.map((call) => [call.id, call]));
  const byDocument = new Map<string, Array<[number, number]>>();
  const sourceIds = new Set(sourceAliases.values());
  const exposedDocumentIds = new Set<string>();
  let gross = 0;
  for (const result of results) {
    const call = byCall.get(result.id);
    const input = (call?.input ?? {}) as Record<string, unknown>;
    const document = [
      input.file_path,
      input.path,
      input.document_id,
      input.doc_id,
    ].find((value): value is string => typeof value === "string" && !!value);
    for (const segment of result.evidence_segments) {
      if (!sourceIds.has(segment.documentId)) continue;
      exposedDocumentIds.add(segment.documentId);
      const start = Math.max(0, Math.trunc(Math.min(segment.start, segment.end)));
      const end = Math.max(start, Math.trunc(Math.max(segment.start, segment.end)));
      if (end === start) continue;
      gross += end - start;
      const key = `${segment.documentId}:${segment.versionId}`;
      const spans = byDocument.get(key) ?? [];
      spans.push([start, end]);
      byDocument.set(key, spans);
    }
    if (!document || result.evidence_segments.length) continue;
    const sourceId = sourceAliases.get(document);
    if (!sourceId) continue;
    exposedDocumentIds.add(sourceId);
    const spans = byDocument.get(sourceId) ?? [];
    for (const [rawStart, rawEnd] of result.evidence_spans) {
      const start = Math.max(0, Math.trunc(Math.min(rawStart, rawEnd)));
      const end = Math.max(start, Math.trunc(Math.max(rawStart, rawEnd)));
      if (end === start) continue;
      gross += end - start;
      spans.push([start, end]);
    }
    if (spans.length) byDocument.set(sourceId, spans);
  }
  let unique = 0;
  for (const spans of byDocument.values()) {
    spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let [start, end] = spans[0];
    for (const [nextStart, nextEnd] of spans.slice(1)) {
      if (nextStart <= end) end = Math.max(end, nextEnd);
      else {
        unique += end - start;
        [start, end] = [nextStart, nextEnd];
      }
    }
    unique += end - start;
  }
  return {
    gross_source_span_chars: gross,
    unique_source_span_chars: unique,
    documents_exposed: exposedDocumentIds.size,
    exposed_document_ids: [...exposedDocumentIds],
    gross_replay_ratio: unique ? Math.round((gross / unique) * 10_000) / 10_000 : null,
  };
}

async function main() {
  const task = argument("task");
  const userId =
    process.env.ANONYMOUS_USER_ID ||
    "00000000-0000-0000-0000-000000000001";
  const arm = argument("arm", "address");
  const model = argument("model", "codex:gpt-5.6-luna");
  const effort = argument("effort", "max");
  const serviceTier = argument("service-tier", "");
  const retrievalPromptVariant = argument("retrieval-prompt", "neutral");
  if (!["neutral", "accuracy", "economy"].includes(retrievalPromptVariant)) {
    throw new Error("--retrieval-prompt must be neutral, accuracy, or economy");
  }
  const toolDescriptionVariant = argument("tool-description", "operational");
  if (!["operational", "terse"].includes(toolDescriptionVariant)) {
    throw new Error("--tool-description must be operational or terse");
  }
  const labRoot = argument("lab-root", DEFAULT_LAB_ROOT);
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/gu, "-")
    .slice(0, 19);
  const runId = argument(
    "run-id",
    `${task}/beaver-${arm}-${model.replace(/[:./]/gu, "-")}/${timestamp}`,
  );
  const armEnvironment: Record<string, Record<string, string>> = {
    p0: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
    },
    d1: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "d1-routed",
    },
    hybrid: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
    },
    working_set: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h5-working-set",
    },
    compiler_hybrid: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h5-working-set",
      MIKE_SLA_WORKFLOW: "1",
    },
    sla_hybrid: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h5-working-set",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
    },
    sla_working_set: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h5-working-set",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "working_set_first",
    },
    h9: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h9-accretive-union",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "working_set_first",
    },
    h10: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h9-accretive-union",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "working_set_first",
      MIKE_GREENFIELD_REVIEW: "1",
      MIKE_GREENFIELD_REVIEW_EFFORT: "low",
    },
    address: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "",
      MIKE_RETRIEVAL_EXPERIMENT: "",
    },
    upstream: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "upstream-mike",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
    },
  };
  if (!armEnvironment[arm])
    throw new Error(
      `unknown --arm ${arm}; expected p0, d1, hybrid, working_set, compiler_hybrid, sla_hybrid, sla_working_set, h9, h10, address, or upstream`,
    );

  // Re-spawn into the isolated anonymous-mode environment (same recipe as
  // scripts/eval-run.ts) so the in-process app binds to a fresh data home.
  if (!process.env.LAB_BEAVER_ARM_CHILD) {
    const dataHome = mkdtempSync(path.join(os.tmpdir(), "lab-beaver-arm-"));
    const child = spawnSync(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        __filename,
        ...process.argv.slice(2),
        "--run-id",
        runId,
      ],
      {
        env: {
          ...process.env,
          LAB_BEAVER_ARM_CHILD: "1",
          NODE_ENV: "",
          AUTH_MODE: "anonymous",
          OPEN_LEGAL_DATA_HOME: dataHome,
          MIKE_LOCAL_DATA_DIR: path.join(dataHome, "apps", "mike", "library"),
          SUPABASE_URL: "",
          SUPABASE_SECRET_KEY: "",
          // Parity with Arm A's sealed sandbox: no online research tools,
          // and no prompt sections describing them (see localAssistantTools).
          MIKE_DISABLE_RESEARCH_TOOLS: "1",
          // No user exists to answer ask_inputs in a benchmark run; the
          // reference harness has no ask-user affordance either.
          MIKE_DISABLE_ASK_INPUTS: "1",
          // Held constant across retrieval arms: same prompt hygiene and the
          // same resident/deferred authoring, review, and workflow domains.
          MIKE_PROGRESSIVE_DISCLOSURE: "1",
          MIKE_PROMPT_VARIANT: "lean",
          MIKE_RETRIEVAL_PROMPT_VARIANT: retrievalPromptVariant,
          MIKE_TOOL_DESCRIPTION_VARIANT: toolDescriptionVariant,
          MIKE_READ_DEFAULT_CHARS: "",
          MIKE_TOOL_RESULT_CAP: "",
          MIKE_BENCHMARK_TRACE_TOOLS: "1",
          ...armEnvironment[arm],
          MIKE_LLM_CONTEXT_MANIFEST_PATH: path.join(dataHome, "manifest.jsonl"),
          // SLA receipts land beside the run's other artifacts; inert
          // unless the parent also sets MIKE_SLA_WORKFLOW=1 (arm variant).
          MIKE_SLA_RECEIPT_PATH: path.join(
            labRoot,
            "results",
            runId,
            "sla-receipts.jsonl",
          ),
        },
        stdio: "inherit",
        // Whole-deliverable runs on claude-p run 45+ min (LAB's sonnet row
        // took 48); the cap is a runaway backstop, not a pace-setter.
        timeout: 180 * 60_000,
      },
    );
    process.exit(child.status ?? 1);
  }

  const taskDir = path.join(labRoot, "tasks", ...task.split("/"));
  const split = JSON.parse(
    readFileSync(path.join(labRoot, "..", "lab", "corpus-split.json"), "utf8"),
  ) as { tasks: { task: string; tier: string; sha256: string }[] };
  const splitEntry = split.tasks.find((entry) => entry.task === task);
  if (!splitEntry || splitEntry.tier !== "dev")
    throw new Error(`LAB task ${task} is not in the visible dev tier`);
  const config = JSON.parse(
    readFileSync(path.join(taskDir, "task.json"), "utf8"),
  ) as {
    title: string;
    instructions?: string;
    criteria: { deliverables?: string[] }[];
  };
  const instructions =
    config.instructions ??
    readFileSync(path.join(taskDir, "instructions.md"), "utf8");
  const docsDir = path.join(taskDir, "documents");
  const documents = readdirSync(docsDir, { recursive: true, encoding: "utf8" })
    .map((rel) => rel.replace(/\\/gu, "/"))
    .filter((rel) => !rel.endsWith("/"))
    .filter((rel) => existsSync(path.join(docsDir, rel)));

  const deliverables = [
    ...new Set(config.criteria.flatMap((c) => c.deliverables ?? [])),
  ];
  const unsupported = deliverables.filter(
    (name) => !/\.(docx|md|txt)$/iu.test(name),
  );
  if (unsupported.length)
    throw new Error(
      `deliverables out of scope for the beaver arm: ${unsupported.join(", ")}`,
    );

  if (process.env.MIKE_DISABLE_RESEARCH_TOOLS !== "1")
    throw new Error("expected MIKE_DISABLE_RESEARCH_TOOLS=1 (see parent env)");
  const { app } = await import("../src/app");
  const request = (await import("supertest")).default;
  const { Document, Packer, Paragraph, TextRun } = await import("docx");
  const textToDocx = (text: string) =>
    Packer.toBuffer(
      new Document({
        sections: [
          {
            children: text
              .split(/\r?\n/u)
              .map((line) => new Paragraph({ children: [new TextRun(line)] })),
          },
        ],
      }),
    );

  const started = Date.now();
  const wrappedUploads: string[] = [];
  const uploadedDocuments: { source: string; uploaded: string; id: string }[] = [];
  for (const rel of documents) {
    const bytes = readFileSync(path.join(docsDir, rel));
    const base = path.basename(rel);
    const extension = path.extname(base).slice(1).toLowerCase();
    let uploadName = base;
    let uploadBytes: Buffer = bytes;
    if (!UPLOADABLE.has(extension)) {
      uploadName = `${path.basename(base, path.extname(base))}.docx`;
      uploadBytes = await textToDocx(bytes.toString("utf8"));
      wrappedUploads.push(base);
    }
    const upload = await request(app)
      .post("/single-documents")
      .attach("file", uploadBytes, uploadName);
    if (upload.status !== 201)
      throw new Error(`upload ${base}: ${upload.status} ${upload.text}`);
    uploadedDocuments.push({
      source: rel,
      uploaded: uploadName,
      id: String(upload.body?.id ?? ""),
    });
  }

  const streamed = await request(app).post("/chat").send({
    model,
    reasoning_effort: effort,
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    expected_version: 0,
    current_turn: { kind: "message", content: instructions },
  });
  if (streamed.status !== 200)
    throw new Error(`/chat: ${streamed.status} ${streamed.text}`);
  const events = sseEvents(streamed.text);
  const answer = visibleText(events);
  const calls = toolCalls(events);
  const results = toolResults(events);
  const sourceAliases = new Map<string, string>();
  for (const document of uploadedDocuments) {
    sourceAliases.set(document.id, document.id);
    sourceAliases.set(document.source, document.id);
    sourceAliases.set(document.uploaded, document.id);
  }
  const exposure = exposureMetrics(calls, results, sourceAliases);
  const surface = events.find((event) => event.type === "benchmark_surface") ?? null;
  if (arm === "upstream") {
    const expectedTools = [
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "generate_docx",
    ];
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    if (
      surface?.upstream_mike_shape !== true ||
      surface?.progressive_disclosure !== false ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0
    ) {
      throw new Error(
        `upstream Mike isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}`,
      );
    }
  }
  const authored = latestAuthoredDocuments(events);
  const askPause = events.find((event) =>
    String(event.type ?? "").startsWith("ask_inputs"),
  );
  if (askPause)
    throw new Error(
      "Beaver paused for ask_inputs; the benchmark has no user to answer — run incomplete",
    );
  if (!answer.trim() && !authored.length)
    throw new Error("empty assistant answer and no documents authored");
  const wallClock = (Date.now() - started) / 1000;
  const { extractLocalDocument } = await import(
    "../src/lib/chat/localAssistantTools"
  );
  let sourceTextChars = 0;
  const sourceReceipts: Array<Record<string, unknown>> = [];
  for (const document of uploadedDocuments) {
    const extracted = await extractLocalDocument(userId, document.id);
    if (!extracted) continue;
    sourceTextChars += extracted.text.length;
    sourceReceipts.push({
      source: document.source,
      uploaded: document.uploaded,
      document_id: document.id,
      text_chars: extracted.text.length,
      text_sha256: createHash("sha256").update(extracted.text).digest("hex"),
      pages: extracted.pages.length,
      pages_sha256: createHash("sha256")
        .update(JSON.stringify(extracted.pages))
        .digest("hex"),
      table_cells: extracted.tableCells.length,
      table_cells_sha256: createHash("sha256")
        .update(JSON.stringify(extracted.tableCells))
        .digest("hex"),
    });
  }

  const runDir = path.join(labRoot, "results", ...runId.split("/"));
  const outputDir = path.join(runDir, "output");
  mkdirSync(outputDir, { recursive: true });

  // Save every document Beaver authored under its own filename; LAB's
  // evaluator resolves expected deliverables against actual files with the
  // same exact/extension/fuzzy matching reference-harness runs get. Answer
  // text is synthesized only for a deliverable whose extension class Beaver
  // created nothing for.
  const deliverableSources: Record<string, string> = {};
  const saved: string[] = [];
  for (const doc of authored) {
    const download = await request(app)
      .get(doc.downloadUrl)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    if (download.status !== 200)
      throw new Error(`download ${doc.filename}: ${download.status}`);
    let name = doc.filename;
    for (let n = 2; saved.includes(name); n += 1) {
      const extension = path.extname(doc.filename);
      name = `${path.basename(doc.filename, extension)}-${n}${extension}`;
    }
    writeFileSync(path.join(outputDir, name), download.body as Buffer);
    saved.push(name);
    deliverableSources[name] = "library";
  }
  for (const name of deliverables) {
    if (saved.includes(name)) continue;
    const extension = path.extname(name).toLowerCase();
    if (saved.some((f) => path.extname(f).toLowerCase() === extension)) continue;
    const target = path.join(outputDir, name);
    if (/\.docx$/iu.test(name)) writeFileSync(target, await textToDocx(answer));
    else writeFileSync(target, answer, "utf8");
    deliverableSources[name] = "answer_text";
  }

  // Real usage from the context-manifest receipts (each streamChatWithTools
  // call appends one entry with provider-reported usage); the byte-based
  // inputEstimate is the fallback for entries that died before usage.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let tokenSource = "context_manifest_usage";
  const reportedServiceTiers = new Set<string>();
  const contextRounds: Array<Record<string, unknown>> = [];
  const manifestPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH ?? "";
  if (manifestPath && existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        provider?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadInputTokens?: number | null;
          cacheWriteInputTokens?: number | null;
        } | null;
        inputEstimate?: { tokens?: number };
        serviceTierRequested?: string | null;
        serviceTierReported?: string | null;
        rounds?: Array<Record<string, unknown>>;
      };
      if (entry.usage?.inputTokens != null) {
        const cacheRead = entry.usage.cacheReadInputTokens ?? 0;
        const cacheWrite = entry.usage.cacheWriteInputTokens ?? 0;
        // OpenAI Responses reports cached input as a subset of input_tokens.
        // Claude Code reports cache reads/writes separately, and the LAB
        // reference adapter adds them to its input total.
        inputTokens +=
          entry.usage.inputTokens +
          (entry.provider === "claude-p" ? cacheRead + cacheWrite : 0);
        cacheReadInputTokens += cacheRead;
        cacheWriteInputTokens += cacheWrite;
        outputTokens += entry.usage.outputTokens ?? 0;
      } else {
        inputTokens += entry.inputEstimate?.tokens ?? 0;
        tokenSource = "context_manifest_mixed_estimate";
      }
      if (entry.serviceTierReported)
        reportedServiceTiers.add(entry.serviceTierReported);
      contextRounds.push(...(entry.rounds ?? []));
    }
  }
  if (serviceTier) {
    const expectedTier =
      serviceTier.trim().toLowerCase() === "fast"
        ? "priority"
        : serviceTier.trim().toLowerCase();
    if (!reportedServiceTiers.has(expectedTier)) {
      throw new Error(
        `requested service tier ${serviceTier}, but provider did not report ${expectedTier}`,
      );
    }
  }

  writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify(
      {
        model,
        arm,
        task,
        task_sha256: splitEntry.sha256,
        run_id: runId,
        harness: "beaver-chat",
        reasoning_effort: effort,
        service_tier_requested: serviceTier || null,
        service_tiers_reported: [...reportedServiceTiers],
        prompt_variant: arm === "upstream" ? "upstream-pinned" : "lean",
        retrieval_prompt_variant: retrievalPromptVariant,
        tool_description_variant: toolDescriptionVariant,
        progressive_disclosure: arm !== "upstream",
        upstream_mike_commit: arm === "upstream" ? UPSTREAM_MIKE_COMMIT : null,
        upstream_mike_schema_sha256:
          arm === "upstream" ? UPSTREAM_MIKE_SCHEMA_SHA256 : null,
        upstream_mike_isolation_verified: arm === "upstream" ? true : null,
        max_turns: 1,
        started_at: new Date(started).toISOString(),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "metrics.json"),
    JSON.stringify(
      {
        model,
        arm,
        task,
        run_id: runId,
        turn_count: 1,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_write_input_tokens: cacheWriteInputTokens,
        token_source: tokenSource,
        service_tier_requested: serviceTier || null,
        service_tiers_reported: [...reportedServiceTiers],
        wall_clock_seconds: Math.round(wallClock * 100) / 100,
        finished_cleanly: true,
        completed_at: new Date().toISOString(),
        documents_ingested: documents.length,
        documents_read_directly: new Set(
          calls.flatMap((call) => {
            const input = (call.input ?? {}) as Record<string, unknown>;
            const values = [
              input.file_path,
              input.path,
              input.document_id,
              input.doc_id,
              ...(Array.isArray(input.doc_ids) ? input.doc_ids : []),
            ].filter((value): value is string => typeof value === "string");
            return uploadedDocuments
              .filter((doc) =>
                values.some(
                  (value) =>
                    value === doc.id ||
                    value === doc.uploaded ||
                    value === doc.source,
                ),
              )
              .map((doc) => doc.source);
          }),
        ).size,
        // A working-set Read is a real read of every source represented by
        // its evidence segments. Keep direct path opens separately instead
        // of under-reporting multi-document retrieval as 1 virtual file.
        documents_read: exposure.documents_exposed,
        documents_read_list: uploadedDocuments
          .filter((document) =>
            exposure.exposed_document_ids.includes(document.id),
          )
          .map((document) => document.source),
        documents_exposed: exposure.documents_exposed,
        total_documents: documents.length,
        source_text_chars: sourceTextChars,
        failed_tool_calls: results.filter((result) => !result.ok).length,
        zero_yield_tool_calls: results.filter((result) => result.zero_yield).length,
        tool_call_count: calls.length,
        tool_result_chars: results.reduce(
          (total, result) => total + result.content_chars,
          0,
        ),
        duplicate_read_calls: results.filter((result) => result.already_read)
          .length,
        duplicate_exposure_calls: results.filter(
          (result) => result.already_exposed,
        ).length,
        context_round_count: contextRounds.length,
        context_rounds: contextRounds,
        context_tool_schema_variants: new Set(
          contextRounds.map((round) => String(round.toolSha256 ?? "")),
        ).size,
        context_tool_argument_bytes: contextRounds.reduce(
          (total, round) => total + Number(round.toolArgumentBytes ?? 0),
          0,
        ),
        context_tool_result_bytes: contextRounds.reduce(
          (total, round) => total + Number(round.toolResultBytes ?? 0),
          0,
        ),
        unique_source_chars: results.reduce(
          (total, result) => total + result.unique_source_chars,
          0,
        ),
        suppressed_source_chars: results.reduce(
          (total, result) => total + result.suppressed_source_chars,
          0,
        ),
        ...exposure,
        unique_source_exposure_ratio:
          sourceTextChars && exposure.unique_source_span_chars
            ? Math.round(
                (exposure.unique_source_span_chars / sourceTextChars) * 10_000,
              ) / 10_000
            : null,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      turn: 1,
      role: "assistant",
      text: answer.slice(0, 500),
      tool_calls: calls.length ? calls : null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    })}\n`,
  );
  writeFileSync(
    path.join(runDir, "beaver-receipts.json"),
    JSON.stringify(
      {
        answer,
        tool_calls: calls,
        tool_results: results,
        surface,
        uploaded_documents: uploadedDocuments,
        source_receipts: sourceReceipts,
        context_rounds: contextRounds,
        wrapped_uploads: wrappedUploads,
        deliverables,
        docs_created: authored.map((doc) => doc.filename),
        deliverable_sources: deliverableSources,
        research_tools_disabled: true,
        upstream_mike_commit: arm === "upstream" ? UPSTREAM_MIKE_COMMIT : null,
        upstream_mike_schema_sha256:
          arm === "upstream" ? UPSTREAM_MIKE_SCHEMA_SHA256 : null,
        service_tier_requested: serviceTier || null,
        service_tiers_reported: [...reportedServiceTiers],
        deviations: {
          uploads_wrapped_as_docx: wrappedUploads,
        },
      },
      null,
      2,
    ),
  );

  console.log(`beaver arm complete: ${runId}`);
  console.log(
    `  tool calls: ${calls.map((call) => call.name).join(", ") || "(none)"}`,
  );
  console.log(`  answer chars: ${answer.length}, ~${outputTokens} tokens out`);
  console.log(`  results: ${runDir}`);
  process.exit(0);
}

main().catch((error) => {
  console.error("[lab-beaver-arm]", error);
  process.exit(1);
});
