import {
  DEFAULT_MAIN_MODEL,
  resolveModel,
  type LlmMessage,
  type NormalizedToolCall,
  type NormalizedToolResult,
  type OpenAIToolSchema,
  type SubagentMode,
  type UserApiKeys,
} from "../llm";
import type { JurisdictionPreference } from "./prompts";
import { jurisdictionPreferencePrompt } from "./prompts";
import { createServerSupabase } from "../supabase";
import { currentA2AJCoveragePrompt } from "./a2ajCoveragePrompt";
import { hideLegalSourceUrls } from "./legalToolResultVisibility";
import { createPublicLegalSourceState } from "./publicLegalSourceState";
import { READ_SUBAGENT_SYSTEM_PROMPT } from "./readSubagents";
import {
  runChatTurn,
  type AssistantEvent,
  type ChatToolRunner,
  type ChatTurnResult,
} from "./turnEngine";
import {
  COURTLISTENER_TOOLS,
} from "./tools/courtlistenerTools";
import { A2AJ_TOOLS } from "./tools/a2ajTools";
import { PUBLIC_LEGAL_SOURCE_TOOLS } from "./tools/publicLegalSourceTools";
import { runToolCalls } from "./tools/toolDispatcher";
import { TOOLS, WORKFLOW_TOOLS } from "./tools/toolSchemas";
import { type TurnEditState, type TurnReadState } from "./tools/documentOps";
import type {
  DocIndex,
  DocStore,
  TabularCellStore,
  WorkflowStore,
} from "./types";
import type { LegalEvidenceReceipt, LegalEvidenceTurnState } from "./legalEvidence";
import type { EditMode } from "../docxTrackedChanges";

export {
  AssistantStreamError,
  isAbortError,
  type AssistantEvent,
} from "./turnEngine";

function normalizedToolResults(
  calls: NormalizedToolCall[],
  rows: NormalizedToolResult[],
): NormalizedToolResult[] {
  const byId = new Map(rows.map((row) => [row.tool_use_id, row]));
  return calls.map((call) => {
    const row = byId.get(call.id);
    return hideLegalSourceUrls(call.name, row ?? {
      tool_use_id: call.id,
      status: "error",
      content: JSON.stringify({
        ok: false,
        error: `Tool '${call.name}' is not available.`,
      }),
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
  editMode = "manual",
  priorLegalEvidence = [],
  onFinish,
}: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  write: (line: string) => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  model?: string;
  apiKeys?: UserApiKeys;
  reasoningEffort?: string;
  serviceTier?: string;
  signal?: AbortSignal;
  projectId?: string | null;
  subagentMode?: SubagentMode;
  subagentModel?: string;
  subagentEffort?: string;
  jurisdictionPreference?: JurisdictionPreference | null;
  activityDetail?: "auto" | "standard" | "tools" | "trace";
  editMode?: EditMode;
  priorLegalEvidence?: LegalEvidenceReceipt[];
  onFinish?: (result: ChatTurnResult) => Promise<void> | void;
}) {
  const raw = apiMessages as {
    role: string;
    content: string | null;
    images?: import("../llm").LlmImage[];
  }[];
  const coverage = includeResearchTools ? await currentA2AJCoveragePrompt() : "";
  const systemPrompt = [
    raw[0]?.role === "system" ? raw[0].content ?? "" : "",
    subagentMode === "beaver" ? READ_SUBAGENT_SYSTEM_PROMPT : "",
    jurisdictionPreferencePrompt(jurisdictionPreference),
    coverage,
  ].filter(Boolean).join("\n\n");
  const messages: LlmMessage[] = raw
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content ?? "",
      images: message.images,
    }));
  const researchTools = includeResearchTools
    ? [...COURTLISTENER_TOOLS, ...A2AJ_TOOLS, ...PUBLIC_LEGAL_SOURCE_TOOLS]
    : [];
  const mcpTools = await (
    await import("../mcpConnectors")
  ).buildUserMcpTools(userId, db);
  const tools: OpenAIToolSchema[] = [
    ...(TOOLS as OpenAIToolSchema[]),
    ...(researchTools as OpenAIToolSchema[]),
    ...(WORKFLOW_TOOLS as OpenAIToolSchema[]),
    ...mcpTools,
    ...((extraTools ?? []) as OpenAIToolSchema[]),
  ];

  const createToolRunner = (
    _evidence: LegalEvidenceTurnState,
    scope: "main" | "reader",
  ): ChatToolRunner => {
    const editState: TurnEditState = new Map();
    const readState: TurnReadState = new Map();
    const courtState = { casesByClusterId: new Map() };
    const publicState = createPublicLegalSourceState();
    return async (calls, context) => {
      const dispatched = await runToolCalls(
        calls,
        {
          docStore,
          userId,
          db,
          emit: scope === "main" ? context.emit : () => undefined,
          workflowStore,
          tabularStore,
          docIndex,
          editState,
          readState,
          projectId,
          courtlistener: courtState,
          apiKeys,
          publicLegal: publicState,
          legalEvidence: context.evidence,
          editMode,
        },
      );
      if (scope === "main") {
        for (const event of [
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
            ...item,
          })),
          ...dispatched.courtlistenerEvents,
          ...dispatched.mcpEvents,
          ...dispatched.caseCitationEvents,
        ] satisfies AssistantEvent[]) context.addEvent(event);
      }
      return {
        results: normalizedToolResults(calls, dispatched.toolResults),
        pause: dispatched.askInputsEvents[0],
      };
    };
  };

  const emit = (event: unknown) => write(`data: ${JSON.stringify(event)}\n\n`);
  return runChatTurn({
    model: resolveModel(model, DEFAULT_MAIN_MODEL),
    systemPrompt,
    messages,
    tools,
    readerTools: tools,
    createToolRunner,
    emit,
    done: () => write("data: [DONE]\n\n"),
    apiKeys,
    reasoningEffort,
    serviceTier,
    signal,
    subagentMode,
    subagentModel,
    subagentEffort,
    jurisdictionPreference,
    activityDetail,
    priorEvidence: priorLegalEvidence,
    onFinish,
  });
}
