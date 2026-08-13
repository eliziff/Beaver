import { createServerSupabase } from "../supabase";
import {
  attachActiveVersionPaths,
} from "../documentVersions";
import {
  type DocStore,
  type DocIndex,
  type WorkflowStore,
  type ChatMessage,
  type AskInputsResponseRequest,
} from "./types";
import { formatChatMessageContent } from "./messageFormatting";
export {
  formatChatMessageContent,
  parseAskInputsResponsePayload,
} from "./messageFormatting";
import { buildSystemPrompt, SPREADSHEET_CITATION_PROMPT } from "./prompts";
import type { AssistantEvent } from "./streaming";
import { priorLegalEvidenceReceipts } from "./legalEvidence";

export async function loadPriorLegalEvidence(
  chatId: string | null | undefined,
  db: ReturnType<typeof createServerSupabase>,
) {
  if (!chatId) return [];
  const { data: rows } = await db
    .from("chat_messages")
    .select("content, created_at")
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .order("created_at", { ascending: true });
  if (!Array.isArray(rows)) return [];
  return priorLegalEvidenceReceipts(
    rows.flatMap((row) =>
      Array.isArray((row as { content?: unknown }).content)
        ? ((row as { content: unknown[] }).content)
        : [],
    ),
  );
}


export async function enrichWithPriorEvents(
  messages: ChatMessage[],
  chatId: string | null | undefined,
  db: ReturnType<typeof createServerSupabase>,
  docIndex: DocIndex,
): Promise<ChatMessage[]> {
  if (!chatId) return messages;
  const { data: rows } = await db
    .from("chat_messages")
    .select("content, created_at")
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);

  const lastRow = rows?.[0] as { content?: unknown } | undefined;
  const content = lastRow?.content;
  if (!Array.isArray(content)) return messages;

  const slugByDocumentId = new Map<string, string>();
  for (const [slug, info] of Object.entries(docIndex)) {
    if (info.document_id) slugByDocumentId.set(info.document_id, slug);
  }
  const refFor = (documentId: unknown, filename: unknown) => {
    const slug =
      typeof documentId === "string"
        ? slugByDocumentId.get(documentId)
        : undefined;
    return slug ? `${slug} ("${filename}")` : `"${filename}"`;
  };

  const lines: string[] = [];
  for (const ev of content as Record<string, unknown>[]) {
    if (ev?.type === "doc_created") {
      lines.push(`- generated_document → ${refFor(ev.document_id, ev.filename)}`);
    } else if (ev?.type === "doc_edited") {
      lines.push(`- edit_document → ${refFor(ev.document_id, ev.filename)}`);
    } else if (ev?.type === "doc_read") {
      lines.push(`- read_document → ${refFor(ev.document_id, ev.filename)}`);
    } else if (ev?.type === "workflow_applied") {
      lines.push(`- applied workflow: "${ev.title}"`);
    } else if (ev?.type === "ask_inputs") {
      const count = Array.isArray(ev.items) ? ev.items.length : 0;
      lines.push(`- asked user for ${count} input${count === 1 ? "" : "s"}`);
    } else if (ev?.type === "ask_inputs_response") {
      const responses = Array.isArray(ev.responses) ? ev.responses : [];
      for (const response of responses) {
        if (!response || typeof response !== "object") continue;
        const row = response as Record<string, unknown>;
        if (row.skipped) {
          lines.push("- user skipped an input");
        } else if (row.kind === "choice" && typeof row.answer === "string") {
          lines.push(`- user answered: "${row.answer}"`);
        } else if (
          row.kind === "documents" &&
          Array.isArray(row.filenames)
        ) {
          lines.push(
            `- user attached documents: ${row.filenames.join(", ") || "none"}`,
          );
        }
      }
    }
  }
  if (lines.length === 0) return messages;
  const summary = `\n\n[Tool activity in your previous turn]\n${lines.join("\n")}`;

  // Find the index of the last assistant message and attach the
  // summary there only.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return messages;
  const enriched = messages.slice();
  const target = enriched[lastAssistantIdx];
  enriched[lastAssistantIdx] = {
    ...target,
    content: (target.content ?? "") + summary,
  };
  return enriched;
}

export function buildMessages(
  messages: ChatMessage[],
  docAvailability: {
    doc_id: string;
    filename: string;
    folder_path?: string;
  }[],
  systemPromptExtra?: string,
  docIndex?: DocIndex,
  includeResearchTools = true,
) {
  const formatted: unknown[] = [];
  let systemContent = buildSystemPrompt(includeResearchTools);

  if (systemPromptExtra) {
    systemContent += `\n\n${systemPromptExtra.trim()}`;
  }

  // Spreadsheet citation syntax is only spliced in when a spreadsheet is
  // actually in context, after the static prompt so the cacheable prefix
  // stays stable across turns.
  const spreadsheetName = /\.(xlsx|xlsm|xls|csv|ods)$/iu;
  const hasSpreadsheet =
    docAvailability.some((doc) => spreadsheetName.test(doc.filename)) ||
    Object.values(docIndex ?? {}).some((info) =>
      spreadsheetName.test(info.filename),
    ) ||
    messages.some((msg) =>
      msg.files?.some((file) => spreadsheetName.test(file.filename)),
    );
  if (hasSpreadsheet) {
    systemContent += `\n\n${SPREADSHEET_CITATION_PROMPT}`;
  }

  if (docAvailability.length) {
    systemContent += "\n\n---\nAVAILABLE DOCUMENTS:\n";
    for (const doc of docAvailability) {
      const label = doc.folder_path
        ? `${doc.folder_path} / ${doc.filename}`
        : doc.filename;
      systemContent += `- ${doc.doc_id}: ${label}\n`;
    }
    systemContent +=
      "\nYou do NOT retain document content between conversation turns. You MUST call read_document (or fetch_documents) once at the start of every response that involves a document's content, even if you have read it in a previous turn. Within the same response, do not call read_document or fetch_documents again for a document/version that has already been read; use the prior tool result, find_in_document for targeted checks, or proceed to the next required tool. Failure to read once per turn will result in hallucinated or stale content.\n---\n";
  }
  formatted.push({ role: "system", content: systemContent });

  // Map document_id (UUID) → current-turn doc_id slug, so when we
  // inline a user attachment we hand the model the same handle it
  // would use to call read_document / fetch_documents.
  const slugByDocumentId = new Map<string, string>();
  if (docIndex) {
    for (const [slug, info] of Object.entries(docIndex)) {
      if (info.document_id) slugByDocumentId.set(info.document_id, slug);
    }
  }

  for (const msg of messages) {
    formatted.push({
      role: msg.role,
      content: formatChatMessageContent(msg, slugByDocumentId),
      images: msg.images,
    });
  }
  return formatted;
}

export function stripTransientAssistantEvents(events: AssistantEvent[]) {
  return events.filter((event) => event.type !== "case_opinions");
}

export async function appendAskInputsResponseToLastAssistantMessage(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  response: AskInputsResponseRequest,
) {
  await appendAssistantEventsToLastAssistantMessage(db, chatId, [
    {
      type: "ask_inputs_response" as const,
      responses: response.responses,
    },
  ]);
}

export async function appendAssistantEventsToLastAssistantMessage(
  db: ReturnType<typeof createServerSupabase>,
  chatId: string,
  events: AssistantEvent[],
  citations?: unknown[],
) {
  if (events.length === 0 && (!citations || citations.length === 0)) {
    return;
  }
  const { data: rows, error: selectError } = await db
    .from("chat_messages")
    .select("id, content, citations")
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(1);
  if (selectError || !rows?.[0]) {
    if (selectError) {
      console.error(
        "[assistant-events] failed to load assistant message",
        selectError,
      );
    }
    return;
  }

  const row = rows[0] as {
    id: string;
    content: unknown;
    citations?: unknown;
  };
  const existing = Array.isArray(row.content)
    ? row.content
    : [];
  const next = [...existing, ...events];
  const existingCitations = Array.isArray(row.citations)
    ? row.citations
    : [];
  const nextCitations =
    citations && citations.length > 0
      ? [...existingCitations, ...citations]
      : existingCitations;
  const { error: updateError } = await db
    .from("chat_messages")
    .update({
      content: next.length ? next : null,
      citations: nextCitations.length ? nextCitations : null,
    })
    .eq("id", row.id);
  if (updateError) {
    console.error(
      "[assistant-events] failed to update assistant message",
      updateError,
    );
  }
}

function appendCancelledAssistantEvent(events: AssistantEvent[]) {
  return [...events, { type: "content" as const, text: "Cancelled by user." }];
}

export function buildCancelledAssistantMessage(args: {
  events: AssistantEvent[];
  fullText?: string;
  buildCitations?: (fullText: string, events: AssistantEvent[]) => unknown[];
}) {
  const events = appendCancelledAssistantEvent(
    stripTransientAssistantEvents(args.events),
  );
  return {
    events,
    citations: args.buildCitations
      ? args.buildCitations(args.fullText ?? "", events)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Document context builder (from message file attachments)
// ---------------------------------------------------------------------------

export async function buildDocContext(
  messages: ChatMessage[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  chatId?: string | null,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
  const docIndex: DocIndex = {};
  const docStore: DocStore = new Map();

  const documentIds = new Set<string>();
  for (const m of messages) {
    for (const f of m.files ?? []) {
      if (f.document_id) documentIds.add(f.document_id);
    }
  }

  // Also pull in document_ids from prior assistant events in this chat —
  // generated docs (generate_docx) and tracked-change edits (edit_document)
  // aren't attached to user messages as files, so they only live in the
  // assistant's `doc_created` / `doc_edited` events. Without this sweep
  // the model loses access to generated docs after the turn that created
  // them, and can't call edit_document / read_document on them.
  if (chatId) {
    const { data: rows } = await db
      .from("chat_messages")
      .select("content")
      .eq("chat_id", chatId)
      .eq("role", "assistant");
    for (const row of rows ?? []) {
      const content = (row as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const ev of content as Record<string, unknown>[]) {
        if (
          (ev?.type === "doc_created" || ev?.type === "doc_edited") &&
          typeof ev.document_id === "string"
        ) {
          documentIds.add(ev.document_id);
        }
      }
    }
  }

  const ids = [...documentIds];
  if (ids.length > 0) {
    const { data: docs } = await db
      .from("documents")
      .select("id, current_version_id, status")
      .in("id", ids)
      .eq("user_id", userId)
      .eq("status", "ready");

    const docList = (docs ?? []) as unknown as {
      id: string;
      filename?: string | null;
      file_type?: string | null;
      current_version_id?: string | null;
      active_version_number?: number | null;
      storage_path?: string | null;
    }[];
    await attachActiveVersionPaths(db, docList);
    for (let i = 0; i < docList.length; i++) {
      const doc = docList[i];
      if (!doc.storage_path) continue;
      const docLabel = `doc-${i}`;
      const filename = doc.filename?.trim() || "Untitled document";
      docIndex[docLabel] = {
        document_id: doc.id,
        filename,
        version_id: doc.current_version_id ?? null,
        version_number: doc.active_version_number ?? null,
      };
      docStore.set(docLabel, {
        storage_path: doc.storage_path,
        file_type: doc.file_type ?? "",
        filename,
      });
    }
  }

  return { docIndex, docStore };
}

export async function buildProjectDocContext(
  projectId: string,
  _userId: string,
  db: ReturnType<typeof createServerSupabase>,
): Promise<{
  docIndex: DocIndex;
  docStore: DocStore;
  folderPaths: Map<string, string>;
}> {
  const docIndex: DocIndex = {};
  const docStore: DocStore = new Map();

  const [{ data: docs }, { data: folders }] = await Promise.all([
    db
      .from("documents")
      .select("id, current_version_id, status, folder_id")
      .eq("project_id", projectId)
      .eq("status", "ready")
      .order("created_at", { ascending: true }),
    db
      .from("project_subfolders")
      .select("id, name, parent_folder_id")
      .eq("project_id", projectId),
  ]);
  const docList = (docs ?? []) as unknown as {
    id: string;
    filename?: string | null;
    file_type?: string | null;
    current_version_id?: string | null;
    active_version_number?: number | null;
    folder_id?: string | null;
    storage_path?: string | null;
  }[];
  await attachActiveVersionPaths(db, docList);

  // Build folder id → full path map
  const folderMap = new Map<
    string,
    { name: string; parent_folder_id: string | null }
  >();
  for (const f of folders ?? [])
    folderMap.set(f.id, {
      name: f.name,
      parent_folder_id: f.parent_folder_id,
    });

  function resolvePath(folderId: string | null): string {
    if (!folderId) return "";
    const parts: string[] = [];
    let cur: string | null = folderId;
    while (cur) {
      const f = folderMap.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parent_folder_id;
    }
    return parts.join(" / ");
  }

  const folderPaths = new Map<string, string>(); // doc label → folder path

  for (let i = 0; i < docList.length; i++) {
    const doc = docList[i];
    if (!doc.storage_path) continue;
    const docLabel = `doc-${i}`;
    const filename = doc.filename?.trim() || "Untitled document";
    docIndex[docLabel] = {
      document_id: doc.id,
      filename,
      version_id: doc.current_version_id ?? null,
      version_number: doc.active_version_number ?? null,
    };
    docStore.set(docLabel, {
      storage_path: doc.storage_path,
      file_type: doc.file_type ?? "",
      filename,
    });
    const path = resolvePath(doc.folder_id ?? null);
    if (path) folderPaths.set(docLabel, path);
  }

  return { docIndex, docStore, folderPaths };
}

export async function buildWorkflowStore(
  userId: string,
  userEmail: string | null | undefined,
  db: ReturnType<typeof createServerSupabase>,
): Promise<WorkflowStore> {
  const { SYSTEM_ASSISTANT_WORKFLOWS } = await import("../systemWorkflows");
  const store: WorkflowStore = new Map();
  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();

  // Seed system workflows first.
  for (const wf of SYSTEM_ASSISTANT_WORKFLOWS) {
    store.set(wf.id, { title: wf.title, skill_md: wf.skill_md });
  }

  // Then overlay user-owned assistant workflows.
  const { data: workflows } = await db
    .from("workflows")
    .select("id, title, prompt_md")
    .eq("user_id", userId)
    .eq("type", "assistant");
  for (const wf of workflows ?? []) {
    if (wf.prompt_md) {
      store.set(wf.id, { title: wf.title, skill_md: wf.prompt_md });
    }
  }

  // Shared assistant workflows must also be readable by workflow tools.
  if (normalizedUserEmail) {
    const { data: shares } = await db
      .from("workflow_shares")
      .select("workflow_id")
      .eq("shared_with_email", normalizedUserEmail);
    const sharedIds = [
      ...new Set((shares ?? []).map((share) => share.workflow_id)),
    ];
    if (sharedIds.length > 0) {
      const { data: sharedWorkflows } = await db
        .from("workflows")
        .select("id, title, prompt_md")
        .in("id", sharedIds)
        .eq("type", "assistant");
      for (const wf of sharedWorkflows ?? []) {
        if (wf.prompt_md) {
          store.set(wf.id, {
            title: wf.title,
            skill_md: wf.prompt_md,
          });
        }
      }
    }
  }
  return store;
}
