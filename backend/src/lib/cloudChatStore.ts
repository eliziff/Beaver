import { cloudData, cloudScope, type CloudScope } from "./access";
import { visibleChatMessages } from "./chat/anonymousTranscript";
import { abortChatTurnForDeletion } from "./chatTurns";
import { completeText } from "./llm";
import {
  ChatStoreError, normalizeChatTitle, patchChatEditEvents, type ChatCommitResult,
  type ChatMessageRecord, type ChatRecord, type ChatScope, type ChatTurnCommit, type CreateChatStore,
} from "./chatStore";
import { getUserModelSettings } from "./userSettings";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const missing = (detail: string) => new ChatStoreError(404, detail);
const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation = "Cloud chat operation failed") =>
  cloudData<T>(operation, query);
const record = (row: Record<string, unknown>): ChatRecord => ({
  ...row, id: String(row.id), user_id: typeof row.user_id === "string" ? row.user_id : "",
  project_id: typeof row.project_id === "string" ? row.project_id : null,
  tabular_review_id: typeof row.tabular_review_id === "string" ? row.tabular_review_id : null,
  title: typeof row.title === "string" ? row.title : null,
  transcript_version: typeof row.transcript_version === "number"
    ? row.transcript_version : 0,
});

function commitResult(value: unknown): ChatCommitResult {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  if (row.status === "committed" && typeof row.current_version === "number") {
    return { status: "committed", currentVersion: row.current_version };
  }
  if (row.status === "conflict" && typeof row.current_version === "number") {
    return { status: "conflict", currentVersion: row.current_version };
  }
  return { status: "missing" };
}

async function commit(scope: CloudScope, chatId: string, expectedVersion: number | null,
  input: { userMessage?: ChatTurnCommit["userMessage"];
    assistantMessage?: ChatTurnCommit["assistantMessage"];
    appendEvent?: { messageId: string; event: Record<string, unknown> } }) {
  const userMessage = input.userMessage && {
    id: input.userMessage.id, turn_id: input.userMessage.turnId,
    content: input.userMessage.content, files: input.userMessage.files,
    workflow: input.userMessage.workflow,
  };
  const assistantMessage = input.assistantMessage && {
    id: input.assistantMessage.id, turn_id: input.assistantMessage.turnId,
    content: input.assistantMessage.content, citations: input.assistantMessage.citations,
  };
  return commitResult(await run(scope.db.rpc("commit_chat_turn", {
    p_actor_user_id: scope.userId, p_actor_user_email: scope.userEmail || null,
    p_chat_id: chatId, p_expected_version: expectedVersion, p_user_message: userMessage ?? null,
    p_assistant_message: assistantMessage ?? null,
    p_append_event: input.appendEvent ? { message_id: input.appendEvent.messageId,
      event: input.appendEvent.event } : null,
  }), "Failed to commit chat turn"));
}

async function requireProject(scope: CloudScope, projectId: string | null) {
  if (projectId && !await scope.project(projectId)) throw missing("Project not found");
}

async function purge(scope: CloudScope) {
  await run(scope.db.from("chats").delete().eq("user_id", scope.userId)
    .not("deleted_at", "is", null)
    .lte("deleted_at", new Date(Date.now() - RETENTION_MS).toISOString()),
  "Failed to purge deleted chats");
}

async function hydrate(scope: CloudScope, messages: ChatMessageRecord[]) {
  const edits = new Set<string>(), versions = new Set<string>();
  for (const message of messages) for (const event of Array.isArray(message.content)
    ? message.content as Record<string, unknown>[] : []) {
    if (event.type !== "doc_edited") continue;
    if (typeof event.version_id === "string") versions.add(event.version_id);
    for (const annotation of Array.isArray(event.annotations)
      ? event.annotations as Record<string, unknown>[] : []) {
      if (typeof annotation.edit_id === "string") edits.add(annotation.edit_id);
      if (typeof annotation.version_id === "string") versions.add(annotation.version_id);
    }
  }
  const [editRows, versionRows] = await Promise.all([
    edits.size ? run(scope.db.from("document_edits").select("id, status")
      .in("id", [...edits]), "Failed to load chat edits") : [],
    versions.size ? run(scope.db.from("document_versions").select("id, version_number")
      .in("id", [...versions]), "Failed to load chat versions") : []]);
  return patchChatEditEvents(messages,
    (editRows as { id: string; status: "pending" | "accepted" | "rejected" }[])
      .filter(({ status }) => ["pending", "accepted", "rejected"].includes(status))
      .map(({ id, status }) => [id, status] as const),
    (versionRows as { id: string; version_number: number | null }[])
      .map(({ id, version_number }) => [id, version_number] as const));
}

export const createCloudChatStore: CreateChatStore = (_tabular) => ({
  async list(identity, options) {
    const scope = cloudScope(identity);
    if (options.projectId) await requireProject(scope, options.projectId);
    if (options.tabularReviewId && !await scope.review(options.tabularReviewId))
      throw missing("Review not found");
    let data: unknown;
    if (options.projectId || options.tabularReviewId) {
      let query = scope.db.from("chats")
        .select("id, project_id, tabular_review_id, user_id, title, created_at, chat_messages!inner(id)")
        .eq(options.projectId ? "project_id" : "tabular_review_id",
          options.projectId ?? options.tabularReviewId)
        .is("deleted_at", null).order("created_at", { ascending: false });
      if (options.limit) query = query.limit(options.limit);
      data = await run(query, "Failed to load chats");
    } else data = await run(scope.db.rpc("get_chats_overview", {
      p_user_id: scope.userId, p_limit: options.limit ?? null,
    }), "Failed to load chats");
    const rows = ((data ?? []) as Record<string, unknown>[])
      .map(({ chat_messages: _messages, ...chat }) => chat);
    if (!options.projectId) return rows.map(record);
    const ids = [...new Set(rows.flatMap(({ user_id }) =>
      typeof user_id === "string" ? [user_id] : []))];
    const profiles = ids.length ? await run(scope.db.from("user_profiles")
      .select("user_id, display_name").in("user_id", ids), "Failed to load chat creators") : [];
    const names = new Map((profiles ?? []).map((profile) => [String(profile.user_id),
      typeof profile.display_name === "string" && profile.display_name.trim()
        ? profile.display_name.trim() : null]));
    return rows.map((row) => record({ ...row,
      creator_display_name: names.get(String(row.user_id)) ?? null }));
  },

  async deleted(identity) {
    const scope = cloudScope(identity);
    await purge(scope);
    const data = await run(scope.db.from("chats")
      .select("id, project_id, tabular_review_id, user_id, title, created_at, deleted_at")
      .eq("user_id", scope.userId).not("deleted_at", "is", null)
      .order("deleted_at", { ascending: false }), "Failed to load deleted chats");
    return ((data ?? []) as Record<string, unknown>[]).map(record);
  },

  async create(identity, input) {
    const scope = cloudScope(identity);
    await requireProject(scope, input.projectId);
    if (input.tabularReviewId && !await scope.review(input.tabularReviewId))
      throw missing("Review not found");
    const data = await run(scope.db.from("chats").insert({ user_id: scope.userId,
      project_id: input.projectId, tabular_review_id: input.tabularReviewId })
      .select("*").single(), "Failed to create chat") as Record<string, unknown> | null;
    if (!data) throw new Error("Failed to create chat");
    return record(data);
  },

  async get(identity, chatId) {
    const access = await cloudScope(identity).chat(chatId);
    return access ? record(access.row) : null;
  },

  async detail(identity, chatId) {
    const scope = cloudScope(identity), access = await scope.chat(chatId);
    if (!access) return null;
    const data = await run(scope.db.from("chat_messages").select("*")
      .eq("chat_id", chatId).order("created_at", { ascending: true }),
    "Failed to load chat messages");
    return { chat: record(access.row), messages: visibleChatMessages(
      await hydrate(scope, (data ?? []) as ChatMessageRecord[])) };
  },

  async transcript(identity, chatId) {
    const scope = cloudScope(identity);
    if (!await scope.chat(chatId)) return null;
    const data = await run(scope.db.from("chat_messages").select("*")
      .eq("chat_id", chatId).order("created_at", { ascending: true }),
    "Failed to load chat transcript");
    return (Array.isArray(data) ? data : []) as ChatMessageRecord[];
  },

  async commitTurn(identity, chatId, turn) {
    const scope = cloudScope(identity);
    return commit(scope, chatId, turn.expectedVersion, turn);
  },

  async appendAssistantEvent(identity, chatId, messageId, event) {
    const scope = cloudScope(identity);
    return commit(scope, chatId, null, { appendEvent: { messageId, event } });
  },

  async update(identity, chatId, input) {
    const scope = cloudScope(identity);
    if (!await scope.chat(chatId, true)) return null;
    if (input.projectId !== undefined) await requireProject(scope, input.projectId);
    const data = await run(scope.db.from("chats").update({
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
    }).eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
      .select("*").maybeSingle(), "Failed to update chat") as Record<string, unknown> | null;
    return data ? record(data) : null;
  },

  async trash(identity, chatId) {
    const scope = cloudScope(identity);
    const data = await run(scope.db.from("chats").update({ deleted_at: new Date().toISOString() })
      .eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
      .select("id").maybeSingle(), "Failed to delete chat");
    if (data) abortChatTurnForDeletion(chatId);
    return !!data;
  },

  async restore(identity, chatId) {
    const scope = cloudScope(identity);
    await purge(scope);
    return !!await run(scope.db.from("chats").update({ deleted_at: null })
      .eq("id", chatId).eq("user_id", scope.userId).not("deleted_at", "is", null)
      .select("id").maybeSingle(), "Failed to restore chat");
  },

  async remove(identity, chatId) {
    const scope = cloudScope(identity);
    return !!await run(scope.db.from("chats").delete().eq("id", chatId)
      .eq("user_id", scope.userId).not("deleted_at", "is", null)
      .select("id").maybeSingle(), "Failed to remove chat");
  },

  async generateTitle(identity, chatId, message) {
    const scope = cloudScope(identity);
    if (!await scope.chat(chatId)) return null;
    const { title_model, api_keys } = await getUserModelSettings(scope.userId, scope.db);
    const title = normalizeChatTitle(await completeText({ model: title_model,
      user: `Generate a concise 3–6 word topic title. Omit generic labels such as "Legal Assistant", "AI", or "Chat". If the message has no identifiable topic, return "Misc. Query". Return only the title.\n\nMessage: ${message.slice(0, 500)}`,
      maxTokens: 64, apiKeys: api_keys }));
    await run(scope.db.from("chats").update({ title }).eq("id", chatId)
      .is("deleted_at", null), "Failed to update chat title");
    return title;
  },
});
