import { checkProjectAccess } from "./access";
import { completeText } from "./llm";
import { abortChatTurnForDeletion } from "./chatTurns";
import {
  ChatStoreError,
  normalizeChatTitle,
  patchChatEditEvents,
  type ChatMessageRecord,
  type ChatRecord,
  type ChatScope,
  type CreateChatStore,
} from "./chatStore";
import { createServerSupabase } from "./supabase";
import { getUserModelSettings } from "./userSettings";
import { visibleChatMessages } from "./chat/anonymousTranscript";

type Db = ReturnType<typeof createServerSupabase>;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const missing = (detail: string) => new ChatStoreError(404, detail);
const run = async <T>(query: PromiseLike<{
  data: T;
  error: { message: string } | null;
}>) => {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
};
const record = (row: Record<string, unknown>): ChatRecord => ({
  ...row,
  id: String(row.id),
  user_id: typeof row.user_id === "string" ? row.user_id : "",
  project_id: typeof row.project_id === "string" ? row.project_id : null,
  tabular_review_id: typeof row.tabular_review_id === "string"
    ? row.tabular_review_id : null,
  title: typeof row.title === "string" ? row.title : null,
});

async function project(db: Db, scope: ChatScope, projectId: string | null) {
  if (projectId && !(await checkProjectAccess(
    projectId, scope.userId, scope.userEmail, db,
  )).ok) throw missing("Project not found");
}

async function purge(db: Db, userId: string) {
  await run(db.from("chats").delete().eq("user_id", userId)
    .not("deleted_at", "is", null)
    .lte("deleted_at", new Date(Date.now() - RETENTION_MS).toISOString()));
}

async function hydrate(db: Db, messages: ChatMessageRecord[]) {
  const edits = new Set<string>();
  const versions = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const event of message.content as Record<string, unknown>[]) {
      if (event.type !== "doc_edited") continue;
      if (typeof event.version_id === "string") versions.add(event.version_id);
      if (!Array.isArray(event.annotations)) continue;
      for (const annotation of event.annotations as Record<string, unknown>[]) {
        if (typeof annotation.edit_id === "string") edits.add(annotation.edit_id);
        if (typeof annotation.version_id === "string") {
          versions.add(annotation.version_id);
        }
      }
    }
  }
  const [editRows, versionRows] = await Promise.all([
    edits.size ? run(db.from("document_edits").select("id, status")
      .in("id", [...edits])) : [],
    versions.size ? run(db.from("document_versions").select("id, version_number")
      .in("id", [...versions])) : [],
  ]);
  return patchChatEditEvents(
    messages,
    (editRows as { id: string; status: "pending" | "accepted" | "rejected" }[])
      .filter(({ status }) => ["pending", "accepted", "rejected"].includes(status))
      .map(({ id, status }) => [id, status] as const),
    (versionRows as { id: string; version_number: number | null }[])
      .map(({ id, version_number }) => [id, version_number] as const),
  );
}

export const createCloudChatStore: CreateChatStore = (tabular) => {
  const accessible = async (scope: ChatScope, chatId: string) => {
    const db = createServerSupabase();
    const row = await run(db.from("chats").select("*").eq("id", chatId)
      .is("deleted_at", null).maybeSingle()) as Record<string, unknown> | null;
    if (!row) return null;
    const chat = record(row);
    if (chat.user_id === scope.userId) return chat;
    if (chat.project_id && (await checkProjectAccess(
      chat.project_id, scope.userId, scope.userEmail, db,
    )).ok) return chat;
    if (chat.tabular_review_id && await tabular.detail(
      scope, chat.tabular_review_id,
    )) return chat;
    return null;
  };

  return {
    async list(scope, options) {
      const db = createServerSupabase();
      if (options.projectId) await project(db, scope, options.projectId);
      if (options.tabularReviewId && !await tabular.detail(
        scope, options.tabularReviewId,
      )) throw missing("Review not found");
      let data;
      if (options.projectId || options.tabularReviewId) {
        let query = db.from("chats")
            .select("id, project_id, tabular_review_id, user_id, title, created_at, chat_messages!inner(id)")
            .eq(options.projectId ? "project_id" : "tabular_review_id",
              options.projectId ?? options.tabularReviewId)
            .is("deleted_at", null).order("created_at", { ascending: false });
        if (options.limit) query = query.limit(options.limit);
        data = await run(query);
      } else data = await run(db.rpc("get_chats_overview", {
        p_user_id: scope.userId,
        p_limit: options.limit ?? null,
      }));
      const rows = ((data ?? []) as Record<string, unknown>[]).map(
        ({ chat_messages: _messages, ...chat }) => chat,
      );
      if (!options.projectId) return rows.map(record);
      const ids = [...new Set(rows.flatMap(({ user_id }) =>
        typeof user_id === "string" ? [user_id] : []))];
      const profiles = ids.length ? await run(db.from("user_profiles")
        .select("user_id, display_name").in("user_id", ids)) : [];
      const names = new Map((profiles ?? []).map((profile) => [
        String(profile.user_id),
        typeof profile.display_name === "string" && profile.display_name.trim()
          ? profile.display_name.trim() : null,
      ]));
      return rows.map((row) => record({ ...row,
        creator_display_name: names.get(String(row.user_id)) ?? null }));
    },

    async deleted(scope) {
      const db = createServerSupabase();
      await purge(db, scope.userId);
      const data = await run(db.from("chats")
        .select("id, project_id, tabular_review_id, user_id, title, created_at, deleted_at")
        .eq("user_id", scope.userId).not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false }));
      return ((data ?? []) as Record<string, unknown>[]).map(record);
    },

    async create(scope, input) {
      const db = createServerSupabase();
      await project(db, scope, input.projectId);
      if (input.tabularReviewId && !await tabular.detail(
        scope, input.tabularReviewId,
      )) throw missing("Review not found");
      const data = await run(db.from("chats").insert({
        user_id: scope.userId,
        project_id: input.projectId,
        tabular_review_id: input.tabularReviewId,
      }).select("*").single()) as Record<string, unknown> | null;
      if (!data) throw new Error("Failed to create chat");
      return record({ ...data, user_id: scope.userId,
        project_id: input.projectId, tabular_review_id: input.tabularReviewId });
    },

    get: accessible,

    async detail(scope, chatId) {
      const chat = await accessible(scope, chatId);
      if (!chat) return null;
      const db = createServerSupabase();
      const data = await run(db.from("chat_messages").select("*")
        .eq("chat_id", chatId).order("created_at", { ascending: true }));
      return {
        chat,
        messages: visibleChatMessages(
          await hydrate(db, (data ?? []) as ChatMessageRecord[]),
        ),
      };
    },

    async transcript(scope, chatId) {
      if (!await accessible(scope, chatId)) return null;
      const data = await run(createServerSupabase().from("chat_messages")
        .select("*").eq("chat_id", chatId)
        .order("created_at", { ascending: true }));
      return (Array.isArray(data) ? data : []) as ChatMessageRecord[];
    },

    async appendAssistantEvent(scope, chatId, messageId, event) {
      if (!await accessible(scope, chatId)) return false;
      const db = createServerSupabase();
      const row = await run(db.from("chat_messages").select("content")
        .eq("chat_id", chatId).eq("id", messageId).eq("role", "assistant")
        .maybeSingle()) as { content?: unknown } | null;
      if (!row) return false;
      return !!await run(db.from("chat_messages").update({
        content: [...(Array.isArray(row.content) ? row.content : []), event],
      }).eq("chat_id", chatId).eq("id", messageId).eq("role", "assistant")
        .select("id").maybeSingle());
    },

    async update(scope, chatId, input) {
      const chat = await accessible(scope, chatId);
      if (!chat || chat.user_id !== scope.userId) return null;
      const db = createServerSupabase();
      if (input.projectId !== undefined) await project(db, scope, input.projectId);
      const data = await run(db.from("chats").update({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
      }).eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
        .select("*").maybeSingle()) as Record<string, unknown> | null;
      return data ? record(data) : null;
    },

    async trash(scope, chatId) {
      const data = await run(createServerSupabase().from("chats")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
        .select("id").maybeSingle());
      if (data) abortChatTurnForDeletion(chatId);
      return !!data;
    },

    async restore(scope, chatId) {
      const db = createServerSupabase();
      await purge(db, scope.userId);
      return !!await run(db.from("chats").update({ deleted_at: null })
        .eq("id", chatId).eq("user_id", scope.userId)
        .not("deleted_at", "is", null).select("id").maybeSingle());
    },

    async remove(scope, chatId) {
      return !!await run(createServerSupabase().from("chats").delete()
        .eq("id", chatId).eq("user_id", scope.userId)
        .not("deleted_at", "is", null).select("id").maybeSingle());
    },

    async generateTitle(scope, chatId, message) {
      if (!await accessible(scope, chatId)) return null;
      const db = createServerSupabase();
      const { title_model, api_keys } = await getUserModelSettings(scope.userId, db);
      const raw = await completeText({
        model: title_model,
        user: `Generate a concise 3–6 word topic title. Omit generic labels such as "Legal Assistant", "AI", or "Chat". If the message has no identifiable topic, return "Misc. Query". Return only the title.\n\nMessage: ${message.slice(0, 500)}`,
        maxTokens: 64,
        apiKeys: api_keys,
      });
      const title = normalizeChatTitle(raw);
      await run(db.from("chats").update({ title }).eq("id", chatId)
        .is("deleted_at", null));
      return title;
    },
  };
};
