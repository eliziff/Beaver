import {
  streamChatWithTools,
  resolveModel,
  DEFAULT_MAIN_MODEL,
  type LlmMessage,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type OpenAIToolSchema,
  type SubagentMode,
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
} from "./citations";
import { hideLegalSourceUrls } from "./legalToolResultVisibility";
import {
  UNVERIFIED_LEGAL_ANSWER,
  hasModelAuthoredLegalSourceUrl,
} from "./legalOutputGate";
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
  registerPriorLegalEvidence,
  renderLegalEvidenceAnswer,
  type LegalEvidenceReceipt,
  type LegalEvidenceReceiptEvent,
} from "./legalEvidence";
import {
  READ_SUBAGENT_SYSTEM_PROMPT,
  READ_SUBAGENT_TOOL,
  READ_SUBAGENT_TOOL_NAME,
  allowedReadSubagentRegions,
  createReadSubagentAdmission,
  readSubagentTools,
  readSubagentActivityLabel,
  readSubagentJurisdiction,
  readSubagentSourceTypes,
  runReadSubagentRound,
  runReadSubagent,
  type ReadSubagentEvent,
} from "./readSubagents";
import {
  jurisdictionPreferencePrompt,
  type JurisdictionPreference,
} from "./prompts";
import { currentA2AJCoveragePrompt } from "./a2ajCoveragePrompt";

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

function normalizedToolResults(
  calls: NormalizedToolCall[],
  rows: unknown[],
): NormalizedToolResult[] {
  const byId = new Map(
    rows.map((item) => {
      const row = item as {
        tool_call_id: string;
        content?: unknown;
        terminal?: unknown;
      };
      return [row.tool_call_id, row] as const;
    }),
  );
  return calls.map((call) => {
    const row = byId.get(call.id);
    return hideLegalSourceUrls(call.name, {
      tool_use_id: call.id,
      status: row ? "ok" : "error",
      content:
        String(row?.content ?? "") ||
        JSON.stringify({
          ok: false,
          error: `Tool '${call.name}' is not available.`,
        }),
      terminal: row?.terminal === true,
    });
  });
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
  model,
  apiKeys,
  reasoningEffort,
  serviceTier,
  signal,
  projectId,
  subagentMode = "none",
  subagentModel,
  subagentEffort,
  jurisdictionPreference = null,
  activityDetail = "auto",
  priorLegalEvidence = [],
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
  subagentMode?: SubagentMode;
  subagentModel?: string;
  subagentEffort?: string;
  jurisdictionPreference?: JurisdictionPreference | null;
  activityDetail?: "auto" | "standard" | "tools" | "trace";
  priorLegalEvidence?: LegalEvidenceReceipt[];
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
  const rawMsgs = apiMessages as {
    role: string;
    content: string | null;
    images?: import("../llm").LlmImage[];
    files?: unknown[];
  }[];
  const baseTools = [
    ...(TOOLS as OpenAIToolSchema[]),
    ...researchTools,
    ...WORKFLOW_TOOLS,
  ];
  const providerTools = extraTools?.length
    ? [...baseTools, ...mcpTools, ...extraTools]
    : [...baseTools, ...mcpTools];
  const activeTools = subagentMode === "beaver"
    ? [...providerTools, READ_SUBAGENT_TOOL, LEGAL_EVIDENCE_SUBMIT_TOOL]
    : [...providerTools, LEGAL_EVIDENCE_SUBMIT_TOOL];

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages.
  const baseSystemPrompt =
    rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
  const coveragePrompt = includeResearchTools
    ? await currentA2AJCoveragePrompt()
    : "";
  const systemPrompt = [
    baseSystemPrompt,
    subagentMode === "beaver" ? READ_SUBAGENT_SYSTEM_PROMPT : "",
    coveragePrompt,
  ].filter(Boolean).join("\n\n");
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
  registerPriorLegalEvidence(legalEvidenceState, priorLegalEvidence);
  const standingJurisdictionPrompt = jurisdictionPreferencePrompt(
    jurisdictionPreference,
  );
  const currentRequest =
    [...chatMessages].reverse().find((message) => message.role === "user")
      ?.content ?? "";
  const admitReadSubagents = createReadSubagentAdmission(
    4,
    allowedReadSubagentRegions(
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

  const emit = (payload: unknown) =>
    write(`data: ${JSON.stringify(payload)}\n\n`);
  const flushText = () => {
    if (!iterText) return;
    fullText += iterText;
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
  };

  const flushPartialTurn = () => {
    flushText();
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
      nativeSubagents: subagentMode === "native",
      serviceTier,
      enableThinking: true,
      reasoningSummary:
        activityDetail === "auto" || activityDetail === "trace" ? "auto" : "none",
      abortSignal: signal,
      callbacks: {
        onContentDelta: (delta) => {
          iterText += delta;
          iterVisibleText += delta;
          emit({ type: "content_delta", text: delta });
        },
        onContentBlockEnd: () => {
          if (iterVisibleText) emit({ type: "content_block_end" });
          flushText();
        },
        onReasoningDelta: (delta) => {
          if (activityDetail !== "auto" && activityDetail !== "trace") return;
          iterReasoning += delta;
          emit({ type: "reasoning_delta", text: delta, debug: true });
        },
        onReasoningBlockEnd: () => {
          if (activityDetail !== "auto" && activityDetail !== "trace") return;
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
            ...((activityDetail === "tools" || activityDetail === "trace") && {
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

        let pauseForInputs = false;
        const results = await runReadSubagentRound({
          calls,
          admit: admitReadSubagents,
          runDirect: async (directCalls) => {
            const toolCalls: ToolCall[] = directCalls.map((call) => ({
              id: call.id,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            }));
            const dispatched = await runToolCalls(
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
            a2ajLookups.push(...dispatched.a2ajLookups);
            a2ajDocuments.push(...dispatched.a2ajDocuments);
            throwIfAborted(signal);
            events.push(
              ...dispatched.docsRead.map((item) => ({
                type: "doc_read" as const,
                filename: item.filename,
                document_id: item.document_id,
              })),
              ...dispatched.docsFound.map((item) => ({
                type: "doc_find" as const,
                filename: item.filename,
                query: item.query,
                total_matches: item.total_matches,
              })),
              ...dispatched.docsCreated.map((item) => ({
                type: "doc_created" as const,
                filename: item.filename,
                download_url: item.download_url,
                document_id: item.document_id,
                version_id: item.version_id,
                version_number: item.version_number ?? null,
              })),
              ...dispatched.workflowsApplied.map((item) => ({
                type: "workflow_applied" as const,
                workflow_id: item.workflow_id,
                title: item.title,
              })),
              ...dispatched.docsEdited.map((item) => ({
                type: "doc_edited" as const,
                filename: item.filename,
                document_id: item.document_id,
                version_id: item.version_id,
                version_number: item.version_number,
                download_url: item.download_url,
                annotations: item.annotations,
              })),
            );
            for (const event of dispatched.askInputsEvents) {
              emit(event);
              events.push(event);
            }
            events.push(
              ...dispatched.courtlistenerEvents,
              ...dispatched.mcpEvents,
              ...dispatched.caseCitationEvents,
            );
            pauseForInputs ||= dispatched.askInputsEvents.length > 0;
            return normalizedToolResults(directCalls, dispatched.toolResults);
          },
          runReader: (call) => {
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
              tools: [
                ...readSubagentTools(
                  activeTools as OpenAIToolSchema[],
                  readSubagentJurisdiction(call),
                  readSubagentSourceTypes(call),
                ),
                LEGAL_EVIDENCE_SUBMIT_TOOL,
              ],
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
                return normalizedToolResults(
                  childCalls,
                  childResult.toolResults,
                );
              },
            });
          },
        });
        if (pauseForInputs) throw new AssistantStreamAskInputsPause();
        return results;
      },
    });
  } catch (err) {
    if (err instanceof AssistantStreamAskInputsPause) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      flushPartialTurn();
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
  const blockedLegalLink =
    evidenceAnswer === null && hasModelAuthoredLegalSourceUrl(fullText);
  if (blockedLegalLink) fullText = UNVERIFIED_LEGAL_ANSWER;

  const visibleText =
    evidenceAnswer ??
    (blockedLegalLink
      ? fullText
      : events
          .flatMap((event) => (event.type === "content" ? [event.text] : []))
          .join("\n\n"));
  const citations = evidenceAnswer
    ? createLegalEvidenceCitations(legalEvidenceState)
    : [];
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
    emittedCitationCount: citations.length,
  });
  emit({ type: "citations", status: "final", citations });
  write("data: [DONE]\n\n");

  return { fullText, events, citations };
}
