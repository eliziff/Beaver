import {
  streamChatWithTools,
  type LlmMessage,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type OpenAIToolSchema,
  type StreamChatResult,
  type SubagentMode,
  type UserApiKeys,
} from "../llm";
import { isAbortError } from "../llm/abort";
import { safeErrorMessage } from "../safeError";
import type { McpToolEvent } from "../mcpConnectors";
import type {
  CaseCitationEvent,
  CourtlistenerToolEvent,
} from "./tools/courtlistenerTools";
import { assistantToolActivityLabel } from "./tools/a2ajTools";
import type { AskInputsEvent, EditAnnotation } from "./types";
import { createLegalEvidenceCitations } from "./citations";
import {
  GROUNDED_LEGAL_REPAIR_INSTRUCTION,
  UNVERIFIED_LEGAL_ANSWER,
  hasModelAuthoredLegalSourceUrl,
} from "./legalOutputGate";
import {
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  LEGAL_EVIDENCE_TOOL_NAME,
  legalEvidenceReceiptEvent,
  registerPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceReceiptEvent,
  type LegalEvidenceTurnState,
} from "./legalEvidence";
import {
  READ_SUBAGENT_TOOL,
  READ_SUBAGENT_TOOL_NAME,
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  readSubagentActivityLabel,
  readSubagentJurisdiction,
  readSubagentSourceTypes,
  readSubagentTools,
  runReadSubagent,
  runReadSubagentRound,
  type ReadSubagentEvent,
} from "./readSubagents";
import { jurisdictionPreferencePrompt, type JurisdictionPreference } from "./prompts";

export type AssistantEvent =
  | { type: "reasoning"; text: string; debug?: boolean }
  | AskInputsEvent
  | {
      type: "ask_inputs_response";
      responses: {
        id: string;
        kind: "choice" | "documents";
        question?: string;
        answer?: string;
        filenames?: string[];
        skipped?: boolean;
      }[];
    }
  | { type: "doc_read"; filename: string; document_id?: string }
  | { type: "doc_find"; filename: string; query: string; total_matches: number }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      version_number: number | null;
      download_url: string;
      annotations: EditAnnotation[];
    }
  | CaseCitationEvent
  | CourtlistenerToolEvent
  | McpToolEvent
  | LegalEvidenceReceiptEvent
  | ReadSubagentEvent
  | { type: "case_opinions"; cluster_id: number; case: unknown }
  | { type: "content"; text: string }
  | { type: "error"; message: string };

export class AssistantStreamError extends Error {
  constructor(
    message: string,
    readonly fullText: string,
    readonly events: AssistantEvent[],
  ) {
    super(message);
    this.name = "AssistantStreamError";
  }
}

class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

export type ChatToolContext = {
  evidence: LegalEvidenceTurnState;
  emit: (event: unknown) => void;
  addEvent: (event: AssistantEvent) => void;
};

export type ChatToolBatch = {
  results: NormalizedToolResult[];
  pause?: AskInputsEvent;
};

export type ChatToolRunner = (
  calls: NormalizedToolCall[],
  context: ChatToolContext,
) => Promise<ChatToolBatch>;

export type ChatTurnResult = {
  status: "complete" | "paused";
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
  continuationId?: string;
  evidence: LegalEvidenceTurnState;
};

function contentBoundarySeparator(before: string, after: string) {
  if (!before || !after || /\s$/u.test(before) || /^\s/u.test(after)) return "";
  const previous = before.at(-1) ?? "";
  const next = after[0] ?? "";
  if (/^[,.;:!?)}\]]$/u.test(next) || /^[-/\\'’–—]$/u.test(previous)) return "";
  return /[\p{L}\p{N}]$/u.test(previous) && /^[\p{Ll}\p{M}]/u.test(next)
    ? ""
    : " ";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const error = new Error("Stream aborted.");
  error.name = "AbortError";
  throw error;
}

export async function runChatTurn(options: {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools: OpenAIToolSchema[];
  readerTools?: OpenAIToolSchema[];
  createToolRunner: (
    evidence: LegalEvidenceTurnState,
    scope: "main" | "reader",
  ) => ChatToolRunner;
  emit: (event: unknown) => void;
  done: () => void;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  serviceTier?: string;
  compactThreshold?: number;
  promptCacheKey?: string;
  signal?: AbortSignal;
  subagentMode?: SubagentMode;
  subagentModel?: string;
  subagentEffort?: string;
  jurisdictionPreference?: JurisdictionPreference | null;
  activityDetail?: "auto" | "standard" | "tools" | "trace";
  toolActivityMetadata?: (call: NormalizedToolCall) => Record<string, unknown>;
  priorEvidence?: LegalEvidenceReceipt[];
  providerSession?: { persist: true; continuationId?: string };
  canRetryProviderSession?: () => boolean;
  separateContentBlocks?: boolean;
  beforeFinalize?: (context: ChatToolContext) => Promise<void> | void;
  transformText?: (text: string, citations: unknown[]) => Promise<string> | string;
  onSubagentEvent?: (event: ReadSubagentEvent) => void;
  onFinish?: (result: ChatTurnResult) => Promise<void> | void;
}) {
  const {
    emit,
    activityDetail = "auto",
    subagentMode = "none",
    signal,
  } = options;
  const events: AssistantEvent[] = [];
  const evidence = createLegalEvidenceTurnState();
  registerPriorLegalEvidence(evidence, options.priorEvidence ?? []);
  const addEvent = (event: AssistantEvent) => events.push(event);
  const context: ChatToolContext = { evidence, emit, addEvent };
  const mainTools = options.createToolRunner(evidence, "main");
  const tools = [
    ...options.tools,
    ...(subagentMode === "beaver" ? [READ_SUBAGENT_TOOL] : []),
    LEGAL_EVIDENCE_SUBMIT_TOOL,
  ];
  const request = [...options.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
  const admitReaders = createReadSubagentAdmission(
    4,
    allowedReadSubagentRegions(options.jurisdictionPreference ?? null, request),
  );
  let text = "";
  let reasoning = "";
  let boundary = false;
  let paused: AskInputsEvent | undefined;
  let providerActivity = false;
  const providerAbort = new AbortController();
  const providerSignal = signal
    ? AbortSignal.any([signal, providerAbort.signal])
    : providerAbort.signal;

  const append = (delta: string) => {
    if (!delta || paused) return;
    if (boundary) {
      boundary = false;
      const separator = contentBoundarySeparator(text, delta);
      if (separator) {
        text += separator;
        emit({ type: "content_delta", text: separator });
      }
    }
    text += delta;
    emit({ type: "content_delta", text: delta });
  };
  const partialEvents = () => {
    if (reasoning) addEvent({ type: "reasoning", text: reasoning, debug: true });
    if (text) addEvent({ type: "content", text });
    reasoning = "";
  };
  const toolContext = (state: LegalEvidenceTurnState): ChatToolContext => ({
    evidence: state,
    emit,
    addEvent,
  });
  const runTools = async (calls: NormalizedToolCall[]) => {
    throwIfAborted(signal);
    const results = await runReadSubagentRound({
      calls,
      admit: admitReaders,
      runDirect: async (direct) => {
        const batch = await mainTools(direct, context);
        if (batch.pause) paused = batch.pause;
        return batch.results;
      },
      runReader: (call) => {
        const childEvidence = createLegalEvidenceTurnState("citation_structure");
        const childTools = options.createToolRunner(childEvidence, "reader");
        return runReadSubagent({
          call,
          tools: [
            ...readSubagentTools(
              options.readerTools ?? options.tools,
              readSubagentJurisdiction(call),
              readSubagentSourceTypes(call),
            ),
            LEGAL_EVIDENCE_SUBMIT_TOOL,
          ],
          evidenceState: childEvidence,
          publishEvidenceTo: evidence,
          model: options.subagentModel,
          effort: options.subagentEffort,
          activityDetail,
          jurisdictionPrompt: jurisdictionPreferencePrompt(
            options.jurisdictionPreference ?? null,
          ),
          signal,
          onEvent: (event) => {
            emit(event);
            options.onSubagentEvent?.(event);
            if (event.status !== "running") addEvent(event);
          },
          runTools: async (childCalls) =>
            (await childTools(childCalls, toolContext(childEvidence))).results,
        });
      },
    });
    if (paused) {
      text = "";
      boundary = false;
      emit({ type: "content_reset" });
      addEvent(paused);
      emit(paused);
      providerAbort.abort();
    }
    const grounded = renderLegalEvidenceAnswer(evidence);
    if (grounded !== null) {
      text = grounded;
      boundary = false;
      emit({ type: "content_snapshot", text: grounded });
      emit({
        type: "citations",
        status: "partial",
        citations: createLegalEvidenceCitations(evidence),
      });
    }
    return results;
  };
  const callbacks = {
    onContentDelta(delta: string) {
      if (delta) providerActivity = true;
      append(delta);
    },
    onContentBlockEnd() {
      if (!paused && options.separateContentBlocks !== false) {
        boundary = Boolean(text);
        emit({ type: "content_block_end" });
      }
    },
    onReasoningDelta(delta: string) {
      if (activityDetail !== "auto" && activityDetail !== "trace") return;
      if (delta) providerActivity = true;
      if (!paused) {
        reasoning += delta;
        emit({ type: "reasoning_delta", text: delta, debug: true });
      }
    },
    onReasoningBlockEnd() {
      if (activityDetail !== "auto" && activityDetail !== "trace") return;
      if (reasoning) addEvent({ type: "reasoning", text: reasoning, debug: true });
      reasoning = "";
      if (!paused) emit({ type: "reasoning_block_end" });
    },
    onToolCallStart(call: NormalizedToolCall) {
      providerActivity = true;
      if (
        call.name === LEGAL_EVIDENCE_TOOL_NAME ||
        (call.name === READ_SUBAGENT_TOOL_NAME && activityDetail === "standard")
      ) return;
      boundary = Boolean(text);
      const label = call.name === READ_SUBAGENT_TOOL_NAME
        ? readSubagentActivityLabel(call.input)
        : assistantToolActivityLabel(call.name, call.input);
      if (label === null) return;
      emit({
        type: "tool_call_start",
        name: call.name,
        ...(label && { label }),
        ...((activityDetail === "tools" || activityDetail === "trace") && {
          id: call.id,
          input: call.input,
        }),
        ...options.toolActivityMetadata?.(call),
      });
    },
  };
  const provider = (
    continuationId?: string,
    repair?: { draft: string; findings: string },
  ) => streamChatWithTools({
    model: options.model,
    systemPrompt: continuationId ? "" : options.systemPrompt,
    messages: [
      ...(continuationId ? options.messages.slice(-1) : options.messages),
      ...(repair
        ? [
            { role: "assistant" as const, content: repair.draft },
            { role: "user" as const, content: repair.findings },
          ]
        : []),
    ],
    tools,
    runTools,
    callbacks,
    apiKeys: options.apiKeys,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    compactThreshold: options.compactThreshold,
    promptCacheKey: options.promptCacheKey,
    nativeSubagents: subagentMode === "native",
    enableThinking: true,
    reasoningSummary:
      activityDetail === "auto" || activityDetail === "trace" ? "auto" : "none",
    abortSignal: providerSignal,
    providerSession: options.providerSession
      ? { persist: true, ...(continuationId ? { continuationId } : {}) }
      : undefined,
  });

  let providerResult: StreamChatResult | undefined;
  try {
    throwIfAborted(signal);
    try {
      providerResult = await provider(options.providerSession?.continuationId);
    } catch (error) {
      if (
        options.providerSession?.continuationId &&
        !providerActivity && !paused && !signal?.aborted &&
        options.canRetryProviderSession?.() !== false
      ) {
        providerResult = await provider();
      } else {
        throw error;
      }
    }
    if (!paused && renderLegalEvidenceAnswer(evidence) === null &&
        hasModelAuthoredLegalSourceUrl(text)) {
      const rejected = text;
      text = "";
      boundary = false;
      emit({ type: "content_reset" });
      providerResult = await provider(providerResult?.continuationId, {
        draft: rejected,
        findings: GROUNDED_LEGAL_REPAIR_INSTRUCTION,
      });
      if (renderLegalEvidenceAnswer(evidence) === null) text = UNVERIFIED_LEGAL_ANSWER;
    }
  } catch (error) {
    if (!paused) {
      partialEvents();
      if (isAbortError(error)) throw new AssistantStreamAbortError(text, events);
      const message = safeErrorMessage(error, "Stream error");
      addEvent({ type: "error", message });
      throw new AssistantStreamError(message, text, events);
    }
  }

  if (!paused) {
    await options.beforeFinalize?.(context);
    await finalizeLegalEvidenceExperiment({
      state: evidence,
      model: options.model,
      draft: text,
      requestContext: request || undefined,
      apiKeys: options.apiKeys,
      reasoningEffort: options.reasoningEffort,
      abortSignal: signal,
    });
    text = renderLegalEvidenceAnswer(evidence) ?? text.trimEnd();
  }
  const citations = paused ? [] : createLegalEvidenceCitations(evidence);
  if (!paused && options.transformText) {
    const transformed = await options.transformText(text, citations);
    if (transformed !== text) {
      if (transformed.startsWith(text)) {
        emit({ type: "content_delta", text: transformed.slice(text.length) });
      } else {
        emit({ type: "content_reset" });
        emit({ type: "content_delta", text: transformed });
      }
      text = transformed;
    }
  }
  const receipt = legalEvidenceReceiptEvent(evidence);
  if (receipt) addEvent(receipt);
  if (text) addEvent({ type: "content", text });
  const result: ChatTurnResult = {
    status: paused ? "paused" : "complete",
    fullText: text,
    events,
    citations,
    continuationId: providerResult?.continuationId,
    evidence,
  };
  emit({ type: "content_final", text });
  await options.onFinish?.(result);
  emit({ type: "citations", status: "final", citations });
  options.done();
  return result;
}

export { isAbortError };
