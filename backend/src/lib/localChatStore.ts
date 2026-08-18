import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createChatStore,
  patchChatEditEvents,
  type ChatMutation,
  type ChatMessageRecord,
  type ChatRecord,
  type CreateChatStore,
} from "./chatStore";
import { abortChatTurnForDeletion } from "./chatTurns";
import {
  localApplicationDatabase,
  localApplicationTransaction,
} from "./localApplicationDatabase";
import { localTrackedEditStatuses } from "./localDocumentStore";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";

const id = z.string().uuid();
const messageSchema = z.object({
  id, chat_id: id, turn_id: id.optional(), role: z.enum(["user", "assistant"]),
  content: z.unknown(), files: z.unknown().optional(), workflow: z.unknown().optional(),
  citations: z.unknown().optional(),
  created_at: z.string().datetime(),
}).strict();
const chatSchema = z.object({
  id, user_id: id, project_id: id.nullable(), tabular_review_id: id.nullable(),
  title: z.string().nullable(), created_at: z.string().datetime(),
  updated_at: z.string().datetime(), deleted_at: z.string().datetime().nullable(),
  transcript_version: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
}).strict();

type LocalMessage = ChatMessageRecord & { created_at: string };
type LocalChat = ChatRecord & {
  created_at: string; updated_at: string; deleted_at: string | null; messages: LocalMessage[];
};
type ChatRow = Omit<LocalChat, "messages"> & { messages_json: string };
type Mutation =
  | { status: "missing" } | { status: "conflict"; currentVersion: number }
  | { status: "committed"; chat: LocalChat };

const selectChat = `SELECT id,user_id,project_id,tabular_review_id,title,
  created_at,updated_at,deleted_at,transcript_version,messages_json
  FROM local_chats`;

function parseChat(row: ChatRow | undefined): LocalChat | null {
  if (!row) return null;
  try {
    const { messages_json, ...chat } = row;
    const parsed = chatSchema.safeParse({ ...chat, messages: JSON.parse(messages_json) });
    return parsed.success && parsed.data.messages.every(
      (message) => message.chat_id === parsed.data.id,
    ) ? parsed.data as LocalChat : null;
  } catch {
    return null;
  }
}

function readChat(userId: string, chatId: string, deleted = false) {
  if (!id.safeParse(userId).success || !id.safeParse(chatId).success) return null;
  return parseChat(localApplicationDatabase().prepare(
    `${selectChat} WHERE user_id=? AND id=? AND deleted_at IS ${
      deleted ? "NOT NULL" : "NULL"
    }`,
  ).get(userId, chatId) as ChatRow | undefined);
}

const record = ({ messages: _messages, ...chat }: LocalChat) => chat as ChatRecord;

function purgeExpired(userId: string, cutoff: string) {
  return localApplicationTransaction((database) => {
    const rows = database.prepare(`SELECT id FROM local_chats WHERE user_id=?
      AND deleted_at IS NOT NULL AND deleted_at<=?`).all(userId, cutoff) as { id: string }[];
    database.prepare(`DELETE FROM local_chats WHERE user_id=?
      AND deleted_at IS NOT NULL AND deleted_at<=?`).run(userId, cutoff);
    return rows.map(({ id }) => id);
  });
}

function listChats(userId: string, deleted: boolean) {
  if (!id.safeParse(userId).success) return [];
  return (localApplicationDatabase().prepare(
    `${selectChat} WHERE user_id=? AND deleted_at IS ${
      deleted ? "NOT NULL" : "NULL"
    } ORDER BY ${deleted
      ? "deleted_at DESC, id"
      : "updated_at DESC, created_at DESC, id"}`,
  ).all(userId) as ChatRow[]).flatMap((row) => parseChat(row) ?? []);
}

function mutateChat(userId: string, chatId: string, expectedVersion: number | undefined,
  change: (chat: LocalChat) => LocalChat | null,
): Mutation {
  return localApplicationTransaction((database) => {
    const current = parseChat(database.prepare(
      `${selectChat} WHERE user_id=? AND id=? AND deleted_at IS NULL`,
    ).get(userId, chatId) as ChatRow | undefined);
    if (!current) return { status: "missing" };
    if (expectedVersion !== undefined && current.transcript_version !== expectedVersion)
      return { status: "conflict", currentVersion: current.transcript_version };
    const next = change(current);
    if (!next) return { status: "missing" };
    const parsed = chatSchema.parse(next) as LocalChat;
    const changed = database.prepare(
      `UPDATE local_chats SET project_id=?,tabular_review_id=?,title=?,updated_at=?,
        deleted_at=?,transcript_version=?,messages_json=?
       WHERE user_id=? AND id=? AND transcript_version=?`,
    ).run(
      parsed.project_id, parsed.tabular_review_id, parsed.title, parsed.updated_at,
      parsed.deleted_at, parsed.transcript_version, JSON.stringify(parsed.messages),
      parsed.user_id, parsed.id, current.transcript_version,
    ).changes;
    if (!changed) {
      const latest = database.prepare(
        "SELECT transcript_version FROM local_chats WHERE user_id=? AND id=?",
      ).get(userId, chatId) as { transcript_version: number } | undefined;
      return latest ? { status: "conflict", currentVersion: latest.transcript_version }
        : { status: "missing" };
    }
    return { status: "committed", chat: parsed };
  });
}

function turnMessages(chat: LocalChat, commit: Extract<ChatMutation, { kind: "turn" }>["turn"]) {
  const messages = [...chat.messages];
  const now = new Date().toISOString();
  if (commit.userMessage) {
    messages.push({
      id: commit.userMessage.id, chat_id: chat.id,
      ...(commit.userMessage.turnId ? { turn_id: commit.userMessage.turnId } : {}),
      role: "user", content: commit.userMessage.content,
      ...(commit.userMessage.files !== undefined ? { files: commit.userMessage.files } : {}),
      ...(commit.userMessage.workflow !== undefined
        ? { workflow: commit.userMessage.workflow } : {}),
      created_at: now,
    });
  }
  if (commit.assistantMessage) {
    const index = messages.findIndex(
      (message) => message.id === commit.assistantMessage!.id && message.role === "assistant",
    );
    const previous = index < 0 ? null : messages[index];
    const assistant: LocalMessage = {
      id: commit.assistantMessage.id, chat_id: chat.id,
      ...(commit.assistantMessage.turnId
        ? { turn_id: commit.assistantMessage.turnId }
        : previous?.turn_id ? { turn_id: previous.turn_id } : {}),
      role: "assistant", content: commit.assistantMessage.content,
      citations: commit.assistantMessage.citations,
      created_at: previous?.created_at ?? now,
    };
    if (index < 0) messages.push(assistant); else messages[index] = assistant;
  }
  return { messages, now };
}

async function decorateMessages(userId: string, messages: ChatMessageRecord[]) {
  const documentIds = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const event of message.content as Record<string, unknown>[]) {
      if (event.type === "doc_edited" && typeof event.document_id === "string")
        documentIds.add(event.document_id);
    }
  }
  const rows = documentIds.size ? await localTrackedEditStatuses(userId, documentIds) : [];
  return patchChatEditEvents(
    messages,
    rows.map((row) => [row.editId, row.status] as const),
    rows.map((row) => [row.versionId, row.versionNumber] as const),
  );
}

export function abortLocalProjectChatTurns(userId: string, projectId: string) {
  const rows = localApplicationDatabase().prepare(
    "SELECT id FROM local_chats WHERE user_id=? AND project_id=?",
  ).all(userId, projectId) as { id: string }[];
  rows.forEach(({ id: chatId }) => abortChatTurnForDeletion(chatId));
}

export const createLocalChatStore: CreateChatStore = (tabular) => createChatStore(
  (scope) => ({
  async context(kind, contextId) { return kind === "project"
    ? !!legalKnowledgeGraphStore().getMatter(scope.userId, contextId)
    : !!await tabular.detail(scope, contextId); },
  async list(options) {
    const rows = listChats(scope.userId, false).filter((chat) => chat.messages.length > 0)
      .filter((chat) => options.projectId ? chat.project_id === options.projectId
        : options.tabularReviewId ? chat.tabular_review_id === options.tabularReviewId
          : chat.project_id === null && chat.tabular_review_id === null);
    return (options.limit ? rows.slice(0, options.limit) : rows).map(record);
  },
  async deleted() { return listChats(scope.userId, true).map(record); },
  async purge(cutoff) { return purgeExpired(scope.userId, cutoff); },
  async create(input) {
    const now = new Date().toISOString();
    const chat = chatSchema.parse({
      id: randomUUID(), user_id: scope.userId, project_id: input.projectId,
      tabular_review_id: input.tabularReviewId, title: null, created_at: now,
      updated_at: now, deleted_at: null, transcript_version: 0, messages: [],
    }) as LocalChat;
    localApplicationDatabase().prepare(
      `INSERT INTO local_chats
        (id,user_id,project_id,tabular_review_id,title,created_at,updated_at,
         deleted_at,transcript_version,messages_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      chat.id, chat.user_id, chat.project_id, chat.tabular_review_id, chat.title,
      chat.created_at, chat.updated_at, null, 0, "[]",
    );
    return record(chat);
  },
  async read(chatId, _messages = false, deleted = false) {
    const chat = readChat(scope.userId, chatId, deleted);
    return chat ? { chat: record(chat), messages: chat.messages } : null; },
  async owns(chatId) { return !!readChat(scope.userId, chatId); },
  async commit(chatId, mutation) {
    const expected = mutation.kind === "turn" ? mutation.turn.expectedVersion : undefined;
    const result = mutateChat(scope.userId, chatId, expected, (chat) => {
      if (mutation.kind === "turn") {
        const { messages, now } = turnMessages(chat, mutation.turn);
        return { ...chat, messages, updated_at: now,
          transcript_version: chat.transcript_version + 1 };
      }
      const index = chat.messages.findIndex(
        (message) => message.id === mutation.messageId && message.role === "assistant");
      if (index < 0) return null;
      const messages = [...chat.messages], message = messages[index];
      messages[index] = { ...message, content: [
        ...(Array.isArray(message.content) ? message.content : []), mutation.event] };
      return { ...chat, messages, updated_at: new Date().toISOString(),
        transcript_version: chat.transcript_version + 1 };
    });
    return result.status === "committed"
      ? { status: "committed", currentVersion: result.chat.transcript_version }
      : result;
  },
  async update(chatId, input) {
    const result = mutateChat(scope.userId, chatId, undefined, (chat) => ({
      ...chat,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.projectId !== undefined ? { project_id: input.projectId } : {}),
      updated_at: new Date().toISOString(),
    }));
    return result.status === "committed" ? record(result.chat) : null;
  },
  async trash(chatId, now) {
    const result = mutateChat(scope.userId, chatId, undefined, (chat) => ({
      ...chat, deleted_at: now, updated_at: now,
      transcript_version: chat.transcript_version + 1,
    }));
    return result.status === "committed";
  },
  async restore(chatId, cutoff, now) {
    return localApplicationDatabase().prepare(
      `UPDATE local_chats SET deleted_at=NULL,updated_at=?,
        transcript_version=transcript_version+1
       WHERE user_id=? AND id=? AND deleted_at>?`,
    ).run(now, scope.userId, chatId, cutoff).changes > 0;
  },
  async remove(chatId) {
    return localApplicationDatabase().prepare(
      "DELETE FROM local_chats WHERE user_id=? AND id=? AND deleted_at IS NOT NULL",
    ).run(scope.userId, chatId).changes > 0;
  },
  async decorate(messages) { return decorateMessages(scope.userId, messages); },
}), async (_scope, message) => message);
