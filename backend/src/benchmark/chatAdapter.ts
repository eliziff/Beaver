import { createHash } from "node:crypto";
import type { NormalizedToolCall, NormalizedToolResult } from "../lib/llm";
import type {
  ChatToolContext,
  ChatToolRunner,
} from "../lib/chat/turnEngine";
import type { LegalEvidenceTurnState } from "../lib/chat/legalEvidence";
import type { ToolEntry } from "../lib/chat/toolRegistry";

type ToolFactory = (
  evidence: LegalEvidenceTurnState,
  scope: "main" | "reader",
) => ToolEntry<ChatToolContext>[];

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function resultEvent(call: NormalizedToolCall, result?: NormalizedToolResult) {
  const content = result?.content ?? "";
  let payload: Record<string, unknown> | null = null;
  try { payload = record(JSON.parse(content)); } catch {}
  const status = result?.status ?? "";
  const zeroYield = /^No (?:matches|files|new evidence)\b/iu.test(content) ||
    /\| added 0 units\b/iu.test(content);
  return {
    type: "tool_call_result",
    id: call.id,
    name: call.name,
    phase: "research",
    ok: status !== "error" && (payload?.ok !== false || [
      "not_found", "ambiguous", "past_end", "selection_required",
    ].includes(status)),
    ...(result?.status && { status: result.status }),
    ...(typeof payload?.error === "string" && { error: payload.error }),
    ...(["research_checkpoint_pending", "research_checkpoint_required"]
      .includes(String(payload?.status ?? "")) && { checkpoint_gate: payload?.status }),
    content_chars: content.length,
    content_sha256: hash(content),
    content_preview: content.length <= 2_000
      ? content
      : `${content.slice(0, 1_600)}\n…\n${content.slice(-400)}`,
    ...(zeroYield && { zero_yield: true }),
    ...(payload?.already_read === true && { already_read: true }),
    ...(payload?.already_exposed === true && { already_exposed: true }),
    ...((result?.exposure || typeof payload?.unique_source_chars === "number") && {
      unique_source_chars: result?.exposure?.uniqueSourceChars ?? payload?.unique_source_chars,
    }),
    ...((result?.exposure || typeof payload?.suppressed_source_chars === "number") && {
      suppressed_source_chars: result?.exposure?.suppressedSourceChars ??
        payload?.suppressed_source_chars,
    }),
    ...(typeof payload?.projection === "string" && { projection: payload.projection }),
    ...(result?.evidenceSpans?.length && { evidence_spans: result.evidenceSpans }),
    ...(result?.evidenceSegments?.length && {
      evidence_segments: result.evidenceSegments.map((segment) => ({
        document_id: segment.documentId,
        version_id: segment.versionId,
        start: segment.start,
        end: segment.end,
        ...(segment.filename && { filename: segment.filename }),
        ...(segment.kind && { kind: segment.kind }),
        ...(segment.locator && { locator: segment.locator }),
        ...(segment.virtualPath && { virtual_path: segment.virtualPath }),
        ...(segment.projection && { projection: segment.projection }),
      })),
    }),
    ...(result?.evidenceRefs?.length && {
      evidence_refs: result.evidenceRefs.map((ref) => ({
        handle: ref.handle,
        filename: ref.filename ?? ref.handle,
        ...(ref.locator && { locator: ref.locator }),
        chars: ref.text.length,
        exact_sha256: ref.exactSha256 || hash(ref.text),
        ...(ref.kind && { kind: ref.kind }),
      })),
    }),
    ...(result?.retrievalHints?.length && { retrieval_hints: result.retrievalHints }),
  };
}

export function createChatBenchmarkAdapter(
  emit: (event: unknown) => void,
) {
  const enabled = process.env.MIKE_BENCHMARK_TRACE_TOOLS === "1";
  return {
    toolActivityMetadata: enabled
      ? (call: NormalizedToolCall) => ({ id: call.id, input: call.input })
      : undefined,
    wrap(factory: ToolFactory): ToolFactory {
      if (!enabled) return factory;
      return (evidence, scope) => {
        const entries = factory(evidence, scope);
        if (scope !== "main") return entries;
        const wrapped = new Map<ChatToolRunner, ChatToolRunner>();
        return entries.map((entry) => {
          let execute = wrapped.get(entry.execute);
          if (!execute) {
            const run = entry.execute;
            execute = async (calls, context) => {
              const batch = await run(calls, context);
              for (const call of calls) {
                emit(resultEvent(
                  call,
                  batch.results.find((result) => result.tool_use_id === call.id),
                ));
              }
              return batch;
            };
            wrapped.set(run, execute);
          }
          return { ...entry, execute };
        });
      };
    },
  };
}
