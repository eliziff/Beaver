import {
  streamChatWithTools,
  type LlmMessage,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type ProviderSubagentUpdate,
  type ProviderTurnControl,
  type ProviderContextCheckpoint,
  type SteeringMessage,
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
import type { LocalAutomationEvent } from "./localAutomationEvent";
import { assistantToolActivityLabel } from "./tools/a2ajTools";
import { ASK_INPUTS_TOOL } from "./tools/toolSchemas";
import type { AskInputsEvent, EditAnnotation } from "./types";
import {
  TurnToolRegistry,
  toolText,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { normalizeAskInputsEvent } from "./askInputs";
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
  registerLegalEvidence,
  registerPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  submitLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceReceiptEvent,
  type LegalEvidenceTurnState,
} from "./legalEvidence";
import {
  READ_SUBAGENT_TOOL,
  READ_SUBAGENT_TOOL_NAME,
  RESUME_SUBAGENT_TOOL,
  RESUME_SUBAGENT_TOOL_NAME,
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  readSubagentActivityLabel,
  readSubagentJurisdiction,
  readSubagentResumePrompt,
  readSubagentTools,
  runReadSubagent,
  runReadSubagentRound,
  type ReadSubagentCheckpoint,
  type ReadSubagentEvent,
  type ToolActivity,
} from "./readSubagents";
import { jurisdictionPreferencePrompt, type JurisdictionPreference } from "./prompts";
import {
  estimateContextTokens,
  modelContextWindow,
} from "../llm/contextWindow";

export type AssistantEvent =
  | { type: "reasoning"; text: string; debug?: boolean }
  | ({ type: "tool_activity" } & ToolActivity)
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
      resource?: string;
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
      edit_mode: "manual" | "auto";
      annotations: EditAnnotation[];
      resource: string;
    }
  | CaseCitationEvent
  | CourtlistenerToolEvent
  | McpToolEvent
  | LegalEvidenceReceiptEvent
  | ReadSubagentEvent
  | LocalAutomationEvent
  | { type: "case_opinions"; cluster_id: number; case: unknown }
  | { type: "content"; text: string }
  | { type: "steering"; id: string; text: string }
  | {
      type: "context_usage";
      used_tokens: number;
      window_tokens: number;
    }
  | { type: "compaction"; status: "running" | "completed" | "failed" }
  | {
      type: "context_checkpoint";
      schema_version: 1;
      summary?: string;
      keep_current: boolean;
      provider?: "claude" | "openai";
      payload?: Record<string, unknown>;
    }
  | { type: "turn_status"; status: "cancelled" | "interrupted" }
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
  createTools: (
    evidence: LegalEvidenceTurnState,
    scope: "main" | "reader",
  ) => BeaverTool<ChatToolContext>[];
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
  toolActivityMetadata?: (
    call: NormalizedToolCall,
  ) => { label?: string; source?: ToolActivity["source"] };
  priorEvidence?: LegalEvidenceReceipt[];
  resumableSubagents?: ReadonlyMap<string, ReadSubagentCheckpoint>;
  providerSession?: { persist: true; continuationId?: string };
  onProviderContinuation?: (continuationId: string) => void;
  onProviderControl?: (control: ProviderTurnControl | null) => void;
  canRetryProviderSession?: () => boolean;
  separateContentBlocks?: boolean;
  prepareMessages?: (
    onCompaction: (status: "running" | "completed" | "failed") => void,
  ) => Promise<LlmMessage[]>;
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
  const toolActivities = new Map<string, ToolActivity>();
  const evidence = createLegalEvidenceTurnState();
  registerPriorLegalEvidence(evidence, options.priorEvidence ?? []);
  const addEvent = (event: AssistantEvent) => events.push(event);
  const replaceLastEvent = (
    type: AssistantEvent["type"],
    event: AssistantEvent,
  ) => {
    const index = events.map((candidate) => candidate.type).lastIndexOf(type);
    if (index < 0) events.push(event);
    else events[index] = event;
  };
  const emitToolActivity = (activity: ToolActivity) => {
    toolActivities.set(activity.id, activity);
    const event: AssistantEvent = { type: "tool_activity", ...activity };
    const index = events.findIndex(
      (candidate) => candidate.type === "tool_activity" && candidate.id === activity.id,
    );
    if (index < 0) events.push(event);
    else events[index] = event;
    emit(event);
  };
  const settleToolActivities = (
    status: "error" | "interrupted",
    ids: Iterable<string> = toolActivities.keys(),
  ) => {
    for (const id of ids) {
      const activity = toolActivities.get(id);
      if (activity?.status === "running") emitToolActivity({ ...activity, status });
    }
  };
  const context: ChatToolContext = { evidence, emit, addEvent };
  const internalNames = new Set([
    "ask_inputs",
    LEGAL_EVIDENCE_TOOL_NAME,
    READ_SUBAGENT_TOOL_NAME,
    RESUME_SUBAGENT_TOOL_NAME,
  ]);
  const mainTools = options.createTools(evidence, "main")
    .filter((tool) => !internalNames.has(tool.name));
  const resumableReaders = new Map(options.resumableSubagents);
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
  let activeMessages = options.messages;
  const steering: SteeringMessage[] = [];
  let nativeControl: ProviderTurnControl | null = null;
  let nativeSteering = Promise.resolve();
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
  const evidenceTool = (state: LegalEvidenceTurnState): BeaverTool<ChatToolContext> => ({
    ...LEGAL_EVIDENCE_SUBMIT_TOOL,
    sequential: true,
    async execute(input) {
      const submitted = submitLegalEvidenceAnswer(input, state);
      return {
        result: toolText(submitted),
        ...(submitted.terminal === true ? { terminal: true } : {}),
      };
    },
  });
  const askTool: BeaverTool<ChatToolContext> = {
    ...ASK_INPUTS_TOOL,
    sequential: true,
    async execute(input) {
      const pause = normalizeAskInputsEvent(input);
      return pause.items.length
        ? {
            result: toolText({ ok: true, status: "waiting_for_user" }),
            pause,
          }
        : { result: toolText({ ok: false, error: "No questions supplied" }, true) };
    },
  };
  const normalizedOutcome = (result: NormalizedToolResult): BeaverOutcome => {
    const { tool_use_id: _id, content, terminal, ...metadata } = result;
    return {
      result: toolText(content),
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...(terminal ? { terminal: true } : {}),
    };
  };
  const runReader = (
    call: NormalizedToolCall,
    resume?: ReadSubagentCheckpoint,
  ) => {
    const childEvidence = createLegalEvidenceTurnState("citation_structure");
    const childTools = options.createTools(childEvidence, "reader")
      .filter((tool) => tool.reader === true);
    const assignmentCall = resume
      ? { ...call, input: resume.assignment }
      : call;
    const schemas = readSubagentTools(
      childTools,
      readSubagentJurisdiction(assignmentCall),
    );
    const names = new Set(schemas.map((tool) => tool.name));
    const childRegistry = new TurnToolRegistry([
      ...childTools.filter((tool) => names.has(tool.name)).map((tool) => ({
        ...tool,
        specialist: false,
      })),
      evidenceTool(childEvidence),
    ]);
    return runReadSubagent({
      call,
      tools: childRegistry.visible(),
      evidenceState: childEvidence,
      publishEvidenceTo: evidence,
      model: options.subagentModel,
      effort: options.subagentEffort,
      jurisdictionPrompt: jurisdictionPreferencePrompt(
        options.jurisdictionPreference ?? null,
      ),
      signal,
      resume,
      onEvent: (event) => {
        emit(event);
        options.onSubagentEvent?.(event);
        if (event.status !== "running") addEvent(event);
      },
      runTools: async (childCalls) => {
        const batch = await childRegistry.run(
          childCalls,
          toolContext(childEvidence),
          providerSignal,
        );
        batch.evidence.forEach((receipt) =>
          registerLegalEvidence(childEvidence, receipt));
        return batch.results;
      },
    }).then((result) => {
      if (resume && result.status === "ok") resumableReaders.delete(resume.id);
      return result;
    });
  };
  const readerSchemas = [
    ...(subagentMode === "beaver" ? [READ_SUBAGENT_TOOL] : []),
    ...(subagentMode === "beaver" && resumableReaders.size
      ? [RESUME_SUBAGENT_TOOL]
      : []),
  ];
  const readerTools: BeaverTool<ChatToolContext>[] = readerSchemas.map((schema) => ({
    ...schema,
    specialist: true,
    activity: (input) => schema.name === READ_SUBAGENT_TOOL_NAME
      ? readSubagentActivityLabel(input)
      : "Resuming reading agents",
    async execute(_input, _context, _signal, call) {
      const [result] = await runReadSubagentRound({
        calls: [call],
        admit: admitReaders,
        runDirect: async () => [],
        runReader,
        resumable: resumableReaders,
        runResume: (resumeCall, checkpoint) => runReader(resumeCall, checkpoint),
      });
      return normalizedOutcome(result);
    },
  }));
  const registry = new TurnToolRegistry([
    askTool,
    evidenceTool(evidence),
    ...mainTools,
    ...readerTools,
  ]);
  const systemPrompt = [options.systemPrompt, registry.specialistPrompt()]
    .filter(Boolean).join("\n\n");
  const resolveTools = () => registry.visible();
  const runTools = async (calls: NormalizedToolCall[]) => {
    throwIfAborted(signal);
    const batch = await registry.run(calls, context, providerSignal).catch((error) => {
      settleToolActivities(
        providerSignal.aborted ? "interrupted" : "error",
        calls.map((call) => call.id),
      );
      throw error;
    });
    batch.evidence.forEach((receipt) => registerLegalEvidence(evidence, receipt));
    for (const event of batch.events) {
      addEvent(event as AssistantEvent);
      emit(event);
    }
    if (batch.pause) paused = batch.pause;
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
    for (const result of batch.results) {
      const activity = toolActivities.get(result.tool_use_id);
      if (activity?.status === "running") {
        emitToolActivity({
          ...activity,
          status: result.status === "error" ? "error" : "completed",
        });
      }
    }
    return batch.results;
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
        call.name === ASK_INPUTS_TOOL.name ||
        call.name === LEGAL_EVIDENCE_TOOL_NAME ||
        ([READ_SUBAGENT_TOOL_NAME, RESUME_SUBAGENT_TOOL_NAME].includes(call.name) &&
          activityDetail === "standard")
      ) return;
      const defaultLabel = call.name === READ_SUBAGENT_TOOL_NAME
        ? readSubagentActivityLabel(call.input)
        : call.name === RESUME_SUBAGENT_TOOL_NAME
          ? "Resuming reading agents"
        : registry.activity(call);
      const metadata = options.toolActivityMetadata?.(call);
      if (
        defaultLabel === null &&
        !metadata?.label &&
        activityDetail !== "tools" &&
        activityDetail !== "trace"
      ) return;
      const label = metadata?.label ?? defaultLabel ??
        assistantToolActivityLabel(call.name, call.input) ?? call.name;
      boundary = Boolean(text);
      emitToolActivity({
        id: call.id,
        tool: call.name,
        status: "running",
        label,
        ...(metadata?.source && { source: metadata.source }),
      });
    },
    onContextUsage(usage: {
      usedTokens: number;
      contextWindowTokens: number;
    }) {
      const event: AssistantEvent = {
        type: "context_usage",
        used_tokens: usage.usedTokens,
        window_tokens: usage.contextWindowTokens,
      };
      replaceLastEvent("context_usage", event);
      emit(event);
    },
    onCompaction(status: "running" | "completed" | "failed") {
      const event: AssistantEvent = { type: "compaction", status };
      replaceLastEvent("compaction", event);
      emit(event);
    },
    onContextCheckpoint(checkpoint: ProviderContextCheckpoint) {
      addEvent({
        type: "context_checkpoint",
        schema_version: 1,
        keep_current: true,
        provider: checkpoint.provider,
        ...(checkpoint.provider === "claude"
          ? { summary: checkpoint.content }
          : {}),
        ...(checkpoint.provider === "openai"
          ? { payload: checkpoint.item }
          : {}),
      });
    },
    onSteer(message: { id: string; text: string }) {
      if (reasoning) addEvent({ type: "reasoning", text: reasoning, debug: true });
      if (text) addEvent({ type: "content", text });
      reasoning = "";
      text = "";
      boundary = false;
      const event: AssistantEvent = { type: "steering", ...message };
      addEvent(event);
      emit(event);
    },
    onSubagentUpdate(update: ProviderSubagentUpdate) {
      providerActivity = true;
      const { activities, ...native } = update;
      const event: ReadSubagentEvent = {
        type: "subagent_run",
        agent: "native",
        ...native,
        ...(activities && {
          activities: activities.map((activity) => ({
            ...activity,
            tool: "native",
          })),
        }),
      };
      emit(event);
      options.onSubagentEvent?.(event);
      if (event.status !== "running") addEvent(event);
    },
  };
  const takeSteering = () => {
    const messages = steering.splice(0);
    messages.forEach(callbacks.onSteer);
    return messages;
  };
  const steerNative = (target: ProviderTurnControl, message: SteeringMessage) => {
    const request = nativeSteering.then(() => target.steer(message));
    nativeSteering = request.catch(() => undefined);
    return request;
  };
  const control: ProviderTurnControl = {
    async steer(message) {
      if (!nativeControl) {
        steering.push(message);
        return;
      }
      await steerNative(nativeControl, message);
    },
  };
  options.onProviderControl?.(control);
  const provider = (
    continuationId?: string,
    repair?: { draft: string; findings: string },
  ) => {
    const resumePrompt = readSubagentResumePrompt(resumableReaders);
    const providerMessages = continuationId && resumePrompt
      ? activeMessages.map((message, index) =>
          index === activeMessages.length - 1
            ? { ...message, content: `${message.content}\n\n${resumePrompt}` }
            : message)
      : activeMessages;
    return streamChatWithTools({
    model: options.model,
    systemPrompt: [systemPrompt, resumePrompt].filter(Boolean).join("\n\n"),
    messages: [
      ...(continuationId ? providerMessages.slice(-1) : providerMessages),
      ...(repair
        ? [
            { role: "assistant" as const, content: repair.draft },
            { role: "user" as const, content: repair.findings },
          ]
        : []),
    ],
    tools: resolveTools(),
    staticTools: registry.all(),
    resolveTools,
    runTools,
    takeSteering,
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
      ? {
          persist: true,
          ...(continuationId ? { continuationId } : {}),
          onContinuationId: options.onProviderContinuation,
          onControl(next) {
            nativeControl = next;
            if (!next || !steering.length) return;
            const queued = steering.splice(0);
            for (const message of queued) {
              void steerNative(next, message).catch(() => undefined);
            }
          },
        }
      : undefined,
  });
  };

  let providerResult: StreamChatResult | undefined;
  try {
    throwIfAborted(signal);
    if (options.prepareMessages) {
      activeMessages = await options.prepareMessages(callbacks.onCompaction);
    }
    const contextWindowTokens = modelContextWindow(options.model);
    if (contextWindowTokens) {
      callbacks.onContextUsage({
        usedTokens: estimateContextTokens({
          systemPrompt,
          messages: activeMessages,
          tools: resolveTools(),
        }),
        contextWindowTokens,
      });
    }
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
    if (!paused) {
      let finalized = await finalizeLegalEvidenceExperiment({
        state: evidence,
        model: options.model,
        draft: text,
        requestContext: request || undefined,
        apiKeys: options.apiKeys,
        reasoningEffort: options.reasoningEffort,
        abortSignal: signal,
      });
      for (let attempt = 0; !finalized.passed && attempt < 2; attempt += 1) {
        const rejected = text;
        const failure = evidence.failure ?? "No grounded submission was received.";
        evidence.answer = null;
        evidence.failure = null;
        text = "";
        boundary = false;
        emit({ type: "content_reset" });
        providerResult = await provider(providerResult?.continuationId, {
          draft: rejected,
          findings: `The answer did not pass Beaver's grounding gate: ${failure} Continue the same request, retrieve any missing authority passages, and finish with submit_grounded_answer. Every case, legislation, journal, or Hansard source named in the answer requires a supporting evidence_id. Do not narrate this correction.`,
        });
        finalized = await finalizeLegalEvidenceExperiment({
          state: evidence,
          model: options.model,
          draft: text,
          requestContext: request || undefined,
          apiKeys: options.apiKeys,
          reasoningEffort: options.reasoningEffort,
          abortSignal: signal,
        });
      }
      if (!finalized.passed) {
        text = "";
        emit({ type: "content_reset" });
        throw new Error("Grounding verification failed after correction attempts");
      }
      text = renderLegalEvidenceAnswer(evidence) ?? text.trimEnd();
    }
  } catch (error) {
    if (!paused) {
      settleToolActivities(isAbortError(error) ? "interrupted" : "error");
      partialEvents();
      if (isAbortError(error)) throw new AssistantStreamAbortError(text, events);
      const message = safeErrorMessage(error, "Stream error");
      addEvent({ type: "error", message });
      throw new AssistantStreamError(message, text, events);
    }
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
  options.onProviderControl?.(null);
  return result;
}

export { isAbortError };
