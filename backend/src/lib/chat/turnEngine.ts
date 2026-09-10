import { parseAssistantCitations } from "./assistantWire";
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
import { isAbortError, throwIfAborted } from "../llm/abort";
import { safeErrorMessage } from "../safeError";
import { assistantToolActivityLabel } from "./tools/a2ajTools";
import { ASK_INPUTS_TOOL } from "./tools/toolSchemas";
import { publicAssistantEvent, type AssistantEvent, type AskInputsEvent,
  type PublicAssistantEvent, type ReadSubagentAssignment, type ReadSubagentCheckpoint,
  type ReadSubagentEvent, type ToolActivity, type LegalEvidenceReceiptEvent } from "./assistantEvents";
import {
  TurnToolRegistry,
  toolText,
  type BeaverOutcome,
  type BeaverTool,
} from "./toolRegistry";
import { normalizeAskInputsEvent } from "./askInputs";
import {
  createLegalEvidenceCitations,
  createLegalEvidenceCitationsFromEntries,
} from "./citations";
import {
  GROUNDED_LEGAL_REPAIR_INSTRUCTION,
  UNVERIFIED_LEGAL_ANSWER,
  hasModelAuthoredLegalSourceUrl,
} from "./legalOutputGate";
import {
  createLegalEvidenceTurnState,
  finalizeLegalEvidence,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  LEGAL_EVIDENCE_TOOL_NAME,
  legalEvidenceReceiptEvent,
  legalEvidenceCitationEntries,
  legalEvidenceRequested,
  modelEvidencePassage,
  registerLegalEvidence,
  registerLegalResearchQueries,
  registerPriorLegalEvidence,
  registerPriorLegalResearchQueries,
  priorLegalEvidencePrompt,
  legalEvidenceResourceReference,
  renderLegalEvidenceAnswer,
  restorePriorLegalEvidence,
  submitLegalEvidenceAnswer,
  type PriorLegalEvidence,
  type LegalEvidenceTurnState,
  type LegalResearchQueryReceipt,
} from "./legalEvidence";
import { childResearchReadContext, researchReadContextPrompt, researchReadReceipt, researchResultFilter,
  type ResearchReadContext, type ResearchObserver } from "../researchReader";
import type { ResearchOperationContext } from "../researchProvenance";
import {
  READ_SUBAGENT_TOOL,
  READ_SUBAGENT_TOOL_NAME,
  RESUME_SUBAGENT_TOOL,
  RESUME_SUBAGENT_TOOL_NAME,
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  getReadSubagentCapability,
  readSubagentActivityLabel,
  readSubagentAssignment,
  readSubagentInstruction,
  readSubagentResumePrompt,
  runReadSubagentRound,
} from "./readSubagents";
import {
  SOURCE_SEARCH_SYSTEM_PROMPT,
  jurisdictionPreferencePrompt,
  type JurisdictionPreference,
} from "./prompts";
import {
  estimateContextTokens,
  modelContextWindow,
} from "../llm/contextWindow";

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
  research?: ResearchReadContext;
  operation: ResearchOperationContext;
  addEvent: (event: AssistantEvent) => void;
  updateActivity?(id: string, label: string): void;
  onActivity?: () => void;
};

export type ChatTurnResult = {
  status: "complete" | "paused";
  fullText: string;
  events: AssistantEvent[];
  citations: Record<string, unknown>[];
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

export async function runChatTurn(options: {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  createTools: (
    evidence: LegalEvidenceTurnState,
    scope: "main" | ReadSubagentAssignment,
    context: ChatToolContext,
  ) => BeaverTool<ChatToolContext>[];
  emit: (event: PublicAssistantEvent) => void;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  compactThreshold?: number;
  promptCacheKey?: string;
  signal?: AbortSignal;
  subagentMode?: SubagentMode;
  subagentModel?: string;
  subagentEffort?: string;
  jurisdictionPreference?: JurisdictionPreference | null;
  activityDetail?: "auto" | "standard" | "tools" | "trace";
  priorEvidence?: PriorLegalEvidence[];
  priorQueries?: LegalResearchQueryReceipt[];
  evidenceState?: LegalEvidenceTurnState;
  /** Structuring calls restate already-verified material as JSON; they are not answers to ground. */
  grounded?: false;
  researchContext?: ResearchReadContext;
  operation?: ResearchOperationContext;
  readerAssignment?: ReadSubagentAssignment;
  resumableSubagents?: ReadonlyMap<string, ReadSubagentCheckpoint>;
  providerSession?: { persist: true; continuationId?: string };
  onProviderContinuation?: (continuationId: string) => void | Promise<void>;
  onProviderControl?: (control: ProviderTurnControl | null) => void;
  canRetryProviderSession?: () => boolean;
  separateContentBlocks?: boolean;
  submissionTool?: string;
  prepareMessages?: (
    onCompaction: (status: "running" | "completed" | "failed") => void,
  ) => Promise<LlmMessage[]>;
  onSubagentEvent?: (event: ReadSubagentEvent) => void;
  onResearchObserved?: ResearchObserver;
  onActivity?: () => void;
}) {
  const {
    emit,
    activityDetail = "auto",
    subagentMode = "none",
    signal,
  } = options;
  const events: AssistantEvent[] = [];
  const toolActivities = new Map<string, ToolActivity>();
  const evidence = options.evidenceState ?? createLegalEvidenceTurnState();
  const submissionTool = options.submissionTool ?? LEGAL_EVIDENCE_TOOL_NAME;
  registerPriorLegalEvidence(evidence, options.priorEvidence ?? []);
  registerPriorLegalResearchQueries(evidence, options.priorQueries ?? []);
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
    status: "completed" | "error" | "interrupted",
    ids: Iterable<string> = toolActivities.keys(),
  ) => {
    for (const id of ids) {
      const activity = toolActivities.get(id);
      if (activity?.status === "running") emitToolActivity({ ...activity, status });
    }
  };
  const context: ChatToolContext = {
    evidence,
    research: options.researchContext,
    operation: { ...options.operation, executor: "assistant", model: options.model },
    addEvent,
    updateActivity(id, label) {
      const activity = toolActivities.get(id);
      if (activity?.status === "running" && label !== activity.label) {
        emitToolActivity({ ...activity, label });
      }
    },
  };
  let researchPersistence = Promise.resolve();
  const observe: ResearchObserver = (event, operation) => researchPersistence = researchPersistence.then(
    () => options.onResearchObserved?.(event, operation));
  const internalNames = new Set([
    "ask_inputs",
    LEGAL_EVIDENCE_TOOL_NAME,
    READ_SUBAGENT_TOOL_NAME,
    RESUME_SUBAGENT_TOOL_NAME,
  ]);
  const mainTools = options.createTools(evidence, options.readerAssignment ?? "main", context)
    .filter((tool) => !internalNames.has(tool.name) && (!options.readerAssignment ||
      tool.reader?.includes(options.readerAssignment.jurisdiction)))
    .map((tool) => options.readerAssignment ? { ...tool, specialist: false } : tool);
  const resumableReaders = new Map(options.resumableSubagents);
  const request = [...options.messages].reverse()
    .find((message) => message.role === "user")?.content ?? "";
  if (!evidence.mode && legalEvidenceRequested(options.messages))
    evidence.mode = "citation_structure";
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
      text += contentBoundarySeparator(text, delta);
    }
    text += delta;
  };
  const partialEvents = () => {
    if (reasoning) addEvent({ type: "reasoning", text: reasoning });
    if (text) addEvent({ type: "content", text });
    reasoning = "";
  };
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
  const runReader = async (
    call: NormalizedToolCall,
    resume?: ReadSubagentCheckpoint,
  ): Promise<NormalizedToolResult> => {
    const refuse = (error: string | undefined): NormalizedToolResult => ({
      tool_use_id: call.id, status: "error",
      content: JSON.stringify({ ok: false, error }),
    });
    const assignment = resume?.assignment ?? readSubagentAssignment(call);
    if (!assignment) return refuse("task and scope are required.");
    const capability = await getReadSubagentCapability(undefined, {
      model: resume?.model ?? options.subagentModel,
      effort: resume?.effort ?? options.subagentEffort,
    });
    if (!capability.available) return refuse(capability.reason);
    const childEvidence = createLegalEvidenceTurnState("citation_structure");
    const inheritReads = (grounding: LegalEvidenceReceiptEvent) => {
      for (const receipt of grounding.evidence) registerLegalEvidence(evidence, receipt,
        childEvidence.evidence.get(receipt.evidence_id));
      for (const query of grounding.queries) registerLegalResearchQueries(evidence, [query], query.model);
    };
    let continuationId = resume?.continuation_id;
    const id = resume?.id ?? call.id;
    let research = resume?.research;
    const activities = new Map(
      (resume?.activities ?? []).map((activity) => [activity.id, activity]),
    );
    const base = {
      type: "subagent_run" as const,
      id,
      agent: "scout" as const,
      task: `${assignment.scope}: ${assignment.task}`,
      model: capability.displayName,
      effort: capability.effort,
    };
    let resumeState: ReadSubagentCheckpoint | undefined;
    const checkpoint = (): ReadSubagentCheckpoint | undefined => continuationId
      ? {
          id,
          continuation_id: continuationId,
          model: capability.model,
          effort: capability.effort,
          assignment,
          evidence: [...childEvidence.evidence.values()].map(({ receipt }) => receipt),
          queries: [...childEvidence.queries.values()],
          ...(research && { research: structuredClone(research) }),
        }
      : undefined;
    const publish = (event: ReadSubagentEvent, visible = event) => {
      context.onActivity?.();
      emit(publicAssistantEvent(visible));
      options.onSubagentEvent?.(event);
      if (event.status !== "running") addEvent(event);
    };
    const running = (activity?: ToolActivity) => {
      if (!activity || activity.status !== "running") resumeState = checkpoint();
      publish({
        ...base, status: "running",
        ...(activities.size ? { activities: [...activities.values()] } : {}),
        ...(resumeState ? { resume: resumeState } : {}),
      }, { ...base, status: "running", ...(activity && { activity }) });
    };
    try {
      research ??= childResearchReadContext(options.researchContext, assignment,
        [...evidence.evidence.values()].map(({ receipt }) => receipt));
      const inScope = researchResultFilter(research), priorEvidence = resume?.evidence.filter((receipt) =>
        inScope({ resource: legalEvidenceResourceReference(receipt) ?? "", evidence: [receipt] }));
      running();
      const child = await runChatTurn({
        model: `codex:${capability.model}`,
        systemPrompt: [
          readSubagentInstruction(assignment),
          jurisdictionPreferencePrompt(options.jurisdictionPreference ?? null),
          SOURCE_SEARCH_SYSTEM_PROMPT,
          priorLegalEvidencePrompt(priorEvidence ?? [], resume?.queries ?? []),
        ].filter(Boolean).join("\n\n"),
        messages: [{
          role: "user",
          content: resume
            ? "Continue the original assignment from where the session stopped and complete its grounded answer."
            : `Assigned scope: ${assignment.scope}\n\nQuestion: ${assignment.task}`,
        }],
        createTools: options.createTools,
        readerAssignment: assignment,
        evidenceState: childEvidence,
        priorEvidence,
        priorQueries: resume?.queries,
        researchContext: research,
        operation: { ...context.operation, subagentId: id },
        onResearchObserved(grounding, operation) {
          inheritReads(grounding);
          return observe(grounding, operation);
        },
        emit(event) {
          if (event.type === "tool_activity") {
            const { type: _type, ...activity } = event;
            activities.set(activity.id, activity);
            running(activity);
          }
        },
        apiKeys: options.apiKeys,
        reasoningEffort: capability.effort,
        signal,
        subagentMode: "none",
        activityDetail: "tools",
        providerSession: {
          persist: true,
          ...(continuationId ? { continuationId } : {}),
        },
        onProviderContinuation(id) {
          continuationId = id;
          running();
        },
        onActivity: () => context.onActivity?.(),
      });
      const grounding = legalEvidenceReceiptEvent(child.evidence);
      if (!grounding || grounding.status !== "passed") {
        throw new Error("Reader returned no grounded answer.");
      }
      inheritReads(grounding);
      if (resume) resumableReaders.delete(resume.id);
      publish({
        ...base,
        status: "completed",
        output: child.fullText,
        activities: [...activities.values()],
        citations: createLegalEvidenceCitations(child.evidence),
        grounding,
      });
      return {
        tool_use_id: call.id,
        status: "ok",
        content: JSON.stringify({
          ok: true,
          agent: "scout",
          findings: grounding.claims,
          evidence: grounding.evidence.map(modelEvidencePassage),
        }),
      };
    } catch (error) {
      const observed = legalEvidenceReceiptEvent({ ...childEvidence, answer: null, attempted: false, failure: null });
      if (observed) inheritReads(observed);
      const interrupted = Boolean(signal?.aborted) || isAbortError(error);
      const status = interrupted ? "interrupted" as const : "error" as const;
      const saved = checkpoint();
      const errorMessage = safeErrorMessage(error, "Reading agent failed");
      for (const [key, activity] of activities) {
        if (activity.status === "running") activities.set(key, { ...activity, status });
      }
      if (saved) resumableReaders.set(id, { ...saved, activities: [...activities.values()] });
      publish({
        ...base,
        status,
        error: errorMessage,
        publicError: saved
          ? `${/ground(?:ed|ing)/iu.test(errorMessage) ? "Grounding verification" : "Reading agent"} failed; this reading agent can be resumed.`
          : "Reading agent failed before it started; retry it.",
        activities: [...activities.values()],
        ...(saved && { resume: saved }),
      });
      return {
        tool_use_id: call.id,
        status: "error",
        content: JSON.stringify({
          ok: false,
          error: errorMessage,
          ...(interrupted && { interrupted: true }),
          ...(saved && { resume_id: id }),
        }),
      };
    }
  };
  const readerSchemas = subagentMode === "beaver"
    ? [READ_SUBAGENT_TOOL, RESUME_SUBAGENT_TOOL] : [];
  const readerTools: BeaverTool<ChatToolContext>[] = readerSchemas.map((schema) => ({
    ...schema,
    specialist: true,
    activity: (input) => schema.name === READ_SUBAGENT_TOOL_NAME
      ? readSubagentActivityLabel(input)
      : "Resuming reading agents",
    async execute(_input, _context, _signal, call) {
      const result = await runReadSubagentRound({
        call,
        admit: admitReaders,
        runReader,
        resumable: resumableReaders,
      });
      return normalizedOutcome(result);
    },
  }));
  const registry = new TurnToolRegistry([
    askTool,
    ...(submissionTool === LEGAL_EVIDENCE_TOOL_NAME ? [evidenceTool(evidence)] : []),
    ...mainTools,
    ...readerTools,
  ]);
  const systemPrompt = [options.systemPrompt, researchReadContextPrompt(context.research)].filter(Boolean).join("\n\n");
  const resolveTools = () => registry.visible();
  const runTools = async (
    calls: NormalizedToolCall[],
    onActivity?: () => void,
  ) => {
    throwIfAborted(signal);
    const previousActivity = context.onActivity;
    context.onActivity = onActivity;
    const results = await registry.run(calls, context, providerSignal, (call, outcome) => {
      const entries = outcome.evidence?.flatMap((receipt) => {
        registerLegalEvidence(evidence, receipt, outcome.evidenceSources?.get(receipt.evidence_id));
        return receipt.span_text ? [evidence.evidence.get(receipt.evidence_id)!] : [];
      }) ?? [];
      registerLegalResearchQueries(evidence, outcome.queryReceipts ?? [], options.model);
      const receipt = options.onResearchObserved && researchReadReceipt(outcome, options.model);
      if (receipt) void observe(receipt, { ...context.operation, callId: call.id });
      for (const event of outcome.events ?? []) {
        addEvent(event);
        const visible = publicAssistantEvent(event);
        if (visible) emit(visible);
      }
      if (outcome.pause) paused = outcome.pause;
      const activity = toolActivities.get(call.id);
      if (activity?.status === "running") {
        const citations = activity.citations?.length ? activity.citations
          : outcome.activityCitations?.length ? parseAssistantCitations(outcome.activityCitations)
          : createLegalEvidenceCitationsFromEntries(entries);
        emitToolActivity({
          ...activity,
          status: (outcome.metadata?.status ?? (outcome.result.isError ? "error" : "ok")) === "error"
            ? "error" : "completed",
          ...(citations.length && { citations }),
        });
      }
    })
      .then(async (results) => { await researchPersistence; return results; }, async (error) => {
        await researchPersistence.catch(() => undefined); throw error;
      })
      .catch((error) => {
        settleToolActivities(
          providerSignal.aborted ? "interrupted" : "error",
          calls.map((call) => call.id),
        );
        throw error;
      })
      .finally(() => { context.onActivity = previousActivity; });
    if (paused) {
      text = "";
      boundary = false;
      addEvent(paused);
      emit(paused);
      providerAbort.abort();
    }
    const grounded = renderLegalEvidenceAnswer(evidence);
    if (grounded !== null) {
      text = grounded;
      boundary = false;
    }
    return results;
  };
  const callbacks = {
    onActivity() {
      providerActivity = true;
      options.onActivity?.();
    },
    onContentDelta(delta: string) {
      if (delta) providerActivity = true;
      append(delta);
    },
    onContentBlockEnd() {
      if (!paused && options.separateContentBlocks !== false) {
        boundary = Boolean(text);
      }
    },
    onReasoningDelta(delta: string) {
      if (activityDetail !== "auto" && activityDetail !== "trace") return;
      if (delta) providerActivity = true;
      if (!paused) {
        reasoning += delta;
      }
    },
    onReasoningBlockEnd() {
      if (activityDetail !== "auto" && activityDetail !== "trace") return;
      if (reasoning) {
        addEvent({ type: "reasoning", text: reasoning });
        emit({ type: "reasoning_delta", text: reasoning });
      }
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
      if (
        defaultLabel === null &&
        activityDetail !== "tools" &&
        activityDetail !== "trace"
      ) return;
      const label = defaultLabel ??
        assistantToolActivityLabel(call.name, call.input) ?? call.name;
      const citations = parseAssistantCitations(registry.activityCitations(call));
      boundary = Boolean(text);
      emitToolActivity({
        id: call.id,
        tool: call.name,
        status: "running",
        label,
        ...(citations.length && { citations }),
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
          ? {
              summary: checkpoint.content,
              payload: checkpoint.block,
            }
          : {}),
        ...(checkpoint.provider === "openai"
          ? { payload: checkpoint.item }
          : {}),
      });
    },
    onSteer(message: { id: string; text: string }) {
      partialEvents();
      text = "";
      boundary = false;
      const event: AssistantEvent = { type: "steering", ...message };
      addEvent(event);
      emit(event);
    },
    onSubagentUpdate(update: ProviderSubagentUpdate) {
      providerActivity = true;
      const { activities, activity, ...native } = update;
      const decorate = <T extends { label: string }>(value: T) =>
        ({ ...value, tool: "native" });
      const event: ReadSubagentEvent = {
        type: "subagent_run",
        agent: "native",
        ...native,
        ...(activities && { activities: activities.map(decorate) }),
      };
      emit(publicAssistantEvent(event.status === "running" ? {
        type: "subagent_run", agent: "native", ...native,
        ...(activity && { activity: decorate(activity) }),
      } : event));
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
  /** Re-run the turn against its own rejected draft, so the retry sees what it must repair. */
  const repairDraft = async (findings: string) => {
    const draft = text;
    text = "";
    boundary = false;
    providerResult = await provider(providerResult?.continuationId, { draft, findings });
  };
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
    if (!paused && options.grounded !== false && renderLegalEvidenceAnswer(evidence) === null &&
        hasModelAuthoredLegalSourceUrl(text)) {
      await repairDraft(
        GROUNDED_LEGAL_REPAIR_INSTRUCTION.replace(LEGAL_EVIDENCE_TOOL_NAME, submissionTool));
      if (renderLegalEvidenceAnswer(evidence) === null) text = UNVERIFIED_LEGAL_ANSWER;
    }
    if (!paused) {
      let finalized = options.grounded === false || finalizeLegalEvidence(evidence, text);
      for (let attempt = 0; !finalized && attempt < 2; attempt += 1) {
        const failure = evidence.failure ?? "No grounded submission was received.";
        evidence.answer = null;
        evidence.failure = null;
        await repairDraft(`Grounding error: ${failure} Revise the answer with available evidence_ids and finish with ${submissionTool}. Retrieve only missing passages.`);
        finalized = finalizeLegalEvidence(evidence, text);
      }
      // An answer that stays unverified is reported as one, and the turn keeps its completed
      // reads and searches instead of dying with them.
      if (!finalized) {
        text = UNVERIFIED_LEGAL_ANSWER;
        Object.assign(evidence, { answer: null, attempted: false, failure: null });
      }
      const priorCitations = legalEvidenceCitationEntries(evidence).filter(({ receipt, document, source }) =>
        evidence.priorEvidenceIds.has(receipt.evidence_id) && !document && !source);
      if (priorCitations.length) for (const { receipt, ...source } of await restorePriorLegalEvidence(
        priorCitations.map(({ receipt }) => receipt), signal, false,
        [...evidence.presentedEvidenceIds].map((id) => evidence.evidence.get(id)!)))
        registerLegalEvidence(evidence, receipt, source);
      text = renderLegalEvidenceAnswer(evidence) ?? text.trimEnd();
    }
  } catch (error) {
    if (!paused) {
      settleToolActivities(isAbortError(error) ? "interrupted" : "error");
      partialEvents();
      const observed = legalEvidenceReceiptEvent({ ...evidence, answer: null, attempted: false, failure: null });
      if (observed) addEvent(observed);
      if (isAbortError(error)) throw new AssistantStreamAbortError(text, events);
      const message = safeErrorMessage(error, "Stream error");
      addEvent({ type: "error", message });
      throw new AssistantStreamError(message, text, events);
    }
  }

  const citations = paused ? [] : createLegalEvidenceCitations(evidence);
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
  if (!paused) {
    settleToolActivities("completed");
    emit({ type: "content_final", text, citations });
  }
  options.onProviderControl?.(null);
  return result;
}

export { isAbortError };
