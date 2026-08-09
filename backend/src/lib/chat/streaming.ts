import {
  streamChatWithTools,
  resolveModel,
  DEFAULT_MAIN_MODEL,
  type LlmMessage,
  type OpenAIToolSchema,
} from "../llm";
import { isAbortError } from "../llm/abort";
import { safeErrorMessage } from "../safeError";
import { createServerSupabase } from "../supabase";
import type { McpToolEvent } from "../mcpConnectors";
import {
  COURTLISTENER_TOOLS,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./tools/courtlistenerTools";
import { A2AJ_TOOLS, assistantToolActivityLabel } from "./tools/a2ajTools";
import { PUBLIC_LEGAL_SOURCE_TOOLS } from "./tools/publicLegalSourceTools";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputsEvent,
  type EditAnnotation,
  devLog,
} from "./types";
import { TOOLS, WORKFLOW_TOOLS } from "./tools/toolSchemas";
import {
  createLegalEvidenceCitations,
  createCitation,
  isResolvedCitation,
  parseCitationsWithDiagnostics,
  parsePartialCitationObjects,
} from "./citations";
import { createVisibleStreamSplitter } from "./visibleStream";
import {
  runToolCalls,
  type CourtlistenerTurnState,
} from "./tools/toolDispatcher";
import { type TurnEditState, type TurnReadState } from "./tools/documentOps";
import type { A2AJDocument, A2AJLocatorLookup } from "../a2aj";
import {
  createPublicLegalSourceState,
  type PublicLegalSourceState,
} from "./publicLegalSourceState";
import {
  createLegalEvidenceTurnState,
  finalizeLegalEvidenceExperiment,
  LEGAL_EVIDENCE_SUBMIT_TOOL,
  legalEvidenceReceiptEvent,
  renderLegalEvidenceAnswer,
  type LegalEvidenceReceiptEvent,
} from "./legalEvidenceExperiment";
import {
  READ_SUBAGENT_SYSTEM_PROMPT,
  READ_SUBAGENT_TOOL,
  READ_SUBAGENT_TOOL_NAME,
  allowedReadSubagentForeignRegions,
  createReadSubagentAdmission,
  readSubagentTools,
  readSubagentActivityLabel,
  runReadSubagent,
  type ReadSubagentEvent,
} from "./readSubagents";
import {
  jurisdictionPreferencePrompt,
  type JurisdictionPreference,
} from "./prompts";

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
      /** Per-document monotonic Vn; null if backend couldn't determine it. */
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
  fullText: string;
  events: AssistantEvent[];

  constructor(message: string, fullText: string, events: AssistantEvent[]) {
    super(message);
    this.name = "AssistantStreamError";
    this.fullText = fullText;
    this.events = events;
  }
}

class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

export { isAbortError };

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  throw err;
}

export async function runLLMStream({
  apiMessages,
  docStore,
  docIndex,
  userId,
  db,
  write,
  extraTools,
  includeResearchTools = true,
  workflowStore,
  tabularStore,
  buildCitations,
  model,
  apiKeys,
  reasoningEffort,
  serviceTier,
  signal,
  projectId,
  subagentsEnabled = false,
  subagentModel,
  subagentEffort,
  jurisdictionPreference = null,
  activityDetail = "standard",
}: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  write: (s: string) => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  buildCitations?: (fullText: string) => unknown[];
  model?: string;
  apiKeys?: import("../llm").UserApiKeys;
  reasoningEffort?: string;
  serviceTier?: string;
  signal?: AbortSignal;
  /**
   * If set, generate_docx will attach created docs to this project so
   * they appear in the project sidebar. Leave null for general chats —
   * generated docs still get persisted, but as standalone documents.
   */
  projectId?: string | null;
  subagentsEnabled?: boolean;
  subagentModel?: string;
  subagentEffort?: string;
  jurisdictionPreference?: JurisdictionPreference | null;
  activityDetail?: "standard" | "tools" | "trace";
}): Promise<{
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
}> {
  const researchTools = includeResearchTools
    ? [...COURTLISTENER_TOOLS, ...A2AJ_TOOLS, ...PUBLIC_LEGAL_SOURCE_TOOLS]
    : [];
  const mcpTools = await (
    await import("../mcpConnectors")
  ).buildUserMcpTools(userId, db);
  const baseTools = [...TOOLS, ...researchTools, ...WORKFLOW_TOOLS];
  const providerTools = extraTools?.length
    ? [...baseTools, ...mcpTools, ...extraTools]
    : [...baseTools, ...mcpTools];
  const activeTools = subagentsEnabled
    ? [...providerTools, READ_SUBAGENT_TOOL]
    : providerTools;

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages.
  const rawMsgs = apiMessages as {
    role: string;
    content: string | null;
    images?: import("../llm").LlmImage[];
  }[];
  const baseSystemPrompt =
    rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
  const systemPrompt = subagentsEnabled
    ? `${baseSystemPrompt}\n\n${READ_SUBAGENT_SYSTEM_PROMPT}`
    : baseSystemPrompt;
  const chatMessages: LlmMessage[] = rawMsgs
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
      images: m.images,
    }));

  const events: AssistantEvent[] = [];
  // One assistant turn produces at most one document_versions row per
  // edited doc. `runToolCalls` fires once per tool-call batch; the model
  // may emit multiple batches in a single turn, so this map persists
  // across batches to let subsequent edit_document calls overwrite the
  // turn's existing version instead of creating a new one.
  const turnEditState: TurnEditState = new Map();
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
  const courtlistenerTurnState: CourtlistenerTurnState = {
    casesByClusterId: new Map(),
  };
  const a2ajLookups: A2AJLocatorLookup[] = [];
  const a2ajDocuments: A2AJDocument[] = [];
  const legalEvidenceState = createLegalEvidenceTurnState();
  const standingJurisdictionPrompt = jurisdictionPreferencePrompt(
    jurisdictionPreference,
  );
  const currentRequest =
    [...chatMessages].reverse().find((message) => message.role === "user")
      ?.content ?? "";
  const admitReadSubagents = createReadSubagentAdmission(
    3,
    allowedReadSubagentForeignRegions(
      jurisdictionPreference,
      currentRequest,
    ),
  );
  const publicLegalState: PublicLegalSourceState =
    createPublicLegalSourceState();
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  const emit = (payload: unknown) =>
    write(`data: ${JSON.stringify(payload)}\n\n`);
  const emitCitationStreamSnapshot = (
    status: "started" | "partial",
    citations: unknown[],
  ) => {
    if (!buildCitations) emit({ type: "citations", status, citations });
  };

  const streamHiddenCitationContent = (delta: string) => {
    if (buildCitations || !delta) return;
    streamingCitationsBuffer += delta;
    const partial = parsePartialCitationObjects(streamingCitationsBuffer);
    if (partial.length <= streamedCitationCount) return;
    streamedCitationCount = partial.length;
    const citations = partial
      .map((c) =>
        createCitation(
          c,
          docIndex,
          courtlistenerTurnState.casesByClusterId,
          a2ajLookups,
          a2ajDocuments,
          publicLegalState,
        ),
      )
      .filter(isResolvedCitation);
    emitCitationStreamSnapshot("partial", citations);
  };

  const splitter = createVisibleStreamSplitter({
    onVisible: (visible) => {
      iterVisibleText += visible;
      emit({ type: "content_delta", text: visible });
    },
    onOpen: () => {
      streamingCitationsBuffer = "";
      streamedCitationCount = 0;
      emitCitationStreamSnapshot("started", []);
    },
    onHidden: streamHiddenCitationContent,
  });

  const flushText = (opts: { emit?: boolean } = {}) => {
    if (!iterText) return;
    fullText += iterText;
    const tail = splitter.takeTail();
    if (tail) {
      iterVisibleText += tail;
      if (opts.emit ?? true) {
        emit({ type: "content_delta", text: tail });
      }
    }
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
    splitter.reset();
    streamingCitationsBuffer = "";
    streamedCitationCount = 0;
  };

  const flushPartialTurn = (opts: { emit?: boolean } = {}) => {
    flushText(opts);
    if (iterReasoning) {
      events.push({ type: "reasoning", text: iterReasoning, debug: true });
      iterReasoning = "";
    }
  };

  const selectedModel = resolveModel(model, DEFAULT_MAIN_MODEL);

  try {
    throwIfAborted(signal);
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt,
      messages: chatMessages,
      tools: activeTools as OpenAIToolSchema[],
      apiKeys,
      reasoningEffort,
      serviceTier,
      enableThinking: true,
      reasoningSummary: activityDetail === "trace" ? "auto" : "none",
      abortSignal: signal,
      callbacks: {
        onContentDelta: (delta) => {
          iterText += delta;
          splitter.push(delta);
        },
        onContentBlockEnd: () => flushText(),
        onReasoningDelta: (delta) => {
          if (activityDetail !== "trace") return;
          iterReasoning += delta;
          emit({ type: "reasoning_delta", text: delta, debug: true });
        },
        onReasoningBlockEnd: () => {
          if (activityDetail !== "trace") return;
          if (!iterReasoning) return;
          events.push({ type: "reasoning", text: iterReasoning, debug: true });
          emit({ type: "reasoning_block_end" });
          iterReasoning = "";
        },
        // Fires after Claude's turn ends with stop_reason=tool_use, before
        // the tool actually runs. Flushes any buffered assistant text so
        // it's emitted in chronological order, then signals the client so
        // it can open a fresh PreResponseWrapper (shows "Working…") while
        // the tool executes — avoids the dead gap between message_stop
        // and the first tool-specific event.
        onToolCallStart: (call) => {
          flushText();
          if (
            call.name === READ_SUBAGENT_TOOL_NAME &&
            activityDetail === "standard"
          ) return;
          const label =
            call.name === READ_SUBAGENT_TOOL_NAME
              ? readSubagentActivityLabel(call.input)
              : assistantToolActivityLabel(call.name, call.input);
          if (label === null) return;
          emit({
            type: "tool_call_start",
            name: call.name,
            ...(label && { label }),
            ...(activityDetail !== "standard" && {
              id: call.id,
              input: call.input,
            }),
          });
        },
      },
      runTools: async (calls) => {
        throwIfAborted(signal);
        // Emit any text the model produced before this tool turn so the
        // UI sees it before the tool results stream in.
        flushText();

        const directCalls = calls.filter(
          (call) => call.name !== READ_SUBAGENT_TOOL_NAME,
        );
        const subagentCandidates = calls.filter(
          (call) => call.name === READ_SUBAGENT_TOOL_NAME,
        );
        const {
          accepted: subagentCalls,
          rejected: rejectedSubagentResults,
        } = admitReadSubagents(subagentCandidates);
        const toolCalls: ToolCall[] = directCalls.map((c) => ({
          id: c.id,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
        const {
          toolResults,
          docsRead,
          docsFound,
          docsCreated,
          workflowsApplied,
          docsEdited,
          askInputsEvents,
          courtlistenerEvents,
          caseCitationEvents,
          mcpEvents,
          a2ajLookups: batchA2AJLookups,
          a2ajDocuments: batchA2AJDocuments,
        } = await runToolCalls(
          toolCalls,
          docStore,
          userId,
          db,
          emit,
          workflowStore,
          tabularStore,
          docIndex,
          turnEditState,
          turnReadState,
          projectId,
          courtlistenerTurnState,
          apiKeys,
          publicLegalState,
          legalEvidenceState,
        );
        a2ajLookups.push(...batchA2AJLookups);
        a2ajDocuments.push(...batchA2AJDocuments);
        throwIfAborted(signal);
        events.push(
          ...docsRead.map((r) => ({
            type: "doc_read" as const,
            filename: r.filename,
            document_id: r.document_id,
          })),
          ...docsFound.map((f) => ({
            type: "doc_find" as const,
            filename: f.filename,
            query: f.query,
            total_matches: f.total_matches,
          })),
          ...docsCreated.map((dl) => ({
            type: "doc_created" as const,
            filename: dl.filename,
            download_url: dl.download_url,
            document_id: dl.document_id,
            version_id: dl.version_id,
            version_number: dl.version_number ?? null,
          })),
          ...workflowsApplied.map((wf) => ({
            type: "workflow_applied" as const,
            workflow_id: wf.workflow_id,
            title: wf.title,
          })),
          ...docsEdited.map((e) => ({
            type: "doc_edited" as const,
            filename: e.filename,
            document_id: e.document_id,
            version_id: e.version_id,
            version_number: e.version_number,
            download_url: e.download_url,
            annotations: e.annotations,
          })),
        );
        for (const askInputsEvent of askInputsEvents) {
          emit(askInputsEvent);
          events.push(askInputsEvent);
        }
        events.push(...courtlistenerEvents, ...mcpEvents, ...caseCitationEvents);

        const readTools = [
          ...readSubagentTools(activeTools as OpenAIToolSchema[]),
          LEGAL_EVIDENCE_SUBMIT_TOOL,
        ];
        const subagentResults = await Promise.all(
          subagentCalls.map((call) => {
            const childEditState: TurnEditState = new Map();
            const childReadState: TurnReadState = new Map();
            const childCourtlistenerState: CourtlistenerTurnState = {
              casesByClusterId: new Map(),
            };
            const childPublicLegalState = createPublicLegalSourceState();
            const childLegalEvidenceState = createLegalEvidenceTurnState(
              "citation_structure",
            );
            return runReadSubagent({
              call,
              tools: readTools,
              evidenceState: childLegalEvidenceState,
              publishEvidenceTo: legalEvidenceState,
              model: subagentModel,
              effort: subagentEffort,
              activityDetail,
              jurisdictionPrompt: standingJurisdictionPrompt,
              signal,
              onEvent: (event) => {
                emit(event);
                if (event.status !== "running") events.push(event);
              },
              runTools: async (childCalls) => {
                const childToolCalls: ToolCall[] = childCalls.map((child) => ({
                  id: child.id,
                  function: {
                    name: child.name,
                    arguments: JSON.stringify(child.input),
                  },
                }));
                const childResult = await runToolCalls(
                  childToolCalls,
                  docStore,
                  userId,
                  db,
                  () => undefined,
                  workflowStore,
                  tabularStore,
                  docIndex,
                  childEditState,
                  childReadState,
                  projectId,
                  childCourtlistenerState,
                  apiKeys,
                  childPublicLegalState,
                  childLegalEvidenceState,
                );
                return childCalls.map((child) => {
                  const result = childResult.toolResults.find(
                    (item) =>
                      (item as { tool_call_id?: unknown }).tool_call_id ===
                      child.id,
                  ) as { content?: unknown } | undefined;
                  return {
                    tool_use_id: child.id,
                    status: result ? ("ok" as const) : ("error" as const),
                    content:
                      String(result?.content ?? "") ||
                      JSON.stringify({
                        error: `Tool '${child.name}' is not available.`,
                      }),
                  };
                });
              },
            });
          }),
        );

        if (askInputsEvents.length > 0) {
          throw new AssistantStreamAskInputsPause();
        }

        // Index alignment would break if any tool branch skips its
        // push (unhandled tool name, disabled store, guard failure).
        // Each tool_result already carries its tool_call_id, so key off
        // that directly — and fall back to an error result for any
        // tool_use that didn't produce one, so Claude's next request
        // has a tool_result for every tool_use it sent.
        toolResults.push(
          ...rejectedSubagentResults.map((result) => ({
            tool_call_id: result.tool_use_id,
            content: result.content,
          })),
        );
        const resultByCallId = new Map<string, string>();
        for (const r of toolResults) {
          const row = r as {
            tool_call_id: string;
            content?: unknown;
            terminal?: unknown;
          };
          resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
        }
        for (const result of subagentResults) {
          resultByCallId.set(result.tool_use_id, result.content);
        }
        return calls.map((c) => ({
          tool_use_id: c.id,
          content:
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.name}' is not available.`,
            }),
          terminal: toolResults.some(
            (result) =>
              (result as { tool_call_id?: unknown; terminal?: unknown })
                .tool_call_id === c.id &&
              (result as { terminal?: unknown }).terminal === true,
          ),
        }));
      },
    });
  } catch (err) {
    if (err instanceof AssistantStreamAskInputsPause) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      flushPartialTurn({ emit: false });
      throw new AssistantStreamAbortError(fullText, events);
    } else {
      flushPartialTurn();
      const message = safeErrorMessage(err, "Stream error");
      events.push({ type: "error", message });
      throw new AssistantStreamError(message, fullText, events);
    }
  }

  flushText();
  await finalizeLegalEvidenceExperiment({
    state: legalEvidenceState,
    model: selectedModel,
    draft: fullText,
    requestContext:
      [...chatMessages].reverse().find((message) => message.role === "user")
        ?.content ?? undefined,
    apiKeys,
    reasoningEffort,
    abortSignal: signal,
  });

  const evidenceAnswer = renderLegalEvidenceAnswer(legalEvidenceState);
  if (evidenceAnswer !== null) fullText = evidenceAnswer;

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitations, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  const visibleText =
    evidenceAnswer ??
    events
      .flatMap((event) => (event.type === "content" ? [event.text] : []))
      .join("\n\n");
  const parsedCitationData = buildCitations
    ? buildCitations(fullText)
    : parsedCitations
        .map((c) =>
          createCitation(
            c,
            docIndex,
            courtlistenerTurnState.casesByClusterId,
            a2ajLookups,
            a2ajDocuments,
            publicLegalState,
          ),
        )
        .filter(isResolvedCitation);
  const citations = evidenceAnswer
    ? createLegalEvidenceCitations(legalEvidenceState)
    : parsedCitationData;
  const linkedText = visibleText;
  const contentIndexes = events.flatMap((event, index) =>
    event.type === "content" ? [index] : [],
  );
  const finalContentIndex = contentIndexes.at(-1);
  if (finalContentIndex === undefined) {
    if (linkedText) events.push({ type: "content", text: linkedText });
  } else {
    for (const index of contentIndexes) {
      events[index] = { type: "content", text: "" };
    }
    events[finalContentIndex] = { type: "content", text: linkedText };
  }
  const evidenceReceipt = legalEvidenceReceiptEvent(legalEvidenceState);
  if (evidenceReceipt) events.push(evidenceReceipt);
  emit({ type: "content_final", text: linkedText });
  devLog("[chat/stream] final citations", {
    hasCitationsBlock: citationDiagnostics.hasBlock,
    citationsBlockLength: citationDiagnostics.rawLength,
    parseError: citationDiagnostics.error,
    parsedCitationCount: parsedCitations.length,
    emittedCitationCount: citations.length,
    usedCustomCitationBuilder: !!buildCitations,
  });
  emit({ type: "citations", status: "final", citations });
  write("data: [DONE]\n\n");

  return { fullText, events, citations };
}
