import { cloudData, cloudScope, type CloudScope } from "./access";
import {
  patchChatEditEvents, type ChatCommitResult, type ChatMessageRecord,
  type ChatRecord, type ChatTurnCommit, type CreateChatRepository,
} from "./chatStore";

const run = <T>(query: PromiseLike<{ data: T; error: any }>, operation = "Cloud chat operation failed") =>
  cloudData<T>(operation, query);
const record = (row: Record<string, unknown>): ChatRecord => ({
  ...row, id: String(row.id), user_id: typeof row.user_id === "string" ? row.user_id : "",
  project_id: typeof row.project_id === "string" ? row.project_id : null,
  tabular_review_id: typeof row.tabular_review_id === "string" ? row.tabular_review_id : null,
  title: typeof row.title === "string" ? row.title : null, transcript_version:
    typeof row.transcript_version === "number" ? row.transcript_version : 0,
});

function commitResult(value: unknown): ChatCommitResult {
  const row = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  if (row.status === "committed" && typeof row.current_version === "number")
    return { status: "committed", currentVersion: row.current_version };
  if (row.status === "conflict" && typeof row.current_version === "number")
    return { status: "conflict", currentVersion: row.current_version };
  return { status: "missing" };
}

async function commit(scope: CloudScope, chatId: string, expectedVersion: number | null,
  input: { userMessage?: ChatTurnCommit["userMessage"]; assistantMessage?: ChatTurnCommit["assistantMessage"];
    appendEvent?: { messageId: string; event: Record<string, unknown> } }) {
  const userMessage = input.userMessage && {
    id: input.userMessage.id, turn_id: input.userMessage.turnId,
    content: input.userMessage.content, files: input.userMessage.files,
    workflow: input.userMessage.workflow,
  };
  const assistantMessage = input.assistantMessage && {
    id: input.assistantMessage.id, turn_id: input.assistantMessage.turnId,
    content: input.assistantMessage.content, citations: input.assistantMessage.citations };
  return commitResult(await run(scope.db.rpc("commit_chat_turn", {
    p_actor_user_id: scope.userId, p_actor_user_email: scope.userEmail || null,
    p_chat_id: chatId, p_expected_version: expectedVersion, p_user_message: userMessage ?? null,
    p_assistant_message: assistantMessage ?? null,
    p_append_event: input.appendEvent ? { message_id: input.appendEvent.messageId,
      event: input.appendEvent.event } : null,
  }), "Failed to commit chat turn"));
}

async function hydrate(scope: CloudScope, messages: ChatMessageRecord[]) {
  const edits = new Set<string>(), versions = new Set<string>();
  for (const message of messages) for (const event of Array.isArray(message.content)
    ? message.content as Record<string, unknown>[] : []) {
    if (event.type !== "document_artifact" || event.action !== "edited") continue;
    if (typeof event.version_id === "string") versions.add(event.version_id);
    for (const annotation of Array.isArray(event.annotations)
      ? event.annotations as Record<string, unknown>[] : []) {
      if (typeof annotation.edit_id === "string") edits.add(annotation.edit_id);
      if (typeof annotation.version_id === "string") versions.add(annotation.version_id);
    }
  }
  const [editRows, versionRows] = await Promise.all([
    edits.size ? run(scope.db.from("document_edits").select("id, status, document_id")
      .in("id", [...edits]), "Failed to load chat edits") : [],
    versions.size ? run(scope.db.from("document_versions").select("id, version_number, document_id")
      .in("id", [...versions]), "Failed to load chat versions") : []]);
  const rows = [...(editRows ?? []), ...(versionRows ?? [])] as { document_id: string }[];
  const allowed = new Set((await scope.documents(rows.map(({ document_id }) => document_id)))
    .map(({ row }) => row.id));
  return patchChatEditEvents(messages,
    (editRows as { id: string; document_id: string;
      status: "pending" | "accepted" | "rejected" }[])
      .filter(({ document_id, status }) => allowed.has(document_id) &&
        ["pending", "accepted", "rejected"].includes(status))
      .map(({ id, status }) => [id, status] as const),
    (versionRows as { id: string; document_id: string; version_number: number | null }[])
      .filter(({ document_id }) => allowed.has(document_id))
      .map(({ id, version_number }) => [id, version_number] as const));
}

export const postgresChatRepository: CreateChatRepository = (identity) => {
    const scope = cloudScope(identity);
    return {
      async list(options) {
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
          .select("user_id, display_name").in("user_id", ids),
        "Failed to load chat creators") : [];
        const names = new Map((profiles ?? []).map((profile) => [String(profile.user_id),
          typeof profile.display_name === "string" && profile.display_name.trim()
            ? profile.display_name.trim() : null]));
        return rows.map((row) => record({ ...row,
          creator_display_name: names.get(String(row.user_id)) ?? null }));
      },
      async deleted() {
        const data = await run(scope.db.from("chats")
          .select("id, project_id, tabular_review_id, user_id, title, created_at, deleted_at")
          .eq("user_id", scope.userId).not("deleted_at", "is", null)
          .order("deleted_at", { ascending: false }), "Failed to load deleted chats");
        return ((data ?? []) as Record<string, unknown>[]).map(record);
      },
      async purge(cutoff) {
        const data = await run(scope.db.from("chats").delete().eq("user_id", scope.userId)
          .not("deleted_at", "is", null).lte("deleted_at", cutoff).select("id"),
        "Failed to purge deleted chats") as { id: string }[] | null;
        return (data ?? []).map(({ id }) => id);
      },
      async create(input) {
        const data = await run(scope.db.from("chats").insert({ user_id: scope.userId,
          project_id: input.projectId, tabular_review_id: input.tabularReviewId })
          .select("*").single(), "Failed to create chat") as Record<string, unknown> | null;
        if (!data) throw new Error("Failed to create chat");
        return record(data);
      },
      async read(chatId, messages = false) {
        const access = await scope.chat(chatId);
        if (!access) return null;
        const data = messages ? await run(scope.db.from("chat_messages").select("*")
          .eq("chat_id", chatId).order("created_at", { ascending: true }),
        "Failed to load chat messages") : [];
        return { chat: record(access.row),
          messages: (Array.isArray(data) ? data : []) as ChatMessageRecord[] };
      },
      async owns(chatId) { return !!await scope.chat(chatId, true); },
      async commit(chatId, mutation) {
        return mutation.kind === "turn"
          ? commit(scope, chatId, mutation.turn.expectedVersion, mutation.turn)
          : commit(scope, chatId, null, { appendEvent: mutation });
      },
      async update(chatId, input) {
        const data = await run(scope.db.from("chats").update({
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
        }).eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
          .select("*").maybeSingle(), "Failed to update chat") as Record<string, unknown> | null;
        return data ? record(data) : null;
      },
      async trash(chatId, at) {
        return !!await run(scope.db.from("chats").update({ deleted_at: at })
          .eq("id", chatId).eq("user_id", scope.userId).is("deleted_at", null)
          .select("id").maybeSingle(), "Failed to delete chat");
      },
      async restore(chatId, cutoff, at) {
        return !!await run(scope.db.from("chats").update({ deleted_at: null, updated_at: at })
          .eq("id", chatId).eq("user_id", scope.userId).gt("deleted_at", cutoff)
          .select("id").maybeSingle(), "Failed to restore chat");
      },
      async remove(chatId) {
        return !!await run(scope.db.from("chats").delete().eq("id", chatId)
          .eq("user_id", scope.userId).not("deleted_at", "is", null)
          .select("id").maybeSingle(), "Failed to remove chat");
      },
      async removeAll() {
        const rows = await run(scope.db.from("chats").delete().eq("user_id", scope.userId)
          .select("id"), "Failed to remove chats") ?? [];
        return rows.map(({ id }: { id: string }) => id);
      },
      async decorate(messages) { return hydrate(scope, messages); },
    };
  };
