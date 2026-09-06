import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BeaverTool } from "./toolRegistry";
import {
  AssistantStreamError,
  runChatTurn,
  type ChatToolContext,
} from "./turnEngine";
import { createChatToolRunner } from "./chatToolRunner";
import type { AuthoritiesWorkspaceApplication } from "../authoritiesWorkspaceApplication";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import type { WorkProductApplication } from "../workProductApplication";
import { WORK_PRODUCT_KINDS } from "../workProduct";
import type { DraftingStyleSettings } from "../draftingStyle";
import type { FeaturePreferences } from "../userPreferences";
import {
  CLIENT_WORK_PRODUCT_PRESUMPTION,
  CODING_PRODUCTION_SYSTEM_PROMPT,
  jurisdictionPreferencePrompt,
  type JurisdictionPreference,
} from "./prompts";
import {
  DEFAULT_MAIN_MODEL,
  isSupportedModel,
  modelSupportsImageInput,
  resolveRequestedModel,
  type LlmImage,
  type SubagentMode,
  type UserApiKeys,
} from "../llm";
import { providerForModel } from "../llm/models";
import { isAbortError } from "../llm/abort";
import { isImageDocumentType, MAX_CHAT_IMAGES, toLlmImage } from "../llm/images";
import { compactionThresholdForModel } from "../llm/contextWindow";
import { compactChatContext } from "./contextCompaction";
import { formatChatMessageContent } from "./messageFormatting";
import { projectChatTranscript } from "./chatTranscript";
import { availableDocumentsPrompt } from "./resourceTools";
import {
  createLegalEvidenceTurnState,
  legalEvidenceReceiptEvent,
  legalEvidenceResourceReference,
  priorLegalEvidencePrompt,
  priorLegalEvidenceReceipts,
  priorLegalResearchQueryReceipts,
  registerPriorLegalResearchQueries,
} from "./legalEvidence";
import { resumableReadSubagents } from "./readSubagents";
import { tabularChatPrompt } from "./tabularContext";
import { safeErrorLog, safeErrorMessage } from "../safeError";
import {
  normalizeChatTitle,
  type ChatMessageRecord,
  type ChatScope,
  type ChatStore,
  type ChatTurnCommit,
} from "../chatStore";
import type { DocumentRecord, DocumentStore } from "../documentStore";
import type { LibraryStore } from "../libraryStore";
import { projectDocuments, type ProjectStore } from "../projectStore";
import type { TabularApplication } from "../tabular/application";
import type { AssistantEvent, AskInputResponseItem, AskInputsEvent, AskInputsResponseRequest,
  PublicAssistantEvent, ReadSubagentEvent } from "./assistantEvents";
import type {
  ChatMessage,
  DocIndex,
  WorkflowStore,
} from "./types";
import type { EditMode } from "../docxTrackedChanges";
import { setChatTurnControl } from "../chatTurns";
import { wordClientTools, type WordClientCall } from "./wordClientTools";
import type { SourceWorkspaceApplication } from "../sourceWorkspaceApplication";
import type { ChatCreateInput } from "../chatStore";
import { researchSelectionSchema } from "../researchSelection";
import { researchResultFilter } from "../researchReader";
import { resourceReference } from "../resourceReferences";
import type { AuditStore } from "../audit";

const uuid = z.string().uuid();
const userMessage = z.string().trim().min(1).max(200_000);
const documentSelection = z.object({
  document_id: z.string().trim().min(1).max(200),
}).strict();
const wordContext = z.object({
  document_name: z.string().trim().min(1).max(500),
}).strict();
const workflow = z.object({
  id: z.string().trim().min(1).max(200),
  variant_id: z.string().trim().min(1).max(200).optional(),
}).strict();
const choiceResponse = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("choice"),
  answer: z.string().max(20_000).optional(),
}).strict();
const documentResponse = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("documents"),
  documents: z.array(documentSelection).max(50).default([]),
}).strict();
const currentTurn = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    turn_id: uuid.optional(),
    content: userMessage,
    files: z.array(documentSelection).max(50).optional(),
    workflow: workflow.optional(),
  }).strict(),
  z.object({
    kind: z.literal("ask_inputs_response"),
    responses: z.array(z.discriminatedUnion("kind", [
      choiceResponse,
      documentResponse,
    ])).min(1).max(50),
  }).strict(),
]);

export const chatTurnInputSchema = z.object({
  chat_id: uuid.nullish(),
  project_id: uuid.nullish(),
  tabular_review_id: uuid.nullish(),
  research_file_id: uuid.nullish(),
  research_selection: researchSelectionSchema.nullish(),
  current_turn: currentTurn,
  expected_version: z.number().int().nonnegative(),
  model: z.string().trim().min(1).max(200)
    .refine(isSupportedModel, "Unsupported model").optional(),
  reasoning_effort: z.string().trim().min(1).max(32).optional(),
  edit_mode: z.enum(["manual", "auto"]).default("manual"),
  jurisdiction_preference: z.object({
    mode: z.enum(["ask", "presume"]),
    jurisdictions: z.array(z.string().trim().min(1).max(100)).max(20),
  }).strict().nullable().optional(),
  subagent_mode: z.enum(["none", "beaver", "native"]).default("none"),
  subagent_model: z.string().trim().min(1).max(128).optional(),
  subagent_effort: z.string().trim().min(1).max(32).optional(),
  activity_detail: z.enum(["auto", "standard", "tools", "trace"]).default("auto"),
  time_zone: z.string().max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "time_zone is invalid").optional(),
  displayed_doc: documentSelection.optional(),
  word_context: wordContext.optional(),
  work_product: z.object({ kind: z.enum(WORK_PRODUCT_KINDS), id: uuid,
    revision: z.number().int().positive(), focus: z.object({
      item_id: z.string().trim().min(1).max(200),
      selection: z.object({ start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative() }).strict()
        .refine(({ start, end }) => end >= start, "selection end precedes start").optional(),
    }).strict().optional() }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.project_id && value.tabular_review_id) {
    context.addIssue({
      code: "custom",
      message: "A chat cannot belong to both a project and a tabular review",
    });
  }
});

export type ChatTurnInput = z.infer<typeof chatTurnInputSchema>;
type AskInputsSubmission = Extract<
  ChatTurnInput["current_turn"], { kind: "ask_inputs_response" }
>;
export type AuthContext = ChatScope;
export type EventSink = {
  claim(chatId: string): boolean;
  emit(event: PublicAssistantEvent): void;
  setControl(control: Parameters<typeof setChatTurnControl>[2]): void;
};

export class ChatApplicationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly currentVersion?: number,
  ) {
    super(message);
  }
}

type TurnFeatures = {
  apiKeys?: UserApiKeys;
  includeResearchTools: boolean;
  productFeatures?: FeaturePreferences;
  personalisationPrompt?: string;
  draftingStyle?: DraftingStyleSettings;
  workflows?: WorkflowStore;
  extraTools?: BeaverTool<ChatToolContext>[];
};

export type ChatApplicationFeatures = {
  load(auth: AuthContext): Promise<TurnFeatures>;
  providerSession?: {
    claim(input: {
      auth: AuthContext;
      chatId: string;
      projectId: string | null;
      researchFileId?: string | null;
      provider: string;
      model: string;
      reasoningEffort?: string;
      expectedVersion: number;
    }): Promise<{
      continuationId?: string;
      promptCacheKey?: string;
      save(continuationId: string | undefined, version: number): Promise<void>;
    } | null>;
    compact(input: {
      auth: AuthContext;
      chatId: string;
      model: string;
      signal: AbortSignal;
    }): Promise<{ handled: boolean; save(version: number): Promise<void> }>;
  };
  audit?(auth: AuthContext, input: {
    chatId: string;
    projectId: string | null;
    title: string | null;
    model: string;
    status?: "cancelled" | "failed";
    events: AssistantEvent[] | null;
  }): void;
};

export type ChatTurnExecution = {
  continuationId?: string;
  onContinuation?(continuationId: string): void | Promise<void>;
  onAccepted?(chatId: string): void | Promise<void>;
  clientTool?: WordClientCall;
};

type Dependencies = {
  chats: ChatStore;
  sources: SourceWorkspaceApplication;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  workProducts: Pick<WorkProductApplication,
    "create" | "get" | "list" | "resolve">;
  authorities: Pick<AuthoritiesWorkspaceApplication,
    "importDraft" | "act" | "refresh" | "refreshInput" | "prepareSources" |
      "discrepancies" | "build" |
      "addReceipts" | "attachLibraryPdf">;
  courtRecords?: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  tabular: Pick<TabularApplication, "detail"> & Partial<Pick<TabularApplication,
    "create" | "update" | "generate" | "stop" | "history" | "change">>;
  audit?: AuditStore["record"];
  features: ChatApplicationFeatures;
};

const LOCAL_MUTATION_COMMITTED_EVENT = "local_mutation_committed";
const LOCAL_TURN_COMPLETED_EVENT = "local_turn_completed";
const CHAT_PROGRESS_CHECKPOINT_MS = 30_000;
const REPLACEABLE_EVENT_TYPES = new Set(["workflow_run", "subagent_run", "tool_activity"]);
const TRANSIENT_EVENT_TYPES = new Set(["reasoning", "error", "context_usage", "subagent_run", "tool_activity"]);
function pendingAskInputs(messages: ChatMessageRecord[]) {
  const assistant = [...messages].reverse().find(({ role }) => role === "assistant");
  if (!assistant || !Array.isArray(assistant.content)) return null;
  let ask: AskInputsEvent | null = null;
  let response: AskInputsResponseRequest | null = null;
  let failed = false, mutationCommitted = false;
  for (const event of assistant.content) {
    if (event.type === "ask_inputs") {
      ask = event.items.length ? event : null;
      response = null; failed = false; mutationCommitted = false;
    } else if (event.type === "ask_inputs_response" && ask) {
      response = { responses: event.responses };
      failed = false; mutationCommitted = false;
    } else if (response && event.type === LOCAL_MUTATION_COMMITTED_EVENT) {
      mutationCommitted = true;
    } else if (response && (event.type === "error" ||
      (event.type === "turn_status" && event.status === "cancelled"))) {
      failed = true;
    }
  }
  return ask && (!response || failed)
    ? { event: ask, retryResponse: response, mutationCommitted, assistant }
    : null;
}

function canonicalAskResponse(
  pending: AskInputsEvent,
  submitted: AskInputsSubmission,
  files: { filename: string; document_id: string }[],
) {
  if (submitted.responses.length !== pending.items.length) return null;
  const byId = new Map(submitted.responses.map((item) => [item.id, item]));
  if (byId.size !== submitted.responses.length) return null;
  const available = new Map(files.map((file) => [file.document_id, file]));
  const responses: AskInputResponseItem[] = [];
  for (const item of pending.items) {
    const value = byId.get(item.id);
    if (!value || value.kind !== item.kind) return null;
    if (item.kind === "choice" && value.kind === "choice") {
      if (value.answer?.trim()) responses.push({
        id: item.id, kind: "choice", answer: value.answer.trim(),
      });
      else responses.push({ id: item.id, kind: "choice" });
    } else if (item.kind === "documents" && value.kind === "documents") {
      if (value.documents.length) {
        const ids = value.documents.map(({ document_id }) => document_id);
        const documents = [...new Set(ids)].flatMap((id) => available.get(id) ?? []);
        if (!documents.length || documents.length !== ids.length) return null;
        responses.push({ id: item.id, kind: "documents", documents });
      } else responses.push({ id: item.id, kind: "documents", documents: [] });
    }
  }
  return { responses };
}

function normalTurnState(messages: ChatMessageRecord[], turnId: string) {
  const user = messages.find((message) =>
    message.role === "user" && message.turn_id === turnId);
  if (!user) return null;
  const assistant = [...messages].reverse().find((message) =>
    message.role === "assistant" && message.turn_id === turnId);
  const events = Array.isArray(assistant?.content) ? assistant.content : [];
  return {
    user,
    assistant,
    completed: events.some((event) => event.type === LOCAL_TURN_COMPLETED_EVENT),
    mutationCommitted: events.some((event) =>
      event.type === LOCAL_MUTATION_COMMITTED_EVENT),
  };
}

function conflict(code: string, currentVersion: number, detail = "Chat changed") {
  throw new ChatApplicationError(409, detail, code, currentVersion);
}

function requestedModel(value?: string) {
  try { return resolveRequestedModel(value, DEFAULT_MAIN_MODEL); }
  catch { throw new ChatApplicationError(400, "Unsupported model"); }
}

async function loadDocumentContext(
  deps: Dependencies,
  auth: AuthContext,
  projectId: string | null,
  messages: ChatMessageRecord[],
  selectedIds: string[],
) {
  const records = projectId
    ? await projectDocuments(deps.projects, auth, projectId)
    : [];
  if (projectId && !records) throw new ChatApplicationError(404, "Project not found");
  const byId = new Map((records ?? []).map((record) => [record.id, record]));
  const ids = new Set<string>(selectedIds);
  for (const message of messages) {
    for (const file of Array.isArray(message.files)
      ? message.files as { document_id?: unknown }[] : []) {
      if (typeof file.document_id === "string") ids.add(file.document_id);
    }
    for (const event of Array.isArray(message.content) ? message.content : []) {
      if (event.type === "document_artifact") ids.add(event.document_id);
    }
  }
  for (const details of await deps.documents.metadataMany(auth, [...ids].filter((id) => !byId.has(id))))
    byId.set(details.id, details);
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new ChatApplicationError(400, "Selected document is unavailable");
  }
  const docIndex: DocIndex = {};
  let index = 0;
  for (const [id, record] of byId) {
    docIndex[`doc-${index++}`] = {
      document_id: id,
      filename: record.filename.trim(),
      version_id: record.current_version_id,
      version_number: record.active_version_number,
    };
  }
  return { records: byId, docIndex, allowed: new Set(byId.keys()) };
}

async function loadImages(
  documents: DocumentStore,
  auth: AuthContext,
  messages: ChatMessage[],
  records: Map<string, DocumentRecord>,
) {
  const ids = new Set(messages.flatMap((message) => (message.files ?? [])
    .flatMap((file) =>
      isImageDocumentType(records.get(file.document_id)?.file_type ?? "")
      ? [file.document_id] : [])));
  if (ids.size > MAX_CHAT_IMAGES) {
    throw new ChatApplicationError(400,
      `Attach no more than ${MAX_CHAT_IMAGES} images per chat.`);
  }
  const images = new Map<string, LlmImage>();
  for (const id of ids) {
    const file = await documents.read(auth, id, null, false);
    if (!file) throw new ChatApplicationError(400, "Attached image is unavailable");
    images.set(id, toLlmImage(file.filename, file.bytes, file.fileType));
  }
  return images;
}

function imageForMessage(message: ChatMessage, images: Map<string, LlmImage>) {
  const selected = (message.files ?? []).flatMap((file) => {
    const image = images.get(file.document_id);
    return image ? [image] : [];
  });
  return selected.length ? selected : undefined;
}

export function createChatApplication(deps: Dependencies) {
  return {
    async create(auth: AuthContext, input: ChatCreateInput) {
      const file = input.researchFileId ? await deps.sources.get(auth, input.researchFileId) : null;
      if (file?.document.project_id && input.projectId && file.document.project_id !== input.projectId)
        throw new ChatApplicationError(400, "Workspace belongs to another project");
      const chat = await deps.chats.create(auth, { ...input,
        projectId: input.tabularReviewId ? null : file?.document.project_id ?? input.projectId });
      if (file) await deps.sources.bind(auth, file.document.id, { chatId: chat.id,
        selection: input.researchSelection ?? undefined }, { executor: "human" });
      return chat;
    },

    async compact(
      auth: AuthContext,
      input: { chatId: string; model?: string },
      signal: AbortSignal,
      claim: (chatId: string) => boolean,
    ) {
      const model = requestedModel(input.model);
      const chat = await deps.chats.get(auth, input.chatId);
      if (!chat) throw new ChatApplicationError(404, "Chat not found");
      if (!claim(chat.id)) conflict(
        "chat_turn_in_progress",
        chat.transcript_version,
        "A response is already running",
      );
      const provider = await deps.features.providerSession?.compact({
        auth,
        chatId: input.chatId,
        model,
        signal,
      }) ?? { handled: false, save: (_version: number) => undefined };
      if (!provider.handled) {
        const features = await deps.features.load(auth);
        const result = await compactChatContext({
          store: deps.chats,
          scope: auth,
          chatId: input.chatId,
          model,
          apiKeys: features.apiKeys,
          signal,
          force: true,
        });
        if (!result.compacted) throw new ChatApplicationError(409,
          "There is no older context to compact");
      }
      const transcript = await deps.chats.transcript(auth, input.chatId);
      const assistant = [...(transcript ?? [])].reverse()
        .find(({ role }) => role === "assistant");
      if (!assistant) throw new Error("Context compaction receipt could not be saved");
      const appended = await deps.chats.appendAssistantEvent(
        auth,
        input.chatId,
        assistant.id,
        { type: "compaction", status: "completed" },
      );
      if (appended.status === "missing") {
        throw new Error("Context compaction receipt could not be saved");
      }
      if (appended.status === "conflict") {
        conflict("chat_version_conflict", appended.currentVersion);
      }
      await provider.save(appended.currentVersion);
      return { compacted: true, transcriptVersion: appended.currentVersion };
    },

    async turn(
      auth: AuthContext,
      input: ChatTurnInput,
      sink: EventSink,
      signal: AbortSignal,
      execution?: ChatTurnExecution,
    ) {
      const selectedModel = requestedModel(input.model);
      const responseProvider = providerForModel(selectedModel);
      let chat = input.chat_id ? await deps.chats.get(auth, input.chat_id) : null;
      if (input.chat_id && !chat) throw new ChatApplicationError(404, "Chat not found");
      if (!chat && input.expected_version !== 0) {
        conflict("chat_version_conflict", 0);
      }
      if (chat && input.project_id !== undefined &&
          chat.project_id !== (input.project_id ?? null)) {
        throw new ChatApplicationError(400, "project_id does not match chat");
      }
      if (chat && input.tabular_review_id !== undefined &&
          chat.tabular_review_id !== (input.tabular_review_id ?? null)) {
        throw new ChatApplicationError(400, "tabular_review_id does not match chat");
      }
      const projectId = chat?.project_id ?? input.project_id ?? null;
      const tabularReviewId = chat?.tabular_review_id ?? input.tabular_review_id ?? null;
      const transcript = chat ? await deps.chats.transcript(auth, chat.id) : [];
      if (chat && !transcript) throw new ChatApplicationError(404, "Chat not found");
      const rows = transcript ?? [];
      const turnFiles = input.current_turn.kind === "message"
        ? input.current_turn.files ?? []
        : input.current_turn.responses.flatMap((response) =>
            response.kind === "documents" ? response.documents : []);
      const tabularDetail = tabularReviewId ? await deps.tabular.detail(auth, tabularReviewId) : null;
      if (tabularReviewId && !tabularDetail) throw new ChatApplicationError(404, "Review not found");
      const researchFileId = input.research_file_id === undefined
        ? chat?.research_file_id ?? tabularDetail?.review.scope_config?.research_file_id : input.research_file_id,
        researchSelection = input.research_selection === undefined
          ? input.research_file_id !== undefined && input.research_file_id !== chat?.research_file_id
            ? undefined : chat?.research_selection ?? tabularDetail?.review.scope_config?.selection : input.research_selection,
        research = researchFileId ? await deps.sources.get(auth, researchFileId) : null;
      if (researchSelection && !research) throw new ChatApplicationError(400, "Select a workspace for this research scope");
      if (researchFileId && !research) throw new ChatApplicationError(404, "Research workspace not found");
      const requested = [
        ...(research ? [research.document.id, ...Object.values(research.state.sources).flatMap(({ reference }) =>
          reference.kind === "document" ? [reference.id] : [])] : []),
        ...turnFiles.map(({ document_id }) => document_id),
        ...(input.displayed_doc ? [input.displayed_doc.document_id] : []),
      ];
      const context = await loadDocumentContext(
        deps, auth, projectId, rows, [...new Set(requested)],
      );
      const canonicalFiles = turnFiles.map((file) => ({
        document_id: file.document_id,
        filename: String(context.records.get(file.document_id)?.filename),
      }));
      const tabularPrompt = tabularDetail ? tabularChatPrompt(tabularDetail) : undefined;
      const features = await deps.features.load(auth);
      const submittedWorkflow = input.current_turn.kind === "message"
        ? input.current_turn.workflow : undefined;
      const registeredWorkflow = submittedWorkflow
        ? features.workflows?.get(submittedWorkflow.variant_id ?? submittedWorkflow.id) : undefined;
      if (submittedWorkflow &&
          (!registeredWorkflow || registeredWorkflow.workflow_id !== submittedWorkflow.id)) {
        throw new ChatApplicationError(400, "Selected workflow is unavailable");
      }
      const canonicalWorkflow = registeredWorkflow && submittedWorkflow
        ? { id: submittedWorkflow.id,
          ...(submittedWorkflow.variant_id && { variant_id: submittedWorkflow.variant_id }),
          title: registeredWorkflow.title }
        : undefined;
      let assistant = input.current_turn.kind === "ask_inputs_response"
        ? pendingAskInputs(rows)?.assistant : undefined;
      let assistantContent = Array.isArray(assistant?.content)
        ? [...assistant.content] : [];
      let assistantCitations = Array.isArray(assistant?.citations)
        ? [...assistant.citations] : [];
      let retry = false;
      const turnId = input.current_turn.kind === "message"
        ? input.current_turn.turn_id : undefined;
      let commit: ChatTurnCommit;
      if (input.current_turn.kind === "ask_inputs_response") {
        const pending = pendingAskInputs(rows);
        if (!pending) throw new ChatApplicationError(400,
          "No assistant question is available for this response");
        const canonical = canonicalAskResponse(
          pending.event,
          input.current_turn,
          canonicalFiles,
        );
        if (!canonical) throw new ChatApplicationError(400,
          "Response does not match the pending assistant questions");
        if (pending.retryResponse &&
            JSON.stringify(pending.retryResponse.responses) !==
              JSON.stringify(canonical.responses)) throw new ChatApplicationError(400,
          "Retry the same response to the assistant questions");
        if (pending.mutationCommitted) conflict(
          "chat_retry_blocked_after_mutation", chat?.transcript_version ?? 0,
          "The prior continuation changed data before it stopped. Review that result before sending a new instruction.",
        );
        if (!pending.retryResponse) assistantContent.push({
          type: "ask_inputs_response",
          responses: canonical.responses,
        });
        commit = {
          expectedVersion: input.expected_version,
          assistantMessage: {
            id: pending.assistant.id,
            turnId: pending.assistant.turn_id,
            content: assistantContent,
            citations: assistantCitations,
          },
        };
        assistant = pending.assistant;
      } else {
        const prior = turnId ? normalTurnState(rows, turnId) : null;
        if (prior) {
          const same = prior.user.content === input.current_turn.content &&
            JSON.stringify(prior.user.files ?? []) === JSON.stringify(canonicalFiles) &&
            JSON.stringify(prior.user.workflow ?? null) ===
              JSON.stringify(canonicalWorkflow ?? null);
          if (!same) throw new ChatApplicationError(400,
            "turn_id was already used for a different message");
          if (prior.completed) conflict(
            "chat_turn_already_completed", chat?.transcript_version ?? 0,
            "This turn already completed",
          );
          if (prior.mutationCommitted) conflict(
            "chat_retry_blocked_after_mutation", chat?.transcript_version ?? 0,
            "The prior response changed data before it stopped. Review that result before sending a new instruction.",
          );
          if ([...rows].reverse().find(({ role }) => role === "user")?.id !==
              prior.user.id) conflict("chat_version_conflict", chat?.transcript_version ?? 0);
          retry = true;
          assistant = prior.assistant;
          assistantContent = Array.isArray(assistant?.content)
            ? assistant.content.filter((event) => event.type === "subagent_run" &&
                (event.status === "interrupted" || event.status === "running" || event.status === "error") &&
                event.resume) : [];
          assistantCitations = [];
          commit = {
            expectedVersion: input.expected_version,
            ...(assistant ? { assistantMessage: {
              id: assistant.id, turnId, content: assistantContent, citations: [],
            } } : {}),
          };
        } else commit = {
          expectedVersion: input.expected_version,
          userMessage: {
            id: randomUUID(), turnId,
            content: input.current_turn.content,
            files: canonicalFiles.length ? canonicalFiles : undefined,
            workflow: canonicalWorkflow,
          },
        };
      }
      if (!commit.userMessage && !commit.assistantMessage) {
        // A retried turn without an assistant receipt still needs one atomic CAS write.
        commit.assistantMessage = {
          id: randomUUID(), turnId, content: [], citations: [],
        };
      }
      const transcriptForModel = rows
        .map((row) => row.id === assistant?.id
          ? { ...row, content: assistantContent, citations: assistantCitations }
          : row)
        .filter((row) => !(retry && turnId &&
          row.role === "assistant" && row.turn_id === turnId));
      const messages = projectChatTranscript(transcriptForModel, responseProvider);
      if (!retry && input.current_turn.kind === "message") messages.push({
        role: "user",
        content: input.current_turn.content,
        files: canonicalFiles,
        workflow: canonicalWorkflow,
      });
      const researchEvidence = research ? await deps.sources.items(auth, research.document.id,
        { kind: "passages", offset: 0, limit: 100 }) : null,
        researchQueries = research ? await deps.sources.items(auth, research.document.id,
          { kind: "queries", offset: 0, limit: 50 }) : null,
        workspaceContext = research ? await deps.sources.context(auth, research.document.id,
          researchSelection ?? undefined) : undefined;
      const researchContext = workspaceContext && tabularDetail && input.research_selection === undefined &&
          !chat?.research_selection && researchFileId === tabularDetail.review.scope_config?.research_file_id
        ? { ...workspaceContext, subjects: tabularDetail.review.scope_config?.subjects ?? workspaceContext.subjects, restricted: true }
        : workspaceContext,
        permittedEvidence = researchResultFilter(researchContext);
      const priorEvents = rows.flatMap((row) => Array.isArray(row.content) ? row.content : []),
        priorEvidenceReceipts = [...new Map([...priorLegalEvidenceReceipts(priorEvents),
          ...(researchEvidence?.items.flatMap((item) => item.kind === "passage" ? [item.value.receipt] : []) ?? [])]
          .map((receipt) => [receipt.evidence_id, receipt])).values()].filter((receipt) =>
            permittedEvidence({ resource: legalEvidenceResourceReference(receipt) ?? "", evidence: [receipt] })),
        priorQueries = [...new Map([...priorLegalResearchQueryReceipts(priorEvents),
          ...(researchQueries?.items.flatMap((item) => item.kind === "query" ? [item.value] : []) ?? [])]
          .map((receipt) => [receipt.query_id, receipt])).values()],
        evidenceState = createLegalEvidenceTurnState();
      registerPriorLegalResearchQueries(evidenceState, priorQueries);
      const images = await loadImages(deps.documents, auth, messages, context.records);
      if (images.size && !modelSupportsImageInput(selectedModel)) {
        throw new ChatApplicationError(400,
          `Model "${selectedModel}" does not support image input.`);
      }
      const focus = [
        ...(input.displayed_doc ? [`Displayed document: ${JSON.stringify(
          context.records.get(input.displayed_doc.document_id)?.filename,
        )}`] : []),
        ...(turnFiles.length ? [
          "User-attached documents for this turn:",
          ...turnFiles.map(({ document_id }) =>
            `- ${JSON.stringify(context.records.get(document_id)?.filename)}`),
        ] : []),
      ];
      const systemPrompt = [
        CODING_PRODUCTION_SYSTEM_PROMPT,
        CLIENT_WORK_PRODUCT_PRESUMPTION,
        jurisdictionPreferencePrompt(input.jurisdiction_preference ?? null),
        features.personalisationPrompt,
        priorLegalEvidencePrompt(priorEvidenceReceipts, priorQueries),
        tabularPrompt,
        research ? `CURRENT RESEARCH WORKSPACE: ${resourceReference.document(research.document.id, research.versionId)}\n` +
          `Read this workspace for labels, sources, passages, searches, memo, and history. Read findings for saved answers and table results, then use their returned references when arranging a view. Page through Read for more results.\n` +
          `Choose useful sets, labels, question columns, and grouping for the user's task. Reuse relevant findings and request new answers where needed. Apply reversible work within the request; propose material changes beyond that scope for review.\n` +
          `Linked tables: ${(research.state.tables ?? []).join(", ") || "none"}. Use update_research_table to create or organize a table and read_table_cells to read its supported answers.` : "",
        focus.length ? `CURRENT MATTER FOCUS:\n${focus.join("\n")}` : "",
        availableDocumentsPrompt(context.docIndex, context.records, requested),
        input.word_context ? [
          `ACTIVE WORD DOCUMENT: ${JSON.stringify(input.word_context.document_name)}`,
          "This live document is available only through read_active_document and " +
            "apply_word_edits; it is not a Library document.",
        ].join("\n") : "",
      ].filter(Boolean).join("\n\n");

      if (input.word_context && !execution?.clientTool) {
        throw new ChatApplicationError(400, "The Word document bridge is unavailable");
      }

      if (!chat) chat = await deps.chats.create(auth, { projectId, tabularReviewId, researchFileId,
        researchSelection: researchSelection ?? null });
      if (!sink.claim(chat.id)) {
        conflict("chat_turn_in_progress", chat.transcript_version,
          "A response is already running");
      }
      const claimed = await deps.chats.commitTurn(auth, chat.id, commit);
      if (claimed.status === "missing") throw new ChatApplicationError(404, "Chat not found");
      if (claimed.status === "conflict") {
        conflict("chat_version_conflict", claimed.currentVersion);
      }
      let version = claimed.currentVersion;
      if (research && (!research.state.chats?.includes(chat.id) || researchFileId !== chat.research_file_id ||
          JSON.stringify(researchSelection ?? null) !== JSON.stringify(chat.research_selection ?? null))) {
        await deps.sources.bind(auth, research.document.id, { chatId: chat.id,
          selection: researchSelection ?? undefined }, { executor: "human", chatId: chat.id, turnId });
      }
      chat = await deps.chats.update(auth, chat.id, {
        model: selectedModel,
        ...(input.research_file_id === null ? { researchFileId: null, researchSelection: null } : {}),
        reasoningEffort: input.reasoning_effort ?? null,
      }) ?? chat;
      await execution?.onAccepted?.(chat.id);
      if (!assistant && commit.assistantMessage) assistant = {
        id: commit.assistantMessage.id,
        chat_id: chat.id,
        turn_id: turnId,
        role: "assistant",
        content: assistantContent,
      };

      let persistence: Promise<void> | undefined, pendingContent: AssistantEvent[] | undefined,
        chatAvailable = true, nextCheckpoint = 0;
      let localTools!: ReturnType<typeof createChatToolRunner>;
      const currentWorkspace = async () => {
        const current = await deps.chats.get(auth, chat!.id), id = current?.research_file_id;
        return id ? deps.sources.get(auth, id) : null;
      };
      localTools = createChatToolRunner({
        userId: auth.userId,
        userEmail: auth.userEmail,
        model: selectedModel,
        turnId,
        chatId: chat.id,
        audit: deps.audit,
        sources: deps.sources,
        onResearchWorkspace: async (documentId, state) => {
          await deps.sources.bind(auth, documentId, { chatId: chat!.id },
            { executor: "assistant", model: selectedModel, chatId: chat!.id, turnId });
          const observation = state && legalEvidenceReceiptEvent({ ...state, answer: null, failure: null });
          if (observation) await deps.sources.observe(auth, documentId, observation,
            { executor: "assistant", model: selectedModel, chatId: chat!.id, turnId });
          return deps.sources.get(auth, documentId);
        },
        projectId,
        allowedDocumentIds: context.allowed,
        documentNames: new Map([...context.records].map(([id, record]) => [
          id, record.filename,
        ])),
        docIndex: Object.keys(context.docIndex).length ? context.docIndex : undefined,
        documents: deps.documents,
        library: deps.library,
        projects: deps.projects,
        workProducts: deps.workProducts,
        authorities: deps.authorities,
        authoritiesId: input.work_product?.kind === "authorities"
          ? input.work_product.id : undefined,
        authoritiesRevision: input.work_product?.kind === "authorities"
          ? input.work_product.revision : undefined,
        workProductFocus: input.work_product?.focus && {
          itemId: input.work_product.focus.item_id,
          selection: input.work_product.focus.selection,
        },
        courtRecords: deps.courtRecords,
        courtRecordId: input.work_product?.kind === "court-record"
          ? input.work_product.id : undefined,
        courtRecordRevision: input.work_product?.kind === "court-record"
          ? input.work_product.revision : undefined,
        workflows: features.workflows,
        researchTables: deps.tabular.create && deps.tabular.update && deps.tabular.generate && deps.tabular.stop &&
          deps.tabular.history && deps.tabular.change
          ? { application: { detail: deps.tabular.detail, create: deps.tabular.create,
            update: deps.tabular.update, generate: deps.tabular.generate, stop: deps.tabular.stop,
            history: deps.tabular.history, change: deps.tabular.change },
            getWorkspace: currentWorkspace } : undefined,
        resolveTabular: async (reviewId) => {
          const id = reviewId ?? tabularReviewId;
          if (!id || id !== tabularReviewId && !(await currentWorkspace())?.state.tables?.includes(id)) return null;
          return deps.tabular.detail(auth, id);
        },
        editMode: input.edit_mode as EditMode,
        timeZone: input.time_zone,
        entries: [
          ...(features.extraTools ?? []),
          ...(input.word_context && execution?.clientTool ? wordClientTools({
            call: execution.clientTool,
            editMode: input.edit_mode,
            onMutation: async () => {
              localTools.commitMutation();
              await persistence;
            },
          }) : []),
        ],
        includeResearchTools: features.includeResearchTools,
        productFeatures: features.productFeatures,
        draftingStyle: features.draftingStyle,
        onMutationCommitted: () => queuePersist([{
          type: LOCAL_MUTATION_COMMITTED_EVENT, schema_version: 1,
        }], [], true),
      });
      const slugByDocumentId = new Map(Object.entries(context.docIndex)
        .map(([slug, info]) => [info.document_id, slug]));
      const modelMessages = messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: formatChatMessageContent(message, slugByDocumentId),
        images: imageForMessage(message, images),
        contextCheckpoint: message.contextCheckpoint,
      }));
      const assistantId = assistant?.id ?? randomUUID();
      function queuePersist(events: AssistantEvent[], citations: unknown[] = [], force = false) {
        for (const event of events) {
          const index = "id" in event && REPLACEABLE_EVENT_TYPES.has(event.type)
            ? assistantContent.findIndex((current) => current.type === event.type &&
                "id" in current && current.id === event.id) : -1;
          const previous = assistantContent[index];
          if (index < 0) assistantContent.push(event); else assistantContent[index] = event;
          force ||= event.type === "subagent_run" && (index < 0 || event.status !== "running" ||
            Boolean(event.resume && !(previous?.type === "subagent_run" && previous.resume)));
        }
        assistantCitations.push(...citations);
        if (!force && performance.now() < nextCheckpoint) return persistence;
        nextCheckpoint = performance.now() + CHAT_PROGRESS_CHECKPOINT_MS;
        pendingContent = [...assistantContent];
        persistence ??= (async () => {
          while (pendingContent) {
            const content = pendingContent;
            pendingContent = undefined;
            if (!chatAvailable) continue;
            const result = await deps.chats.commitTurn(auth, chat!.id, {
              expectedVersion: version,
              assistantMessage: { id: assistantId, turnId, content,
                citations: [...assistantCitations] },
            });
            if (result.status === "conflict")
              conflict("chat_version_conflict", result.currentVersion);
            if (result.status === "missing") chatAvailable = false;
            if (result.status === "committed") version = result.currentVersion;
          }
        })().finally(() => { persistence = undefined; });
        return persistence;
      }

      let providerSession: Awaited<ReturnType<
        NonNullable<ChatApplicationFeatures["providerSession"]>["claim"]
      >> = null;
      try {
        providerSession = await deps.features.providerSession?.claim({
          auth,
          chatId: chat.id,
          projectId,
          researchFileId: research?.document.id,
          provider: responseProvider,
          model: selectedModel,
          reasoningEffort: input.reasoning_effort,
          expectedVersion: input.expected_version,
        }) ?? null;
      } catch (error) {
        console.warn("[chat] provider continuation unavailable", safeErrorLog(error));
      }
      let activeContinuationId = execution?.continuationId ?? providerSession?.continuationId;
      const onSubagentEvent = (event: ReadSubagentEvent) => {
        void queuePersist([event])?.catch(() => undefined);
      };
      try {
        sink.emit({ type: "chat_id", chatId: chat.id, transcriptVersion: version });
        const result = await runChatTurn({
          model: selectedModel,
          systemPrompt,
          messages: modelMessages,
          createTools: localTools.createTools,
          researchContext,
          priorQueries,
          operation: { executor: "assistant", model: selectedModel, chatId: chat.id, turnId,
            ...(tabularReviewId ? { reviewId: tabularReviewId } : {}) },
          onResearchObserved: async (receipt, operation) => {
            const current = await currentWorkspace();
            if (current) await deps.sources.observe(auth, current.document.id, receipt, operation);
          },
          emit: (event) => {
            sink.emit(event);
            if (event.type === "tool_activity")
              void queuePersist([event])?.catch(() => undefined);
          },
          apiKeys: features.apiKeys,
          reasoningEffort: input.reasoning_effort,
          compactThreshold: compactionThresholdForModel(selectedModel),
          promptCacheKey: providerSession?.promptCacheKey,
          signal,
          prepareMessages: async (onCompaction) => {
            const prepared = await compactChatContext({
              store: deps.chats, scope: auth, chatId: chat!.id,
              model: selectedModel, apiKeys: features.apiKeys, signal,
              onStatus: onCompaction,
            });
            version = (await deps.chats.get(auth, chat!.id))?.transcript_version ?? version;
            const preparedMessages = prepared.messages.map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: formatChatMessageContent(message, slugByDocumentId),
              images: imageForMessage(message, images),
              contextCheckpoint: message.contextCheckpoint,
            }));
            return preparedMessages;
          },
          subagentMode: input.subagent_mode as SubagentMode,
          subagentModel: input.subagent_model,
          subagentEffort: input.subagent_effort,
          jurisdictionPreference: input.jurisdiction_preference as JurisdictionPreference,
          activityDetail: input.activity_detail,
          evidenceState,
          priorEvidence: priorEvidenceReceipts,
          resumableSubagents: resumableReadSubagents(rows.flatMap((row) =>
            Array.isArray(row.content) ? row.content : [])),
          providerSession: providerSession
            ? { persist: true, ...(activeContinuationId
                ? { continuationId: activeContinuationId } : {}) }
            : undefined,
          onProviderContinuation: async (id) => {
            activeContinuationId = id;
            await execution?.onContinuation?.(id);
          },
          onProviderControl: sink.setControl,
          canRetryProviderSession: () => !localTools.mutationCommitted(),
          onSubagentEvent,
        });
        activeContinuationId = result.continuationId ?? activeContinuationId;
        await persistence;
        const events = result.events.filter(({ type }) => !TRANSIENT_EVENT_TYPES.has(type));
        if (!result.fullText && !result.events.some(({ type }) => [
          "content", "document_artifact", "workflow_run",
        ].includes(type)) && result.status !== "paused") {
          events.push({ type: "error", message: "The selected model returned no response." });
        }
        events.push({ type: LOCAL_TURN_COMPLETED_EVENT, schema_version: 1 });
        await queuePersist(events, result.citations, true);
        if (!chat.title) {
          const lastUser = [...messages].reverse().find(({ role }) => role === "user");
          if (lastUser?.content) {
            await deps.chats.update(auth, chat.id, {
              title: normalizeChatTitle(lastUser.content),
            });
          }
        }
        await providerSession?.save(activeContinuationId, version);
        sink.emit({ type: "transcript_version", transcriptVersion: version });
        deps.features.audit?.(auth, {
          chatId: chat.id, projectId, title: chat.title, model: selectedModel,
          events: result.events,
        });
        return { chatId: chat.id, transcriptVersion: version };
      } catch (error) {
        const message = safeErrorMessage(error, "Model request failed");
        console.error("[chat]", safeErrorLog(error));
        if (chatAvailable) {
          await persistence?.catch(() => undefined);
          await queuePersist([
            ...(error instanceof AssistantStreamError
              ? error.events.filter(({ type }) => !TRANSIENT_EVENT_TYPES.has(type))
              : []),
            isAbortError(error)
              ? { type: "turn_status", status: "cancelled" }
              : { type: "error", message },
          ], [], true)?.catch((persistError) => console.error(
            "[chat] failed to persist model error", safeErrorLog(persistError),
          ));
          await providerSession?.save(activeContinuationId, version);
        }
        deps.features.audit?.(auth, {
          chatId: chat.id, projectId, title: chat.title, model: selectedModel,
          status: isAbortError(error) ? "cancelled" : "failed", events: null,
        });
        if (!signal.aborted) {
          sink.emit({
            type: "error", message,
            ...(localTools.mutationCommitted() ? { retryable: false } : {}),
          });
          sink.emit({ type: "transcript_version", transcriptVersion: version });
        }
        if (!isAbortError(error)) throw error;
        return { chatId: chat.id, transcriptVersion: version };
      }
    },
  };
}

export type ChatApplication = ReturnType<typeof createChatApplication>;
