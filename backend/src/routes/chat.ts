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
  createAnonymousChat,
  deleteAnonymousChat,
  getAnonymousChat,
  listAnonymousChats,
  updateAnonymousChatTitle,
  type AnonymousChat,
  type AnonymousChatMessage,
} from "../lib/anonymousChatStore";
import {
  imagesForMessage,
  loadLocalChatImages,
  loadStoredChatImages,
} from "../lib/chat/imageAttachments";
import { legalKnowledgeGraphStore } from "../lib/legalKnowledgeGraphStore";
import { listLocalDocumentsById } from "../lib/localDocumentStore";
import { readLocalPdfEvidenceReceipt } from "../lib/localPdfLookup";

export const chatRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

const TITLE_FALLBACK = "Misc. Query";
const LOCAL_PDF_EVIDENCE_REGISTRY_EVENT = "local_pdf_evidence_handles";
const MAX_LOCAL_PDF_EVIDENCE_HANDLES = 20;
const LOCAL_PDF_EVIDENCE_HANDLE = /^mike-evidence:v1:[0-9a-f]{64}$/u;

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
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.filter(
      (event) =>
        !event ||
        typeof event !== "object" ||
        Array.isArray(event) ||
        (event as Record<string, unknown>).type !==
          LOCAL_PDF_EVIDENCE_REGISTRY_EVENT,
    );
    return content.length === message.content.length
      ? message
      : { ...message, content };
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
  messages: ChatMessage[];
  model?: string;
  reasoningEffort?: string;
  projectId?: string | null;
  projectIdProvided?: boolean;
  displayedDocument?: { filename: string; document_id: string };
  attachedDocuments?: { filename: string; document_id: string }[];
  askInputsResponse?: AskInputsResponseRequest | null;
}) {
  const { res, userId, messages } = params;
  const existingChat = params.chatId
    ? getAnonymousChat(userId, params.chatId)
    : null;
  if (params.chatId && !existingChat) {
    res.status(404).json({ detail: "Chat not found" });
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
  let imagesByDocumentId: Map<string, LlmImage>;
  try {
    imagesByDocumentId = await loadLocalChatImages(
      messages,
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

  const lastUser = [...messages].reverse().find((message) => {
    return message.role === "user" && typeof message.content === "string";
  });
  const askInputsContext = params.askInputsResponse
    ? `\n\n[User responses to requested inputs]\n${params.askInputsResponse.responses
        .map((response) => {
          if (response.skipped) return `- ${response.id}: skipped`;
          if (response.kind === "choice") {
            return `- ${response.question}: ${response.answer ?? ""}`;
          }
          return `- ${response.id}: ${response.filenames.join(", ") || "none"}`;
        })
        .join("\n")}`
    : "";
  if (params.askInputsResponse) {
    appendAnonymousAssistantEvents(chat, [
      {
        type: "ask_inputs_response",
        responses: params.askInputsResponse.responses,
      },
    ]);
  } else if (lastUser) {
    appendAnonymousMessage(chat, {
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
    });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const streamAbort = new AbortController();
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
  try {
    sseWrite(res, { type: "chat_id", chatId: chat.id });
    await streamChatWithTools({
      model: selectedModel,
      systemPrompt:
        `${
          projectId
            ? "The current Beaver matter is connected through its attached Library documents"
            : "The user's local Beaver Library is connected"
        } through library_list, library_lookup, library_evidence, library_read, library_find, library_link_docx_citations, and library_fix_docx_supras. Use library_list before claiming a Library document is unavailable. For an exact PDF page, paragraph, footnote, proposition, section, or bounded range, use library_lookup instead of library_read; rely on its evidence and do not invent locators or URLs. Beaver adds verified links for exact quoted PDF text automatically. Preserve returned mike-evidence handles when the material may be needed after compaction; rehydrate one with library_evidence instead of repeating or guessing the lookup. If the user asks to add links to citations in a DOCX, call library_link_docx_citations directly; do not read or split its footnotes and do not construct the URLs yourself. If the user asks to fix or update supra-note references, call library_fix_docx_supras first; rely on its deterministic changes and reason only about the cases it reports for review. For a table or book of authorities from a Library DOCX, call toa_submit_library_document with split_fallback auto, poll with toa_job_status, and return job.open_path; do not parse the document or invent local paths yourself. Use A2AJ tools for Canadian case law and legislation. Do not construct URLs for a2aj_lookup results; Beaver attaches verified pinpoint links automatically.\n\n` +
        focusPrompt +
        priorEvidencePrompt +
        COURTLISTENER_SYSTEM_PROMPT +
        "\n\n" +
        PUBLIC_LEGAL_SOURCE_SYSTEM_PROMPT,
      messages: messages.map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content:
          message === lastUser && askInputsContext
            ? `${message.content ?? ""}${askInputsContext}`
            : message.content ?? "",
        images: imagesForMessage(message, imagesByDocumentId),
      })),
      enableThinking: true,
      reasoningEffort: params.reasoningEffort,
      abortSignal: streamAbort.signal,
      tools: LOCAL_ASSISTANT_TOOLS,
      runTools: (calls) =>
        runLocalAssistantTools(
          userId,
          calls,
          a2ajLookups,
          a2ajDocuments,
          courtlistenerState,
          publicLegalState,
          allowedDocumentIds,
          localPdfEvidenceHandles,
        ),
      callbacks: {
        onContentDelta: (text: string) => {
          rawText += text;
          streamVisible(text);
        },
        onReasoningDelta: (text: string) =>
          sseWrite(res, { type: "reasoning_delta", text }),
        onReasoningBlockEnd: () =>
          sseWrite(res, { type: "reasoning_block_end" }),
        onToolCallStart: (call) =>
          sseWrite(res, {
            type: "tool_call_start",
            name: call.name,
          }),
      },
    });

    if (!citationsOpen && visibleTail) {
      visibleText += visibleTail;
      sseWrite(res, { type: "content_delta", text: visibleTail });
      visibleTail = "";
    }
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
    if (params.askInputsResponse) {
      appendAnonymousAssistantEvents(chat, assistantEvents, citations);
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
    sseWrite(res, { type: "content_done" });
    sseWrite(res, {
      type: "citations",
      status: "final",
      citations,
    });
    res.write("data: [DONE]\n\n");
  } catch (error) {
    const message = safeErrorMessage(error, "Model request failed");
    console.error("[chat/anonymous]", safeErrorLog(error));
    if (!res.headersSent) {
      res.status(502).json({ detail: message });
    } else if (!streamAbort.signal.aborted) {
      sseWrite(res, { type: "error", message });
      res.write("data: [DONE]\n\n");
    }
  } finally {
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
  const parsedMessages = parseChatMessages(body.messages);
  if (!parsedMessages.ok) {
    return void res.status(400).json({ detail: parsedMessages.detail });
  }
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
  const askInputsResponse = parseAskInputsResponsePayload(
    body.ask_inputs_response,
  );

  const messages = parsedMessages.messages;
  const chat_id = parsedChatId.chatId;
  const project_id = parsedProjectId.projectId;
  const model = parsedModel.model;
  const reasoningEffort =
    typeof body.reasoning_effort === "string"
      ? body.reasoning_effort.trim().slice(0, 32) || undefined
      : undefined;

  if (isAnonymousLocalMode()) {
    await streamAnonymousChat({
      res,
      userId: res.locals.userId as string,
      chatId: chat_id,
      messages,
      model,
      reasoningEffort,
      projectId: project_id,
      projectIdProvided: parsedProjectId.provided,
      askInputsResponse,
    });
    return;
  }

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
