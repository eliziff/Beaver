import { randomUUID } from "node:crypto";
import {
  patchChatEditEvents, type ChatCommitResult, type ChatMessageRecord,
  type ChatMutation, type ChatRecord, type CreateChatRepository,
} from "./chatStore";
import { sqliteDatabase, sqliteTransaction } from "./sqliteDatabase";
import { localTrackedEditStatuses } from "./sqlitePersistence";

type ChatRow = ChatRecord & {
  created_at: string; updated_at: string; deleted_at: string | null;
};
type MessageRow = {
  id: string; chat_id: string; turn_id: string | null; role: "user" | "assistant";
  content_json: string; files_json: string | null; workflow_json: string | null;
  citations_json: string | null; created_at: string;
};
const selectChat = `SELECT id,user_id,project_id,tabular_review_id,title,
  created_at,updated_at,deleted_at,transcript_version FROM chats`;
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
const parse = (value: string | null) => value === null ? null : JSON.parse(value);
const message = ({ content_json, files_json, workflow_json, citations_json, ...row }: MessageRow) => ({
  ...row, content: parse(content_json), files: parse(files_json),
  workflow: parse(workflow_json), citations: parse(citations_json),
}) as ChatMessageRecord;

function read(userId: string, chatId: string, deleted = false) {
  return (sqliteDatabase().prepare(`${selectChat} WHERE user_id=? AND id=?
    AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"}`)
    .get(userId, chatId) as ChatRow | undefined) ?? null;
}

function messages(chatId: string) {
  return (sqliteDatabase().prepare(`SELECT * FROM chat_messages
    WHERE chat_id=? ORDER BY created_at,id`).all(chatId) as MessageRow[]).map(message);
}

function commit(userId: string, chatId: string, mutation: ChatMutation): ChatCommitResult {
  return sqliteTransaction((database) => {
    const current = database.prepare(`SELECT transcript_version FROM chats
      WHERE user_id=? AND id=? AND deleted_at IS NULL`).get(userId, chatId) as
      { transcript_version: number } | undefined;
    if (!current) return { status: "missing" };
    const expected = mutation.kind === "turn" ? mutation.turn.expectedVersion : undefined;
    if (expected !== undefined && expected !== current.transcript_version)
      return { status: "conflict", currentVersion: current.transcript_version };
    const now = new Date().toISOString();
    if (mutation.kind === "append") {
      const prior = database.prepare(`SELECT content_json FROM chat_messages
        WHERE id=? AND chat_id=? AND role='assistant'`).get(mutation.messageId, chatId) as
        { content_json: string } | undefined;
      if (!prior) return { status: "missing" };
      const content = parse(prior.content_json);
      database.prepare("UPDATE chat_messages SET content_json=? WHERE id=?")
        .run(json([...(Array.isArray(content) ? content : []), mutation.event]), mutation.messageId);
    } else {
      const { userMessage, assistantMessage } = mutation.turn;
      if (userMessage) database.prepare(`INSERT INTO chat_messages
        (id,chat_id,turn_id,role,content_json,files_json,workflow_json,created_at)
        VALUES (?,?,?,'user',?,?,?,?)`).run(userMessage.id, chatId, userMessage.turnId ?? null,
        json(userMessage.content), json(userMessage.files), json(userMessage.workflow), now);
      if (assistantMessage) {
        const changed = database.prepare(`UPDATE chat_messages SET
          turn_id=coalesce(?,turn_id),content_json=?,citations_json=?
          WHERE id=? AND chat_id=? AND role='assistant'`).run(assistantMessage.turnId ?? null,
          json(assistantMessage.content), json(assistantMessage.citations),
          assistantMessage.id, chatId).changes;
        if (!changed) database.prepare(`INSERT INTO chat_messages
          (id,chat_id,turn_id,role,content_json,citations_json,created_at)
          VALUES (?,?,?,'assistant',?,?,?)`).run(assistantMessage.id, chatId,
          assistantMessage.turnId ?? null, json(assistantMessage.content),
          json(assistantMessage.citations), now);
      }
    }
    const version = current.transcript_version + 1;
    const changed = database.prepare(`UPDATE chats SET updated_at=?,transcript_version=?
      WHERE user_id=? AND id=? AND transcript_version=?`).run(
      now, version, userId, chatId, current.transcript_version).changes;
    return changed ? { status: "committed", currentVersion: version }
      : { status: "conflict", currentVersion: current.transcript_version };
  });
}

async function decorate(userId: string, rows: ChatMessageRecord[]) {
  const documentIds = new Set<string>();
  for (const row of rows) for (const event of Array.isArray(row.content)
    ? row.content as Record<string, unknown>[] : [])
    if (event.type === "document_artifact" && event.action === "edited" &&
      typeof event.document_id === "string")
      documentIds.add(event.document_id);
  const statuses = documentIds.size ? await localTrackedEditStatuses(userId, documentIds) : [];
  return patchChatEditEvents(rows,
    statuses.map(({ editId, status }) => [editId, status] as const),
    statuses.map(({ versionId, versionNumber }) => [versionId, versionNumber] as const));
}

export const sqliteChatRepository: CreateChatRepository = (scope) => ({
  async list(options) {
    const values: Array<string | number> = [scope.userId];
    const context = options.projectId ? (values.push(options.projectId), "project_id=?")
      : options.tabularReviewId ? (values.push(options.tabularReviewId), "tabular_review_id=?")
        : "project_id IS NULL AND tabular_review_id IS NULL";
    if (options.limit) values.push(options.limit);
    return sqliteDatabase().prepare(`${selectChat} WHERE user_id=? AND ${context}
      AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM chat_messages m WHERE m.chat_id=chats.id)
      ORDER BY updated_at DESC,created_at DESC,id ${options.limit ? "LIMIT ?" : ""}`)
      .all(...values) as ChatRow[];
  },
  async deleted() {
    return sqliteDatabase().prepare(`${selectChat} WHERE user_id=? AND deleted_at IS NOT NULL
      ORDER BY deleted_at DESC,id`).all(scope.userId) as ChatRow[];
  },
  async purge(cutoff) {
    return (sqliteDatabase().prepare(`DELETE FROM chats WHERE user_id=?
      AND deleted_at IS NOT NULL AND deleted_at<=? RETURNING id`).all(scope.userId, cutoff) as
      { id: string }[]).map(({ id }) => id);
  },
  async create(input) {
    const now = new Date().toISOString(), chat: ChatRow = { id: randomUUID(),
      user_id: scope.userId, project_id: input.projectId,
      tabular_review_id: input.tabularReviewId, title: null,
      transcript_version: 0, created_at: now, updated_at: now, deleted_at: null };
    sqliteDatabase().prepare(`INSERT INTO chats
      (id,user_id,project_id,tabular_review_id,title,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(chat.id, chat.user_id, chat.project_id,
      chat.tabular_review_id, chat.title, now, now);
    return chat;
  },
  async read(chatId, includeMessages = false, deleted = false) {
    const chat = read(scope.userId, chatId, deleted);
    return chat ? { chat, messages: includeMessages ? messages(chatId) : [] } : null;
  },
  async owns(chatId) { return !!read(scope.userId, chatId); },
  async commit(chatId, mutation) { return commit(scope.userId, chatId, mutation); },
  async update(chatId, input) {
    const now = new Date().toISOString();
    const changed = sqliteDatabase().prepare(`UPDATE chats SET
      title=CASE WHEN ? THEN ? ELSE title END,
      project_id=CASE WHEN ? THEN ? ELSE project_id END,updated_at=?
      WHERE user_id=? AND id=? AND deleted_at IS NULL`).run(
      input.title !== undefined ? 1 : 0, input.title ?? null,
      input.projectId !== undefined ? 1 : 0, input.projectId ?? null,
      now, scope.userId, chatId).changes;
    return changed ? read(scope.userId, chatId) : null;
  },
  async trash(chatId, at) {
    return sqliteDatabase().prepare(`UPDATE chats SET deleted_at=?,updated_at=?
      WHERE user_id=? AND id=? AND deleted_at IS NULL`).run(at, at, scope.userId, chatId).changes > 0;
  },
  async restore(chatId, cutoff, at) {
    return sqliteDatabase().prepare(`UPDATE chats SET deleted_at=NULL,updated_at=?
      WHERE user_id=? AND id=? AND deleted_at>?`).run(at, scope.userId, chatId, cutoff).changes > 0;
  },
  async remove(chatId) {
    return sqliteDatabase().prepare(`DELETE FROM chats WHERE user_id=? AND id=?
      AND deleted_at IS NOT NULL`).run(scope.userId, chatId).changes > 0;
  },
  async removeAll() {
    return (sqliteDatabase().prepare("DELETE FROM chats WHERE user_id=? RETURNING id")
      .all(scope.userId) as { id: string }[]).map(({ id }) => id);
  },
  async decorate(rows) { return decorate(scope.userId, rows); },
});
