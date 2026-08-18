import {
  DEFAULT_MAIN_MODEL,
  resolveModel,
  type LlmMessage,
  type SubagentMode,
  type UserApiKeys,
} from "../llm";
import type { JurisdictionPreference } from "./prompts";
import { jurisdictionPreferencePrompt } from "./prompts";
import { createServerSupabase } from "../supabase";
import { currentA2AJCoveragePrompt } from "./a2ajCoveragePrompt";
import {
  READ_SUBAGENT_SYSTEM_PROMPT,
  type ReadSubagentCheckpoint,
} from "./readSubagents";
import {
  runChatTurn,
  type ChatToolContext,
  type ChatTurnResult,
} from "./turnEngine";
import { createChatToolRunner } from "./chatToolRunner";
import type {
  DocIndex,
  ChatMessage,
  TabularCellStore,
  WorkflowStore,
} from "./types";
import type { LegalEvidenceReceipt } from "./legalEvidence";
import type { EditMode } from "../docxTrackedChanges";
import { compactionThresholdForModel } from "../llm/contextWindow";
import { formatChatMessageContent } from "./messageFormatting";
import { toolText, type BeaverTool } from "./toolRegistry";
import { cloudDocuments } from "../cloudDocumentStore";
import { cloudLibraryStore } from "../cloudLibraryStore";
import { cloudProjects } from "../cloudProjectStore";
import { buildUserMcpTools, executeMcpToolCall } from "../mcpConnectors";

export {
  AssistantStreamError,
  isAbortError,
  type AssistantEvent,
} from "./turnEngine";

export async function runLLMStream({
  apiMessages,
  docIndex,
  userId,
  userEmail,
  db,
  write,
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
  timeZone,
  priorLegalEvidence = [],
  resumableSubagents = new Map(),
  onFinish,
  prepareMessages,
}: {
  apiMessages: unknown[];
  docIndex: DocIndex;
  userId: string;
  userEmail?: string;
  db: ReturnType<typeof createServerSupabase>;
  write: (line: string) => void;
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
  timeZone?: string;
  priorLegalEvidence?: LegalEvidenceReceipt[];
  resumableSubagents?: ReadonlyMap<string, ReadSubagentCheckpoint>;
  onFinish?: (result: ChatTurnResult) => Promise<void> | void;
  prepareMessages?: (
    onCompaction: (status: "running" | "completed" | "failed") => void,
  ) => Promise<ChatMessage[]>;
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
  const mcpEntries: BeaverTool<ChatToolContext>[] = (await buildUserMcpTools(userId, db))
    .map((schema) => ({
      ...schema,
      activity: () => `Using ${schema.name}`,
      async execute(input, context, signal) {
        context.emit({ type: "mcp_tool_start", name: schema.name });
        const { content, event } = await executeMcpToolCall(
          userId, schema.name, input, db, signal,
        );
        context.emit({
          type: "mcp_tool_result",
          name: schema.name,
          connector_name: event.connector_name,
          tool_name: event.tool_name,
          status: event.status,
          error: event.error,
        });
        return {
          result: toolText(content, event.status === "error"),
          events: [event],
        };
      },
    }));
  const documentNames = new Map(
    Object.values(docIndex).map(({ document_id, filename }) => [
      document_id,
      filename,
    ]),
  );
  const assistantTools = createChatToolRunner({
    userId,
    userEmail,
    projectId: projectId ?? null,
    allowedDocumentIds: new Set(documentNames.keys()),
    documentNames,
    documents: cloudDocuments,
    library: cloudLibraryStore,
    projects: cloudProjects,
    workflows: workflowStore,
    tabular: tabularStore,
    editMode,
    timeZone,
    entries: mcpEntries,
    excludeToolNames: includeResearchTools
      ? undefined
      : new Set(["search_sources", "note_up", "find_in_case", "verify_citations"]),
    onMutationCommitted: () => undefined,
  });

  const emit = (event: unknown) => write(`data: ${JSON.stringify(event)}\n\n`);
  const selectedModel = resolveModel(model, DEFAULT_MAIN_MODEL);
  const slugByDocumentId = new Map<string, string>();
  for (const [slug, info] of Object.entries(docIndex)) {
    if (info.document_id) slugByDocumentId.set(info.document_id, slug);
  }
  return runChatTurn({
    model: selectedModel,
    systemPrompt,
    messages,
    createTools: assistantTools.createTools,
    emit,
    done: () => write("data: [DONE]\n\n"),
    apiKeys,
    reasoningEffort,
    serviceTier,
    compactThreshold: compactionThresholdForModel(selectedModel),
    signal,
    subagentMode,
    subagentModel,
    subagentEffort,
    jurisdictionPreference,
    activityDetail,
    priorEvidence: priorLegalEvidence,
    resumableSubagents,
    onFinish,
    prepareMessages: prepareMessages
      ? async (onCompaction) => (await prepareMessages(onCompaction)).map(
          (message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: formatChatMessageContent(message, slugByDocumentId),
            images: message.images,
            contextCheckpoint: message.contextCheckpoint,
          }),
        )
      : undefined,
  });
}
