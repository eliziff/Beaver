import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BeaverTool } from "./toolRegistry";
import {
  AssistantStreamError,
  runChatTurn,
  type AssistantEvent,
  type ChatToolContext,
} from "./turnEngine";
import { createChatToolRunner } from "./chatToolRunner";
import {
  CLIENT_WORK_PRODUCT_PRESUMPTION,
  CODING_PRODUCTION_SYSTEM_PROMPT,
  SPREADSHEET_CITATION_PROMPT,
  jurisdictionPreferencePrompt,
  type JurisdictionPreference,
} from "./prompts";
import {
  DEFAULT_MAIN_MODEL,
  modelSupportsImageInput,
  resolveModel,
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
import { normalizeAskInputsEvent } from "./askInputs";
import {
  priorLegalEvidencePrompt,
  priorLegalEvidenceReceipts,
} from "./legalEvidence";
import {
  READ_SUBAGENT_SYSTEM_PROMPT,
  resumableReadSubagents,
  type ReadSubagentEvent,
} from "./readSubagents";
import { tabularChatContext } from "./tabularContext";
import { safeErrorLog, safeErrorMessage } from "../safeError";
import {
  normalizeChatTitle,
  type ChatMessageRecord,
  type ChatScope,
  type ChatStore,
  type ChatTurnCommit,
} from "../chatStore";
import type { DocumentStore } from "../documentStore";
import type { LibraryStore } from "../libraryStore";
import type { ProjectStore } from "../projectStore";
import type { TabularApplication } from "../tabular/application";
import type {
  AskInputResponseItem,
  AskInputsEvent,
  AskInputsResponseRequest,
  ChatMessage,
  DocIndex,
  TabularCellStore,
  WorkflowStore,
} from "./types";
import type { EditMode } from "../docxTrackedChanges";
import { chatTurnWasDeleted, setChatTurnControl } from "../chatTurns";

const uuid = z.string().uuid();
const documentReference = z.object({
  filename: z.string().trim().min(1).max(500),
  document_id: z.string().trim().min(1).max(200),
}).strict();
const workflow = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
}).strict();
const choiceResponse = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("choice"),
  question: z.string().trim().min(1).max(2_000),
  answer: z.string().max(20_000).optional(),
  skipped: z.boolean().optional(),
}).strict();
const documentResponse = z.object({
  id: z.string().trim().min(1).max(80),
  kind: z.literal("documents"),
  filenames: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  documents: z.array(documentReference).max(50).optional(),
  skipped: z.boolean().optional(),
}).strict();
const currentTurn = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    turn_id: uuid.optional(),
    content: z.string().trim().min(1).max(1_000_000),
    files: z.array(documentReference).max(50).optional(),
    workflow: workflow.optional(),
  }).strict(),
  z.object({
    kind: z.literal("ask_inputs_response"),
    content: z.string().trim().min(1).max(1_000_000),
    files: z.array(documentReference).max(50).optional(),
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
  current_turn: currentTurn,
  expected_version: z.number().int().nonnegative(),
  model: z.string().trim().min(1).max(200).optional(),
  reasoning_effort: z.string().trim().min(1).max(32).optional(),
  service_tier: z.string().trim().min(1).max(32).optional(),
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
  displayed_doc: documentReference.optional(),
  attached_documents: z.array(documentReference).max(50).optional(),
}).strict().superRefine((value, context) => {
  if (value.project_id && value.tabular_review_id) {
    context.addIssue({
      code: "custom",
      message: "A chat cannot belong to both a project and a tabular review",
    });
  }
});

export type ChatTurnInput = z.infer<typeof chatTurnInputSchema>;
export type AuthContext = ChatScope;
export type EventSink = {
  claim(chatId: string): boolean;
  start(): void;
  emit(event: unknown): void;
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
      provider: string;
      model: string;
      reasoningEffort?: string;
      serviceTier?: string;
      expectedVersion: number;
    }): Promise<{
      continuationId?: string;
      promptCacheKey?: string;
      save(continuationId: string | undefined, version: number): void;
    } | null>;
    compact(input: {
      auth: AuthContext;
      chatId: string;
      model: string;
      signal: AbortSignal;
    }): Promise<{ handled: boolean; save(version: number): void }>;
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

type Dependencies = {
  chats: ChatStore;
  documents: DocumentStore;
  library: LibraryStore;
  projects: ProjectStore;
  tabular: Pick<TabularApplication, "detail">;
  features: ChatApplicationFeatures;
};

const LOCAL_MUTATION_COMMITTED_EVENT = "local_mutation_committed";
const LOCAL_TURN_COMPLETED_EVENT = "local_turn_completed";
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

function pendingAskInputs(messages: ChatMessageRecord[]) {
  const assistant = [...messages].reverse().find(({ role }) => role === "assistant");
  if (!assistant || !Array.isArray(assistant.content)) return null;
  let ask: AskInputsEvent | null = null;
  let response: AskInputsResponseRequest | null = null;
  let failed = false, mutationCommitted = false;
  for (const value of assistant.content) {
    const event = asRecord(value);
    if (event?.type === "ask_inputs") {
      const normalized = normalizeAskInputsEvent(event);
      ask = normalized.items.length ? normalized : null;
      response = null; failed = false; mutationCommitted = false;
    } else if (event?.type === "ask_inputs_response" && ask) {
      response = { responses: Array.isArray(event.responses)
        ? event.responses as AskInputResponseItem[] : [] };
      failed = false; mutationCommitted = false;
    } else if (response && event?.type === LOCAL_MUTATION_COMMITTED_EVENT) {
      mutationCommitted = true;
    } else if (response && (event?.type === "error" ||
      (event?.type === "turn_status" && event.status === "cancelled"))) {
      failed = true;
    }
  }
  return ask && (!response || failed)
    ? { event: ask, retryResponse: response, mutationCommitted, assistant }
    : null;
}

function canonicalAskResponse(
  pending: AskInputsEvent,
  submitted: AskInputsResponseRequest,
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
      if (value.question.trim() !== item.question) return null;
      if (value.skipped) responses.push({
        id: item.id, kind: "choice", question: item.question, skipped: true,
      });
      else if (value.answer?.trim()) responses.push({
        id: item.id, kind: "choice", question: item.question,
        answer: value.answer.trim(),
      });
      else return null;
    } else if (item.kind === "documents" && value.kind === "documents") {
      if (value.skipped) responses.push({
        id: item.id, kind: "documents", filenames: [], documents: [], skipped: true,
      });
      else {
        const ids = value.documents?.map(({ document_id }) => document_id) ?? [];
        const documents = [...new Set(ids)].flatMap((id) => available.get(id) ?? []);
        if (!documents.length || documents.length !== ids.length) return null;
        responses.push({
          id: item.id, kind: "documents",
          filenames: documents.map(({ filename }) => filename), documents,
        });
      }
    }
  }
  const lines = responses.map((item, index) => item.kind === "choice"
    ? item.skipped ? `${index + 1}. Skipped: ${item.question}`
      : `${index + 1}. ${item.question}\n${item.answer}`
    : item.skipped ? `${index + 1}. Skipped document request.`
      : `${index + 1}. Documents attached: ${item.filenames.join(", ")}`);
  return { responses, content: `Responses to Beaver's questions:\n${lines.join("\n\n")}` };
}

const sameResponse = (left: AskInputsResponseRequest, right: AskInputsResponseRequest) =>
  JSON.stringify(left.responses) === JSON.stringify(right.responses);

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
    completed: events.some((event) => asRecord(event)?.type === LOCAL_TURN_COMPLETED_EVENT),
    mutationCommitted: events.some((event) =>
      asRecord(event)?.type === LOCAL_MUTATION_COMMITTED_EVENT),
  };
}

function conflict(code: string, currentVersion: number, detail = "Chat changed") {
  throw new ChatApplicationError(409, detail, code, currentVersion);
}

async function projectDocuments(
  projects: ProjectStore,
  auth: AuthContext,
  projectId: string,
) {
  if (!await projects.get(auth, projectId)) return null;
  const queue: Array<{ id: string | null; path: string }> = [{ id: null, path: "" }];
  const documents: Array<Record<string, unknown> & { folder_path?: string }> = [];
  while (queue.length) {
    const parent = queue.shift()!;
    let after: [number, string, string] | null = null;
    do {
      const page = await projects.directory(auth, projectId, {
        q: "", parentFolderId: parent.id, limit: 100, after,
      });
      for (const value of page.items) {
        const row = asRecord(value);
        const folder = asRecord(row?.folder), document = asRecord(row?.document);
        if (row?.kind === "folder" && typeof folder?.id === "string") {
          const name = String(folder.name ?? "").trim();
          queue.push({ id: folder.id, path: [parent.path, name].filter(Boolean).join(" / ") });
        } else if (row?.kind === "document" && document) {
          documents.push({ ...document, ...(parent.path ? { folder_path: parent.path } : {}) });
        }
      }
      after = page.nextAfter;
    } while (after);
  }
  return documents;
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
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records ?? []) if (typeof record.id === "string") {
    byId.set(record.id, record);
  }
  const ids = new Set<string>(selectedIds);
  for (const message of messages) {
    for (const file of Array.isArray(message.files)
      ? message.files as { document_id?: unknown }[] : []) {
      if (typeof file.document_id === "string") ids.add(file.document_id);
    }
    for (const event of Array.isArray(message.content)
      ? message.content as Record<string, unknown>[] : []) {
      if (event.type === "document_artifact" &&
          typeof event.document_id === "string") ids.add(event.document_id);
    }
  }
  for (const id of ids) if (!byId.has(id)) {
    const details = await deps.documents.versions(auth, id);
    const version = details?.versions.find(({ id: versionId }) =>
      versionId === details.current_version_id);
    if (version) byId.set(id, {
      id,
      filename: version.filename,
      file_type: version.file_type,
      current_version_id: version.id,
      active_version_number: version.version_number,
    });
  }
  if (selectedIds.some((id) => !byId.has(id))) {
    throw new ChatApplicationError(400, "Selected document is unavailable");
  }
  const docIndex: DocIndex = {};
  let index = 0;
  for (const [id, record] of byId) {
    const filename = String(record.filename ?? "Untitled document").trim();
    docIndex[`doc-${index++}`] = {
      document_id: id,
      filename,
      version_id: typeof record.current_version_id === "string"
        ? record.current_version_id : null,
      version_number: typeof record.active_version_number === "number"
        ? record.active_version_number : null,
    };
  }
  return { records: byId, docIndex, allowed: new Set(byId.keys()) };
}

async function loadImages(
  documents: DocumentStore,
  auth: AuthContext,
  messages: ChatMessage[],
  records: Map<string, Record<string, unknown>>,
) {
  const ids = new Set(messages.flatMap((message) => (message.files ?? [])
    .flatMap((file) => file.document_id &&
      isImageDocumentType(String(records.get(file.document_id)?.file_type ?? ""))
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
    const image = file.document_id ? images.get(file.document_id) : undefined;
    return image ? [image] : [];
  });
  return selected.length ? selected : undefined;
}

function availableDocumentsPrompt(
  docIndex: DocIndex,
  records: Map<string, Record<string, unknown>>,
) {
  if (!Object.keys(docIndex).length) return "";
  const lines = Object.entries(docIndex).map(([label, info]) => {
    const path = String(records.get(info.document_id)?.folder_path ?? "");
    return `- ${label}: ${path ? `${path} / ` : ""}${info.filename}`;
  });
  return `AVAILABLE DOCUMENTS:\n${lines.join("\n")}\nCall Read for the relevant versioned resource before relying on its content.`;
}

export function createChatApplication(deps: Dependencies) {
  return {
    async compact(
      auth: AuthContext,
      input: { chatId: string; model?: string },
      signal: AbortSignal,
      claim: (chatId: string) => boolean,
    ) {
      const chat = await deps.chats.get(auth, input.chatId);
      if (!chat) throw new ChatApplicationError(404, "Chat not found");
      if (!claim(chat.id)) conflict(
        "chat_turn_in_progress",
        chat.transcript_version,
        "A response is already running",
      );
      const model = resolveModel(input.model, DEFAULT_MAIN_MODEL);
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
      provider.save(appended.currentVersion);
      return { compacted: true, transcriptVersion: appended.currentVersion };
    },

    async turn(
      auth: AuthContext,
      input: ChatTurnInput,
      sink: EventSink,
      signal: AbortSignal,
    ) {
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
      const requested = [
        ...(input.current_turn.files ?? []).map(({ document_id }) => document_id),
        ...(input.displayed_doc ? [input.displayed_doc.document_id] : []),
        ...(input.attached_documents ?? []).map(({ document_id }) => document_id),
      ];
      const context = await loadDocumentContext(
        deps, auth, projectId, rows, [...new Set(requested)],
      );
      const canonicalFiles = (input.current_turn.files ?? []).map((file) => ({
        document_id: file.document_id,
        filename: String(context.records.get(file.document_id)?.filename ?? file.filename),
      }));
      const tabularDetail = tabularReviewId
        ? await deps.tabular.detail(auth, tabularReviewId) : null;
      if (tabularReviewId && !tabularDetail) {
        throw new ChatApplicationError(404, "Review not found");
      }
      const tabular = tabularDetail ? tabularChatContext(tabularDetail) : undefined;
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
          { responses: input.current_turn.responses as AskInputResponseItem[] },
          canonicalFiles,
        );
        if (!canonical) throw new ChatApplicationError(400,
          "Response does not match the pending assistant questions");
        if (pending.retryResponse && !sameResponse(
          pending.retryResponse, { responses: canonical.responses },
        )) throw new ChatApplicationError(400,
          "Retry the same response to the assistant questions");
        if (pending.mutationCommitted) conflict(
          "chat_retry_blocked_after_mutation", chat?.transcript_version ?? 0,
          "The prior continuation changed data before it stopped. Review that result before sending a new instruction.",
        );
        if (!pending.retryResponse) assistantContent.push({
          type: "ask_inputs_response",
          content: canonical.content,
          files: canonicalFiles,
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
              JSON.stringify(input.current_turn.workflow ?? null);
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
            ? assistant.content.filter((event) => {
                const row = asRecord(event);
                return row?.type === "subagent_run" && row.status === "interrupted" &&
                  !!asRecord(row.resume);
              }) : [];
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
            workflow: input.current_turn.workflow,
          },
        };
      }
      if (!commit.userMessage && !commit.assistantMessage) {
        // A retried turn without an assistant receipt still needs one atomic CAS write.
        commit.assistantMessage = {
          id: randomUUID(), turnId, content: [], citations: [],
        };
      }
      const selectedModel = resolveModel(input.model, DEFAULT_MAIN_MODEL);
      const responseProvider = providerForModel(selectedModel);
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
        workflow: input.current_turn.workflow,
      });
      const priorEvidence = priorLegalEvidenceReceipts(rows.flatMap((row) =>
        Array.isArray(row.content) ? row.content : []));
      const evidencePrompt = priorLegalEvidencePrompt(priorEvidence);
      if (evidencePrompt) {
        const last = messages.map(({ role }) => role).lastIndexOf("user");
        if (last >= 0) messages[last] = {
          ...messages[last],
          content: `${messages[last].content}\n\n${evidencePrompt}`,
        };
      }
      const images = await loadImages(deps.documents, auth, messages, context.records);
      if (images.size && !modelSupportsImageInput(selectedModel)) {
        throw new ChatApplicationError(400,
          `Model "${selectedModel}" does not support image input.`);
      }
      const features = await deps.features.load(auth);
      const focus = [
        ...(input.displayed_doc ? [`Displayed document: ${JSON.stringify(
          context.records.get(input.displayed_doc.document_id)?.filename,
        )}`] : []),
        ...(input.attached_documents?.length ? [
          "User-attached documents for this turn:",
          ...input.attached_documents.map(({ document_id }) =>
            `- ${JSON.stringify(context.records.get(document_id)?.filename)}`),
        ] : []),
      ];
      const hasSpreadsheet = [...context.records.values()].some((record) =>
        /\.(?:xlsx|xlsm|xls|csv|ods)$/iu.test(String(record.filename ?? "")));
      const systemPrompt = [
        CODING_PRODUCTION_SYSTEM_PROMPT,
        CLIENT_WORK_PRODUCT_PRESUMPTION,
        input.subagent_mode === "beaver" ? READ_SUBAGENT_SYSTEM_PROMPT : "",
        jurisdictionPreferencePrompt(input.jurisdiction_preference ?? null),
        tabular?.prompt,
        focus.length ? `CURRENT MATTER FOCUS:\n${focus.join("\n")}` : "",
        availableDocumentsPrompt(context.docIndex, context.records),
        hasSpreadsheet ? SPREADSHEET_CITATION_PROMPT : "",
      ].filter(Boolean).join("\n\n");

      if (!chat) chat = await deps.chats.create(auth, { projectId, tabularReviewId });
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
      if (!assistant && commit.assistantMessage) assistant = {
        id: commit.assistantMessage.id,
        chat_id: chat.id,
        turn_id: turnId,
        role: "assistant",
        content: assistantContent,
      };

      const localTools = createChatToolRunner({
        userId: auth.userId,
        userEmail: auth.userEmail,
        projectId,
        allowedDocumentIds: context.allowed,
        documentNames: new Map([...context.records].map(([id, record]) => [
          id, String(record.filename ?? "Untitled document"),
        ])),
        documents: deps.documents,
        library: deps.library,
        projects: deps.projects,
        workflows: features.workflows,
        tabular: tabular?.store as TabularCellStore | undefined,
        editMode: input.edit_mode as EditMode,
        timeZone: input.time_zone,
        entries: features.extraTools,
        includeResearchTools: features.includeResearchTools,
        onMutationCommitted: () => queuePersist([{
          type: LOCAL_MUTATION_COMMITTED_EVENT, schema_version: 1,
        }]),
      });
      const slugByDocumentId = new Map(Object.entries(context.docIndex)
        .map(([slug, info]) => [info.document_id, slug]));
      const modelMessages = messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" as const : "user" as const,
        content: formatChatMessageContent(message, slugByDocumentId),
        images: imageForMessage(message, images),
        contextCheckpoint: message.contextCheckpoint,
      }));
      let persistence = Promise.resolve();
      const assistantId = assistant?.id ?? randomUUID();
      const upsertEvents = (events: unknown[]) => {
        for (const event of events) {
          const row = asRecord(event);
          if (row?.type === "subagent_run" && typeof row.id === "string") {
            const index = assistantContent.findIndex((value) => {
              const current = asRecord(value);
              return current?.type === "subagent_run" && current.id === row.id;
            });
            if (index >= 0) assistantContent[index] = event;
            else assistantContent.push(event);
          } else assistantContent.push(event);
        }
      };
      function queuePersist(events: unknown[], citations: unknown[] = []) {
        upsertEvents(events);
        assistantCitations.push(...citations);
        const content = [...assistantContent], savedCitations = [...assistantCitations];
        persistence = persistence.then(async () => {
          if (chatTurnWasDeleted(chat!.id)) return;
          const result = await deps.chats.commitTurn(auth, chat!.id, {
            expectedVersion: version,
            assistantMessage: {
              id: assistantId, turnId, content, citations: savedCitations,
            },
          });
          if (result.status === "missing") return;
          if (result.status === "conflict") {
            conflict("chat_version_conflict", result.currentVersion);
          }
          version = result.currentVersion;
        });
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
          provider: responseProvider,
          model: selectedModel,
          reasoningEffort: input.reasoning_effort,
          serviceTier: input.service_tier,
          expectedVersion: input.expected_version,
        }) ?? null;
      } catch (error) {
        console.warn("[chat] provider continuation unavailable", safeErrorLog(error));
      }
      let activeContinuationId = providerSession?.continuationId;
      const onSubagentEvent = (event: ReadSubagentEvent) => {
        if (!chatTurnWasDeleted(chat!.id)) queuePersist([event]);
      };
      try {
        sink.start();
        sink.emit({ type: "chat_id", chatId: chat.id, transcriptVersion: version });
        const result = await runChatTurn({
          model: selectedModel,
          systemPrompt,
          messages: modelMessages,
          createTools: localTools.createTools,
          emit: sink.emit,
          apiKeys: features.apiKeys,
          reasoningEffort: input.reasoning_effort,
          serviceTier: input.service_tier,
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
            return prepared.messages.map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: formatChatMessageContent(message, slugByDocumentId),
              images: imageForMessage(message, images),
              contextCheckpoint: message.contextCheckpoint,
            }));
          },
          subagentMode: input.subagent_mode as SubagentMode,
          subagentModel: input.subagent_model,
          subagentEffort: input.subagent_effort,
          jurisdictionPreference: input.jurisdiction_preference as JurisdictionPreference,
          activityDetail: input.activity_detail,
          priorEvidence,
          resumableSubagents: resumableReadSubagents(rows.flatMap((row) =>
            Array.isArray(row.content) ? row.content : [])),
          providerSession: providerSession
            ? { persist: true, ...(activeContinuationId
                ? { continuationId: activeContinuationId } : {}) }
            : undefined,
          onProviderContinuation: (id) => { activeContinuationId = id; },
          onProviderControl: sink.setControl,
          canRetryProviderSession: () => !localTools.mutationCommitted(),
          onSubagentEvent,
        });
        activeContinuationId = result.continuationId ?? activeContinuationId;
        await persistence;
        const events: unknown[] = result.events.filter(({ type }) =>
          !["reasoning", "error", "context_usage", "case_opinions"].includes(type));
        if (!result.fullText && !result.events.some(({ type }) => [
          "content", "document_artifact", "automation_run",
        ].includes(type)) && result.status !== "paused") {
          events.push({ type: "error", message: "The selected model returned no response." });
        }
        events.push({ type: LOCAL_TURN_COMPLETED_EVENT, schema_version: 1 });
        await queuePersist(events, result.citations);
        if (!chat.title) {
          const lastUser = [...messages].reverse().find(({ role }) => role === "user");
          if (lastUser?.content) {
            await deps.chats.update(auth, chat.id, {
              title: normalizeChatTitle(lastUser.content),
            });
          }
        }
        providerSession?.save(activeContinuationId, version);
        sink.emit({ type: "transcript_version", transcriptVersion: version });
        sink.emit({ type: "content_done" });
        deps.features.audit?.(auth, {
          chatId: chat.id, projectId, title: chat.title, model: selectedModel,
          events: result.events,
        });
        return { chatId: chat.id, transcriptVersion: version };
      } catch (error) {
        const message = safeErrorMessage(error, "Model request failed");
        console.error("[chat]", safeErrorLog(error));
        if (!chatTurnWasDeleted(chat.id)) {
          await persistence.catch(() => undefined);
          await queuePersist([
            ...(error instanceof AssistantStreamError
              ? error.events.filter(({ type }) =>
                  !["reasoning", "error", "context_usage"].includes(type))
              : []),
            isAbortError(error)
              ? { type: "turn_status", status: "cancelled" }
              : { type: "error", message },
          ]).catch((persistError) => console.error(
            "[chat] failed to persist model error", safeErrorLog(persistError),
          ));
          providerSession?.save(activeContinuationId, version);
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
