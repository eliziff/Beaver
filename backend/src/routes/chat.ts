import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { isAnonymousLocalMode } from "../lib/localMode";
import {
  buildDocContext,
  buildMessages,
  enrichWithPriorEvents,
  buildWorkflowStore,
  appendAskInputsResponseToLastAssistantMessage,
  appendAssistantEventsToLastAssistantMessage,
  AssistantStreamError,
  buildCancelledAssistantMessage,
  extractCitations,
  isAbortError,
  runLLMStream,
  stripTransientAssistantEvents,
  parseAskInputsResponsePayload,
  normalizeAskInputsEvent,
  type AskInputResponseItem,
  type AskInputsEvent,
  type AskInputsResponseRequest,
  type ChatMessage,
} from "../lib/chat";
import {
  completeText,
  DEFAULT_MAIN_MODEL,
  modelSupportsImageInput,
  streamChatWithTools,
  type LlmImage,
} from "../lib/llm";
import {
  LOCAL_ASSISTANT_TOOLS,
  runLocalAssistantTools,
} from "../lib/chat/localAssistantTools";
import { appendLocalPdfPinpointLinks } from "../lib/chat/localPdfEvidenceState";
import { appendA2AJPinpointLinks } from "../lib/legalSourceLinks";
import type { A2AJDocument, A2AJLocatorLookup } from "../lib/a2aj";
import {
  createCitation,
  CITATIONS_OPEN_TAG,
  parseCitations,
} from "../lib/chat/citations";
import { COURTLISTENER_SYSTEM_PROMPT } from "../lib/chat/tools/courtlistenerTools";
import { PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT } from "../lib/chat/tools/publicLegalSourceTools";
import type { LocalCourtlistenerState } from "../lib/chat/localCourtlistenerTools";
import {
  appendPublicLegalPinpointLinks,
  createPublicLegalSourceState,
} from "../lib/chat/publicLegalSourceState";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import { safeErrorLog, safeErrorMessage } from "../lib/safeError";
import {
  appendAnonymousAssistantEvents,
  appendAnonymousMessage,
  AnonymousChatVersionConflictError,
  createAnonymousChat,
  deleteAnonymousChat,
  getAnonymousChat,
  listAnonymousChats,
  updateAnonymousChatTitle,
  resetAnonymousAssistantEvents,
  type AnonymousChat,
  type AnonymousChatMessage,
} from "../lib/anonymousChatStore";
import {
  parseAnonymousCurrentTurn,
  parseExpectedTranscriptVersion,
  type AnonymousCurrentTurn,
} from "../lib/chat/anonymousCurrentTurn";
import { projectAnonymousTranscript } from "../lib/chat/anonymousTranscript";
import {
  imagesForMessage,
  loadLocalChatImages,
  loadStoredChatImages,
} from "../lib/chat/imageAttachments";
import { legalKnowledgeGraphStore } from "../lib/legalKnowledgeGraphStore";
import { listLocalDocumentsById } from "../lib/localDocumentStore";
import { readLocalPdfEvidenceReceipt } from "../lib/localPdfLookup";
import {
  anonymousTurnInProgress,
  anonymousTurnWasDeleted,
  beginAnonymousTurn,
  finishAnonymousTurn,
} from "../lib/anonymousChatTurns";

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

const TITLE_FALLBACK = "Misc. Query";
const LOCAL_PDF_EVIDENCE_REGISTRY_EVENT = "local_pdf_evidence_handles";
const LOCAL_MUTATION_COMMITTED_EVENT = "local_mutation_committed";
const LOCAL_TURN_COMPLETED_EVENT = "local_turn_completed";
const MAX_LOCAL_PDF_EVIDENCE_HANDLES = 20;
const LOCAL_PDF_EVIDENCE_HANDLE = /^mike-evidence:v1:[0-9a-f]{64}$/u;
const LOCAL_MUTATION_TOOL_NAMES = new Set([
  "library_create_docx",
  "library_revise_docx",
  "library_link_docx_citations",
  "library_fix_docx_supras",
  "toa_submit_library_document",
]);
type LocalPdfEvidenceRegistryItem = {
  handle: string;
  document_id: string;
  version_id: string;
};

function registryItem(value: unknown): LocalPdfEvidenceRegistryItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const handle = typeof row.handle === "string" ? row.handle.trim() : "";
  const documentId =
    typeof row.document_id === "string" ? row.document_id.trim() : "";
  const versionId =
    typeof row.version_id === "string" ? row.version_id.trim() : "";
  if (
    !LOCAL_PDF_EVIDENCE_HANDLE.test(handle) ||
    !documentId ||
    !versionId ||
    documentId.length > 200 ||
    versionId.length > 200
  ) {
    return null;
  }
  return {
    handle,
    document_id: documentId,
    version_id: versionId,
  };
}

function priorLocalPdfEvidenceRegistry(
  chat: AnonymousChat,
  allowedDocumentIds?: ReadonlySet<string>,
) {
  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const message = chat.messages[index];
    if (message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) return [];
    for (
      let eventIndex = message.content.length - 1;
      eventIndex >= 0;
      eventIndex -= 1
    ) {
      const value = message.content[eventIndex];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const event = value as Record<string, unknown>;
      if (
        event.type !== LOCAL_PDF_EVIDENCE_REGISTRY_EVENT ||
        event.schema_version !== 1
      ) {
        continue;
      }
      const seen = new Set<string>();
      return (Array.isArray(event.handles) ? event.handles : [])
        .map(registryItem)
        .filter((item): item is LocalPdfEvidenceRegistryItem => {
          if (
            !item ||
            seen.has(item.handle) ||
            (allowedDocumentIds && !allowedDocumentIds.has(item.document_id))
          ) {
            return false;
          }
          seen.add(item.handle);
          return true;
        })
        .slice(0, MAX_LOCAL_PDF_EVIDENCE_HANDLES);
    }
    return [];
  }
  return [];
}

async function activeLocalPdfEvidenceRegistry(
  handles: ReadonlySet<string>,
  allowedDocumentIds?: ReadonlySet<string>,
) {
  const recentHandles = [...handles]
    .filter((handle) => LOCAL_PDF_EVIDENCE_HANDLE.test(handle))
    .slice(-MAX_LOCAL_PDF_EVIDENCE_HANDLES);
  const items = await Promise.all(
    recentHandles.map(async (handle) => {
      try {
        const receipt = await readLocalPdfEvidenceReceipt(handle);
        if (
          allowedDocumentIds &&
          !allowedDocumentIds.has(receipt.source.document_id)
        ) {
          return null;
        }
        return {
          handle,
          document_id: receipt.source.document_id,
          version_id: receipt.source.version_id,
        };
      } catch {
        return null;
      }
    }),
  );
  return items.filter(
    (item): item is LocalPdfEvidenceRegistryItem => item !== null,
  );
}

function mergeLocalPdfEvidenceRegistries(
  active: LocalPdfEvidenceRegistryItem[],
  prior: LocalPdfEvidenceRegistryItem[],
) {
  const seen = new Set<string>();
  return [...active, ...prior]
    .filter((item) => {
      if (seen.has(item.handle)) return false;
      seen.add(item.handle);
      return true;
    })
    .slice(0, MAX_LOCAL_PDF_EVIDENCE_HANDLES);
}

function localPdfEvidenceRegistryPrompt(
  registry: LocalPdfEvidenceRegistryItem[],
) {
  if (registry.length === 0) return "";
  const handles = registry
    .map(
      (item) =>
        `- handle=${JSON.stringify(item.handle)} document_id=${JSON.stringify(
          item.document_id,
        )} version_id=${JSON.stringify(item.version_id)}`,
    )
    .join("\n");
  return (
    "DURABLE LOCAL PDF EVIDENCE FROM PRIOR TURNS:\n" +
    `${handles}\n` +
    "Call library_evidence with one of these handles only when the current request needs that exact prior material. Do not expose opaque handles to the user.\n\n"
  );
}

function visibleAnonymousMessages(messages: AnonymousChatMessage[]) {
  return messages.flatMap((storedMessage) => {
    const { turn_id: turnId, ...message } = storedMessage;
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [message];
    }
    const content = message.content.filter(
      (event) =>
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        ((event as Record<string, unknown>).type !==
          LOCAL_PDF_EVIDENCE_REGISTRY_EVENT &&
          (event as Record<string, unknown>).type !==
            LOCAL_MUTATION_COMMITTED_EVENT &&
          (event as Record<string, unknown>).type !==
            LOCAL_TURN_COMPLETED_EVENT),
    );
    if (turnId && content.length === 0) return [];
    return [{ ...message, content }];
  });
}

function anonymousTurnDocumentIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const id = (item as Record<string, unknown>).document_id;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  });
  return ids.every((id): id is string => id !== null) ? ids : null;
}

function sameAnonymousNormalTurn(
  stored: AnonymousChatMessage,
  content: string,
  files: { document_id: string }[],
  workflow: ChatMessage["workflow"],
) {
  const storedDocumentIds = anonymousTurnDocumentIds(stored.files);
  if (
    stored.content !== content ||
    !storedDocumentIds ||
    JSON.stringify(storedDocumentIds) !==
      JSON.stringify(files.map((file) => file.document_id))
  ) {
    return false;
  }
  const storedWorkflow =
    stored.workflow &&
    typeof stored.workflow === "object" &&
    !Array.isArray(stored.workflow)
      ? (stored.workflow as Record<string, unknown>)
      : undefined;
  return (
    (storedWorkflow?.id ?? undefined) === workflow?.id &&
    (storedWorkflow?.title ?? undefined) === workflow?.title
  );
}

type AnonymousNormalTurnState = {
  user: AnonymousChatMessage;
  assistant?: AnonymousChatMessage;
  completed: boolean;
  mutationCommitted: boolean;
};

function anonymousNormalTurnState(
  chat: AnonymousChat,
  turnId: string,
): AnonymousNormalTurnState | null {
  const user = chat.messages.find(
    (message) => message.role === "user" && message.turn_id === turnId,
  );
  if (!user) return null;
  const assistant = [...chat.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.turn_id === turnId,
    );
  const events = Array.isArray(assistant?.content)
    ? assistant.content
    : [];
  return {
    user,
    assistant,
    completed: events.some(
      (event) =>
        !!event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as Record<string, unknown>).type ===
          LOCAL_TURN_COMPLETED_EVENT,
    ),
    mutationCommitted: events.some(
      (event) =>
        !!event &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as Record<string, unknown>).type ===
          LOCAL_MUTATION_COMMITTED_EVENT,
    ),
  };
}

function appendAnonymousNormalTurnEvents(
  chat: AnonymousChat,
  turnId: string,
  events: unknown[],
  citations?: unknown[],
) {
  const state = anonymousNormalTurnState(chat, turnId);
  if (!state) throw new Error("Anonymous turn receipt is missing");
  if (state.assistant) {
    if (
      !appendAnonymousAssistantEvents(
        chat,
        events,
        citations,
        undefined,
        turnId,
      )
    ) {
      throw new Error("Anonymous turn response receipt is missing");
    }
    return;
  }
  appendAnonymousMessage(chat, {
    turn_id: turnId,
    role: "assistant",
    content: events,
    citations,
  });
}

function storedAskInputsResponse(
  event: Record<string, unknown>,
): AskInputsResponseRequest | null {
  const parsed = parseAskInputsResponsePayload(event);
  if (!parsed || !Array.isArray(event.responses)) return null;
  const rawById = new Map(
    event.responses.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      return typeof row.id === "string"
        ? [[row.id.trim().slice(0, 80), row] as const]
        : [];
    }),
  );
  for (const item of parsed.responses) {
    if (item.kind !== "documents") continue;
    const rawDocuments = rawById.get(item.id)?.documents;
    if (!Array.isArray(rawDocuments)) continue;
    item.documents = rawDocuments.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      const documentId =
        typeof row.document_id === "string" ? row.document_id.trim() : "";
      const filename =
        typeof row.filename === "string" ? row.filename.trim() : "";
      return documentId && filename
        ? [{ document_id: documentId, filename }]
        : [];
    });
  }
  return parsed;
}

type PendingAnonymousAskInputs = {
  event: AskInputsEvent;
  retryResponse?: AskInputsResponseRequest;
  mutationCommitted?: boolean;
};

function pendingAnonymousAskInputs(
  chat: AnonymousChat,
): PendingAnonymousAskInputs | null {
  const assistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant");
  if (!assistant || !Array.isArray(assistant.content)) return null;
  let ask: AskInputsEvent | null = null;
  let response: AskInputsResponseRequest | null = null;
  let responseFailed = false;
  let mutationCommitted = false;
  for (const value of assistant.content) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type === "ask_inputs") {
      const normalized = normalizeAskInputsEvent(event);
      ask = normalized.items.length ? normalized : null;
      response = null;
      responseFailed = false;
      mutationCommitted = false;
      continue;
    }
    if (event.type === "ask_inputs_response" && ask) {
      response = storedAskInputsResponse(event);
      responseFailed = false;
      mutationCommitted = false;
      continue;
    }
    if (!response) continue;
    if (event.type === LOCAL_MUTATION_COMMITTED_EVENT) {
      mutationCommitted = true;
      continue;
    }
    if (event.type === "error") {
      responseFailed = true;
      continue;
    }
    if (event.type === "content" && typeof event.text === "string") {
      responseFailed =
        event.text.trim().toLowerCase() === "cancelled by user.";
    }
  }
  if (!ask || (response && !responseFailed)) return null;
  return {
    event: ask,
    ...(response ? { retryResponse: response } : {}),
    ...(mutationCommitted ? { mutationCommitted: true } : {}),
  };
}

type CanonicalAskInputsResponse =
  | { ok: true; response: AskInputsResponseRequest; content: string }
  | { ok: false; detail: string };

function canonicalAnonymousAskInputsResponse(
  pending: AskInputsEvent,
  response: AskInputsResponseRequest,
  files: { filename: string; document_id: string }[],
): CanonicalAskInputsResponse {
  if (response.responses.length !== pending.items.length) {
    return {
      ok: false,
      detail: "Response does not match the pending assistant questions",
    };
  }
  const responsesById = new Map<string, AskInputResponseItem>();
  for (const item of response.responses) {
    if (responsesById.has(item.id)) {
      return {
        ok: false,
        detail: "Response contains a duplicate assistant question",
      };
    }
    responsesById.set(item.id, item);
  }
  const availableDocuments = new Map(
    files.map((file) => [file.document_id, file] as const),
  );
  const canonical: AskInputResponseItem[] = [];
  for (const item of pending.items) {
    const submitted = responsesById.get(item.id);
    if (!submitted || submitted.kind !== item.kind) {
      return {
        ok: false,
        detail: "Response does not match the pending assistant questions",
      };
    }
    if (item.kind === "choice" && submitted.kind === "choice") {
      if (submitted.question.trim() !== item.question) {
        return {
          ok: false,
          detail: "Response question does not match the assistant question",
        };
      }
      if (submitted.skipped) {
        canonical.push({
          id: item.id,
          kind: "choice",
          question: item.question,
          skipped: true,
        });
        continue;
      }
      const answer = submitted.answer?.trim() ?? "";
      const knownAnswer = item.options.some(
        (option) => option.value === answer,
      );
      if (!answer || (!knownAnswer && !item.allow_other)) {
        return {
          ok: false,
          detail: "Response choice is not available for this question",
        };
      }
      canonical.push({
        id: item.id,
        kind: "choice",
        question: item.question,
        answer,
      });
      continue;
    }
    if (item.kind === "documents" && submitted.kind === "documents") {
      if (submitted.skipped) {
        canonical.push({
          id: item.id,
          kind: "documents",
          filenames: [],
          documents: [],
          skipped: true,
        });
        continue;
      }
      const submittedDocuments = submitted.documents ?? [];
      const seenDocumentIds = new Set<string>();
      const documents = submittedDocuments.flatMap((document) => {
        const canonicalDocument = availableDocuments.get(document.document_id);
        if (
          !canonicalDocument ||
          seenDocumentIds.has(canonicalDocument.document_id)
        ) {
          return [];
        }
        seenDocumentIds.add(canonicalDocument.document_id);
        return [canonicalDocument];
      });
      if (
        documents.length === 0 ||
        documents.length !== submittedDocuments.length
      ) {
        return {
          ok: false,
          detail: "Response documents are not attached to this turn",
        };
      }
      canonical.push({
        id: item.id,
        kind: "documents",
        filenames: documents.map((document) => document.filename),
        documents,
      });
    }
  }
  const lines = canonical.map((item, index) => {
    if (item.kind === "choice") {
      return item.skipped
        ? `${index + 1}. Skipped: ${item.question}`
        : `${index + 1}. ${item.question}\n${item.answer ?? ""}`;
    }
    return item.skipped
      ? `${index + 1}. Skipped document request.`
      : `${index + 1}. Documents attached: ${item.filenames.join(", ")}`;
  });
  return {
    ok: true,
    response: { responses: canonical },
    content: `Responses to Beaver's questions:\n${lines.join("\n\n")}`,
  };
}

function sameAskInputsResponse(
  left: AskInputsResponseRequest,
  right: AskInputsResponseRequest,
) {
  if (left.responses.length !== right.responses.length) return false;
  return left.responses.every((item, index) => {
    const other = right.responses[index];
    if (
      !other ||
      item.id !== other.id ||
      item.kind !== other.kind ||
      Boolean(item.skipped) !== Boolean(other.skipped)
    ) {
      return false;
    }
    if (item.kind === "choice" && other.kind === "choice") {
      return (
        item.question === other.question &&
        (item.answer ?? "") === (other.answer ?? "")
      );
    }
    if (item.kind === "documents" && other.kind === "documents") {
      const identities = (value: typeof item) =>
        value.documents?.length
          ? value.documents.map((document) => document.document_id).sort()
          : [...value.filenames].sort();
      return JSON.stringify(identities(item)) === JSON.stringify(identities(other));
    }
    return false;
  });
}

function normalizeGeneratedTitle(raw: string): string {
  const title = raw
    .trim()
    .replace(/^["'`]+|["'`.,:;!?]+$/g, "")
    .trim();
  if (!title) return TITLE_FALLBACK;
  return title.slice(0, 80);
}

type AccessibleChat = {
  id: string;
  title: string | null;
  user_id: string;
  project_id: string | null;
} & Record<string, unknown>;

function sseWrite(res: import("express").Response, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function streamAnonymousChat(params: {
  res: import("express").Response;
  userId: string;
  chatId: string | null;
  currentTurn: AnonymousCurrentTurn;
  expectedVersion: number;
  model?: string;
  reasoningEffort?: string;
  projectId?: string | null;
  projectIdProvided?: boolean;
  displayedDocument?: { filename: string; document_id: string };
  attachedDocuments?: { filename: string; document_id: string }[];
}) {
  const { res, userId } = params;
  const existingChat = params.chatId
    ? getAnonymousChat(userId, params.chatId)
    : null;
  if (params.chatId && !existingChat) {
    res.status(404).json({ detail: "Chat not found" });
    return;
  }
  if (!existingChat && params.expectedVersion !== 0) {
    res.status(409).json({
      code: "chat_version_conflict",
      current_version: 0,
    });
    return;
  }
  if (
    existingChat &&
    params.projectIdProvided &&
    existingChat.project_id !== (params.projectId ?? null)
  ) {
    res.status(400).json({ detail: "project_id does not match chat" });
    return;
  }
  const projectId = existingChat?.project_id ?? params.projectId ?? null;
  const matterDocumentIds = projectId
    ? legalKnowledgeGraphStore().listMatterDocumentIds(userId, projectId)
    : undefined;
  if (projectId && !matterDocumentIds) {
    res.status(404).json({ detail: "Project not found" });
    return;
  }
  const allowedDocumentIds = matterDocumentIds
    ? new Set(matterDocumentIds)
    : undefined;
  const displayedDocumentId =
    typeof params.displayedDocument?.document_id === "string"
      ? params.displayedDocument.document_id.trim()
      : "";
  const attachedDocumentIds = (params.attachedDocuments ?? []).map((document) =>
    typeof document?.document_id === "string"
      ? document.document_id.trim()
      : "",
  );
  const requestedFocusIds = [
    ...(displayedDocumentId ? [displayedDocumentId] : []),
    ...attachedDocumentIds.filter(Boolean),
  ];
  if (
    (params.displayedDocument && !displayedDocumentId) ||
    attachedDocumentIds.some((documentId) => !documentId) ||
    (requestedFocusIds.length > 0 && !allowedDocumentIds) ||
    (allowedDocumentIds &&
      requestedFocusIds.some(
        (documentId) => !allowedDocumentIds.has(documentId),
      ))
  ) {
    res.status(400).json({ detail: "Focused document is not in this matter" });
    return;
  }
  const uniqueFocusIds = [...new Set(requestedFocusIds)];
  const focusedDocuments = uniqueFocusIds.length
    ? await listLocalDocumentsById(userId, uniqueFocusIds)
    : [];
  if (focusedDocuments.length !== uniqueFocusIds.length) {
    res.status(400).json({ detail: "Focused document is unavailable" });
    return;
  }
  const focusedById = new Map(
    focusedDocuments.map((document) => [document.id, document] as const),
  );
  const focusLines: string[] = [];
  if (displayedDocumentId) {
    focusLines.push(
      `Displayed document: ${JSON.stringify(
        focusedById.get(displayedDocumentId)!.filename,
      )} (document_id: ${displayedDocumentId})`,
    );
  }
  if (attachedDocumentIds.length) {
    focusLines.push(
      "User-attached documents for this turn:",
      ...attachedDocumentIds.map(
        (documentId) =>
          `- ${JSON.stringify(
            focusedById.get(documentId)!.filename,
          )} (document_id: ${documentId})`,
      ),
    );
  }
  const focusPrompt = focusLines.length
    ? `CURRENT MATTER FOCUS:\n${focusLines.join("\n")}\n\n`
    : "";
  const turnFiles =
    params.currentTurn.kind === "message"
      ? params.currentTurn.message.files
      : params.currentTurn.files;
  const turnDocumentIds = [
    ...new Set(
      (turnFiles ?? []).flatMap((file) =>
        file.document_id ? [file.document_id] : [],
      ),
    ),
  ];
  if (
    allowedDocumentIds &&
    turnDocumentIds.some((documentId) => !allowedDocumentIds.has(documentId))
  ) {
    res.status(400).json({ detail: "Attached document is not in this matter" });
    return;
  }
  const turnDocuments = turnDocumentIds.length
    ? await listLocalDocumentsById(userId, turnDocumentIds)
    : [];
  if (turnDocuments.length !== turnDocumentIds.length) {
    res.status(400).json({ detail: "Attached document is unavailable" });
    return;
  }
  const turnDocumentById = new Map(
    turnDocuments.map((document) => [document.id, document] as const),
  );
  const canonicalTurnFiles = turnDocumentIds.map((documentId) => ({
    filename: turnDocumentById.get(documentId)!.filename,
    document_id: documentId,
  }));
  const currentProviderMessage: ChatMessage =
    params.currentTurn.kind === "message"
      ? {
          ...params.currentTurn.message,
          files: canonicalTurnFiles.length ? canonicalTurnFiles : undefined,
        }
      : {
          role: "user",
          content: params.currentTurn.content,
          files: canonicalTurnFiles.length ? canonicalTurnFiles : undefined,
        };
  const withinMatter = (message: ChatMessage): ChatMessage => ({
    ...message,
    files: message.files?.filter(
      (file) =>
        !file.document_id ||
        !allowedDocumentIds ||
        allowedDocumentIds.has(file.document_id),
    ),
  });
  const proposedMessages = [
    ...projectAnonymousTranscript(existingChat?.messages ?? []).map(
      withinMatter,
    ),
    currentProviderMessage,
  ];
  let imagesByDocumentId: Map<string, LlmImage>;
  try {
    imagesByDocumentId = await loadLocalChatImages(
      proposedMessages,
      userId,
      allowedDocumentIds,
    );
  } catch (error) {
    res.status(400).json({
      detail: safeErrorMessage(error, "Invalid image attachment"),
    });
    return;
  }
  const selectedModel = params.model || DEFAULT_MAIN_MODEL;
  if (
    imagesByDocumentId.size &&
    !modelSupportsImageInput(selectedModel)
  ) {
    res.status(400).json({
      detail: `Model "${selectedModel}" does not support image input.`,
    });
    return;
  }
  const chat = existingChat ?? createAnonymousChat(userId, projectId);
  const priorEvidenceRegistry = priorLocalPdfEvidenceRegistry(
    chat,
    allowedDocumentIds,
  );
  const priorEvidencePrompt = localPdfEvidenceRegistryPrompt(
    priorEvidenceRegistry,
  );

  if (anonymousTurnInProgress(chat.id)) {
    res.status(409).json({
      code: "chat_turn_in_progress",
      current_version: chat.transcript_version,
    });
    return;
  }
  const normalTurnId =
    params.currentTurn.kind === "message"
      ? params.currentTurn.turnId
      : undefined;
  let retryingNormalTurn = false;
  try {
    if (params.currentTurn.kind === "ask_inputs_response") {
      const pending = pendingAnonymousAskInputs(chat);
      if (!pending) {
        res.status(400).json({
          detail: "No assistant question is available for this response",
        });
        return;
      }
      const canonicalResponse = canonicalAnonymousAskInputsResponse(
        pending.event,
        params.currentTurn.response,
        canonicalTurnFiles,
      );
      if (!canonicalResponse.ok) {
        res.status(400).json({ detail: canonicalResponse.detail });
        return;
      }
      if (pending.retryResponse) {
        if (
          !sameAskInputsResponse(
            pending.retryResponse,
            canonicalResponse.response,
          )
        ) {
          res.status(400).json({
            detail: "Retry the same response to the assistant questions",
          });
          return;
        }
        if (pending.mutationCommitted) {
          res.status(409).json({
            code: "chat_retry_blocked_after_mutation",
            current_version: chat.transcript_version,
            detail:
              "The prior continuation changed local data before it stopped. Review that result before sending a new instruction.",
          });
          return;
        }
        if (chat.transcript_version !== params.expectedVersion) {
          throw new AnonymousChatVersionConflictError(
            chat.transcript_version,
          );
        }
      } else {
        const appended = appendAnonymousAssistantEvents(
          chat,
          [
            {
              type: "ask_inputs_response",
              content: canonicalResponse.content,
              files: canonicalTurnFiles,
              responses: canonicalResponse.response.responses,
            },
          ],
          undefined,
          params.expectedVersion,
        );
        if (!appended) {
          res.status(400).json({
            detail: "No assistant question is available for this response",
          });
          return;
        }
      }
    } else {
      const priorTurn = normalTurnId
        ? anonymousNormalTurnState(chat, normalTurnId)
        : null;
      if (priorTurn) {
        if (
          !sameAnonymousNormalTurn(
            priorTurn.user,
            params.currentTurn.message.content,
            canonicalTurnFiles,
            params.currentTurn.message.workflow,
          )
        ) {
          res.status(400).json({
            detail: "turn_id was already used for a different message",
          });
          return;
        }
        if (priorTurn.completed) {
          res.status(409).json({
            code: "chat_turn_already_completed",
            current_version: chat.transcript_version,
          });
          return;
        }
        if (priorTurn.mutationCommitted) {
          res.status(409).json({
            code: "chat_retry_blocked_after_mutation",
            current_version: chat.transcript_version,
            detail:
              "The prior response changed local data before it stopped. Review that result before sending a new instruction.",
          });
          return;
        }
        if (chat.transcript_version !== params.expectedVersion) {
          throw new AnonymousChatVersionConflictError(
            chat.transcript_version,
          );
        }
        const lastUser = [...chat.messages]
          .reverse()
          .find((message) => message.role === "user");
        if (lastUser?.id !== priorTurn.user.id) {
          res.status(409).json({
            code: "chat_version_conflict",
            current_version: chat.transcript_version,
          });
          return;
        }
        if (
          priorTurn.assistant &&
          !resetAnonymousAssistantEvents(chat, normalTurnId!)
        ) {
          throw new Error("Anonymous turn response receipt is missing");
        }
        retryingNormalTurn = true;
      }
      if (!retryingNormalTurn) {
        appendAnonymousMessage(
          chat,
          {
            turn_id: normalTurnId,
            role: "user",
            content: params.currentTurn.message.content,
            files: canonicalTurnFiles.length ? canonicalTurnFiles : undefined,
            workflow: params.currentTurn.message.workflow,
          },
          params.expectedVersion,
        );
      }
    }
  } catch (error) {
    if (error instanceof AnonymousChatVersionConflictError) {
      res.status(409).json({
        code: "chat_version_conflict",
        current_version: error.currentVersion,
      });
      return;
    }
    throw error;
  }
  const messages = projectAnonymousTranscript(
    retryingNormalTurn && normalTurnId
      ? chat.messages.filter(
          (message) =>
            message.role !== "assistant" || message.turn_id !== normalTurnId,
        )
      : chat.messages,
  ).map(withinMatter);
  const lastUser = [...messages].reverse().find((message) => {
    return message.role === "user" && typeof message.content === "string";
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const streamAbort = new AbortController();
  if (!beginAnonymousTurn(chat.id, streamAbort)) {
    res.end();
    return;
  }
  let streamFinished = false;
  res.on("close", () => {
    if (!streamFinished) streamAbort.abort();
  });

  let rawText = "";
  let visibleText = "";
  let visibleTail = "";
  let citationsOpen = false;
  const a2ajLookups: A2AJLocatorLookup[] = [];
  const a2ajDocuments: A2AJDocument[] = [];
  const courtlistenerState: LocalCourtlistenerState = {
    casesByClusterId: new Map(),
  };
  const publicLegalState = createPublicLegalSourceState();
  const localPdfEvidenceHandles = new Set<string>();
  let pendingAskInputs: AskInputsEvent | null = null;
  let askInputsFinalized = false;
  let localMutationCommitted = false;
  const streamVisible = (delta: string) => {
    if (!delta || citationsOpen) return;
    const combined = visibleTail + delta;
    const markerIndex = combined.indexOf(CITATIONS_OPEN_TAG);
    if (markerIndex >= 0) {
      const visible = combined.slice(0, markerIndex);
      if (visible) {
        visibleText += visible;
        sseWrite(res, { type: "content_delta", text: visible });
      }
      visibleTail = "";
      citationsOpen = true;
      return;
    }
    const retained = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
    const visible = combined.slice(0, combined.length - retained);
    visibleTail = combined.slice(combined.length - retained);
    if (visible) {
      visibleText += visible;
      sseWrite(res, { type: "content_delta", text: visible });
    }
  };
  const acceptPendingAskInputs = (event: AskInputsEvent) => {
    if (pendingAskInputs || event.items.length === 0) return;
    pendingAskInputs = event;
    rawText = "";
    visibleText = "";
    visibleTail = "";
    citationsOpen = false;
    if (!res.destroyed) sseWrite(res, { type: "content_reset" });
  };
  const finalizePendingAskInputs = async () => {
    const event = pendingAskInputs;
    if (!event || askInputsFinalized) return Boolean(event);
    if (!citationsOpen && visibleTail) {
      visibleText += visibleTail;
      if (!res.destroyed) {
        sseWrite(res, { type: "content_delta", text: visibleTail });
      }
      visibleTail = "";
    }
    const assistantEvents: unknown[] = visibleText
      ? [{ type: "content", text: visibleText }]
      : [];
    assistantEvents.push(event);
    const activeEvidenceRegistry = await activeLocalPdfEvidenceRegistry(
      localPdfEvidenceHandles,
      allowedDocumentIds,
    );
    const nextEvidenceRegistry = mergeLocalPdfEvidenceRegistries(
      activeEvidenceRegistry,
      priorEvidenceRegistry,
    );
    if (nextEvidenceRegistry.length > 0) {
      assistantEvents.push({
        type: LOCAL_PDF_EVIDENCE_REGISTRY_EVENT,
        schema_version: 1,
        handles: nextEvidenceRegistry,
      });
    }
    if (anonymousTurnWasDeleted(chat.id)) {
      askInputsFinalized = true;
      return true;
    }
    if (params.currentTurn.kind === "ask_inputs_response") {
      appendAnonymousAssistantEvents(chat, assistantEvents);
    } else if (normalTurnId) {
      appendAnonymousNormalTurnEvents(chat, normalTurnId, [
        ...assistantEvents,
        { type: LOCAL_TURN_COMPLETED_EVENT, schema_version: 1 },
      ]);
    } else {
      appendAnonymousMessage(chat, {
        role: "assistant",
        content: assistantEvents,
      });
    }
    if (!chat.title && lastUser?.content) {
      updateAnonymousChatTitle(chat, normalizeGeneratedTitle(lastUser.content));
    }
    askInputsFinalized = true;
    if (!res.destroyed) {
      sseWrite(res, event);
      sseWrite(res, {
        type: "transcript_version",
        transcriptVersion: chat.transcript_version,
      });
      sseWrite(res, { type: "content_done" });
      sseWrite(res, {
        type: "citations",
        status: "final",
        citations: [],
      });
      res.write("data: [DONE]\n\n");
    }
    return true;
  };
  try {
    sseWrite(res, {
      type: "chat_id",
      chatId: chat.id,
      transcriptVersion: chat.transcript_version,
    });
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt:
        `${
          projectId
            ? "The current Beaver matter is connected through its attached Library documents"
            : "The user's local Beaver Library is connected"
        } through library_list, library_lookup, library_evidence, library_read, library_find, library_create_docx, library_revise_docx, library_link_docx_citations, and library_fix_docx_supras. Use library_list before claiming a Library document is unavailable. Create requested Word drafts with library_create_docx. Revise a Library DOCX with library_revise_docx using its exact active version_id; never claim a revision succeeded without its receipt. For an exact PDF page, paragraph, footnote, proposition, section, or bounded range, use library_lookup instead of library_read; rely on its evidence and do not invent locators or URLs. Beaver adds verified links for exact quoted PDF text automatically. Preserve returned mike-evidence handles when the material may be needed after compaction; rehydrate one with library_evidence instead of repeating or guessing the lookup. If the user asks to add links to citations in a DOCX, call library_link_docx_citations directly; do not read or split its footnotes and do not construct the URLs yourself. If the user asks to fix or update supra-note references, call library_fix_docx_supras first; rely on its deterministic changes and reason only about the cases it reports for review. For a table or book of authorities from a Library DOCX, call toa_submit_library_document with split_fallback auto, poll with toa_job_status, and return job.open_path; do not parse the document or invent local paths yourself. Use A2AJ tools for Canadian case law and legislation. Do not construct URLs for a2aj_lookup results; Beaver attaches verified pinpoint links automatically.\n\n` +
        "When a missing decision, clarification, or document would materially change the work, call ask_inputs once with every needed input. Beaver will pause the turn and resume from the user's structured response.\n\n" +
        focusPrompt +
        priorEvidencePrompt +
        COURTLISTENER_SYSTEM_PROMPT +
        "\n\n" +
        PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT,
      messages: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content ?? "",
        images: imagesForMessage(message, imagesByDocumentId),
      })),
      enableThinking: true,
      reasoningEffort: params.reasoningEffort,
      abortSignal: streamAbort.signal,
      tools: LOCAL_ASSISTANT_TOOLS,
      runTools: async (calls) => {
        if (!pendingAskInputs) {
          const askCall = calls.find((call) => call.name === "ask_inputs");
          if (askCall) {
            const normalized = normalizeAskInputsEvent(askCall.input);
            if (normalized.items.length && !localMutationCommitted) {
              acceptPendingAskInputs(normalized);
            } else if (normalized.items.length) {
              const otherCalls = calls.filter(
                (call) => call.name !== "ask_inputs",
              );
              const otherResults = otherCalls.length
                ? await runLocalAssistantTools(
                    userId,
                    otherCalls,
                    a2ajLookups,
                    a2ajDocuments,
                    courtlistenerState,
                    publicLegalState,
                    allowedDocumentIds,
                    localPdfEvidenceHandles,
                    projectId,
                  )
                : [];
              return calls.map((call) =>
                call.name === "ask_inputs"
                  ? {
                      tool_use_id: call.id,
                      content: JSON.stringify({
                        ok: false,
                        error:
                          "ask_inputs must be called before document or workflow changes in a turn",
                      }),
                    }
                  : (otherResults.find(
                      (result) => result.tool_use_id === call.id,
                    ) ?? {
                      tool_use_id: call.id,
                      content: JSON.stringify({
                        ok: false,
                        error: "Tool result is unavailable",
                      }),
                    }),
              );
            }
          }
        }
        if (pendingAskInputs) {
          const results = calls.map((call) => ({
            tool_use_id: call.id,
            content: JSON.stringify({
              ok: true,
              status: "waiting_for_user",
            }),
          }));
          streamAbort.abort();
          return results;
        }
        const results = await runLocalAssistantTools(
          userId,
          calls,
          a2ajLookups,
          a2ajDocuments,
          courtlistenerState,
          publicLegalState,
          allowedDocumentIds,
          localPdfEvidenceHandles,
          projectId,
        );
        const mutationWasAlreadyCommitted = localMutationCommitted;
        for (const call of calls) {
          if (!LOCAL_MUTATION_TOOL_NAMES.has(call.name)) continue;
          const toolResult = results.find(
            (result) => result.tool_use_id === call.id,
          );
          try {
            const parsed = JSON.parse(toolResult?.content ?? "{}") as {
              ok?: unknown;
            };
            if (parsed.ok === true) localMutationCommitted = true;
          } catch {
            // A mutation is only considered committed on an explicit receipt.
          }
        }
        if (
          !mutationWasAlreadyCommitted &&
          localMutationCommitted &&
          !anonymousTurnWasDeleted(chat.id)
        ) {
          const mutationEvent = {
            type: LOCAL_MUTATION_COMMITTED_EVENT,
            schema_version: 1,
          };
          if (params.currentTurn.kind === "ask_inputs_response") {
            appendAnonymousAssistantEvents(chat, [mutationEvent]);
          } else if (normalTurnId) {
            appendAnonymousNormalTurnEvents(chat, normalTurnId, [
              mutationEvent,
            ]);
          }
        }
        return results;
      },
      callbacks: {
        onContentDelta: (text: string) => {
          if (pendingAskInputs) return;
          rawText += text;
          streamVisible(text);
        },
        onReasoningDelta: (text: string) => {
          if (!pendingAskInputs) {
            sseWrite(res, { type: "reasoning_delta", text });
          }
        },
        onReasoningBlockEnd: () => {
          if (!pendingAskInputs) {
            sseWrite(res, { type: "reasoning_block_end" });
          }
        },
        onToolCallStart: (call) => {
          sseWrite(res, {
            type: "tool_call_start",
            name: call.name,
          });
        },
      },
    });

    if (!citationsOpen && visibleTail) {
      visibleText += visibleTail;
      sseWrite(res, { type: "content_delta", text: visibleTail });
      visibleTail = "";
    }
    if (await finalizePendingAskInputs()) return;
    const citations = parseCitations(rawText).map((citation) =>
      createCitation(
        citation,
        {},
        courtlistenerState.casesByClusterId,
        a2ajLookups,
        a2ajDocuments,
        publicLegalState,
      ),
    );
    const citationUrls = citations.flatMap((citation) => {
      const url = "url" in citation ? citation.url : null;
      return typeof url === "string" ? [url] : [];
    });
    const providerLinkedText = appendPublicLegalPinpointLinks(
      appendA2AJPinpointLinks(visibleText.trimEnd(), a2ajLookups),
      publicLegalState,
      citationUrls,
    );
    const linkedText = await appendLocalPdfPinpointLinks(
      providerLinkedText,
      userId,
      localPdfEvidenceHandles,
      allowedDocumentIds,
      citationUrls,
    );
    const linkDelta = linkedText.slice(visibleText.trimEnd().length);
    if (linkDelta) sseWrite(res, { type: "content_delta", text: linkDelta });
    visibleText = linkedText;

    const assistantEvents: unknown[] = visibleText
      ? [{ type: "content", text: visibleText }]
      : [
          {
            type: "error",
            message: "The selected model returned no response.",
          },
        ];
    const activeEvidenceRegistry = await activeLocalPdfEvidenceRegistry(
      localPdfEvidenceHandles,
      allowedDocumentIds,
    );
    const nextEvidenceRegistry = mergeLocalPdfEvidenceRegistries(
      activeEvidenceRegistry,
      priorEvidenceRegistry,
    );
    if (nextEvidenceRegistry.length > 0) {
      assistantEvents.push({
        type: LOCAL_PDF_EVIDENCE_REGISTRY_EVENT,
        schema_version: 1,
        handles: nextEvidenceRegistry,
      });
    }
    if (anonymousTurnWasDeleted(chat.id)) return;
    if (params.currentTurn.kind === "ask_inputs_response") {
      appendAnonymousAssistantEvents(chat, assistantEvents, citations);
    } else if (normalTurnId) {
      appendAnonymousNormalTurnEvents(
        chat,
        normalTurnId,
        [
          ...assistantEvents,
          { type: LOCAL_TURN_COMPLETED_EVENT, schema_version: 1 },
        ],
        citations,
      );
    } else {
      appendAnonymousMessage(chat, {
        role: "assistant",
        content: assistantEvents,
        citations,
      });
    }
    if (!chat.title && lastUser?.content) {
      updateAnonymousChatTitle(chat, normalizeGeneratedTitle(lastUser.content));
    }
    sseWrite(res, {
      type: "transcript_version",
      transcriptVersion: chat.transcript_version,
    });
    sseWrite(res, { type: "content_done" });
    sseWrite(res, {
      type: "citations",
      status: "final",
      citations,
    });
    res.write("data: [DONE]\n\n");
  } catch (error) {
    if (pendingAskInputs) {
      try {
        if (await finalizePendingAskInputs()) return;
      } catch (persistError) {
        console.error(
          "[chat/anonymous] failed to persist requested inputs",
          safeErrorLog(persistError),
        );
      }
    }
    const message = safeErrorMessage(error, "Model request failed");
    console.error("[chat/anonymous]", safeErrorLog(error));
    const visiblePartial =
      visibleText + (!citationsOpen ? visibleTail : "");
    if (
      !anonymousTurnWasDeleted(chat.id) &&
      !streamAbort.signal.aborted &&
      !citationsOpen &&
      visibleTail
    ) {
      sseWrite(res, { type: "content_delta", text: visibleTail });
    }
    if (!anonymousTurnWasDeleted(chat.id)) {
      try {
        const partialEvents = visiblePartial
          ? [{ type: "content", text: visiblePartial }]
          : [];
        const errorEvents = isAbortError(error)
          ? [
              ...partialEvents,
              { type: "content", text: "Cancelled by user." },
            ]
          : [...partialEvents, { type: "error", message }];
        if (params.currentTurn.kind === "ask_inputs_response") {
          appendAnonymousAssistantEvents(chat, errorEvents);
        } else if (normalTurnId) {
          appendAnonymousNormalTurnEvents(chat, normalTurnId, errorEvents);
        } else {
          appendAnonymousMessage(chat, {
            role: "assistant",
            content: errorEvents,
          });
        }
      } catch (persistError) {
        console.error(
          "[chat/anonymous] failed to persist model error",
          safeErrorLog(persistError),
        );
      }
    }
    if (anonymousTurnWasDeleted(chat.id)) {
      // Deletion is authoritative; do not recreate or write to the chat.
    } else if (!res.headersSent) {
      res.status(502).json({ detail: message });
    } else if (!streamAbort.signal.aborted) {
      sseWrite(res, {
        type: "error",
        message,
        ...(localMutationCommitted ? { retryable: false } : {}),
      });
      sseWrite(res, {
        type: "transcript_version",
        transcriptVersion: chat.transcript_version,
      });
      res.write("data: [DONE]\n\n");
    }
  } finally {
    finishAnonymousTurn(chat.id);
    streamFinished = true;
    res.end();
  }
}

function parseOptionalProjectId(
  value: unknown,
):
  | { ok: true; provided: boolean; projectId: string | null }
  | { ok: false; detail: string } {
  if (value === undefined)
    return { ok: true, provided: false, projectId: null };
  if (value === null) return { ok: true, provided: true, projectId: null };
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "project_id must be a non-empty string or null",
    };
  }
  return { ok: true, provided: true, projectId: value.trim() };
}

function parseOptionalChatId(
  value: unknown,
): { ok: true; chatId: string | null } | { ok: false; detail: string } {
  if (value === undefined || value === null) return { ok: true, chatId: null };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "chat_id must be a non-empty string" };
  }
  return { ok: true, chatId: value.trim() };
}

export function parseChatMessages(
  value: unknown,
): { ok: true; messages: ChatMessage[] } | { ok: false; detail: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: "messages must be a non-empty array" };
  }

  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, detail: "messages must contain objects" };
    }
    const row = message as Record<string, unknown>;
    if (typeof row.role !== "string") {
      return { ok: false, detail: "message.role must be a string" };
    }
    if (row.content !== null && typeof row.content !== "string") {
      return {
        ok: false,
        detail: "message.content must be a string or null",
      };
    }
  }

  return { ok: true, messages: value as ChatMessage[] };
}

function parseOptionalModel(
  value: unknown,
): { ok: true; model: string | undefined } | { ok: false; detail: string } {
  if (value === undefined) return { ok: true, model: undefined };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, detail: "model must be a non-empty string" };
  }
  return { ok: true, model: value.trim() };
}

async function validateAccessibleProjectId(
  projectId: string | null,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  if (!projectId) return { ok: true };
  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok)
    return { ok: false, status: 404, detail: "Project not found" };
  return { ok: true };
}

async function getAccessibleChat(
  chatId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<AccessibleChat | null> {
  const { data: chat, error } = await db
    .from("chats")
    .select("*")
    .eq("id", chatId)
    .maybeSingle();
  if (error || !chat) return null;

  const row = chat as AccessibleChat;
  if (row.user_id === userId) return row;

  if (row.project_id) {
    const access = await checkProjectAccess(
      row.project_id,
      userId,
      userEmail,
      db,
    );
    if (access.ok) return row;
  }

  return null;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
  if (isAnonymousLocalMode()) {
    const userId = res.locals.userId as string;
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;
    res.json(
      listAnonymousChats(userId)
        .filter((chat) => chat.project_id === null)
        .slice(0, limit)
        .map(({ messages: _messages, ...chat }) => chat),
    );
    return;
  }
  try {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const requestedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : null;

    const { data, error } = await db.rpc("get_chats_overview", {
      p_user_id: userId,
      p_limit: limit,
    });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
  } catch (error) {
    console.error("[chat/list] failed to load chats", error);
    res.status(500).json({ detail: "Failed to load chats" });
  }
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const parsedProjectId = parseOptionalProjectId(req.body?.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
  }
  const projectId = parsedProjectId.projectId;
  if (isAnonymousLocalMode()) {
    if (projectId && !legalKnowledgeGraphStore().getMatter(userId, projectId)) {
      return void res.status(404).json({ detail: "Project not found" });
    }
    const chat = createAnonymousChat(userId, projectId);
    res.json({ id: chat.id });
    return;
  }
  const db = createServerSupabase();
  const projectAccess = await validateAccessibleProjectId(
    projectId,
    userId,
    userEmail,
    db,
  );
  if (!projectAccess.ok)
    return void res
      .status(projectAccess.status)
      .json({ detail: projectAccess.detail });

  const { data, error } = await db
    .from("chats")
    .insert({ user_id: userId, project_id: projectId ?? null })
    .select("id")
    .single();

  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;
  if (isAnonymousLocalMode()) {
    const chat = getAnonymousChat(userId, chatId);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    const { messages, ...chatData } = chat;
    res.json({ chat: chatData, messages: visibleAnonymousMessages(messages) });
    return;
  }
  const db = createServerSupabase();

  const chat = await getAccessibleChat(chatId, userId, userEmail, db);
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  const { data: messages } = await db
    .from("chat_messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  const hydrated = await hydrateEditStatuses(messages ?? [], db);
  res.json({ chat, messages: hydrated });
});

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
  messages: Record<string, unknown>[],
  db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
  const editIds = new Set<string>();
  const versionIds = new Set<string>();
  const collectFromAnnList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const a of list as Record<string, unknown>[]) {
      if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
      if (typeof a?.version_id === "string") versionIds.add(a.version_id);
    }
  };
  for (const m of messages) {
    const content = m.content;
    if (Array.isArray(content)) {
      for (const ev of content as Record<string, unknown>[]) {
        if (ev?.type === "doc_edited") {
          collectFromAnnList(ev.annotations);
          if (typeof ev.version_id === "string") versionIds.add(ev.version_id);
        }
      }
    }
  }
  if (editIds.size === 0 && versionIds.size === 0) return messages;

  // Edit status patch.
  const statusById = new Map<string, "pending" | "accepted" | "rejected">();
  if (editIds.size > 0) {
    const { data: rows } = await db
      .from("document_edits")
      .select("id, status")
      .in("id", Array.from(editIds));
    for (const r of (rows ?? []) as { id: string; status: string }[]) {
      if (
        r.status === "pending" ||
        r.status === "accepted" ||
        r.status === "rejected"
      ) {
        statusById.set(r.id, r.status);
      }
    }
  }

  // Version-number patch — old stored events don't carry `version_number`
  // because they predate the schema change. Look it up from
  // document_versions so the UI can render "V3" chips + download filenames.
  const versionNumberById = new Map<string, number | null>();
  if (versionIds.size > 0) {
    const { data: vrows } = await db
      .from("document_versions")
      .select("id, version_number")
      .in("id", Array.from(versionIds));
    for (const r of (vrows ?? []) as {
      id: string;
      version_number: number | null;
    }[]) {
      versionNumberById.set(r.id, r.version_number ?? null);
    }
  }

  const patchAnnList = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    return (list as Record<string, unknown>[]).map((a) => {
      let next = a;
      if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
        next = { ...next, status: statusById.get(a.edit_id) };
      }
      if (
        typeof a?.version_id === "string" &&
        versionNumberById.has(a.version_id)
      ) {
        next = {
          ...next,
          version_number: versionNumberById.get(a.version_id) ?? null,
        };
      }
      return next;
    });
  };
  return messages.map((m) => {
    const next: Record<string, unknown> = { ...m };
    if (Array.isArray(m.content)) {
      next.content = (m.content as Record<string, unknown>[]).map((ev) => {
        if (ev?.type !== "doc_edited") return ev;
        let patched: Record<string, unknown> = {
          ...ev,
          annotations: patchAnnList(ev.annotations),
        };
        if (
          typeof ev.version_id === "string" &&
          versionNumberById.has(ev.version_id)
        ) {
          patched = {
            ...patched,
            version_number: versionNumberById.get(ev.version_id) ?? null,
          };
        }
        return patched;
      });
    }
    return next;
  });
}

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;
  const title = (req.body.title ?? "").trim();
  if (!title) return void res.status(400).json({ detail: "title is required" });

  if (isAnonymousLocalMode()) {
    const chat = getAnonymousChat(userId, chatId);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    updateAnonymousChatTitle(chat, title);
    res.json({ id: chat.id, title: chat.title });
    return;
  }

  const db = createServerSupabase();
  const { data, error } = await db
    .from("chats")
    .update({ title })
    .eq("id", chatId)
    .eq("user_id", userId)
    .select("id, title")
    .single();

  if (error || !data)
    return void res.status(404).json({ detail: "Chat not found" });
  res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { chatId } = req.params;
  if (isAnonymousLocalMode()) {
    if (!deleteAnonymousChat(userId, chatId)) {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    res.status(204).send();
    return;
  }
  const db = createServerSupabase();
  const { error } = await db
    .from("chats")
    .delete()
    .eq("id", chatId)
    .eq("user_id", userId);

  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { chatId } = req.params;
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message)
    return void res.status(400).json({ detail: "message is required" });

  if (isAnonymousLocalMode()) {
    const chat = getAnonymousChat(userId, chatId);
    if (!chat) return void res.status(404).json({ detail: "Chat not found" });
    const title = normalizeGeneratedTitle(message);
    updateAnonymousChatTitle(chat, title);
    res.json({ title });
    return;
  }

  const db = createServerSupabase();
  const chat = await getAccessibleChat(chatId, userId, userEmail, db);
  if (!chat) return void res.status(404).json({ detail: "Chat not found" });

  try {
    const { title_model, api_keys } = await getUserModelSettings(userId, db);
    const titleText = await completeText({
      model: title_model,
      user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. If there is not enough information to generate a title, return exactly "${TITLE_FALLBACK}". Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
      maxTokens: 64,
      apiKeys: api_keys,
    });
    const title = normalizeGeneratedTitle(titleText);

    await db.from("chats").update({ title }).eq("id", chatId);

    res.json({ title });
  } catch (err) {
    console.error("[generate-title]", safeErrorLog(err));
    res.status(500).json({ detail: "Failed to generate title" });
  }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  const parsedChatId = parseOptionalChatId(body.chat_id);
  if (!parsedChatId.ok) {
    return void res.status(400).json({ detail: parsedChatId.detail });
  }
  const parsedProjectId = parseOptionalProjectId(body.project_id);
  if (!parsedProjectId.ok) {
    return void res.status(400).json({ detail: parsedProjectId.detail });
  }
  const parsedModel = parseOptionalModel(body.model);
  if (!parsedModel.ok) {
    return void res.status(400).json({ detail: parsedModel.detail });
  }
  const chat_id = parsedChatId.chatId;
  const project_id = parsedProjectId.projectId;
  const model = parsedModel.model;
  const reasoningEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort.trim().slice(0, 32) || undefined
      : undefined;

  if (isAnonymousLocalMode()) {
    if (body.messages !== undefined) {
      return void res.status(400).json({
        detail:
          "Account-free local chat accepts current_turn, not browser-supplied history",
      });
    }
    const parsedTurn = parseAnonymousCurrentTurn(body.current_turn);
    if (!parsedTurn.ok) {
      return void res.status(400).json({ detail: parsedTurn.detail });
    }
    const parsedVersion = parseExpectedTranscriptVersion(
      body.expected_version,
    );
    if (!parsedVersion.ok) {
      return void res.status(400).json({ detail: parsedVersion.detail });
    }
    try {
      await streamAnonymousChat({
        res,
        userId: res.locals.userId as string,
        chatId: chat_id,
        currentTurn: parsedTurn.turn,
        expectedVersion: parsedVersion.version,
        model,
        reasoningEffort,
        projectId: project_id,
        projectIdProvided: parsedProjectId.provided,
      });
    } catch (error) {
      console.error("[chat/anonymous] preflight", safeErrorLog(error));
      if (!res.headersSent) {
        res.status(500).json({ detail: "Local chat failed" });
      } else {
        res.end();
      }
    }
    return;
  }

  const parsedMessages = parseChatMessages(body.messages);
  if (!parsedMessages.ok) {
    return void res.status(400).json({ detail: parsedMessages.detail });
  }
  const messages = parsedMessages.messages;
  const askInputsResponse = parseAskInputsResponsePayload(
    body.ask_inputs_response,
  );

  devLog("[chat/stream] incoming request", {
    userId,
    chat_id,
    project_id,
    model,
    messageCount: messages?.length,
  });

  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  let chatId = chat_id ?? null;
  let chatTitle: string | null = null;
  let resolvedProjectId: string | null = parsedProjectId.projectId;

  if (chatId) {
    const existing = await getAccessibleChat(chatId, userId, userEmail, db);
    if (!existing)
      return void res.status(404).json({ detail: "Chat not found" });

    const existingProjectId = existing.project_id ?? null;
    if (
      parsedProjectId.provided &&
      parsedProjectId.projectId !== existingProjectId
    ) {
      return void res
        .status(400)
        .json({ detail: "project_id does not match chat" });
    }
    resolvedProjectId = existingProjectId;
    chatTitle = existing.title;
  }

  if (!chatId) {
    // If creating a chat tied to a project, the user must have access
    // to the project (own or shared).
    const projectAccess = await validateAccessibleProjectId(
      resolvedProjectId,
      userId,
      userEmail,
      db,
    );
    if (!projectAccess.ok)
      return void res
        .status(projectAccess.status)
        .json({ detail: projectAccess.detail });

    const { data: newChat, error } = await db
      .from("chats")
      .insert({ user_id: userId, project_id: resolvedProjectId })
      .select("id, title")
      .single();
    if (error || !newChat) {
      console.error("[chat/stream] failed to create chat", error);
      return void res.status(500).json({ detail: "Failed to create chat" });
    }
    chatId = newChat.id as string;
    chatTitle = newChat.title;
  }

  devLog("[chat/stream] resolved chatId", chatId);

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (askInputsResponse) {
    await appendAskInputsResponseToLastAssistantMessage(
      db,
      chatId,
      askInputsResponse,
    );
  } else if (lastUser) {
    await db.from("chat_messages").insert({
      chat_id: chatId,
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
    });
  }

  const { docIndex, docStore } = await buildDocContext(
    messages,
    userId,
    db,
    chatId,
  );
  let imagesByDocumentId: Map<string, LlmImage>;
  try {
    imagesByDocumentId = await loadStoredChatImages(messages, docIndex, docStore);
  } catch (error) {
    return void res.status(400).json({
      detail: safeErrorMessage(error, "Invalid image attachment"),
    });
  }
  const selectedModel = model || DEFAULT_MAIN_MODEL;
  if (
    imagesByDocumentId.size &&
    !modelSupportsImageInput(selectedModel)
  ) {
    return void res.status(400).json({
      detail: `Model "${selectedModel}" does not support image input.`,
    });
  }
  const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
    doc_id,
    filename: info.filename,
  }));
  const enrichedMessages = (await enrichWithPriorEvents(
    messages,
    chatId,
    db,
    docIndex,
  )).map((message) => ({
    ...message,
    images: imagesForMessage(message, imagesByDocumentId),
  }));
  const { api_keys: apiKeys, legal_research_us: legalResearchUs } =
    await getUserModelSettings(userId, db);
  const apiMessages = buildMessages(
    enrichedMessages,
    docAvailability,
    undefined,
    undefined,
    legalResearchUs,
  );

  const workflowStore = await buildWorkflowStore(userId, userEmail, db);

  devLog("[chat/stream] starting LLM stream", {
    apiMessageCount: apiMessages.length,
    docCount: Object.keys(docIndex).length,
    workflowCount: Object.keys(workflowStore).length,
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const write = (line: string) => res.write(line);
  const streamAbort = new AbortController();
  let streamFinished = false;
  res.on("close", () => {
    if (!streamFinished) streamAbort.abort();
  });

  try {
    write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

    const { fullText, events, citations } = await runLLMStream({
      apiMessages,
      docStore,
      docIndex,
      userId,
      db,
      write,
      workflowStore,
      includeResearchTools: legalResearchUs,
      model,
      apiKeys,
      reasoningEffort,
      signal: streamAbort.signal,
      projectId: resolvedProjectId,
    });

    devLog("[chat/stream] LLM stream finished", {
      fullTextLen: fullText?.length ?? 0,
      eventCount: events?.length ?? 0,
    });

    const persistedEvents = stripTransientAssistantEvents(events);
    if (askInputsResponse) {
      await appendAssistantEventsToLastAssistantMessage(
        db,
        chatId,
        persistedEvents,
        citations,
      );
    } else {
      await db.from("chat_messages").insert({
        chat_id: chatId,
        role: "assistant",
        content: persistedEvents.length ? persistedEvents : null,
        citations: citations.length ? citations : null,
      });
    }

    if (!chatTitle && lastUser?.content) {
      await db
        .from("chats")
        .update({ title: lastUser.content.slice(0, 120) })
        .eq("id", chatId);
    }
  } catch (err) {
    if (isAbortError(err)) {
      devLog("[chat/stream] client aborted stream", { chatId });
      if (err instanceof AssistantStreamError) {
        const partial = buildCancelledAssistantMessage({
          fullText: err.fullText,
          events: err.events,
          buildCitations: (fullText, events) =>
            extractCitations(fullText, docIndex, events),
        });
        const saveError = askInputsResponse
          ? null
          : (
              await db.from("chat_messages").insert({
                chat_id: chatId,
                role: "assistant",
                content: partial.events.length ? partial.events : null,
                citations: partial.citations.length ? partial.citations : null,
              })
            ).error;
        if (askInputsResponse) {
          await appendAssistantEventsToLastAssistantMessage(
            db,
            chatId,
            partial.events,
            partial.citations,
          );
        }
        if (saveError) {
          console.error(
            "[chat/stream] failed to save aborted stream",
            saveError,
          );
        }
      }
      return;
    }
    console.error("[chat/stream] error:", safeErrorLog(err));
    const message = safeErrorMessage(err, "Stream error");
    const errorEvents =
      err instanceof AssistantStreamError
        ? stripTransientAssistantEvents(err.events)
        : [{ type: "error" as const, message }];
    const errorFullText =
      err instanceof AssistantStreamError ? err.fullText : "";
    try {
      const citations = extractCitations(errorFullText, docIndex, errorEvents);
      const saveError = askInputsResponse
        ? null
        : (
            await db.from("chat_messages").insert({
              chat_id: chatId,
              role: "assistant",
              content: errorEvents.length ? errorEvents : null,
              citations: citations.length ? citations : null,
            })
          ).error;
      if (askInputsResponse) {
        await appendAssistantEventsToLastAssistantMessage(
          db,
          chatId,
          errorEvents,
          citations,
        );
      }
      if (saveError)
        console.error("[chat/stream] failed to save error", saveError);
    } catch (saveErr) {
      console.error("[chat/stream] failed to save error", saveErr);
    }
    try {
      write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      write("data: [DONE]\n\n");
    } catch {
      /* ignore */
    }
  } finally {
    streamFinished = true;
    res.end();
  }
});
