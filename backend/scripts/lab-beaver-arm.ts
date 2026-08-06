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
 *  - Token counts use provider-reported context-manifest usage when present;
 *    entries that fail before usage fall back to the manifest estimate.
 *
 * Usage (spawns itself into the isolated anonymous-mode environment):
 *   npx tsx scripts/lab-beaver-arm.ts \
 *     --task trusts-estates-private-client/extract-client-intake-facts/scenario-01 \
 *     --arm p0 --model gpt-5.6-luna --effort max \
 *     [--lab-root <dir>] [--run-id <id>] [--office-pdf eager|lazy]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWED_DOCUMENT_TYPES } from "../src/lib/documentTypes";
import {
  ADAPTIVE_MIKE_DELTA,
  CODING_MARKDOWN_DELTA,
  CODING_MARKDOWN_LAB_SYSTEM_PROMPT,
  CODING_MARKDOWN_V2_DELTA,
  CODING_MARKDOWN_V2_LAB_TOOLS,
  CODING_NEUTRAL_PROMPT_DELTA,
  CODING_PARITY_DELTA,
  COMPACT_AUTHOR_MIKE_DELTA,
  COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT,
  COMPACT_AUTHOR_MIKE_LAB_TOOLS,
  GROUNDED_STRUCTURE_LAB_SYSTEM_PROMPT,
  GROUNDED_STRUCTURE_OUTLINE_DELTA,
  GROUNDED_STRUCTURE_OUTLINE_LAB_SYSTEM_PROMPT,
  LEAN_BATCH_DELTA,
  LEAN_BATCH_HARDREFS_DELTA,
  LEAN_BATCH_LAB_SYSTEM_PROMPT,
  LEAN_BATCH_LAB_TOOLS,
  MARKDOWN_E2E_DELTA,
  MARKDOWN_E2E_FLOOR_DELTA,
  MARKDOWN_E2E_FLOOR_LAB_SYSTEM_PROMPT,
  MARKDOWN_E2E_INDEX_DELTA,
  MARKDOWN_E2E_INDEX_FLOOR_DELTA,
  MARKDOWN_E2E_INDEX_FLOOR_LAB_SYSTEM_PROMPT,
  MARKDOWN_E2E_INDEX_LAB_SYSTEM_PROMPT,
  MARKDOWN_INDEX_LAB_TOOLS,
  MARKDOWN_SWAP_DELTA,
  MIKE_GREP_LAB_SYSTEM_PROMPT,
  MIKE_GREP_LAB_TOOLS,
  MIKE_GREP_DELTAS,
  MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT,
  MIKE_STRUCTURE_PATHS_LAB_TOOLS,
  UPSTREAM_MIKE_COMMIT,
  UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
  UPSTREAM_MIKE_LAB_TOOLS,
  UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS,
  UPSTREAM_MIKE_SCHEMA_SHA256,
  UPSTREAM_MIKE_SOURCE_BLOBS,
  UPSTREAM_NATIVE_DELTA,
  UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT,
  UPSTREAM_NATIVE_MIKE_LAB_TOOLS,
  UPSTREAM_NATIVE_MIKE_LAB_TOOL_NAMES,
  UPSTREAM_TERMINAL_DELTA,
  CITATION_CONTRACT_DELTA,
  CITATION_CONTRACT_V2_DELTA,
  MARKDOWN_E2E_TREATMENT_DELTA,
  MARKDOWN_E2E_TREATMENT_V2_DELTA,
  MARKDOWN_E2E_INDEX_TREATMENT_DELTA,
  MARKDOWN_E2E_INDEX_TREATMENT_V2_DELTA,
  EXPOSURE_ECHO_DELTA,
  MARKDOWN_E2E_TREATMENT_LAB_SYSTEM_PROMPT,
  MARKDOWN_E2E_TREATMENT_V2_LAB_SYSTEM_PROMPT,
  MARKDOWN_E2E_INDEX_TREATMENT_V1_LAB_SYSTEM_PROMPT,
  MARKDOWN_E2E_TREATMENT_LAB_TOOLS,
  MARKDOWN_INDEX_TREATMENT_LAB_TOOLS,
  NO_DEFERRAL_DELTA,
  REQUIREMENTS_ECHO_DELTA,
} from "../src/lib/chat/upstreamMikeBenchmarkSurface";
import { latestAuthoredDocuments } from "./lab-authored-documents";
import { STRUCTURE_INDEX_ENABLED } from "../src/lib/chat/structureIndexExperiment";
import type { OpenAIToolSchema } from "../src/lib/llm";

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

// Set once the run directory exists so the top-level failure handler can
// record a typed terminal status (context_overflow / quota_exhausted / failed)
// instead of leaving a permanent provider_call_pending stub.
let activeRunDir: string | null = null;

// The expected LAB surface per arm: the system prompt the server must have
// served and the tool schema it must have exposed. Shared by --preflight-only
// and the post-run conformance gate so a prompt-wiring failure is a hard error,
// never a silent fallback (the SECT-INDEX arm ran its whole first wave on the
// upstream prompt because only the preflight referenced its prompt const).
function armExpectedSurface(
  arm: string,
): { systemPrompt: string; tools: OpenAIToolSchema[] } | null {
  return arm === "mike_upstream_native_v1"
    ? {
        systemPrompt: UPSTREAM_NATIVE_MIKE_LAB_SYSTEM_PROMPT,
        tools: UPSTREAM_NATIVE_MIKE_LAB_TOOLS,
      }
    : // TREATMENT: the e2e chassis plus both mechanisms. The prompt is composed
      // by the SAME helper chat.ts serves through
      // (MARKDOWN_E2E_TREATMENT_LAB_SYSTEM_PROMPT is
      // withLabTreatmentPromptAdditions(e2e prompt, both on)), so the prompt-sha
      // gate is satisfied by construction rather than by a parallel transcription.
    arm === "mike_markdown_e2e_treatment_v1"
    ? {
        systemPrompt: MARKDOWN_E2E_TREATMENT_LAB_SYSTEM_PROMPT,
        tools: MARKDOWN_E2E_TREATMENT_LAB_TOOLS,
      }
    : // TREATMENT v2: floor base + echo + amended grounding contract, same
      // helper-composed prompt const, same tool list as v1 (no new tools).
    arm === "mike_markdown_e2e_treatment_v2"
    ? {
        systemPrompt: MARKDOWN_E2E_TREATMENT_V2_LAB_SYSTEM_PROMPT,
        tools: MARKDOWN_E2E_TREATMENT_LAB_TOOLS,
      }
    : ["upstream", "upstream_terminal_v1"].includes(arm)
    ? {
        systemPrompt: UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
        tools: UPSTREAM_MIKE_LAB_TOOLS,
      }
    : ["mike_markdown_swap_v1", "mike_markdown_e2e_v1"].includes(arm)
      ? {
          systemPrompt: UPSTREAM_MIKE_LAB_SYSTEM_PROMPT,
          tools: UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS,
        }
      : arm === "mike_markdown_e2e_index_v1"
        ? {
            systemPrompt: MARKDOWN_E2E_INDEX_LAB_SYSTEM_PROMPT,
            tools: MARKDOWN_INDEX_LAB_TOOLS,
          }
        : arm === "mike_markdown_e2e_floor_v1"
          ? {
              systemPrompt: MARKDOWN_E2E_FLOOR_LAB_SYSTEM_PROMPT,
              tools: UPSTREAM_MIKE_MARKDOWN_SWAP_LAB_TOOLS,
            }
        : arm === "mike_markdown_e2e_index_floor_v1"
          ? {
              systemPrompt: MARKDOWN_E2E_INDEX_FLOOR_LAB_SYSTEM_PROMPT,
              tools: MARKDOWN_INDEX_LAB_TOOLS,
            }
        : // INDEX TREATMENT: the scoped-index floor chassis plus the echo,
          // amended grounding contract, and no-deferral mechanisms. Prompt and
          // tools composed by the same helpers chat.ts serves through.
          // v2 adds exposure accounting (tool payloads only), so it serves the
          // SAME prompt and tool list — the sha gate expects equality.
        arm === "mike_markdown_e2e_index_treatment_v1" ||
          arm === "mike_markdown_e2e_index_treatment_v2"
          ? {
              systemPrompt: MARKDOWN_E2E_INDEX_TREATMENT_V1_LAB_SYSTEM_PROMPT,
              tools: MARKDOWN_INDEX_TREATMENT_LAB_TOOLS,
            }
        : arm === "mike_compact_author_v1"
          ? {
              systemPrompt: COMPACT_AUTHOR_MIKE_LAB_SYSTEM_PROMPT,
              tools: COMPACT_AUTHOR_MIKE_LAB_TOOLS,
            }
          : ["lean_batch_v1", "lean_batch_hardrefs_v1"].includes(arm)
            ? {
                systemPrompt: LEAN_BATCH_LAB_SYSTEM_PROMPT,
                tools: LEAN_BATCH_LAB_TOOLS,
              }
          : // CODING-MARKDOWN: the lean-batch tool surface verbatim, with the
            // navigation-neutral prompt (prompt is the only tool-facing
            // difference; the markdown plane changes served text, not schema).
          arm === "coding_markdown_v1"
            ? {
                systemPrompt: CODING_MARKDOWN_LAB_SYSTEM_PROMPT,
                tools: LEAN_BATCH_LAB_TOOLS,
              }
          : // CODING-MARKDOWN v2 (parity pack): same neutral prompt over the
            // Claude-Code-shaped tool surface.
          arm === "coding_markdown_v2"
            ? {
                systemPrompt: CODING_MARKDOWN_LAB_SYSTEM_PROMPT,
                tools: CODING_MARKDOWN_V2_LAB_TOOLS,
              }
            : arm === "mike_grep_v1"
              ? {
                  systemPrompt: MIKE_GREP_LAB_SYSTEM_PROMPT,
                  tools: MIKE_GREP_LAB_TOOLS,
                }
              : [
                    "mike_structure_paths_v1",
                    "grounded_structure_v1",
                    "grounded_structure_outline_v1",
                  ].includes(arm)
                ? {
                    systemPrompt:
                      arm === "grounded_structure_outline_v1"
                        ? GROUNDED_STRUCTURE_OUTLINE_LAB_SYSTEM_PROMPT
                        : arm === "grounded_structure_v1"
                          ? GROUNDED_STRUCTURE_LAB_SYSTEM_PROMPT
                          : MIKE_STRUCTURE_PATHS_LAB_SYSTEM_PROMPT,
                    tools: MIKE_STRUCTURE_PATHS_LAB_TOOLS,
                  }
                : null;
}

// Byte-identical reproduction of the AVAILABLE DOCUMENTS block chat.ts appends
// to the LAB system prompt (routes/chat.ts ~1185): doc index order follows the
// upload order, which is the sorted documents[] order here.
//
// Two shapes, because the Beaver LAB block and upstream's own block differ.
// The Beaver block (all arms except mike_upstream_native_v1) has no --- fences,
// appends a (file_type) suffix upstream never emits, and omits the read-once
// trailer entirely. The native block reproduces
// 2266446b:backend/src/lib/chat/contextBuilders.ts:143-153 exactly. The earlier
// version of this comment claimed byte-identity with upstream; that was true of
// chat.ts and this function relative to each other, never of upstream.
function inventoryPromptFor(documents: string[], arm?: string): string {
  if (arm === "mike_upstream_native_v1") {
    return (
      "\n\n---\nAVAILABLE DOCUMENTS:\n" +
      documents
        .map(
          (relative, index) => `- doc-${index}: ${path.basename(relative)}\n`,
        )
        .join("") +
      "\nYou do NOT retain document content between conversation turns. You MUST call read_document (or fetch_documents) once at the start of every response that involves a document's content, even if you have read it in a previous turn. Within the same response, do not call read_document or fetch_documents again for a document/version that has already been read; use the prior tool result, find_in_document for targeted checks, or proceed to the next required tool. Failure to read once per turn will result in hallucinated or stale content.\n---\n"
    );
  }
  return (
    "\n\nAVAILABLE DOCUMENTS:\n" +
    documents
      .map((relative, index) => {
        const filename = path.basename(relative);
        const fileType = path.extname(filename).slice(1).toLowerCase();
        return `- doc-${index}: ${filename} (${fileType})`;
      })
      .join("\n") +
    "\n"
  );
}

type SourceBundleEntry = {
  source: string;
  source_sha256: string;
  uploaded: string;
  uploaded_sha256: string;
};

const ordinalCompare = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const sourceBundleSha256 = (entries: SourceBundleEntry[]) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...entries].sort((left, right) =>
          ordinalCompare(left.source, right.source),
        ),
      ),
    )
    .digest("hex");

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

const visibleText = (events: SseEvent[]) => {
  let text = "";
  for (const event of events) {
    if (event.type === "content_reset") text = "";
    else if (event.type === "content_delta") text += String(event.text ?? "");
    else if (event.type === "content_final") text = String(event.text ?? text);
  }
  return text;
};

const toolCalls = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "tool_call_start")
    .map((event) => ({
      id: String(event.id ?? ""),
      name: String(event.name ?? ""),
      phase: typeof event.phase === "string" ? event.phase : null,
      input:
        event.input && typeof event.input === "object" ? event.input : null,
    }));

const toolResults = (events: SseEvent[]) =>
  events
    .filter((event) => event.type === "tool_call_result")
    .map((event) => ({
      id: String(event.id ?? ""),
      name: String(event.name ?? ""),
      phase: typeof event.phase === "string" ? event.phase : null,
      ok: event.ok !== false,
      status: typeof event.status === "string" ? event.status : null,
      error: typeof event.error === "string" ? event.error : null,
      checkpoint_gate:
        typeof event.checkpoint_gate === "string"
          ? event.checkpoint_gate
          : null,
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
      union_unique_source_chars: Number(
        event.union_unique_source_chars ?? 0,
      ),
      union_suppressed_source_chars: Number(
        event.union_suppressed_source_chars ?? 0,
      ),
      reviewed_union_reuse_source_chars: Number(
        event.reviewed_union_reuse_source_chars ?? 0,
      ),
      retrieval_hints: Array.isArray(event.retrieval_hints)
        ? event.retrieval_hints.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const hint = raw as Record<string, unknown>;
            const offset = Number(hint.offset);
            const limit = Number(hint.limit);
            return hint.kind === "literal_reference" &&
              typeof hint.label === "string" &&
              typeof hint.path === "string" &&
              Number.isInteger(offset) &&
              Number.isInteger(limit)
              ? [
                  {
                    kind: "literal_reference" as const,
                    label: hint.label,
                    path: hint.path,
                    offset,
                    limit,
                  },
                ]
              : [];
          })
        : [],
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
              ? [
                  {
                    documentId,
                    versionId,
                    start,
                    end,
                    filename:
                      typeof segment.filename === "string"
                        ? segment.filename
                        : null,
                    locator:
                      typeof segment.locator === "string"
                        ? segment.locator
                        : null,
                    projection:
                      typeof segment.projection === "string"
                        ? segment.projection
                        : null,
                    kind:
                      segment.kind === "candidate" ||
                      segment.kind === "evidence"
                        ? segment.kind
                        : null,
                    virtualPath:
                      typeof segment.virtual_path === "string"
                        ? segment.virtual_path
                        : null,
                  },
                ]
              : [];
          })
        : [],
      evidence_refs: Array.isArray(event.evidence_refs)
        ? event.evidence_refs.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const ref = raw as Record<string, unknown>;
            const handle = String(ref.handle ?? "");
            const exactSha256 = String(ref.exact_sha256 ?? "");
            const chars = Number(ref.chars);
            return handle && exactSha256 && Number.isFinite(chars)
              ? [
                  {
                    handle,
                    exactSha256,
                    chars,
                    filename: String(ref.filename ?? handle),
                    locator:
                      typeof ref.locator === "string" ? ref.locator : null,
                  },
                ]
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
  const candidateDocumentIds = new Set<string>();
  const uniqueRefs = new Map<string, number>();
  let gross = 0;
  let candidateChars = 0;
  let grossRefChars = 0;
  for (const result of results) {
    const call = byCall.get(result.id);
    const input = (call?.input ?? {}) as Record<string, unknown>;
    const document = [
      input.file_path,
      input.path,
      input.document_id,
      input.doc_id,
    ].find((value): value is string => typeof value === "string" && !!value);
    for (const ref of result.evidence_refs) {
      grossRefChars += ref.chars;
      uniqueRefs.set(`${ref.handle}:${ref.exactSha256}`, ref.chars);
    }
    for (const segment of result.evidence_segments) {
      if (!sourceIds.has(segment.documentId)) continue;
      const start = Math.max(0, Math.trunc(Math.min(segment.start, segment.end)));
      const end = Math.max(start, Math.trunc(Math.max(segment.start, segment.end)));
      // Zero-length segments deliver no source text and must not mark the
      // document exposed (a (0,0) segment once counted a doc as "read").
      if (end === start) continue;
      // Candidates (grep/find hits, inventory opening lines) are pointers,
      // not delivered coverage: counting them as exposure saturated
      // documents_read the moment list_documents ran and let a single grep
      // line mark a document "read" (2026-08-06 coding-arm audit F1/F10).
      // They are tracked separately so selection behavior stays measurable.
      if (segment.kind === "candidate") {
        candidateDocumentIds.add(segment.documentId);
        candidateChars += end - start;
        continue;
      }
      exposedDocumentIds.add(segment.documentId);
      gross += end - start;
      const key = `${segment.documentId}:${segment.versionId}`;
      const spans = byDocument.get(key) ?? [];
      spans.push([start, end]);
      byDocument.set(key, spans);
    }
    if (!document || result.evidence_segments.length) continue;
    const sourceId = sourceAliases.get(document);
    if (!sourceId) continue;
    const spans = byDocument.get(sourceId) ?? [];
    for (const [rawStart, rawEnd] of result.evidence_spans) {
      const start = Math.max(0, Math.trunc(Math.min(rawStart, rawEnd)));
      const end = Math.max(start, Math.trunc(Math.max(rawStart, rawEnd)));
      if (end === start) continue;
      exposedDocumentIds.add(sourceId);
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
    // Docs the model only POINTED at (grep/find hits, inventory lines)
    // without any delivered body coverage — the selection-behavior signal.
    documents_candidate_only: [...candidateDocumentIds].filter(
      (id) => !exposedDocumentIds.has(id),
    ).length,
    candidate_span_chars: candidateChars,
    gross_replay_ratio: unique ? Math.round((gross / unique) * 10_000) / 10_000 : null,
    gross_evidence_ref_chars: grossRefChars,
    unique_evidence_ref_chars: [...uniqueRefs.values()].reduce(
      (total, chars) => total + chars,
      0,
    ),
    unique_evidence_refs: uniqueRefs.size,
  };
}

async function main() {
  const task = argument("task");
  const userId =
    process.env.ANONYMOUS_USER_ID ||
    "00000000-0000-0000-0000-000000000001";
  const arm = argument("arm", "address");
  const model = argument("model", "gpt-5.6-luna");
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
  const officePdfRendition = argument("office-pdf", "eager");
  if (!["eager", "lazy"].includes(officePdfRendition)) {
    throw new Error("--office-pdf must be eager or lazy");
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
  const preflightOnly = process.argv.includes("--preflight-only");
  const continuousCodingEnvironment = {
    MIKE_NAV_SHAPE: "address",
    MIKE_TOOL_SHAPE: "coding",
    MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
    MIKE_MODEL_COVERAGE_ROUTING: "1",
    MIKE_WHOLE_READ_MAX_CHARS: "800000",
    MIKE_TOOL_RESULT_CAP: "51200",
    MIKE_TOOL_DESCRIPTION_VARIANT: "terse",
    MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
    MIKE_CONTEXT_HANDOFF: "0",
    MIKE_CONTINUOUS_EVIDENCE: "0",
    MIKE_SLA_WORKFLOW: "0",
    MIKE_GREENFIELD_REVIEW: "0",
  };
  const armEnvironment: Record<string, Record<string, string>> = {
    p0: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
    },
    coding_finalist: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "120000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "120000",
      MIKE_GREENFIELD_REVIEW: "0",
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
    hybrid_finalist: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "120000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "120000",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    coverage_finalist: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      // The model chooses complete, targeted, or mixed coverage after Glob.
      // There is no request regex, task metadata, domain router, or source-size
      // threshold in this arm.
      MIKE_MODEL_COVERAGE_ROUTING: "1",
      MIKE_CONTEXT_HANDOFF: "1",
      // Accuracy gate first: a fresh drafting context may retain roughly
      // 200k tokens of exact source text before selection is required.
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "800000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    coverage_hybrid_v2: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      // One request-independent surface: the model sees truthful extracted
      // sizes and chooses whole, targeted, or mixed coverage itself.
      MIKE_MODEL_COVERAGE_ROUTING: "1",
      MIKE_WHOLE_READ_MAX_CHARS: "800000",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "800000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    checkpoint_paged_v1: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      MIKE_MODEL_COVERAGE_ROUTING: "1",
      MIKE_WHOLE_READ_MAX_CHARS: "800000",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_DRAFT_HANDOFF_MODE: "paged",
      MIKE_RESEARCH_CHECKPOINT_MAX_CHARS: "12000",
      MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS: "24000",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "800000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    v13: {
      ...continuousCodingEnvironment,
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
    },
    v14: {
      ...continuousCodingEnvironment,
      // Match Codex's default 90% auto-compaction point for Luna's
      // provider-advertised 272k raw context window.
      MIKE_OPENAI_COMPACT_THRESHOLD: "244800",
    },
    v15: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      // Stable core surface: bounded file tools and direct authoring. No
      // whole-document batch transport or model-facing memory layer.
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_TOOL_RESULT_CAP: "51200",
      MIKE_TOOL_DESCRIPTION_VARIANT: "terse",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
      MIKE_RESIDENT_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    coverage_soft_v2: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      // Minimal ablation: truthful source sizes plus model judgment. No host
      // whole-read cutoff or selection response.
      MIKE_MODEL_COVERAGE_ROUTING: "1",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "800000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
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
      MIKE_GREENFIELD_REVIEW: "0",
    },
    h10: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h9-accretive-union",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "working_set_first",
      // The fresh-context reviewer was a failed side experiment: it added
      // quality on two tasks only by triggering an expensive correction pass.
      // Keep its code behind an explicit flag, but do not ship it in the core
      // benchmark arm.
      MIKE_GREENFIELD_REVIEW: "0",
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
    upstream_terminal_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "upstream-mike",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
    },
    // The full pinned upstream chat surface at 2266446b, project composition,
    // research tools off. One flag selects prompt + tools + inventory shape +
    // native tool-result envelopes + maxIterations=10; everything else is
    // switched OFF so no Beaver-side affordance leaks into the baseline.
    // MIKE_TERMINAL_AUTHORING=0 because native has no terminal exit
    // (claude.ts:239-241 breaks only when the model stops calling tools);
    // MIKE_DISABLE_ASK_INPUTS=0 because ask_inputs is a native tool and its
    // turn-terminating behaviour is measured, not suppressed.
    mike_upstream_native_v1: {
      MIKE_UPSTREAM_NATIVE: "1",
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "0",
      MIKE_READ_DOCX_MARKDOWN: "0",
      MIKE_STRUCTURE_INDEX: "0",
      MIKE_COMPLETENESS_FLOOR: "0",
      MIKE_DISABLE_ASK_INPUTS: "0",
      MIKE_TOOL_RESULT_CAP: "",
    },
    mike_markdown_swap_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-swap-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
    },
    mike_markdown_e2e_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
    },
    // TREATMENT arm: byte-for-byte the e2e env above plus the two mechanism
    // flags, so any measured difference is attributable to the mechanisms and
    // nothing else. The completeness floor deliberately stays OFF — the
    // requirements echo supersedes it; the floor returns later as an ablation
    // if the echo underperforms it.
    mike_markdown_e2e_treatment_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_REQUIREMENTS_ECHO: "1",
      MIKE_CITATION_CONTRACT: "1",
    },
    // TREATMENT v2: the v1 chassis with the completeness floor RESTORED
    // (showdown forensics falsified "echo supersedes floor": the floor
    // recovered 7 of v1's 11 banking/employment criterion losses) and the
    // citation contract replaced by its amended v2. Three mechanism flags,
    // each independently gated; run at effort HIGH per the 2026-08-06
    // effort policy.
    mike_markdown_e2e_treatment_v2: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_REQUIREMENTS_ECHO: "1",
      MIKE_CITATION_CONTRACT_V2: "1",
      MIKE_COMPLETENESS_FLOOR: "1",
    },
    // SILO'D experiment: e2e + a derived SECT-INDEX prepended to each docx
    // read, plus an orient-first prompt. Deletes cleanly (see
    // structureIndexExperiment.ts).
    mike_markdown_e2e_index_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_STRUCTURE_INDEX: "1",
      // No MIKE_DEEPSEEK_MAX_TOKENS override: the 65536 lift was an
      // uncontrolled second delta vs every other arm (triple audit D2).
    },
    // Read-scope x write-discipline 2x2, write-discipline cells: the e2e and
    // index arms plus the LEAN_BATCH completeness clause appended to the
    // prompt (MIKE_COMPLETENESS_FLOOR). ONE delta vs their parent arms.
    mike_markdown_e2e_floor_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_COMPLETENESS_FLOOR: "1",
    },
    mike_markdown_e2e_index_floor_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_STRUCTURE_INDEX: "1",
      MIKE_COMPLETENESS_FLOOR: "1",
    },
    // INDEX TREATMENT: index_floor chassis + echo + contract v2 + no-deferral.
    // Motivated by the 2026-08-06 CoC pilot: 6/14 misses were explicit
    // "recommend further review" deferrals of unread addressable sections.
    mike_markdown_e2e_index_treatment_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_STRUCTURE_INDEX: "1",
      MIKE_INDEX_ATTACH_GATED: "1",
      MIKE_FIND_QUERY_NORM: "1",
      MIKE_TYPED_RANGE: "1",
      MIKE_INDEX_COMPACT_HEADINGS: "1",
      MIKE_COMPLETENESS_FLOOR: "1",
      MIKE_REQUIREMENTS_ECHO: "1",
      MIKE_CITATION_CONTRACT_V2: "1",
      MIKE_NO_DEFERRAL: "1",
      MIKE_SCOPED_REREAD: "1",
    },
    // INDEX TREATMENT v2: v1 + exposure accounting. The echo's read/unread
    // split counts BODY EXPOSURE instead of tool touches (index-only
    // orientation gets a documents_oriented_only bucket) and the first
    // authoring call is refused once while unexposed documents remain.
    // Motivated by the 2026-08-06 Phase D sweep: acq-diligence 30/64 with
    // 12/31 documents index-only at draft time (echo said "2 unread"), tax
    // 39/77 with 14/25 unexposed (echo said "0 unread"), three-plus rounds
    // of budget unused in both. Same prompt + tool list as v1.
    mike_markdown_e2e_index_treatment_v2: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-markdown-e2e-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_STRUCTURE_INDEX: "1",
      MIKE_INDEX_ATTACH_GATED: "1",
      MIKE_FIND_QUERY_NORM: "1",
      MIKE_TYPED_RANGE: "1",
      MIKE_INDEX_COMPACT_HEADINGS: "1",
      MIKE_COMPLETENESS_FLOOR: "1",
      MIKE_REQUIREMENTS_ECHO: "1",
      MIKE_CITATION_CONTRACT_V2: "1",
      MIKE_NO_DEFERRAL: "1",
      MIKE_SCOPED_REREAD: "1",
      MIKE_EXPOSURE_ECHO: "1",
    },
    // Reverse swap: markdown READ (Pandoc drafting-source) + UPSTREAM Mike
    // drafting (sections[] shape). Completes the 2x2 read/write matrix:
    //   control          = upstream read  + upstream sections[] draft
    //   mike_markdown_swap_v1 = upstream read + markdown draft
    //   mike_markdown_e2e_v1  = markdown read + markdown draft
    //   THIS arm               = markdown read + upstream sections[] draft
    mike_markdown_read_upstream_draft_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "upstream-mike",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_READ_DOCX_MARKDOWN: "1",
    },
    mike_compact_author_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-compact-author-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    lean_batch_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "lean-batch-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      // Match Codex's 90% auto-compaction point for Luna's 272k context.
      MIKE_OPENAI_COMPACT_THRESHOLD: "244800",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    // CODING-MARKDOWN (pure-coding hypothesis, Eli 2026-08-06): the frozen
    // lean-batch chassis — the coding-native tool surface the models were
    // RL'd on — over the pandoc-markdown drafting plane, with the SOURCE
    // WORK navigation prescriptions removed from the prompt. Motivated by
    // the v2 exposure-forcing null (acq 26/64, tax 42/77; pooled ~0 vs v1
    // at +30-50% input): breadth forcing reshuffles criteria under a fixed
    // synthesis budget, so the live lever is evidence-driven SELECTION.
    // Run 1 is observational — no navigation guidance, watch the pathways.
    coding_markdown_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "lean-batch-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "244800",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_CODING_NEUTRAL_PROMPT: "1",
    },
    // CODING-MARKDOWN v2 (parity pack; adversarial audit 2026-08-06): v1 +
    // MIKE_CODING_PARITY. Serves the CC-shaped surface (Glob, single
    // file_path Read always cat -n, Grep with -A/-B and files_with_matches
    // default, CC efficiency cues in the descriptions) and the executor
    // parity behaviors (regex fallback, minima guard). Same neutral prompt.
    coding_markdown_v2: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "lean-batch-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "244800",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
      MIKE_READ_DOCX_MARKDOWN: "1",
      MIKE_CODING_NEUTRAL_PROMPT: "1",
      MIKE_CODING_PARITY: "1",
    },
    lean_batch_hardrefs_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "lean-batch-hardrefs-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "0",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "244800",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    adaptive_mike_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "adaptive-mike-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    mike_grep_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-grep-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "p0-pure-coding",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    mike_legal_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-legal-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    mike_legal_guided_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-legal-guided-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    mike_structure_paths_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-structure-paths-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "s1-structure-paths",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    grounded_structure_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-structure-paths-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "s1-structure-paths",
      MIKE_GROUNDING_FIRST: "1",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    grounded_structure_outline_v1: {
      MIKE_NAV_SHAPE: "legacy",
      MIKE_TOOL_SHAPE: "mike-structure-paths-v1",
      MIKE_RETRIEVAL_EXPERIMENT: "s1-structure-paths",
      MIKE_GROUNDING_FIRST: "1",
      // H7: inject the compact outline + top-K cross-ref summary into the
      // system context once; no new tools, no multi-turn churn.
      MIKE_GROUNDED_OUTLINE_INJECTION: "1",
      MIKE_PROGRESSIVE_DISCLOSURE: "0",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_TOOL_RESULT_CAP: "64000",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_TERMINAL_AUTHORING: "1",
      MIKE_CONTEXT_HANDOFF: "0",
      MIKE_CONTINUOUS_EVIDENCE: "0",
      MIKE_OPENAI_COMPACT_THRESHOLD: "",
      MIKE_SLA_WORKFLOW: "0",
      MIKE_GREENFIELD_REVIEW: "0",
    },
    v5_reconstruction_v1: {
      MIKE_NAV_SHAPE: "address",
      MIKE_TOOL_SHAPE: "coding",
      MIKE_RETRIEVAL_EXPERIMENT: "h4-legal-grep",
      MIKE_PROGRESSIVE_DISCLOSURE: "1",
      MIKE_MODEL_COVERAGE_ROUTING: "0",
      MIKE_WHOLE_READ_MAX_CHARS: "",
      MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
      MIKE_CONTEXT_HANDOFF: "1",
      MIKE_RESEARCH_CONTEXT_REFRESH: "0",
      MIKE_FULL_HANDOFF_PROMPT_VARIANT: "legacy-v5",
      MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "120000",
      MIKE_OPENAI_COMPACT_THRESHOLD: "120000",
      MIKE_SLA_WORKFLOW: "1",
      MIKE_SLA_STRATEGY: "full",
      MIKE_GREENFIELD_REVIEW: "0",
    },
  };
  if (!armEnvironment[arm])
    throw new Error(
      `unknown --arm ${arm}; expected a registered LAB arm, including upstream_terminal_v1, mike_upstream_native_v1, mike_markdown_e2e_treatment_v1, mike_markdown_e2e_treatment_v2, mike_markdown_swap_v1, mike_markdown_e2e_v1, mike_markdown_e2e_index_v1, mike_markdown_e2e_floor_v1, mike_markdown_e2e_index_floor_v1, mike_markdown_e2e_index_treatment_v1, mike_markdown_e2e_index_treatment_v2, mike_markdown_read_upstream_draft_v1, mike_compact_author_v1, lean_batch_v1, lean_batch_hardrefs_v1, coding_markdown_v1, coding_markdown_v2, or grounded_structure_outline_v1`,
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
          // Fail closed against ambient experiment flags. Each arm below
          // opts in explicitly, so upstream Mike cannot inherit Beaver-only
          // context or compiler behavior from the invoking shell.
          MIKE_CONTEXT_HANDOFF: "0",
          MIKE_RESEARCH_CONTEXT_REFRESH: "1",
          MIKE_FULL_HANDOFF_PROMPT_VARIANT: "current",
          MIKE_CONTINUOUS_EVIDENCE: "0",
          MIKE_DRAFT_HANDOFF_MODE: "full",
          MIKE_RESEARCH_CHECKPOINT_MAX_CHARS: "",
          MIKE_DRAFT_HOT_EVIDENCE_MAX_CHARS: "",
          MIKE_EVIDENCE_PAGE_MAX_CHARS: "",
          MIKE_MODEL_COVERAGE_ROUTING: "0",
          MIKE_WHOLE_READ_MAX_CHARS: "",
          MIKE_SUPPRESS_DUPLICATE_WHOLE_READS: "1",
          MIKE_RESIDENT_AUTHORING: "0",
          MIKE_TERMINAL_AUTHORING: "0",
          MIKE_EVIDENCE_HANDOFF_MAX_CHARS: "",
          MIKE_OPENAI_COMPACT_THRESHOLD: "",
          MIKE_SLA_WORKFLOW: "0",
          MIKE_SLA_STRATEGY: "",
          MIKE_GREENFIELD_REVIEW: "0",
          MIKE_GROUNDING_FIRST: "0",
          MIKE_GROUNDED_OUTLINE_INJECTION: "0",
          MIKE_SCHEMA_ENCODING: "",
          // Fail closed on the treatment/serving mechanisms too (2026-08-06
          // adversarial audit F8): every one of these is an explicit per-arm
          // opt-in below, and an ambient value would silently change a frozen
          // arm's prompt or serving plane — the citation-contract blocks are
          // prompt-only and leave no tool-list trace, and a leaked
          // STRUCTURE_INDEX turns lean-family unbounded Reads into
          // scoped_read_required dead-ends naming tools those arms not serve.
          MIKE_STRUCTURE_INDEX: "",
          MIKE_INDEX_ATTACH_GATED: "",
          MIKE_FIND_QUERY_NORM: "",
          MIKE_TYPED_RANGE: "",
          MIKE_INDEX_COMPACT_HEADINGS: "",
          MIKE_COMPLETENESS_FLOOR: "",
          MIKE_REQUIREMENTS_ECHO: "",
          MIKE_CITATION_CONTRACT: "",
          MIKE_CITATION_CONTRACT_V2: "",
          MIKE_NO_DEFERRAL: "",
          MIKE_SCOPED_REREAD: "",
          MIKE_EXPOSURE_ECHO: "",
          MIKE_READ_DOCX_MARKDOWN: "",
          MIKE_CODING_NEUTRAL_PROMPT: "",
          // Compute-only ablation. It does not change tool schemas, prompts,
          // or extracted text; a PDF is still created on the first paged read.
          MIKE_EAGER_OFFICE_PDF_RENDITION:
            officePdfRendition === "lazy" ? "0" : "1",
          ...armEnvironment[arm],
          // Lane-level transport setting, not an experimental variable: the
          // stateless claude-p mode spawns a fresh CLI process per tool round
          // and re-uploads the ENTIRE conversation each time. The persistent
          // session sends only the new tool results to a live process; a dead
          // session recovers statelessly with a full replay, and our arms'
          // fixed tool schemas never trigger the session-killing condition.
          // contextRounds receipts record continuation: "provider" vs "none",
          // so the transport mode stays visible per round.
          ...(model.startsWith("claude-p:")
            ? { MIKE_CLAUDE_P_PERSIST: "1" }
            : {}),
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

  // Capture the executed source before app import or any model call. The
  // prelaunch registration separately binds these hashes to the committed
  // tree, so a run cannot silently fingerprint post-run edits.
  const harnessSourceFiles = [
    "scripts/lab-beaver-arm.ts",
    "scripts/lab-authored-documents.ts",
    "src/routes/chat.ts",
    "src/lib/documentTypes.ts",
    "src/lib/chat/evidenceExposure.ts",
    "src/lib/chat/localAssistantTools.ts",
    "src/lib/chat/labOutlineInjection.ts",
    "src/lib/chat/upstreamMikeBenchmarkSurface.ts",
    "src/lib/chat/upstreamNativeDocxRenderer.ts",
    "src/lib/chat/prompts.ts",
    "src/lib/chat/slaWorkflow.ts",
    "src/lib/legalCrossReference.ts",
    "src/lib/legalDocumentNavigator.ts",
    "src/lib/legalStructureSidecar.ts",
    "src/lib/legalTextSkeleton.ts",
    "src/lib/localDocumentStore.ts",
    "src/lib/localPdfLookup.ts",
    "src/lib/llm/codex.ts",
    "src/lib/llm/codexToolBridge.ts",
    "src/lib/llm/contextManifest.ts",
    "src/lib/llm/openai.ts",
    "src/lib/llm/schemaEncoding.ts",
    "src/lib/llm/types.ts",
  ];
  const harnessSourceFingerprints = Object.fromEntries(
    harnessSourceFiles.map((relative) => {
      const bytes = readFileSync(path.join(__dirname, "..", relative));
      return [relative, createHash("sha256").update(bytes).digest("hex")];
    }),
  );

  const taskDir = path.join(labRoot, "tasks", ...task.split("/"));
  const split = JSON.parse(
    readFileSync(path.join(labRoot, "..", "lab", "corpus-split.json"), "utf8"),
  ) as {
    tasks: {
      task: string;
      tier: string;
      sha256: string;
      scenarios?: string[];
    }[];
  };
  const splitEntry = split.tasks.find((entry) => {
    if (entry.task === task) return true;
    const scenario = task.slice(entry.task.length + 1);
    return (
      task.startsWith(`${entry.task}/`) &&
      !scenario.includes("/") &&
      entry.scenarios?.includes(scenario)
    );
  });
  if (!splitEntry || splitEntry.tier !== "dev")
    throw new Error(`LAB task ${task} is not in the visible dev tier`);
  const taskConfigText = readFileSync(
    path.join(taskDir, "task.json"),
    "utf8",
  );
  const taskConfigSha256 = createHash("sha256")
    .update(taskConfigText)
    .digest("hex");
  const config = JSON.parse(taskConfigText) as {
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
    .filter((rel) => {
      const sourcePath = path.join(docsDir, rel);
      return existsSync(sourcePath) && statSync(sourcePath).isFile();
    })
    .sort(ordinalCompare);

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

  if (preflightOnly) {
    const unsupportedSources = documents.filter(
      (relative) =>
        !UPLOADABLE.has(path.extname(relative).slice(1).toLowerCase()),
    );
    if (unsupportedSources.length) {
      throw new Error(
        `preflight cannot reproduce wrapped upload bytes: ${unsupportedSources.join(", ")}`,
      );
    }
    let sourceBytes = 0;
    const sourceEntries = documents.map((relative): SourceBundleEntry => {
      const bytes = readFileSync(path.join(docsDir, relative));
      sourceBytes += bytes.length;
      const digest = createHash("sha256").update(bytes).digest("hex");
      return {
        source: relative,
        source_sha256: digest,
        uploaded: path.basename(relative),
        uploaded_sha256: digest,
      };
    });
    const surface = armExpectedSurface(arm);
    if (!surface) {
      throw new Error(`--preflight-only is not registered for arm ${arm}`);
    }
    const inventoryPrompt = inventoryPromptFor(documents, arm);
    const { toResponseTools } = await import("../src/lib/llm/openai");
    const responseTools = toResponseTools(surface.tools);
    console.log(
      JSON.stringify({
        task,
        split_sha256: splitEntry.sha256,
        task_config_sha256: taskConfigSha256,
        instructions_sha256: createHash("sha256")
          .update(instructions)
          .digest("hex"),
        source_bundle_sha256: sourceBundleSha256(sourceEntries),
        source_count: sourceEntries.length,
        source_bytes: sourceBytes,
        arm,
        system_prompt_sha256: createHash("sha256")
          .update(surface.systemPrompt + inventoryPrompt)
          .digest("hex"),
        tool_schema_sha256: createHash("sha256")
          .update(JSON.stringify(responseTools))
          .digest("hex"),
        tool_names: responseTools.map((tool) => tool.name),
      }),
    );
    process.exit(0);
  }

  if (process.env.MIKE_DISABLE_RESEARCH_TOOLS !== "1")
    throw new Error("expected MIKE_DISABLE_RESEARCH_TOOLS=1 (see parent env)");
  const runDir = path.join(labRoot, "results", ...runId.split("/"));
  activeRunDir = runDir;
  mkdirSync(path.dirname(runDir), { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`refusing to reuse existing run directory: ${runDir}`);
    }
    throw error;
  }
  writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(
      {
        status: "initializing",
        task,
        arm,
        run_id: runId,
        task_sha256: splitEntry.sha256,
        task_config_sha256: taskConfigSha256,
        instructions_sha256: createHash("sha256")
          .update(instructions)
          .digest("hex"),
        harness_source_fingerprints: harnessSourceFingerprints,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
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
  const uploadedDocuments: Array<{
    source: string;
    uploaded: string;
    id: string;
    source_bytes: number;
    source_sha256: string;
    uploaded_bytes: number;
    uploaded_sha256: string;
  }> = [];
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
      source_bytes: bytes.length,
      source_sha256: createHash("sha256").update(bytes).digest("hex"),
      uploaded_bytes: uploadBytes.length,
      uploaded_sha256: createHash("sha256")
        .update(uploadBytes)
        .digest("hex"),
    });
  }

  writeFileSync(
    path.join(runDir, "run-state.json"),
    JSON.stringify(
      {
        status: "provider_call_pending",
        task,
        arm,
        run_id: runId,
        task_sha256: splitEntry.sha256,
        task_config_sha256: taskConfigSha256,
        instructions_sha256: createHash("sha256")
          .update(instructions)
          .digest("hex"),
        source_bundle_sha256: sourceBundleSha256(
          uploadedDocuments.map((document) => ({
            source: document.source,
            source_sha256: document.source_sha256,
            uploaded: document.uploaded,
            uploaded_sha256: document.uploaded_sha256,
          })),
        ),
        uploaded_documents: uploadedDocuments,
        harness_source_fingerprints: harnessSourceFingerprints,
        provider_service_tier_requested: serviceTier || null,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const streamed = await request(app).post("/chat").send({
    model,
    reasoning_effort: effort,
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    expected_version: 0,
    current_turn: { kind: "message", content: instructions },
  });
  writeFileSync(path.join(runDir, "raw-sse.txt"), streamed.text ?? "");
  const liveManifestPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH ?? "";
  if (liveManifestPath && existsSync(liveManifestPath)) {
    writeFileSync(
      path.join(runDir, "context-manifest.jsonl"),
      readFileSync(liveManifestPath),
    );
  }
  if (streamed.status !== 200)
    throw new Error(`/chat: ${streamed.status} ${streamed.text}`);
  const events = sseEvents(streamed.text);
  // A provider failure ends the SSE stream with a typed error event (the
  // route logs and swallows the exception). Rethrow it HERE, before any
  // conformance gate, so main()'s catch can classify it (context_overflow /
  // quota_exhausted) instead of a downstream gate masking it with an
  // untyped "0 deliverables" or "no echo" error.
  const providerError = events.find((event) => event.type === "error");
  if (providerError) {
    throw new Error(String(providerError.message ?? "provider error"));
  }
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
  const hardReferenceHints = [
    ...new Map(
      results
        .flatMap((result) => result.retrieval_hints)
        .map((hint) => [
          `${hint.path}:${hint.offset}:${hint.limit}`,
          hint,
        ] as const),
    ).values(),
  ];
  const followedHardReferenceHints = hardReferenceHints.filter((hint) =>
    calls.some((call) => {
      if (call.name !== "Read") return false;
      const input = (call.input ?? {}) as Record<string, unknown>;
      const paths = Array.isArray(input.paths) ? input.paths : [];
      return (
        paths.length === 1 &&
        paths[0] === hint.path &&
        Number(input.offset) === hint.offset &&
        Number(input.limit) === hint.limit
      );
    }),
  );
  const evidenceHandoffs = events.filter(
    (event) => event.type === "evidence_handoff",
  );
  const evidenceHandoff = evidenceHandoffs.at(-1) ?? null;
  const evidenceWorkingSetReceipts = events.filter(
    (event) => event.type === "evidence_working_set_receipt",
  );
  const evidenceWorkingSetUpdates = events.filter(
    (event) => event.type === "evidence_working_set_update",
  );
  const evidenceWorkingSetReceipt = evidenceWorkingSetReceipts.at(-1) ?? null;
  const contentResets = events.filter((event) => event.type === "content_reset");
  // Native ask_inputs terminates the turn with no tool_result and no
  // deliverable (2266446b:streaming.ts:484-486). Recorded as a first-class
  // outcome so the rate is reported rather than folded into "failed".
  const turnTerminations = events.filter(
    (event) => event.type === "benchmark_turn_termination",
  );
  const askInputsTerminated = turnTerminations.some(
    (event) => event.reason === "ask_inputs_terminated",
  );
  // TREATMENT mechanism 1 outcome receipt (chat.ts emits it after the turn, so
  // the counts are real rather than config echoes).
  const requirementsEchoReceipt =
    events.filter((event) => event.type === "benchmark_requirements_echo").at(-1) ??
    null;
  const echoCallCount = Number(requirementsEchoReceipt?.echo_call_count ?? 0);
  const documentsUnreadAtEcho =
    requirementsEchoReceipt?.documents_unread_at_echo ?? null;
  const documentsOrientedOnlyAtEcho =
    requirementsEchoReceipt?.documents_oriented_only_at_echo ?? null;
  // A native ask_inputs termination is a FIRST-CLASS measured outcome, not a
  // harness failure: upstream ends the turn on ask_inputs with no tool_result
  // and therefore no deliverable (2266446b:streaming.ts:484-486, and
  // toolDispatcher.ts:620-624 pushes no result). Three guards below would
  // otherwise throw before the metrics object that carries
  // ask_inputs_terminated / turn_termination_reason is written, so the rate
  // this instrumentation exists to report could never be reported and the cell
  // would be indistinguishable from a genuine failure.
  //
  // Only mike_upstream_native_v1 can reach this: it is the sole arm with
  // MIKE_DISABLE_ASK_INPUTS="0", and the benchmark_turn_termination receipt is
  // emitted only under UPSTREAM_NATIVE_MIKE_SHAPE. For every other arm this is
  // constantly false, so `!false && <original>` is the original predicate and
  // their fail-loud behaviour is byte-for-byte unchanged. A native run that
  // paused for ask_inputs WITHOUT emitting the receipt still throws — that
  // would mean the instrumentation itself broke, which must stay loud.
  const askInputsNoDeliverable =
    arm === "mike_upstream_native_v1" && askInputsTerminated;
  const researchContextRefreshes = events.filter(
    (event) => event.type === "research_context_refresh",
  );
  const researchCheckpointRequests = events.filter(
    (event) => event.type === "research_checkpoint_request",
  );
  const researchCheckpoints = events.filter(
    (event) => event.type === "research_checkpoint",
  );
  const initialResearchCheckpoints = researchCheckpoints.filter(
    (event) => event.resume_mode === "research",
  );
  const researchCheckpointFailures = events.filter(
    (event) => event.type === "research_checkpoint_failed",
  );
  const checkpointHandoffAudit: Array<{
    handoff_index: number;
    reviewed_checkpoint_sha256: string | null;
    handoff_checkpoint_sha256: string | null;
    matches: boolean;
  }> = [];
  let latestReviewedCheckpointSha256: string | null = null;
  for (const event of events) {
    if (
      event.type === "research_checkpoint" &&
      typeof event.brief_sha256 === "string"
    ) {
      latestReviewedCheckpointSha256 = event.brief_sha256;
    }
    if (event.type !== "evidence_handoff") continue;
    const handoffCheckpointSha256 =
      typeof event.checkpoint_sha256 === "string"
        ? event.checkpoint_sha256
        : null;
    checkpointHandoffAudit.push({
      handoff_index: checkpointHandoffAudit.length + 1,
      reviewed_checkpoint_sha256: latestReviewedCheckpointSha256,
      handoff_checkpoint_sha256: handoffCheckpointSha256,
      matches:
        latestReviewedCheckpointSha256 !== null &&
        latestReviewedCheckpointSha256 === handoffCheckpointSha256,
    });
  }
  const checkpointHandoffMismatches = checkpointHandoffAudit.filter(
    (receipt) => !receipt.matches,
  );
  if (arm === "mike_upstream_native_v1") {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    // The served prompt must be the arm's registered prompt, byte-for-byte —
    // the same check the markdown family gets below, and the reason the
    // SECT-INDEX arm's first wave silently ran on the wrong prompt.
    const nativeSurface = armExpectedSurface(arm);
    const nativePromptSha = nativeSurface
      ? createHash("sha256")
          .update(
            nativeSurface.systemPrompt + inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (
      nativePromptSha &&
      surface?.system_prompt_sha256 !== nativePromptSha
    ) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${nativePromptSha}`,
      );
    }
    if (
      surface?.upstream_native_shape !== true ||
      Number(surface?.max_iterations ?? 0) !== 10 ||
      surface?.upstream_mike_shape !== false ||
      surface?.adaptive_mike_shape !== false ||
      surface?.compact_author_mike_shape !== false ||
      surface?.markdown_swap_shape !== false ||
      surface?.markdown_e2e_shape !== false ||
      surface?.markdown_read_docx !== false ||
      surface?.structure_index !== false ||
      surface?.completeness_floor !== false ||
      surface?.lean_batch_shape !== false ||
      surface?.lean_batch_hardrefs_shape !== false ||
      surface?.mike_grep_shape !== false ||
      surface?.mike_legal_shape !== false ||
      surface?.mike_legal_guided_shape !== false ||
      surface?.mike_structure_paths_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      // The runtime tool-result cap the receipts actually carry. Upstream has
      // no cap at all (2266446b:documentOps.ts:1567 returns bare text), and
      // every native envelope bypasses Beaver's truncator by returning through
      // upstreamMikeResult rather than result() — the sole exception,
      // generate_docx, tops out near 1.2 KB. So this is an ISOLATION assertion,
      // not a fidelity one: it pins the value an env leak would move. Note
      // MIKE_TOOL_RESULT_CAP="" resolves to 64000, NOT 0 ("" is falsy, so the
      // `|| 64_000` default wins); asserting the real number here is what makes
      // that visible instead of implied.
      Number(surface?.tool_result_max_chars ?? 0) !== 64_000 ||
      // Further axes the receipt carries that an env leak could move. Each
      // value was measured under the arm's own merged environment before being
      // asserted here (.tmp-native-gate-probe.ts), not assumed.
      surface?.navigation_shape !== "legacy" ||
      (surface?.retrieval_experiment ?? null) !== null ||
      surface?.tool_description_variant !== "operational" ||
      surface?.resident_authoring !== false ||
      surface?.grounded_outline_injection !== false ||
      surface?.suppress_duplicate_whole_reads !== true ||
      // Native has no terminal-authoring exit: the turn ends only when the
      // model stops calling tools (2266446b:claude.ts:239-241).
      surface?.terminal_authoring !== false ||
      JSON.stringify(residentTools) !==
        JSON.stringify(UPSTREAM_NATIVE_MIKE_LAB_TOOL_NAMES) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      // Accepting an ask_inputs event emits exactly one content_reset
      // (chat.ts:2501, inside acceptPendingAskInputs) before the native turn
      // aborts. That reset belongs to the native ask_inputs path itself, not to
      // any Beaver context-reset affordance, so on a terminated run one is
      // expected and must not read as isolation leakage — while a second one,
      // or any reset at all on a normal run, still fails.
      contentResets.length > (askInputsNoDeliverable ? 1 : 0)
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; native=${String(surface?.upstream_native_shape)}; max_iterations=${String(surface?.max_iterations)}; terminal=${String(surface?.terminal_authoring)}; content_resets=${contentResets.length}; ask_inputs_terminated=${String(askInputsTerminated)}`,
      );
    }
  }
  if (["upstream", "upstream_terminal_v1"].includes(arm)) {
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
    const expectedTerminal = arm === "upstream_terminal_v1";
    if (
      surface?.upstream_mike_shape !== true ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== expectedTerminal ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
  }
  if (arm === "adaptive_mike_v1") {
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
      surface?.adaptive_mike_shape !== true ||
      surface?.upstream_mike_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0
    ) {
      throw new Error(
        `adaptive Mike isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; handoff=${String(surface?.context_handoff)}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
  }
  if (arm === "mike_compact_author_v1") {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const expectedTools = [
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "generate_docx",
    ];
    if (
      surface?.compact_author_mike_shape !== true ||
      surface?.upstream_mike_shape !== false ||
      surface?.adaptive_mike_shape !== false ||
      surface?.coding_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      Number(surface?.tool_result_max_chars ?? 0) !== 64_000 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `compact-author isolation failed: resident=${residentTools.join(",")}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
  }
  if (
    [
      "mike_markdown_swap_v1",
      "mike_markdown_e2e_v1",
      "mike_markdown_e2e_index_v1",
      "mike_markdown_e2e_floor_v1",
      "mike_markdown_e2e_index_floor_v1",
    ].includes(arm)
  ) {
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
    const markdownE2e = arm !== "mike_markdown_swap_v1";
    const markdownSwap = arm === "mike_markdown_swap_v1";
    const structureIndex =
      arm === "mike_markdown_e2e_index_v1" ||
      arm === "mike_markdown_e2e_index_floor_v1";
    const completenessFloor =
      arm === "mike_markdown_e2e_floor_v1" ||
      arm === "mike_markdown_e2e_index_floor_v1";
    // The served prompt must be the arm's registered prompt, byte-for-byte.
    // The SECT-INDEX arm's first wave ran entirely on the upstream prompt
    // because only --preflight-only ever referenced its prompt const; this
    // gate makes that class of miswiring a hard failure.
    const expectedSurface = armExpectedSurface(arm);
    const expectedPromptSha = expectedSurface
      ? createHash("sha256")
          .update(
            expectedSurface.systemPrompt + inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (expectedPromptSha && surface?.system_prompt_sha256 !== expectedPromptSha) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${expectedPromptSha}`,
      );
    }
    if (
      surface?.markdown_swap_shape !== markdownSwap ||
      surface?.markdown_e2e_shape !== markdownE2e ||
      surface?.markdown_read_docx !== markdownE2e ||
      surface?.structure_index !== structureIndex ||
      // Attachment gating, find recovery, typed range, compact headings, and
      // the scoped-reread clause swap are the index-treatment arm's
      // mechanisms; the frozen index arms must keep serving byte-for-byte.
      surface?.index_attach_gated !== false ||
      surface?.find_query_norm !== false ||
      surface?.typed_range !== false ||
      surface?.index_compact_headings !== false ||
      surface?.scoped_reread !== false ||
      surface?.completeness_floor !== completenessFloor ||
      surface?.upstream_mike_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
  }
  // TREATMENT arm. Deliberately its OWN block rather than a member of the
  // markdown family above: its resident list carries one extra tool and two
  // extra receipt flags must be true, so folding it in would have forced the
  // e2e arms' assertions to become conditional — the exact loosening this gate
  // exists to prevent.
  if (arm === "mike_markdown_e2e_treatment_v1") {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const expectedTools = MARKDOWN_E2E_TREATMENT_LAB_TOOLS.map(
      (tool) => tool.function.name,
    );
    const expectedSurface = armExpectedSurface(arm);
    const expectedPromptSha = expectedSurface
      ? createHash("sha256")
          .update(
            expectedSurface.systemPrompt + inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (expectedPromptSha && surface?.system_prompt_sha256 !== expectedPromptSha) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${expectedPromptSha}`,
      );
    }
    if (
      // the two mechanisms under test
      surface?.requirements_echo !== true ||
      surface?.citation_contract !== true ||
      // frozen arm: exposure accounting must stay off
      surface?.exposure_echo !== false ||
      // …on an otherwise byte-identical e2e chassis
      surface?.markdown_e2e_shape !== true ||
      surface?.markdown_read_docx !== true ||
      surface?.markdown_swap_shape !== false ||
      surface?.structure_index !== false ||
      surface?.completeness_floor !== false ||
      surface?.upstream_mike_shape !== false ||
      surface?.upstream_native_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; echo=${String(surface?.requirements_echo)}; citation=${String(surface?.citation_contract)}; e2e=${String(surface?.markdown_e2e_shape)}; floor=${String(surface?.completeness_floor)}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
    // The mechanism must actually have run: the prompt instructs one echo, and
    // the authoring backstop refuses the deliverable until it happens, so a
    // completed treatment run with zero echoes means the tool never served.
    if (echoCallCount < 1) {
      throw new Error(
        `${arm} produced no fetch_requirements echo (echo_call_count=${echoCallCount}); the requirements-echo mechanism did not run`,
      );
    }
  }
  // TREATMENT v2. Own block for the same reason as v1: its assertions differ
  // (completeness_floor and citation_contract_v2 must be TRUE, contract v1
  // FALSE), and folding versions together would loosen both gates.
  if (arm === "mike_markdown_e2e_treatment_v2") {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const expectedTools = MARKDOWN_E2E_TREATMENT_LAB_TOOLS.map(
      (tool) => tool.function.name,
    );
    const expectedSurface = armExpectedSurface(arm);
    const expectedPromptSha = expectedSurface
      ? createHash("sha256")
          .update(
            expectedSurface.systemPrompt + inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (expectedPromptSha && surface?.system_prompt_sha256 !== expectedPromptSha) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${expectedPromptSha}`,
      );
    }
    if (
      // the three mechanisms under test: echo + floor + amended contract
      surface?.requirements_echo !== true ||
      surface?.citation_contract !== false ||
      surface?.citation_contract_v2 !== true ||
      surface?.completeness_floor !== true ||
      // frozen arm: exposure accounting must stay off
      surface?.exposure_echo !== false ||
      // …on an otherwise byte-identical e2e chassis
      surface?.markdown_e2e_shape !== true ||
      surface?.markdown_read_docx !== true ||
      surface?.markdown_swap_shape !== false ||
      surface?.structure_index !== false ||
      surface?.upstream_mike_shape !== false ||
      surface?.upstream_native_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; echo=${String(surface?.requirements_echo)}; citationV1=${String(surface?.citation_contract)}; citationV2=${String(surface?.citation_contract_v2)}; floor=${String(surface?.completeness_floor)}; e2e=${String(surface?.markdown_e2e_shape)}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
    if (echoCallCount < 1) {
      throw new Error(
        `${arm} produced no fetch_requirements echo (echo_call_count=${echoCallCount}); the requirements-echo mechanism did not run`,
      );
    }
  }
  // INDEX TREATMENT. Own block like v1/v2: the scoped-index chassis flags
  // (structure_index, completeness_floor) and all three treatment mechanisms
  // (echo, contract v2, no-deferral) must be TRUE together, contract v1
  // FALSE, on the index tool list plus fetch_requirements. Exposure
  // accounting is asserted PER ARM: true on v2, false on the frozen v1, so
  // a leaked MIKE_EXPOSURE_ECHO can never silently change a v1 cell.
  if (
    arm === "mike_markdown_e2e_index_treatment_v1" ||
    arm === "mike_markdown_e2e_index_treatment_v2"
  ) {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const expectedTools = MARKDOWN_INDEX_TREATMENT_LAB_TOOLS.map(
      (tool) => tool.function.name,
    );
    const expectedSurface = armExpectedSurface(arm);
    const expectedPromptSha = expectedSurface
      ? createHash("sha256")
          .update(
            expectedSurface.systemPrompt + inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (expectedPromptSha && surface?.system_prompt_sha256 !== expectedPromptSha) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${expectedPromptSha}`,
      );
    }
    if (
      // the mechanisms under test on the scoped chassis
      surface?.requirements_echo !== true ||
      surface?.citation_contract !== false ||
      surface?.citation_contract_v2 !== true ||
      surface?.no_deferral !== true ||
      surface?.scoped_reread !== true ||
      surface?.exposure_echo !==
        (arm === "mike_markdown_e2e_index_treatment_v2") ||
      surface?.completeness_floor !== true ||
      surface?.structure_index !== true ||
      surface?.index_attach_gated !== true ||
      surface?.find_query_norm !== true ||
      surface?.typed_range !== true ||
      surface?.index_compact_headings !== true ||
      // …on an otherwise byte-identical index chassis
      surface?.markdown_e2e_shape !== true ||
      surface?.markdown_read_docx !== true ||
      surface?.markdown_swap_shape !== false ||
      surface?.upstream_mike_shape !== false ||
      surface?.upstream_native_shape !== false ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; deferred=${deferredTools.join(",")}; echo=${String(surface?.requirements_echo)}; citationV2=${String(surface?.citation_contract_v2)}; noDeferral=${String(surface?.no_deferral)}; scopedReread=${String(surface?.scoped_reread)}; exposureEcho=${String(surface?.exposure_echo)}; floor=${String(surface?.completeness_floor)}; index=${String(surface?.structure_index)}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
    if (echoCallCount < 1) {
      throw new Error(
        `${arm} produced no fetch_requirements echo (echo_call_count=${echoCallCount}); the requirements-echo mechanism did not run`,
      );
    }
  }
  if (
    [
      "lean_batch_v1",
      "lean_batch_hardrefs_v1",
      "coding_markdown_v1",
      "coding_markdown_v2",
    ].includes(arm)
  ) {
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const hardrefs = arm === "lean_batch_hardrefs_v1";
    // coding_markdown_v1 = the lean-batch chassis + markdown plane +
    // navigation-neutral prompt; v2 adds CC parity (Glob + file_path Read
    // surface, executor parity). Every flag is asserted PER ARM so a leak
    // can never silently change a frozen lean-batch cell (and vice versa).
    const codingParity = arm === "coding_markdown_v2";
    const codingMarkdown =
      arm === "coding_markdown_v1" || codingParity;
    const expectedTools = codingParity
      ? ["Glob", "Grep", "Read", "generate_docx"]
      : ["list_documents", "Grep", "Read", "generate_docx"];
    // Prompt-sha gate (audit F8): the prompt-only treatment additions leave
    // no tool-list trace, so without this a leaked citation-contract or
    // no-deferral block would pass isolation silently.
    const leanExpectedSurface = armExpectedSurface(arm);
    const leanExpectedPromptSha = leanExpectedSurface
      ? createHash("sha256")
          .update(
            leanExpectedSurface.systemPrompt +
              inventoryPromptFor(documents, arm),
          )
          .digest("hex")
      : null;
    if (
      leanExpectedPromptSha &&
      surface?.system_prompt_sha256 !== leanExpectedPromptSha
    ) {
      throw new Error(
        `${arm} served the wrong system prompt: receipt sha ${String(surface?.system_prompt_sha256)} != expected ${leanExpectedPromptSha}`,
      );
    }
    if (
      surface?.lean_batch_shape !== !hardrefs ||
      // Serving/prompt mechanisms that must stay off across the lean family
      // (audit F8): a leaked STRUCTURE_INDEX turns unbounded Reads into
      // scoped_read_required dead-ends naming unserved tools.
      surface?.structure_index !== false ||
      surface?.completeness_floor !== false ||
      surface?.citation_contract !== false ||
      surface?.citation_contract_v2 !== false ||
      surface?.no_deferral !== false ||
      surface?.scoped_reread !== false ||
      surface?.requirements_echo !== false ||
      surface?.lean_batch_hardrefs_shape !== hardrefs ||
      surface?.hard_reference_hints !== hardrefs ||
      surface?.markdown_read_docx !== codingMarkdown ||
      surface?.coding_neutral_prompt !== codingMarkdown ||
      surface?.coding_parity !== codingParity ||
      surface?.exposure_echo !== false ||
      surface?.compact_author_mike_shape !== false ||
      surface?.upstream_mike_shape !== false ||
      surface?.adaptive_mike_shape !== false ||
      surface?.coding_shape !== true ||
      surface?.retrieval_experiment !== "p0-pure-coding" ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      Number(surface?.tool_result_max_chars ?? 0) !== 64_000 ||
      Number(surface?.openai_compact_threshold ?? 0) !== 244_800 ||
      surface?.suppress_duplicate_whole_reads !== false ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0 ||
      results.some((result) => result.already_read || result.already_exposed)
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; hardrefs=${String(surface?.hard_reference_hints)}; markdownPlane=${String(surface?.markdown_read_docx)}; neutralPrompt=${String(surface?.coding_neutral_prompt)}; duplicate_suppression=${String(surface?.suppress_duplicate_whole_reads)}`,
      );
    }
  }
  const mikeGrepArms = [
    "mike_grep_v1",
    "mike_legal_v1",
    "mike_legal_guided_v1",
    "mike_structure_paths_v1",
    "grounded_structure_v1",
    "grounded_structure_outline_v1",
  ];
  if (mikeGrepArms.includes(arm)) {
    const expectedTools = [
      "read_document",
      "find_in_document",
      "list_documents",
      "fetch_documents",
      "Grep",
      "Read",
      "generate_docx",
    ];
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const deferredTools = Array.isArray(surface?.deferred_tools)
      ? surface.deferred_tools
      : [];
    const expectedFlags = {
      mike_grep_shape: arm === "mike_grep_v1",
      mike_legal_shape: arm === "mike_legal_v1",
      mike_legal_guided_shape: arm === "mike_legal_guided_v1",
      mike_structure_paths_shape: [
        "mike_structure_paths_v1",
        "grounded_structure_v1",
        "grounded_structure_outline_v1",
      ].includes(arm),
    };
    if (
      surface?.upstream_mike_shape !== false ||
      surface?.adaptive_mike_shape !== false ||
      surface?.mike_grep_shape !== expectedFlags.mike_grep_shape ||
      surface?.mike_legal_shape !== expectedFlags.mike_legal_shape ||
      surface?.mike_legal_guided_shape !==
        expectedFlags.mike_legal_guided_shape ||
      surface?.mike_structure_paths_shape !==
        expectedFlags.mike_structure_paths_shape ||
      surface?.grounding_first !==
        ["grounded_structure_v1", "grounded_structure_outline_v1"].includes(
          arm,
        ) ||
      surface?.grounded_outline_injection !==
        (arm === "grounded_structure_outline_v1") ||
      surface?.retrieval_experiment !==
        armEnvironment[arm].MIKE_RETRIEVAL_EXPERIMENT ||
      surface?.coding_shape !== true ||
      surface?.progressive_disclosure !== false ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.context_handoff !== false ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      Number(surface?.tool_result_max_chars ?? 0) !== 64_000 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools) ||
      deferredTools.length > 0 ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      contentResets.length > 0
    ) {
      throw new Error(
        `${arm} isolation failed: resident=${residentTools.join(",")}; flags=${JSON.stringify(expectedFlags)}; handoff=${String(surface?.context_handoff)}; terminal=${String(surface?.terminal_authoring)}`,
      );
    }
  }
  if (arm === "v5_reconstruction_v1") {
    const expectedTools = ["Glob", "Grep", "Read", "describe_tools"];
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    if (
      surface?.navigation_shape !== "address" ||
      surface?.coding_shape !== true ||
      surface?.retrieval_experiment !== "h4-legal-grep" ||
      surface?.progressive_disclosure !== true ||
      surface?.trajectory_mode !== "handoff" ||
      surface?.context_handoff !== true ||
      surface?.full_handoff_prompt_variant !== "legacy-v5" ||
      surface?.research_context_refresh !== false ||
      surface?.draft_handoff_mode !== "full" ||
      surface?.continuous_evidence !== false ||
      surface?.sla_workflow !== true ||
      surface?.greenfield_review !== false ||
      surface?.model_coverage_routing !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !== 0 ||
      Number(surface?.tool_result_max_chars ?? 0) !== 64_000 ||
      Number(surface?.evidence_handoff_max_chars ?? 0) !== 120_000 ||
      Number(surface?.openai_compact_threshold ?? 0) !== 120_000 ||
      surface?.suppress_duplicate_whole_reads !== true ||
      surface?.terminal_authoring !== false ||
      researchContextRefreshes.length > 0 ||
      evidenceHandoffs.length !== 1 ||
      contentResets.length < 1 ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedTools)
    ) {
      throw new Error(
        `v5 reconstruction drifted: resident=${residentTools.join(",")}; trajectory=${String(surface?.trajectory_mode)}; handoff=${String(surface?.context_handoff)}; sla=${String(surface?.sla_workflow)}`,
      );
    }
  }
  const authored = latestAuthoredDocuments(events);
  let requiredDeliverableMapping: Record<string, string> | null = null;
  const askPause = events.find((event) =>
    String(event.type ?? "").startsWith("ask_inputs"),
  );
  // The native arm reaches finalizePendingAskInputs via the aborted turn
  // (chat.ts catch -> finalizePendingAskInputs -> sseWrite(event)), so an
  // `ask_inputs` event IS present on a faithful native termination. Exempt it
  // here too, or this throws before either of the two guards further down and
  // the typed outcome is still lost.
  if (askPause && !askInputsNoDeliverable)
    throw new Error(
      "Beaver paused for ask_inputs; the benchmark has no user to answer — run incomplete",
    );

  const {
    extractLocalDocument,
    servedDraftingText,
    MARKDOWN_E2E_MIKE_TOOL_SHAPE,
    MARKDOWN_READ_DOCX,
    MARKDOWN_SWAP_MIKE_TOOL_SHAPE,
    WORKING_SET_GREP_DEFAULT_HEAD_LIMIT,
    WORKING_SET_GREP_LINE_MAX_CHARS,
    WORKING_SET_GREP_MAX_HEAD_LIMIT,
    WORKING_SET_PAGE_MAX_CHARS,
    WORKING_SET_PATH,
  } = await import("../src/lib/chat/localAssistantTools");
  if (arm === "checkpoint_paged_v1") {
    const expectedDocxCount = deliverables.filter((name) =>
      /\.docx$/iu.test(name),
    ).length;
    const authoredDocxCount = authored.filter((document) =>
      /\.docx$/iu.test(document.filename),
    ).length;
    const initialCheckpointMax = Number(
      surface?.initial_research_checkpoint_max_count,
    );
    if (!Number.isInteger(initialCheckpointMax) || initialCheckpointMax < 1) {
      throw new Error(
        `checkpoint-paged surface omitted a valid initial checkpoint maximum: ${String(surface?.initial_research_checkpoint_max_count ?? "missing")}`,
      );
    }
    if (
      researchCheckpointRequests.length === 0 ||
      researchCheckpointFailures.length > 0 ||
      researchCheckpointRequests.length !== researchCheckpoints.length ||
      initialResearchCheckpoints.length > initialCheckpointMax ||
      checkpointHandoffMismatches.length > 0
    ) {
      throw new Error(
        `checkpoint-paged validity failed: requests=${researchCheckpointRequests.length}; completed=${researchCheckpoints.length}; initial=${initialResearchCheckpoints.length}; failures=${researchCheckpointFailures.length}; handoff_hash_mismatches=${checkpointHandoffMismatches.length}`,
      );
    }
    if (
      evidenceHandoff?.handoff_mode !== "paged" ||
      Number(evidenceHandoff.checkpoint_chars ?? Infinity) > 12_000 ||
      Number(evidenceHandoff.hot_packet_chars ?? Infinity) > 24_000 ||
      Number(evidenceHandoff.working_set_page_max_chars ?? 0) !== 24_000 ||
      Number(surface?.working_set_grep_default_head_limit ?? 0) !==
        WORKING_SET_GREP_DEFAULT_HEAD_LIMIT ||
      Number(surface?.working_set_grep_max_head_limit ?? 0) !==
        WORKING_SET_GREP_MAX_HEAD_LIMIT ||
      Number(surface?.working_set_grep_line_max_chars ?? 0) !==
        WORKING_SET_GREP_LINE_MAX_CHARS ||
      Number(evidenceHandoff.initial_research_checkpoint_count ?? Infinity) >
        initialCheckpointMax ||
      Number(
        evidenceHandoff.initial_research_checkpoint_max_count ?? 0,
      ) !== initialCheckpointMax
    ) {
      throw new Error(
        `checkpoint-paged handoff invalid: mode=${String(evidenceHandoff?.handoff_mode ?? "missing")}; checkpoint_chars=${String(evidenceHandoff?.checkpoint_chars ?? "missing")}; hot_packet_chars=${String(evidenceHandoff?.hot_packet_chars ?? "missing")}; page_max_chars=${String(evidenceHandoff?.working_set_page_max_chars ?? "missing")}; grep_default_heads=${String(surface?.working_set_grep_default_head_limit ?? "missing")}; grep_max_heads=${String(surface?.working_set_grep_max_head_limit ?? "missing")}; grep_line_chars=${String(surface?.working_set_grep_line_max_chars ?? "missing")}; initial_checkpoints=${String(evidenceHandoff?.initial_research_checkpoint_count ?? "missing")}; initial_checkpoint_max=${String(evidenceHandoff?.initial_research_checkpoint_max_count ?? "missing")}`,
      );
    }
    if (
      evidenceWorkingSetReceipt?.path !== ".mike/working-sets/evidence.txt" ||
      typeof evidenceWorkingSetReceipt.text !== "string" ||
      evidenceWorkingSetReceipt.text.length === 0
    ) {
      throw new Error("checkpoint-paged exact working-set receipt missing");
    }
    if (authoredDocxCount < expectedDocxCount) {
      throw new Error(
        `checkpoint-paged run authored ${authoredDocxCount}/${expectedDocxCount} required DOCX deliverables`,
      );
    }
  }
  if (["v13", "v14", "v15"].includes(arm)) {
    const expectedDocxCount = deliverables.filter((name) =>
      /\.docx$/iu.test(name),
    ).length;
    const authoredDocxCount = authored.filter((document) =>
      /\.docx$/iu.test(document.filename),
    ).length;
    const residentTools = Array.isArray(surface?.resident_tools)
      ? surface.resident_tools
      : [];
    const expectedResidentTools =
      arm === "v15"
        ? ["Glob", "Grep", "Read", "library_create_docx", "describe_tools"]
        : ["Glob", "fetch_documents", "Grep", "Read", "describe_tools"];
    if (
      surface?.navigation_shape !== "address" ||
      surface?.coding_shape !== true ||
      surface?.model_coverage_routing !== (arm !== "v15") ||
      surface?.retrieval_experiment !== "p0-pure-coding" ||
      surface?.tool_description_variant !== "terse" ||
      surface?.progressive_disclosure !== true ||
      JSON.stringify(residentTools) !== JSON.stringify(expectedResidentTools) ||
      surface?.trajectory_mode !== "continuous" ||
      surface?.continuous_evidence !== false ||
      surface?.context_handoff !== false ||
      surface?.draft_handoff_mode !== "none" ||
      surface?.sla_workflow !== false ||
      surface?.greenfield_review !== false ||
      surface?.suppress_duplicate_whole_reads !== false ||
      surface?.resident_authoring !== (arm === "v15") ||
      surface?.terminal_authoring !== false ||
      Number(surface?.whole_read_max_chars ?? 0) !==
        (arm === "v15" ? 0 : 800_000) ||
      Number(surface?.tool_result_max_chars ?? 0) !== 51_200 ||
      (arm === "v14"
        ? String(surface?.openai_compact_threshold ?? "") !== "244800"
        : surface?.openai_compact_threshold != null) ||
      researchContextRefreshes.length > 0 ||
      researchCheckpointRequests.length > 0 ||
      researchCheckpoints.length > 0 ||
      evidenceHandoffs.length > 0 ||
      evidenceWorkingSetReceipts.length > 0 ||
      evidenceWorkingSetUpdates.length > 0 ||
      contentResets.length > 0 ||
      results.some((result) => result.already_read || result.already_exposed)
    ) {
      throw new Error(
        `${arm} trajectory invalid: resident=${residentTools.join(",")}; resident_authoring=${String(surface?.resident_authoring)}; terminal_authoring=${String(surface?.terminal_authoring)}; trajectory=${String(surface?.trajectory_mode)}; continuous_evidence=${String(surface?.continuous_evidence)}; handoff=${String(surface?.context_handoff)}; mode=${String(surface?.draft_handoff_mode)}; sla=${String(surface?.sla_workflow)}; duplicate_suppression=${String(surface?.suppress_duplicate_whole_reads)}; whole_cap=${String(surface?.whole_read_max_chars)}; result_cap=${String(surface?.tool_result_max_chars)}; compact_threshold=${String(surface?.openai_compact_threshold)}; refreshes=${researchContextRefreshes.length}; checkpoint_requests=${researchCheckpointRequests.length}; checkpoints=${researchCheckpoints.length}; handoffs=${evidenceHandoffs.length}; working_sets=${evidenceWorkingSetReceipts.length}; resets=${contentResets.length}`,
      );
    }
    if (authoredDocxCount < expectedDocxCount) {
      throw new Error(
        `${arm} run authored ${authoredDocxCount}/${expectedDocxCount} required DOCX deliverables`,
      );
    }
  }
  if (
    !askInputsNoDeliverable &&
    [
      "upstream",
      "upstream_terminal_v1",
      "mike_upstream_native_v1",
      "mike_markdown_e2e_treatment_v1",
      "mike_markdown_e2e_treatment_v2",
      "mike_markdown_swap_v1",
      "mike_markdown_e2e_v1",
      "mike_markdown_e2e_index_v1",
      "mike_markdown_e2e_floor_v1",
      "mike_markdown_e2e_index_floor_v1",
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
      "mike_compact_author_v1",
      "lean_batch_v1",
      "lean_batch_hardrefs_v1",
      "coding_markdown_v1",
      "coding_markdown_v2",
      "mike_grep_v1",
      "mike_structure_paths_v1",
      "grounded_structure_v1",
      "grounded_structure_outline_v1",
    ].includes(arm)
  ) {
    const expectedDocx = deliverables.filter((name) => /\.docx$/iu.test(name));
    const authoredDocx = authored.filter((document) =>
      /\.docx$/iu.test(document.filename),
    );
    if (
      expectedDocx.length !== deliverables.length ||
      authoredDocx.length !== expectedDocx.length
    ) {
      throw new Error(
        `${arm} run authored ${authoredDocx.length}/${expectedDocx.length} required DOCX deliverables; answer-text fallback and extra artifacts are forbidden for this matrix`,
      );
    }
    if (expectedDocx.length === 1) {
      requiredDeliverableMapping = {
        [expectedDocx[0]]: authoredDocx[0].filename,
      };
    } else {
      requiredDeliverableMapping = Object.fromEntries(
        expectedDocx.map((expected) => {
          const match = authoredDocx.find(
            (document) =>
              document.filename.toLowerCase() === expected.toLowerCase(),
          );
          if (!match) {
            throw new Error(
              `${arm} run omitted required deliverable ${expected}; authored ${authoredDocx.map((document) => document.filename).join(", ")}`,
            );
          }
          return [expected, match.filename];
        }),
      );
    }
  }
  // Same exemption: an ask_inputs-terminated native turn legitimately produces
  // neither prose nor a document (the abort fires before the model can emit a
  // final message), so this guard would otherwise mask the typed outcome.
  if (!askInputsNoDeliverable && !answer.trim() && !authored.length)
    throw new Error("empty assistant answer and no documents authored");
  const wallClock = (Date.now() - started) / 1000;
  let sourceTextChars = 0;
  const sourceReceipts: Array<Record<string, unknown>> = [];
  for (const document of uploadedDocuments) {
    const extracted = await extractLocalDocument(userId, document.id);
    if (!extracted) continue;
    // The exposure numerator lives on the served BODY plane (pandoc markdown
    // for markdown arms, SECT-INDEX excluded). The denominator must be the
    // same plane per document — the plaintext denominator made the ratio
    // cross-plane, and shipped runs reported impossible values > 1.
    const served = MARKDOWN_READ_DOCX
      ? await servedDraftingText(userId, document.id)
      : null;
    const servedBodyChars = served
      ? served.served.length - served.bodyOffset
      : extracted.text.length;
    sourceTextChars += servedBodyChars;
    sourceReceipts.push({
      served_body_chars: servedBodyChars,
      source: document.source,
      uploaded: document.uploaded,
      document_id: document.id,
      version_id: extracted.versionId,
      source_bytes: document.source_bytes,
      source_sha256: document.source_sha256,
      uploaded_bytes: document.uploaded_bytes,
      uploaded_sha256: document.uploaded_sha256,
      text_chars: extracted.text.length,
      text_sha256: createHash("sha256").update(extracted.text).digest("hex"),
      pages: extracted.pages.pages.length,
      pages_sha256: createHash("sha256")
        .update(JSON.stringify(extracted.pages))
        .digest("hex"),
      table_cells: extracted.tableCells.length,
      table_cells_sha256: createHash("sha256")
        .update(JSON.stringify(extracted.tableCells))
        .digest("hex"),
    });
  }

  const outputDir = path.join(runDir, "output");
  mkdirSync(outputDir, { recursive: true });
  let evidenceWorkingSetArtifact: Record<string, unknown> | null = null;
  const evidenceWorkingSetHistory = evidenceWorkingSetReceipts.map(
    (receipt, index) => {
      if (typeof receipt.text !== "string")
        throw new Error(`evidence working-set receipt ${index + 1} has no text`);
      const textSha256 = createHash("sha256").update(receipt.text).digest("hex");
      if (
        typeof receipt.text_sha256 === "string" &&
        receipt.text_sha256 !== textSha256
      ) {
        throw new Error(`evidence working-set receipt ${index + 1} hash mismatch`);
      }
      return {
        index: index + 1,
        path: receipt.path ?? null,
        text_chars: receipt.text.length,
        text_sha256: textSha256,
        source_chars: Number(receipt.source_chars ?? 0),
        map_chars: Number(receipt.map_chars ?? 0),
        mapped_versions: receipt.mapped_versions ?? [],
        segment_count: Array.isArray(receipt.segments)
          ? receipt.segments.length
          : 0,
        ref_count: Array.isArray(receipt.refs) ? receipt.refs.length : 0,
      };
    },
  );
  if (
    evidenceWorkingSetReceipt &&
    typeof evidenceWorkingSetReceipt.text === "string"
  ) {
    const text = evidenceWorkingSetReceipt.text;
    const textSha256 = createHash("sha256").update(text).digest("hex");
    if (
      typeof evidenceWorkingSetReceipt.text_sha256 === "string" &&
      evidenceWorkingSetReceipt.text_sha256 !== textSha256
    ) {
      throw new Error("evidence working-set receipt hash mismatch");
    }
    const filename = "evidence-working-set.json";
    writeFileSync(
      path.join(runDir, filename),
      JSON.stringify(
        {
          ...evidenceWorkingSetReceipt,
          receipt_history: evidenceWorkingSetHistory,
        },
        null,
        2,
      ),
    );
    evidenceWorkingSetArtifact = {
      filename,
      path: evidenceWorkingSetReceipt.path ?? null,
      text_chars: text.length,
      text_sha256: textSha256,
      source_chars: Number(evidenceWorkingSetReceipt.source_chars ?? 0),
      map_chars: Number(evidenceWorkingSetReceipt.map_chars ?? 0),
      mapped_versions: evidenceWorkingSetReceipt.mapped_versions ?? [],
      segment_count: Array.isArray(evidenceWorkingSetReceipt.segments)
        ? evidenceWorkingSetReceipt.segments.length
        : 0,
      ref_count: Array.isArray(evidenceWorkingSetReceipt.refs)
        ? evidenceWorkingSetReceipt.refs.length
        : 0,
      receipt_count: evidenceWorkingSetHistory.length,
      receipt_history: evidenceWorkingSetHistory,
    };
  }

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
  // text_chars is the deliverable's extracted text length (not zip bytes) —
  // deliverable size is the strongest single score predictor in the deepseek
  // family and was never recorded, so every arm comparison carried a hidden
  // verbosity confound.
  const { extractDocxBodyStructure } = await import(
    "../src/lib/docxTrackedChanges"
  );
  const deliverableReceipts = await Promise.all(
    readdirSync(outputDir, { encoding: "utf8" })
      .sort((left, right) => left.localeCompare(right))
      .map(async (filename) => {
        const bytes = readFileSync(path.join(outputDir, filename));
        let textChars: number | null = null;
        if (/\.docx$/iu.test(filename)) {
          textChars = await extractDocxBodyStructure(bytes)
            .then((body) => body.text.length)
            .catch(() => null);
        } else if (/\.(md|txt)$/iu.test(filename)) {
          textChars = bytes.toString("utf8").length;
        }
        return {
          filename,
          bytes: bytes.length,
          text_chars: textChars,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          source: deliverableSources[filename] ?? "library",
        };
      }),
  );

  // Real usage from the context-manifest receipts (each streamChatWithTools
  // call appends one entry with provider-reported usage); the byte-based
  // inputEstimate is the fallback for entries that died before usage.
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let tokenSource = "context_manifest_usage";
  let cacheReadReportingComplete = true;
  let cacheWriteReportingComplete = true;
  const reportedServiceTiers = new Set<string>();
  const contextRounds: Array<Record<string, unknown>> = [];
  const compactions: Array<Record<string, unknown>> = [];
  const promptCacheKeyHashes = new Set<string>();
  const promptCacheStrategies = new Set<string>();
  const providerInvocations: Array<Record<string, unknown>> = [];
  const manifestPath = process.env.MIKE_LLM_CONTEXT_MANIFEST_PATH ?? "";
  if (manifestPath && existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        provider?: string;
        usage?: {
          inputTokens?: number;
          outputTokens?: number;
          reasoningTokens?: number | null;
          cacheReadInputTokens?: number | null;
          cacheWriteInputTokens?: number | null;
        } | null;
        startedAt?: string;
        firstContentLatencyMs?: number | null;
        totalLatencyMs?: number;
        status?: string;
        providerInvocationId?: string | null;
        components?: Record<string, unknown>;
        inputEstimate?: { bytes?: number; tokens?: number };
        serviceTierRequested?: string | null;
        serviceTierReported?: string | null;
        rounds?: Array<Record<string, unknown>>;
        compactions?: Array<Record<string, unknown>>;
        promptCache?: {
          strategy?: string;
          keySha256?: string | null;
        };
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
        if (
          ["openai", "codex"].includes(entry.provider ?? "") &&
          entry.usage.cacheReadInputTokens == null
        ) {
          cacheReadReportingComplete = false;
        }
        if (
          ["openai", "codex"].includes(entry.provider ?? "") &&
          entry.usage.cacheWriteInputTokens == null
        ) {
          cacheWriteReportingComplete = false;
        }
        outputTokens += entry.usage.outputTokens ?? 0;
        reasoningTokens += entry.usage.reasoningTokens ?? 0;
      } else {
        inputTokens += entry.inputEstimate?.tokens ?? 0;
        tokenSource = "context_manifest_mixed_estimate";
        if (["openai", "codex"].includes(entry.provider ?? "")) {
          cacheReadReportingComplete = false;
          cacheWriteReportingComplete = false;
        }
      }
      if (entry.serviceTierReported)
        reportedServiceTiers.add(entry.serviceTierReported);
      const firstRound = contextRounds.length;
      contextRounds.push(...(entry.rounds ?? []));
      const firstCompaction = compactions.length;
      for (const compaction of entry.compactions ?? []) {
        compactions.push(compaction);
        const compactionUsage = compaction.usage as
          | {
              inputTokens?: number | null;
              outputTokens?: number | null;
              cacheReadInputTokens?: number | null;
              cacheWriteInputTokens?: number | null;
            }
          | undefined;
        if (compactionUsage?.inputTokens == null) {
          inputTokens += Number(compaction.estimatedInputTokens ?? 0);
          outputTokens += Number(compaction.estimatedOutputTokens ?? 0);
          tokenSource = "context_manifest_mixed_estimate";
          cacheReadReportingComplete = false;
          cacheWriteReportingComplete = false;
        }
      }
      if (entry.promptCache?.strategy)
        promptCacheStrategies.add(entry.promptCache.strategy);
      if (entry.promptCache?.keySha256)
        promptCacheKeyHashes.add(entry.promptCache.keySha256);
      providerInvocations.push({
        provider: entry.provider ?? null,
        started_at: entry.startedAt ?? null,
        status: entry.status ?? null,
        first_content_latency_ms: entry.firstContentLatencyMs ?? null,
        total_latency_ms: entry.totalLatencyMs ?? null,
        provider_invocation_id: entry.providerInvocationId ?? null,
        input_estimate: entry.inputEstimate ?? null,
        components: entry.components ?? null,
        usage: entry.usage ?? null,
        context_round_start: firstRound,
        context_round_count: (entry.rounds ?? []).length,
        compaction_start: firstCompaction,
        compaction_count: (entry.compactions ?? []).length,
        prompt_cache: entry.promptCache ?? null,
      });
    }
  }
  // The default-tier and session prompt-cache receipt gates below were built
  // for the Anthropic/codex lane, which reports service tiers and prompt-cache
  // keys on every response. The deepseek provider structurally reports neither
  // (serviceTierReported/promptCache stay null), so these receipts can never
  // arrive; enforcing them on the deepseek lane would discard every run,
  // including ones that authored their deliverable. The claude-p lane is the
  // same shape: the CLI envelope reports no service tier and no prompt-cache
  // key, and the tier gate killed every claude-p run of the last wave. The
  // single-invocation count gate below still applies — it checks trajectory
  // shape, not provider receipts.
  const flatRateLane =
    model.startsWith("deepseek") || model.startsWith("claude-p:");
  const singleInvocationArms = [
    "v13",
    "v14",
    "v15",
    "upstream",
    "upstream_terminal_v1",
    "mike_markdown_swap_v1",
    "mike_markdown_e2e_v1",
    "mike_markdown_e2e_index_v1",
    "mike_markdown_e2e_floor_v1",
    "mike_markdown_e2e_index_floor_v1",
    "mike_markdown_e2e_index_treatment_v1",
    "mike_markdown_e2e_index_treatment_v2",
    "mike_markdown_e2e_treatment_v1",
    "mike_markdown_e2e_treatment_v2",
    "adaptive_mike_v1",
    "mike_compact_author_v1",
    "lean_batch_v1",
    "lean_batch_hardrefs_v1",
    "coding_markdown_v1",
    "coding_markdown_v2",
    ...mikeGrepArms,
  ];
  const defaultTierArms = [
    "upstream",
    ...singleInvocationArms,
    "v5_reconstruction_v1",
  ];
  if (singleInvocationArms.includes(arm) && providerInvocations.length !== 1) {
    throw new Error(
      `${arm} trajectory used ${providerInvocations.length} provider invocations; expected exactly one`,
    );
  }
  if (arm === "v5_reconstruction_v1" && providerInvocations.length < 2) {
    throw new Error(
      `v5 reconstruction used ${providerInvocations.length} provider invocations; expected research and fresh drafting contexts`,
    );
  }
  if (
    !flatRateLane &&
    defaultTierArms.includes(arm) &&
    (reportedServiceTiers.size !== 1 || !reportedServiceTiers.has("default"))
  ) {
    throw new Error(
      `${arm} requires the provider-reported default tier; received ${[...reportedServiceTiers].join(",") || "no tier receipt"}`,
    );
  }
  if (
    !flatRateLane &&
    singleInvocationArms.includes(arm) &&
    (promptCacheStrategies.size !== 1 ||
      !promptCacheStrategies.has("session") ||
      promptCacheKeyHashes.size !== 1)
  ) {
    throw new Error(
      `${arm} requires one session-scoped prompt-cache key receipt; strategies=${[...promptCacheStrategies].join(",") || "none"}; keys=${promptCacheKeyHashes.size}`,
    );
  }
  if (
    !flatRateLane &&
    arm === "v5_reconstruction_v1" &&
    (promptCacheStrategies.size !== 1 ||
      !promptCacheStrategies.has("session") ||
      promptCacheKeyHashes.size < 1)
  ) {
    throw new Error(
      `v5 reconstruction requires session-scoped prompt-cache receipts; strategies=${[...promptCacheStrategies].join(",") || "none"}; keys=${promptCacheKeyHashes.size}`,
    );
  }
  if (arm === "v14") {
    const thresholdCrossingRounds = contextRounds.filter(
      (round) =>
        Number(
          (round.usage as Record<string, unknown> | undefined)?.inputTokens ??
            0,
        ) >= 244_800 && Number(round.toolCallCount ?? 0) > 0,
    );
    const uncompactedCrossingRounds = thresholdCrossingRounds.filter(
      (round) =>
        !compactions.some(
          (compaction) =>
            Number(compaction.iteration ?? -1) === Number(round.iteration),
        ),
    );
    const invalidCompactions = compactions.filter(
      (compaction) =>
        Number(compaction.thresholdTokens ?? 0) !== 244_800 ||
        Number(compaction.outputItems ?? 0) < 1 ||
        Number(compaction.outputBytes ?? 0) < 1 ||
        (Number(compaction.triggerInputTokens ?? 0) < 244_800 &&
          Number(compaction.projectedInputTokens ?? 0) < 244_800 &&
          compaction.triggerReason !== "context_length_exceeded"),
    );
    if (
      uncompactedCrossingRounds.length > 0 ||
      invalidCompactions.length > 0
    ) {
      throw new Error(
        `v14 compaction validity failed: threshold_crossings=${thresholdCrossingRounds.length}; uncompacted=${uncompactedCrossingRounds.length}; compactions=${compactions.length}; invalid=${invalidCompactions.length}`,
      );
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

  const instructionsSha256 = createHash("sha256")
    .update(instructions)
    .digest("hex");
  const sourceBundleFingerprint = sourceBundleSha256(
    uploadedDocuments.map((document) => ({
      source: document.source,
      source_sha256: document.source_sha256,
      uploaded: document.uploaded,
      uploaded_sha256: document.uploaded_sha256,
    })),
  );
  const systemPromptFingerprints = [
    ...new Set(
      contextRounds.map((round) => String(round.instructionsSha256 ?? "")),
    ),
  ].filter(Boolean);
  const toolSchemaFingerprints = [
    ...new Set(contextRounds.map((round) => String(round.toolSha256 ?? ""))),
  ].filter(Boolean);
  const mikeGrepDerived = mikeGrepArms.includes(arm);
  const leanBatchDerived = [
    "mike_compact_author_v1",
    "lean_batch_v1",
    "lean_batch_hardrefs_v1",
  ].includes(arm);
  const upstreamDerived =
    ["upstream", "upstream_terminal_v1", "adaptive_mike_v1"].includes(arm) ||
    mikeGrepDerived ||
    leanBatchDerived;
  const mikeGrepDelta = mikeGrepDerived
    ? MIKE_GREP_DELTAS[
        armEnvironment[arm]
          .MIKE_TOOL_SHAPE as keyof typeof MIKE_GREP_DELTAS
      ]
    : null;
  const runFingerprintInput = {
    task_sha256: splitEntry.sha256,
    task_config_sha256: taskConfigSha256,
    instructions_sha256: instructionsSha256,
    source_bundle_sha256: sourceBundleFingerprint,
    model,
    effort,
    service_tier_requested: serviceTier || null,
    arm,
    office_pdf_rendition: officePdfRendition,
    arm_environment: armEnvironment[arm],
    harness_sources: harnessSourceFingerprints,
    system_prompt_sha256s: systemPromptFingerprints,
    tool_schema_sha256s: toolSchemaFingerprints,
    upstream_mike_commit: upstreamDerived ? UPSTREAM_MIKE_COMMIT : null,
    upstream_mike_source_blobs: upstreamDerived
      ? UPSTREAM_MIKE_SOURCE_BLOBS
      : null,
    adaptive_delta:
      arm === "adaptive_mike_v1" ? ADAPTIVE_MIKE_DELTA : null,
    upstream_terminal_delta:
      arm === "upstream_terminal_v1" ? UPSTREAM_TERMINAL_DELTA : null,
    upstream_native_delta:
      arm === "mike_upstream_native_v1" ? UPSTREAM_NATIVE_DELTA : null,
    requirements_echo_delta: [
      "mike_markdown_e2e_treatment_v1",
      "mike_markdown_e2e_treatment_v2",
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
    ].includes(arm)
      ? REQUIREMENTS_ECHO_DELTA
      : null,
    citation_contract_delta:
      arm === "mike_markdown_e2e_treatment_v1" ? CITATION_CONTRACT_DELTA : null,
    citation_contract_v2_delta: [
      "mike_markdown_e2e_treatment_v2",
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
    ].includes(arm)
      ? CITATION_CONTRACT_V2_DELTA
      : null,
    no_deferral_delta: [
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
    ].includes(arm)
      ? NO_DEFERRAL_DELTA
      : null,
    markdown_e2e_treatment_delta:
      arm === "mike_markdown_e2e_treatment_v1"
        ? MARKDOWN_E2E_TREATMENT_DELTA
        : null,
    markdown_e2e_treatment_v2_delta:
      arm === "mike_markdown_e2e_treatment_v2"
        ? MARKDOWN_E2E_TREATMENT_V2_DELTA
        : null,
    markdown_e2e_index_treatment_delta: [
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
    ].includes(arm)
      ? MARKDOWN_E2E_INDEX_TREATMENT_DELTA
      : null,
    markdown_e2e_index_treatment_v2_delta:
      arm === "mike_markdown_e2e_index_treatment_v2"
        ? MARKDOWN_E2E_INDEX_TREATMENT_V2_DELTA
        : null,
    exposure_echo_delta:
      arm === "mike_markdown_e2e_index_treatment_v2"
        ? EXPOSURE_ECHO_DELTA
        : null,
    compact_author_delta:
      arm === "mike_compact_author_v1" ? COMPACT_AUTHOR_MIKE_DELTA : null,
    markdown_swap_delta:
      [
        "mike_markdown_swap_v1",
        "mike_markdown_e2e_v1",
        "mike_markdown_e2e_index_v1",
        "mike_markdown_e2e_floor_v1",
        "mike_markdown_e2e_index_floor_v1",
      ].includes(arm)
        ? MARKDOWN_SWAP_DELTA
        : null,
    markdown_e2e_delta:
      arm === "mike_markdown_e2e_v1" ? MARKDOWN_E2E_DELTA : null,
    markdown_e2e_index_delta:
      arm === "mike_markdown_e2e_index_v1" ? MARKDOWN_E2E_INDEX_DELTA : null,
    markdown_e2e_floor_delta: [
      "mike_markdown_e2e_floor_v1",
      "mike_markdown_e2e_treatment_v2",
    ].includes(arm)
      ? MARKDOWN_E2E_FLOOR_DELTA
      : null,
    markdown_e2e_index_floor_delta: [
      "mike_markdown_e2e_index_floor_v1",
      "mike_markdown_e2e_index_treatment_v1",
      "mike_markdown_e2e_index_treatment_v2",
    ].includes(arm)
      ? MARKDOWN_E2E_INDEX_FLOOR_DELTA
      : null,
    lean_batch_delta:
      [
        "lean_batch_v1",
        "lean_batch_hardrefs_v1",
        "coding_markdown_v1",
        "coding_markdown_v2",
      ].includes(arm)
        ? LEAN_BATCH_DELTA
        : null,
    coding_markdown_delta:
      ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
        ? CODING_MARKDOWN_DELTA
        : null,
    coding_neutral_prompt_delta:
      ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
        ? CODING_NEUTRAL_PROMPT_DELTA
        : null,
    coding_markdown_v2_delta:
      arm === "coding_markdown_v2" ? CODING_MARKDOWN_V2_DELTA : null,
    coding_parity_delta:
      arm === "coding_markdown_v2" ? CODING_PARITY_DELTA : null,
    lean_batch_hardrefs_delta:
      arm === "lean_batch_hardrefs_v1" ? LEAN_BATCH_HARDREFS_DELTA : null,
    mike_grep_delta: mikeGrepDelta,
    grounded_structure_outline_delta:
      arm === "grounded_structure_outline_v1"
        ? GROUNDED_STRUCTURE_OUTLINE_DELTA
        : null,
    strategy_reconstruction:
      arm === "v5_reconstruction_v1"
        ? "finalist-luna-long-v5-hybrid-finalist"
        : null,
  };
  const runFingerprintSha256 = createHash("sha256")
    .update(JSON.stringify(runFingerprintInput))
    .digest("hex");
  const callsById = new Map(calls.map((call) => [call.id, call]));
  const isStructurePath = (value: unknown) =>
    typeof value === "string" &&
    value
      .replace(/\\/gu, "/")
      .toLowerCase()
      .startsWith(".mike/structure/");
  const structurePathCalls = calls.filter((call) => {
    const input = (call.input ?? {}) as Record<string, unknown>;
    return isStructurePath(input.path) || isStructurePath(input.file_path);
  });
  const structurePathCallIds = new Set(
    structurePathCalls.map((call) => call.id),
  );
  const structurePathSegments = results.flatMap((toolResult) =>
    toolResult.evidence_segments.filter((segment) =>
      isStructurePath(segment.virtualPath),
    ),
  );
  const emittedStructurePathSegments = structurePathSegments.filter(
    (segment) => segment.kind === "candidate",
  );
  const discoveredStructurePaths = new Set(
    emittedStructurePathSegments.flatMap((segment) =>
      segment.virtualPath ? [segment.virtualPath] : [],
    ),
  );
  const followedStructurePaths = new Set(
    structurePathCalls.flatMap((call) => {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const value = isStructurePath(input.path)
        ? input.path
        : isStructurePath(input.file_path)
          ? input.file_path
          : null;
      return typeof value === "string" ? [value.toLowerCase()] : [];
    }),
  );
  const followedDiscoveredStructurePaths = new Set(
    [...discoveredStructurePaths]
      .filter((path) => followedStructurePaths.has(path.toLowerCase()))
      .map((path) => path.toLowerCase()),
  );
  const structurePathLocatorKinds: Record<string, number> = {};
  for (const path of discoveredStructurePaths) {
    const locator = emittedStructurePathSegments.find(
      (segment) => segment.virtualPath === path,
    )?.locator;
    const kind =
      typeof locator !== "string"
        ? "unknown"
        : locator.startsWith("table:")
          ? "table"
          : locator.startsWith("pdf:")
            ? "pdf-page"
            : locator.startsWith("printed:") || locator.startsWith("page:")
              ? "page"
              : "section";
    structurePathLocatorKinds[kind] =
      (structurePathLocatorKinds[kind] ?? 0) + 1;
  }
  const structurePathEvidence = exposureMetrics(
    calls,
    results.map((toolResult) => ({
      ...toolResult,
      evidence_segments: toolResult.evidence_segments.filter(
        (segment) =>
          segment.kind === "evidence" &&
          isStructurePath(segment.virtualPath),
      ),
      evidence_spans: [],
      evidence_refs: [],
    })),
    sourceAliases,
  );
  const workingSetPagingResults = results.filter((result) => {
    if (!["drafting", "continuous"].includes(result.phase ?? "")) return false;
    const input = (callsById.get(result.id)?.input ?? {}) as Record<
      string,
      unknown
    >;
    return [input.path, input.file_path].some(
      (value) =>
        typeof value === "string" &&
        value.replace(/\\/gu, "/").toLowerCase() ===
          WORKING_SET_PATH.toLowerCase(),
    );
  });
  const oversizedWorkingSetResults = workingSetPagingResults.filter(
    (result) => result.content_chars > WORKING_SET_PAGE_MAX_CHARS,
  );
  if (
    ["checkpoint_paged_v1", "continuous_coverage"].includes(arm) &&
    oversizedWorkingSetResults.length
  ) {
    const diagnostics = oversizedWorkingSetResults.map((result) => ({
      id: result.id,
      name: result.name,
      phase: result.phase,
      content_chars: result.content_chars,
      content_sha256: result.content_sha256,
      input: callsById.get(result.id)?.input ?? null,
    }));
    writeFileSync(
      path.join(runDir, "invalid-working-set-paging.json"),
      JSON.stringify(
        { cap_chars: WORKING_SET_PAGE_MAX_CHARS, results: diagnostics },
        null,
        2,
      ),
    );
    throw new Error(
      `working-set result exceeded ${WORKING_SET_PAGE_MAX_CHARS} chars: ${diagnostics
        .map((result) => `${result.name}#${result.id}=${result.content_chars}`)
        .join(", ")}`,
    );
  }
  const providerTotalLatencyMs = providerInvocations.reduce(
    (total, invocation) => total + Number(invocation.total_latency_ms ?? 0),
    0,
  );
  const providerRequestCount =
    contextRounds.reduce(
      (total, round) => total + Number(round.requestAttempts ?? 0),
      0,
    ) + compactions.length;
  const compactionUsageComplete = compactions.every((compaction) => {
    const usage = compaction.usage as Record<string, unknown> | undefined;
    return usage?.inputTokens != null && usage?.outputTokens != null;
  });
  const compactionReportedInputTokens = compactions.reduce(
    (total, compaction) =>
      total +
      Number(
        (compaction.usage as Record<string, unknown> | undefined)
          ?.inputTokens ?? 0,
      ),
    0,
  );
  const compactionEstimatedInputTokens = compactions.reduce(
    (total, compaction) => {
      const usage = compaction.usage as Record<string, unknown> | undefined;
      return (
        total +
        (usage?.inputTokens == null
          ? Number(compaction.estimatedInputTokens ?? 0)
          : 0)
      );
    },
    0,
  );
  const compactionLatencyMs = compactions.reduce(
    (total, compaction) => total + Number(compaction.latencyMs ?? 0),
    0,
  );
  const cacheReadRatio =
    cacheReadReportingComplete && inputTokens > 0
      ? cacheReadInputTokens / inputTokens
      : null;
  const cacheWriteRatio =
    cacheWriteReportingComplete && inputTokens > 0
      ? cacheWriteInputTokens / inputTokens
      : null;
  const knownCacheReadTokens = Math.min(cacheReadInputTokens, inputTokens);
  const nonReadInputTokens = Math.max(0, inputTokens - knownCacheReadTokens);
  const knownCacheWriteTokens = Math.min(
    cacheWriteInputTokens,
    nonReadInputTokens,
  );
  const cacheAdjustedInputTokenEquivalent =
    cacheReadReportingComplete && cacheWriteReportingComplete
      ? nonReadInputTokens -
        knownCacheWriteTokens +
        knownCacheReadTokens * 0.1 +
        knownCacheWriteTokens * 1.25
      : null;
  const cacheAdjustedInputLowerBound = cacheReadReportingComplete
    ? nonReadInputTokens + knownCacheReadTokens * 0.1
    : inputTokens * 0.1;
  const cacheAdjustedInputUpperBound = cacheReadReportingComplete
    ? nonReadInputTokens * 1.25 + knownCacheReadTokens * 0.1
    : inputTokens * 1.25;
  const canonicalModel = model.replace(/^codex:/u, "");
  const gpt56ApiRates = canonicalModel.endsWith("-sol")
    ? { inputPerMillionUsd: 5, outputPerMillionUsd: 30 }
    : canonicalModel.endsWith("-terra")
      ? { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 }
      : canonicalModel.endsWith("-luna")
        ? { inputPerMillionUsd: 1, outputPerMillionUsd: 6 }
        : null;
  const apiCostUsd = (adjustedInputTokens: number) =>
    gpt56ApiRates
      ? (adjustedInputTokens * gpt56ApiRates.inputPerMillionUsd +
          outputTokens * gpt56ApiRates.outputPerMillionUsd) /
        1_000_000
      : null;
  const apiPriceEquivalent = {
    scope:
      "GPT-5.6 public API price-equivalent; not Codex subscription quota or billing",
    input_rate_per_million_usd:
      gpt56ApiRates?.inputPerMillionUsd ?? null,
    cached_read_multiplier: 0.1,
    cache_write_multiplier: 1.25,
    output_rate_per_million_usd:
      gpt56ApiRates?.outputPerMillionUsd ?? null,
    exact_usd:
      cacheAdjustedInputTokenEquivalent == null
        ? null
        : apiCostUsd(cacheAdjustedInputTokenEquivalent),
    lower_bound_usd: apiCostUsd(cacheAdjustedInputLowerBound),
    upper_bound_usd: apiCostUsd(cacheAdjustedInputUpperBound),
  };

  writeFileSync(
    path.join(runDir, "config.json"),
    JSON.stringify(
      {
        model,
        arm,
        task,
        task_sha256: splitEntry.sha256,
        task_config_sha256: taskConfigSha256,
        task_instructions_chars: instructions.length,
        task_instructions_sha256: instructionsSha256,
        source_bundle_sha256: sourceBundleFingerprint,
        harness_source_fingerprints: harnessSourceFingerprints,
        system_prompt_sha256s: systemPromptFingerprints,
        tool_schema_sha256s: toolSchemaFingerprints,
        run_fingerprint_sha256: runFingerprintSha256,
        run_id: runId,
        harness: "beaver-chat",
        reasoning_effort: effort,
        service_tier_requested: serviceTier || null,
        service_tiers_reported: [...reportedServiceTiers],
        prompt_variant:
          ["upstream", "upstream_terminal_v1"].includes(arm)
            ? "upstream-pinned"
            : [
                  "mike_markdown_swap_v1",
                  "mike_markdown_e2e_v1",
                  "mike_markdown_e2e_index_v1",
                  "mike_markdown_e2e_floor_v1",
                  "mike_markdown_e2e_index_floor_v1",
                ].includes(arm)
              ? arm === "mike_markdown_e2e_v1"
                ? "upstream-markdown-e2e-v1"
                : arm === "mike_markdown_e2e_index_v1"
                  ? "upstream-markdown-e2e-index-v1"
                  : arm === "mike_markdown_e2e_floor_v1"
                    ? "upstream-markdown-e2e-floor-v1"
                    : arm === "mike_markdown_e2e_index_floor_v1"
                      ? "upstream-markdown-e2e-index-floor-v1"
                      : "upstream-markdown-swap-v1"
              : arm === "adaptive_mike_v1"
              ? "adaptive-mike-v1"
              : arm === "mike_compact_author_v1"
                ? "upstream-retrieval-compact-author-v1"
                : ["lean_batch_v1", "lean_batch_hardrefs_v1"].includes(arm)
                  ? "lean-batch-v1"
              : mikeGrepDerived
                ? armEnvironment[arm].MIKE_TOOL_SHAPE
                : arm === "v5_reconstruction_v1"
                  ? "lean-v5-strategy-reconstruction"
              : "lean",
        retrieval_prompt_variant: retrievalPromptVariant,
        tool_description_variant:
          surface?.tool_description_variant ?? toolDescriptionVariant,
        office_pdf_rendition: officePdfRendition,
        retrieval_experiment: surface?.retrieval_experiment ?? null,
        markdown_swap_shape: MARKDOWN_SWAP_MIKE_TOOL_SHAPE,
        markdown_e2e_shape: MARKDOWN_E2E_MIKE_TOOL_SHAPE,
        markdown_read_docx: MARKDOWN_READ_DOCX,
        structure_index: STRUCTURE_INDEX_ENABLED,
        progressive_disclosure: surface?.progressive_disclosure === true,
        model_coverage_routing: surface?.model_coverage_routing === true,
        whole_read_max_chars: surface?.whole_read_max_chars ?? null,
        tool_result_max_chars: surface?.tool_result_max_chars ?? null,
        suppress_duplicate_whole_reads:
          surface?.suppress_duplicate_whole_reads ?? null,
        hard_reference_hints: surface?.hard_reference_hints === true,
        grounded_outline_injection:
          surface?.grounded_outline_injection === true,
        grounded_outline_injection_chars:
          surface?.grounded_outline_injection_chars ?? null,
        trajectory_mode: surface?.trajectory_mode ?? null,
        context_handoff: surface?.context_handoff === true,
        full_handoff_prompt_variant:
          surface?.full_handoff_prompt_variant ?? null,
        research_context_refresh:
          surface?.research_context_refresh === true,
        continuous_evidence: surface?.continuous_evidence === true,
        draft_handoff_mode: surface?.draft_handoff_mode ?? null,
        research_checkpoint_max_chars:
          surface?.research_checkpoint_max_chars ?? null,
        initial_research_checkpoint_max_count:
          surface?.initial_research_checkpoint_max_count ?? null,
        draft_hot_evidence_max_chars:
          surface?.draft_hot_evidence_max_chars ?? null,
        working_set_page_max_chars:
          surface?.working_set_page_max_chars ?? null,
        working_set_grep_default_head_limit:
          surface?.working_set_grep_default_head_limit ?? null,
        working_set_grep_max_head_limit:
          surface?.working_set_grep_max_head_limit ?? null,
        working_set_grep_line_max_chars:
          surface?.working_set_grep_line_max_chars ?? null,
        evidence_handoff_max_chars:
          surface?.evidence_handoff_max_chars ?? null,
        openai_compact_threshold:
          surface?.openai_compact_threshold ?? null,
        prompt_cache_strategy: [...promptCacheStrategies],
        prompt_cache_key_sha256s: [...promptCacheKeyHashes],
        upstream_mike_commit: upstreamDerived ? UPSTREAM_MIKE_COMMIT : null,
        upstream_mike_source_blobs: upstreamDerived
          ? UPSTREAM_MIKE_SOURCE_BLOBS
          : null,
        upstream_mike_schema_sha256:
          ["upstream", "upstream_terminal_v1"].includes(arm)
            ? UPSTREAM_MIKE_SCHEMA_SHA256
            : null,
        upstream_terminal_delta:
          arm === "upstream_terminal_v1" ? UPSTREAM_TERMINAL_DELTA : null,
        upstream_native_delta:
          arm === "mike_upstream_native_v1" ? UPSTREAM_NATIVE_DELTA : null,
        requirements_echo_delta: [
          "mike_markdown_e2e_treatment_v1",
          "mike_markdown_e2e_treatment_v2",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? REQUIREMENTS_ECHO_DELTA
          : null,
        citation_contract_delta:
          arm === "mike_markdown_e2e_treatment_v1"
            ? CITATION_CONTRACT_DELTA
            : null,
        citation_contract_v2_delta: [
          "mike_markdown_e2e_treatment_v2",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? CITATION_CONTRACT_V2_DELTA
          : null,
        no_deferral_delta: [
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? NO_DEFERRAL_DELTA
          : null,
        markdown_e2e_treatment_delta:
          arm === "mike_markdown_e2e_treatment_v1"
            ? MARKDOWN_E2E_TREATMENT_DELTA
            : null,
        markdown_e2e_treatment_v2_delta:
          arm === "mike_markdown_e2e_treatment_v2"
            ? MARKDOWN_E2E_TREATMENT_V2_DELTA
            : null,
        markdown_e2e_index_treatment_delta: [
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_INDEX_TREATMENT_DELTA
          : null,
        markdown_e2e_index_treatment_v2_delta:
          arm === "mike_markdown_e2e_index_treatment_v2"
            ? MARKDOWN_E2E_INDEX_TREATMENT_V2_DELTA
            : null,
        exposure_echo_delta:
          arm === "mike_markdown_e2e_index_treatment_v2"
            ? EXPOSURE_ECHO_DELTA
            : null,
        compact_author_delta:
          arm === "mike_compact_author_v1" ? COMPACT_AUTHOR_MIKE_DELTA : null,
        markdown_swap_delta:
          [
            "mike_markdown_swap_v1",
            "mike_markdown_e2e_v1",
            "mike_markdown_e2e_index_v1",
            "mike_markdown_e2e_floor_v1",
            "mike_markdown_e2e_index_floor_v1",
          ].includes(arm)
            ? MARKDOWN_SWAP_DELTA
            : null,
        markdown_e2e_delta:
          arm === "mike_markdown_e2e_v1" ? MARKDOWN_E2E_DELTA : null,
        markdown_e2e_index_delta:
          arm === "mike_markdown_e2e_index_v1" ? MARKDOWN_E2E_INDEX_DELTA : null,
        markdown_e2e_floor_delta: [
          "mike_markdown_e2e_floor_v1",
          "mike_markdown_e2e_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_FLOOR_DELTA
          : null,
        markdown_e2e_index_floor_delta: [
          "mike_markdown_e2e_index_floor_v1",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_INDEX_FLOOR_DELTA
          : null,
        lean_batch_delta:
          [
            "lean_batch_v1",
            "lean_batch_hardrefs_v1",
            "coding_markdown_v1",
            "coding_markdown_v2",
          ].includes(arm)
            ? LEAN_BATCH_DELTA
            : null,
        coding_markdown_delta:
          ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
            ? CODING_MARKDOWN_DELTA
            : null,
        coding_neutral_prompt_delta:
          ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
            ? CODING_NEUTRAL_PROMPT_DELTA
            : null,
        coding_markdown_v2_delta:
          arm === "coding_markdown_v2" ? CODING_MARKDOWN_V2_DELTA : null,
        coding_parity_delta:
          arm === "coding_markdown_v2" ? CODING_PARITY_DELTA : null,
        lean_batch_hardrefs_delta:
          arm === "lean_batch_hardrefs_v1"
            ? LEAN_BATCH_HARDREFS_DELTA
            : null,
        adaptive_mike_delta:
          arm === "adaptive_mike_v1" ? ADAPTIVE_MIKE_DELTA : null,
        mike_grep_delta: mikeGrepDelta,
        grounded_structure_outline_delta:
          arm === "grounded_structure_outline_v1"
            ? GROUNDED_STRUCTURE_OUTLINE_DELTA
            : null,
        strategy_reconstruction:
          arm === "v5_reconstruction_v1"
            ? {
                historical_run:
                  "finalist-luna-long-v5/hybrid_finalist/high/corporate-ma/analyze-change-of-control-provisions-across-targets-material-contracts",
                fidelity: "strategy reconstruction on current committed code",
                deliberate_deviations: [
                  "provider tier requested null instead of historical fast",
                  "current source tree is fingerprinted because the historical dirty tree was not",
                  "grouped 96-character selection previews replace the historical ungrouped manifest",
                  "invalid evidence aliases do not replay the historical giant manifest",
                ],
              }
            : null,
        upstream_mike_isolation_verified:
          ["upstream", "upstream_terminal_v1"].includes(arm) ? true : null,
        upstream_terminal_isolation_verified:
          arm === "upstream_terminal_v1" ? true : null,
        adaptive_mike_isolation_verified:
          arm === "adaptive_mike_v1" ? true : null,
        compact_author_isolation_verified:
          arm === "mike_compact_author_v1" ? true : null,
        markdown_swap_isolation_verified:
          ["mike_markdown_swap_v1", "mike_markdown_e2e_v1"].includes(arm)
            ? true
            : null,
        markdown_e2e_isolation_verified:
          [
            "mike_markdown_e2e_v1",
            "mike_markdown_e2e_index_v1",
            "mike_markdown_e2e_floor_v1",
            "mike_markdown_e2e_index_floor_v1",
          ].includes(arm)
            ? true
            : null,
        lean_batch_isolation_verified:
          ["lean_batch_v1", "lean_batch_hardrefs_v1"].includes(arm)
            ? true
            : null,
        mike_grep_isolation_verified: mikeGrepDerived ? true : null,
        v5_strategy_isolation_verified:
          arm === "v5_reconstruction_v1" ? true : null,
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
        logical_input_tokens: inputTokens,
        // Round count separated from invocation count: deepseek drives the
        // loop as one invocation per round (rounds reported as invocations),
        // claude-p as one invocation with per-iteration context rounds. The
        // cache-adjusted input headline conflates context volume with turn
        // count without this.
        provider_round_count: contextRounds.length || providerInvocations.length,
        output_tokens: outputTokens,
        reasoning_tokens: reasoningTokens,
        total_tokens: inputTokens + outputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_write_input_tokens: cacheWriteInputTokens,
        cache_read_reporting_complete: cacheReadReportingComplete,
        cache_write_reporting_complete: cacheWriteReportingComplete,
        cache_read_ratio: cacheReadRatio,
        cache_write_ratio: cacheWriteRatio,
        uncached_input_tokens:
          cacheReadReportingComplete && cacheWriteReportingComplete
            ? Math.max(
                0,
                inputTokens -
                  cacheReadInputTokens -
                  cacheWriteInputTokens,
              )
            : null,
        cache_adjusted_input_token_equivalent:
          cacheAdjustedInputTokenEquivalent,
        cache_adjusted_input_lower_bound: cacheAdjustedInputLowerBound,
        cache_adjusted_input_upper_bound: cacheAdjustedInputUpperBound,
        api_price_equivalent: apiPriceEquivalent,
        token_source: tokenSource,
        service_tier_requested: serviceTier || null,
        service_tiers_reported: [...reportedServiceTiers],
        model_coverage_routing: surface?.model_coverage_routing === true,
        whole_read_max_chars: surface?.whole_read_max_chars ?? null,
        tool_result_max_chars: surface?.tool_result_max_chars ?? null,
        suppress_duplicate_whole_reads:
          surface?.suppress_duplicate_whole_reads ?? null,
        hard_reference_hints: surface?.hard_reference_hints === true,
        grounded_outline_injection:
          surface?.grounded_outline_injection === true,
        grounded_outline_injection_chars:
          surface?.grounded_outline_injection_chars ?? null,
        trajectory_mode: surface?.trajectory_mode ?? null,
        continuous_evidence: surface?.continuous_evidence === true,
        working_set_page_max_chars:
          surface?.working_set_page_max_chars ?? null,
        working_set_grep_default_head_limit:
          surface?.working_set_grep_default_head_limit ?? null,
        working_set_grep_max_head_limit:
          surface?.working_set_grep_max_head_limit ?? null,
        working_set_grep_line_max_chars:
          surface?.working_set_grep_line_max_chars ?? null,
        wall_clock_seconds: Math.round(wallClock * 100) / 100,
        provider_invocation_count: providerInvocations.length,
        provider_request_count: providerRequestCount,
        provider_total_latency_ms: providerTotalLatencyMs,
        provider_invocations: providerInvocations,
        prompt_cache_strategies: [...promptCacheStrategies],
        prompt_cache_key_sha256s: [...promptCacheKeyHashes],
        compaction_count: compactions.length,
        compaction_usage_complete: compactionUsageComplete,
        compaction_reported_input_tokens: compactionReportedInputTokens,
        compaction_estimated_input_tokens: compactionEstimatedInputTokens,
        compaction_latency_ms: compactionLatencyMs,
        compaction_request_input_bytes: compactions.reduce(
          (total, compaction) =>
            total + Number(compaction.requestInputBytes ?? 0),
          0,
        ),
        compaction_output_bytes: compactions.reduce(
          (total, compaction) => total + Number(compaction.outputBytes ?? 0),
          0,
        ),
        compaction_compression_ratio: compactions.length
          ? compactions.reduce(
              (total, compaction) =>
                total + Number(compaction.outputBytes ?? 0),
              0,
            ) /
            Math.max(
              1,
              compactions.reduce(
                (total, compaction) =>
                  total + Number(compaction.requestInputBytes ?? 0),
                0,
              ),
            )
          : null,
        compactions,
        finished_cleanly: true,
        completed_at: new Date().toISOString(),
        deliverable_count: deliverableReceipts.length,
        deliverable_chars: deliverableReceipts.reduce(
          (total, receipt) => total + (receipt.text_chars ?? 0),
          0,
        ),
        required_deliverable_mapping: requiredDeliverableMapping,
        deliverable_receipts: deliverableReceipts,
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
              ...(Array.isArray(input.paths) ? input.paths : []),
            ].filter((value): value is string => typeof value === "string");
            return uploadedDocuments
              .filter((doc, index) =>
                values.some(
                  (value) =>
                    value === doc.id ||
                    value === doc.uploaded ||
                    value === doc.source ||
                    // The chat surface addresses documents positionally
                    // (doc-0, doc-1, ... in upload order) — the only ID the
                    // model ever sees for read_document/fetch_documents.
                    value === `doc-${index}`,
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
        documents_candidate_only: exposure.documents_candidate_only,
        candidate_span_chars: exposure.candidate_span_chars,
        total_documents: documents.length,
        source_text_chars: sourceTextChars,
        failed_tool_calls: results.filter(
          (result) => !result.ok && !result.checkpoint_gate,
        ).length,
        checkpoint_gate_calls: results.filter(
          (result) => Boolean(result.checkpoint_gate),
        ).length,
        zero_yield_tool_calls: results.filter((result) => result.zero_yield).length,
        tool_call_count: calls.length,
        ask_inputs_terminated: askInputsTerminated,
        turn_termination_reason:
          turnTerminations.at(-1)?.reason ?? null,
        echo_call_count: echoCallCount,
        documents_unread_at_echo: documentsUnreadAtEcho,
        documents_oriented_only_at_echo: documentsOrientedOnlyAtEcho,
        hard_reference_hints_offered: hardReferenceHints.length,
        hard_reference_hints_followed: followedHardReferenceHints.length,
        hard_reference_hint_follow_rate:
          hardReferenceHints.length > 0
            ? followedHardReferenceHints.length / hardReferenceHints.length
            : null,
        tool_result_chars: results.reduce(
          (total, result) => total + result.content_chars,
          0,
        ),
        structure_paths_discovered: discoveredStructurePaths.size,
        structure_paths_followed: followedDiscoveredStructurePaths.size,
        structure_path_follow_rate:
          discoveredStructurePaths.size > 0
            ? followedDiscoveredStructurePaths.size /
              discoveredStructurePaths.size
            : null,
        structure_path_locator_kinds: structurePathLocatorKinds,
        structure_path_tool_calls: structurePathCalls.length,
        structure_path_read_calls: structurePathCalls.filter(
          (call) => call.name === "Read",
        ).length,
        structure_path_grep_calls: structurePathCalls.filter(
          (call) => call.name === "Grep",
        ).length,
        structure_path_not_found_calls: results.filter(
          (result) =>
            structurePathCallIds.has(result.id) &&
            result.status === "not_found",
        ).length,
        structure_path_evidence_chars:
          structurePathEvidence.unique_source_span_chars,
        structure_path_evidence_replay_ratio:
          structurePathEvidence.gross_replay_ratio,
        duplicate_read_calls: results.filter((result) => result.already_read)
          .length,
        duplicate_exposure_calls: results.filter(
          (result) => result.already_exposed,
        ).length,
        research_tool_calls: results.filter(
          (result) =>
            result.phase === "research" && result.name !== "generate_docx",
        ).length,
        // The single-conversation lab chassis never flips the harness
        // draftingPhase flag, so tool_call_start stamps generate_docx as
        // "research". The deliverable call IS the drafting phase here.
        drafting_tool_calls: results.filter(
          (result) =>
            result.phase === "drafting" ||
            (result.phase === "research" && result.name === "generate_docx"),
        ).length,
        continuous_tool_calls: results.filter(
          (result) => result.phase === "continuous",
        ).length,
        working_set_paging_calls: workingSetPagingResults.length,
        working_set_paging_result_chars: workingSetPagingResults.reduce(
          (total, result) => total + result.content_chars,
          0,
        ),
        working_set_paging_max_result_chars: Math.max(
          0,
          ...workingSetPagingResults.map((result) => result.content_chars),
        ),
        working_set_paging_duplicate_calls: workingSetPagingResults.filter(
          (result) => result.already_exposed,
        ).length,
        not_found_tool_calls: results.filter(
          (result) => result.status === "not_found",
        ).length,
        ambiguous_tool_calls: results.filter(
          (result) => result.status === "ambiguous",
        ).length,
        evidence_selection_calls: results.filter(
          (result) => result.status === "selection_required",
        ).length,
        past_end_tool_calls: results.filter(
          (result) => result.status === "past_end",
        ).length,
        research_context_refresh_count: researchContextRefreshes.length,
        research_context_refreshes: researchContextRefreshes,
        research_checkpoint_request_count: researchCheckpointRequests.length,
        research_checkpoint_requests: researchCheckpointRequests,
        research_checkpoint_count: researchCheckpoints.length,
        research_checkpoints: researchCheckpoints,
        initial_research_checkpoint_count: initialResearchCheckpoints.length,
        initial_research_checkpoint_max_count:
          surface?.initial_research_checkpoint_max_count ?? null,
        research_checkpoint_failure_count: researchCheckpointFailures.length,
        research_checkpoint_failures: researchCheckpointFailures,
        checkpoint_handoff_hash_mismatch_count:
          checkpointHandoffMismatches.length,
        checkpoint_handoff_hash_audit: checkpointHandoffAudit,
        evidence_handoff: evidenceHandoff,
        evidence_handoff_count: evidenceHandoffs.length,
        evidence_handoffs: evidenceHandoffs,
        evidence_orientation_chars: Number(
          evidenceHandoff?.orientation_chars ?? 0,
        ),
        evidence_working_set: evidenceWorkingSetArtifact,
        evidence_working_set_update_count: evidenceWorkingSetUpdates.length,
        evidence_working_set_updates: evidenceWorkingSetUpdates,
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
        union_unique_source_chars: results.reduce(
          (total, result) => total + result.union_unique_source_chars,
          0,
        ),
        union_suppressed_source_chars: results.reduce(
          (total, result) => total + result.union_suppressed_source_chars,
          0,
        ),
        reviewed_union_reuse_calls: results.filter(
          (result) => result.reviewed_union_reuse_source_chars > 0,
        ).length,
        reviewed_union_reuse_source_chars: results.reduce(
          (total, result) =>
            total + result.reviewed_union_reuse_source_chars,
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
        research_context_refreshes: researchContextRefreshes,
        research_checkpoint_requests: researchCheckpointRequests,
        research_checkpoints: researchCheckpoints,
        research_checkpoint_failures: researchCheckpointFailures,
        checkpoint_handoff_hash_audit: checkpointHandoffAudit,
        evidence_handoff: evidenceHandoff,
        evidence_handoffs: evidenceHandoffs,
        evidence_working_set: evidenceWorkingSetArtifact,
        evidence_working_set_updates: evidenceWorkingSetUpdates,
        uploaded_documents: uploadedDocuments,
        source_receipts: sourceReceipts,
        context_rounds: contextRounds,
        compactions,
        prompt_cache: {
          strategies: [...promptCacheStrategies],
          key_sha256s: [...promptCacheKeyHashes],
          cache_read_reporting_complete: cacheReadReportingComplete,
          cache_write_reporting_complete: cacheWriteReportingComplete,
          api_price_equivalent: apiPriceEquivalent,
        },
        provider_invocations: providerInvocations,
        run_fingerprint: runFingerprintInput,
        run_fingerprint_sha256: runFingerprintSha256,
        wrapped_uploads: wrappedUploads,
        office_pdf_rendition: officePdfRendition,
        deliverables,
        required_deliverable_mapping: requiredDeliverableMapping,
        docs_created: authored.map((doc) => doc.filename),
        deliverable_sources: deliverableSources,
        deliverable_receipts: deliverableReceipts,
        research_tools_disabled: true,
        upstream_mike_commit: upstreamDerived ? UPSTREAM_MIKE_COMMIT : null,
        upstream_mike_source_blobs: upstreamDerived
          ? UPSTREAM_MIKE_SOURCE_BLOBS
          : null,
        upstream_mike_schema_sha256:
          ["upstream", "upstream_terminal_v1"].includes(arm)
            ? UPSTREAM_MIKE_SCHEMA_SHA256
            : null,
        upstream_terminal_delta:
          arm === "upstream_terminal_v1" ? UPSTREAM_TERMINAL_DELTA : null,
        upstream_native_delta:
          arm === "mike_upstream_native_v1" ? UPSTREAM_NATIVE_DELTA : null,
        requirements_echo_delta: [
          "mike_markdown_e2e_treatment_v1",
          "mike_markdown_e2e_treatment_v2",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? REQUIREMENTS_ECHO_DELTA
          : null,
        citation_contract_delta:
          arm === "mike_markdown_e2e_treatment_v1"
            ? CITATION_CONTRACT_DELTA
            : null,
        citation_contract_v2_delta: [
          "mike_markdown_e2e_treatment_v2",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? CITATION_CONTRACT_V2_DELTA
          : null,
        no_deferral_delta: [
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? NO_DEFERRAL_DELTA
          : null,
        markdown_e2e_treatment_delta:
          arm === "mike_markdown_e2e_treatment_v1"
            ? MARKDOWN_E2E_TREATMENT_DELTA
            : null,
        markdown_e2e_treatment_v2_delta:
          arm === "mike_markdown_e2e_treatment_v2"
            ? MARKDOWN_E2E_TREATMENT_V2_DELTA
            : null,
        markdown_e2e_index_treatment_delta: [
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_INDEX_TREATMENT_DELTA
          : null,
        markdown_e2e_index_treatment_v2_delta:
          arm === "mike_markdown_e2e_index_treatment_v2"
            ? MARKDOWN_E2E_INDEX_TREATMENT_V2_DELTA
            : null,
        exposure_echo_delta:
          arm === "mike_markdown_e2e_index_treatment_v2"
            ? EXPOSURE_ECHO_DELTA
            : null,
        compact_author_delta:
          arm === "mike_compact_author_v1" ? COMPACT_AUTHOR_MIKE_DELTA : null,
        markdown_swap_delta:
          [
            "mike_markdown_swap_v1",
            "mike_markdown_e2e_v1",
            "mike_markdown_e2e_index_v1",
            "mike_markdown_e2e_floor_v1",
            "mike_markdown_e2e_index_floor_v1",
          ].includes(arm)
            ? MARKDOWN_SWAP_DELTA
            : null,
        markdown_e2e_delta:
          arm === "mike_markdown_e2e_v1" ? MARKDOWN_E2E_DELTA : null,
        markdown_e2e_index_delta:
          arm === "mike_markdown_e2e_index_v1" ? MARKDOWN_E2E_INDEX_DELTA : null,
        markdown_e2e_floor_delta: [
          "mike_markdown_e2e_floor_v1",
          "mike_markdown_e2e_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_FLOOR_DELTA
          : null,
        markdown_e2e_index_floor_delta: [
          "mike_markdown_e2e_index_floor_v1",
          "mike_markdown_e2e_index_treatment_v1",
          "mike_markdown_e2e_index_treatment_v2",
        ].includes(arm)
          ? MARKDOWN_E2E_INDEX_FLOOR_DELTA
          : null,
        lean_batch_delta:
          [
            "lean_batch_v1",
            "lean_batch_hardrefs_v1",
            "coding_markdown_v1",
            "coding_markdown_v2",
          ].includes(arm)
            ? LEAN_BATCH_DELTA
            : null,
        coding_markdown_delta:
          ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
            ? CODING_MARKDOWN_DELTA
            : null,
        coding_neutral_prompt_delta:
          ["coding_markdown_v1", "coding_markdown_v2"].includes(arm)
            ? CODING_NEUTRAL_PROMPT_DELTA
            : null,
        coding_markdown_v2_delta:
          arm === "coding_markdown_v2" ? CODING_MARKDOWN_V2_DELTA : null,
        coding_parity_delta:
          arm === "coding_markdown_v2" ? CODING_PARITY_DELTA : null,
        lean_batch_hardrefs_delta:
          arm === "lean_batch_hardrefs_v1"
            ? LEAN_BATCH_HARDREFS_DELTA
            : null,
        adaptive_mike_delta:
          arm === "adaptive_mike_v1" ? ADAPTIVE_MIKE_DELTA : null,
        mike_grep_delta: mikeGrepDelta,
        grounded_structure_outline_delta:
          arm === "grounded_structure_outline_v1"
            ? GROUNDED_STRUCTURE_OUTLINE_DELTA
            : null,
        v5_strategy_reconstruction:
          arm === "v5_reconstruction_v1" ? true : null,
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
  // Typed terminal outcomes: a context overflow on a 200K-class model is the
  // MEASURED RESULT of a whole-read arm on a no-fit task, and a quota wall
  // must be distinguishable from a crashed run. Recorded in run-state.json so
  // the results tree carries the reason instead of a permanent
  // "provider_call_pending" stub.
  const text = String((error as Error)?.message ?? error);
  const status = /prompt is too long|blocking_limit/iu.test(text)
    ? "context_overflow"
    : /hit your (?:weekly |session )?limit/iu.test(text)
      ? "quota_exhausted"
      : "failed";
  if (activeRunDir) {
    try {
      const statePath = path.join(activeRunDir, "run-state.json");
      const prior = existsSync(statePath)
        ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<
            string,
            unknown
          >)
        : {};
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            ...prior,
            status,
            error: text.slice(0, 1_000),
            failed_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch {
      // The typed receipt is best-effort; the console error above stands.
    }
  }
  process.exit(1);
});
