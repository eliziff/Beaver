import { randomUUID } from "node:crypto";
import { z } from "zod";
import { abortChatTurnForDeletion } from "./chatTurns";
import {
  localApplicationDatabase,
  localApplicationTransaction,
} from "./localApplicationDatabase";
import type { ChatTurnCommit } from "./chatStore";

export type AnonymousChatMessage = {
  id: string;
  chat_id: string;
  turn_id?: string;
  role: "user" | "assistant";
  content: unknown;
  files?: unknown;
  workflow?: unknown;
  citations?: unknown;
  created_at: string;
};

export type AnonymousChat = {
  id: string;
  user_id: string;
  project_id: string | null;
  tabular_review_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  transcript_version: number;
  messages: AnonymousChatMessage[];
};

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const messageSchema = z.object({
  id: idSchema,
  chat_id: idSchema,
  turn_id: idSchema.optional(),
  role: z.enum(["user", "assistant"]),
  content: z.unknown(),
  files: z.unknown().optional(),
  workflow: z.unknown().optional(),
  citations: z.unknown().optional(),
  created_at: z.string().datetime(),
}).strict();
const chatSchema = z.object({
  id: idSchema,
  user_id: idSchema,
  project_id: idSchema.nullable(),
  tabular_review_id: idSchema.nullable(),
  title: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  deleted_at: z.string().datetime().nullable(),
  transcript_version: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
}).strict();

type ChatRow = Omit<AnonymousChat, "messages"> & { messages_json: string };
const deletedChatRetentionMs = 30 * 24 * 60 * 60 * 1000;

function validId(value: string) {
  return idSchema.safeParse(value).success;
}

function chatFromRow(row: ChatRow | undefined): AnonymousChat | null {
  if (!row) return null;
  try {
    const { messages_json, ...values } = row;
    const parsed = chatSchema.safeParse({
      ...values,
      messages: JSON.parse(messages_json),
    });
    return parsed.success && parsed.data.messages.every(
      (message) => message.chat_id === parsed.data.id,
    ) ? parsed.data as AnonymousChat : null;
  } catch {
    return null;
  }
}

function readChat(userId: string, chatId: string) {
  if (!validId(userId) || !validId(chatId)) return null;
  return chatFromRow(localApplicationDatabase().prepare(
    `SELECT id,user_id,project_id,tabular_review_id,title,created_at,updated_at,
            deleted_at,transcript_version,messages_json
     FROM local_chats WHERE user_id = ? AND id = ?`,
  ).get(userId, chatId) as ChatRow | undefined);
}

function deletedChatExpired(chat: AnonymousChat, now: Date) {
  return chat.deleted_at !== null &&
    now.getTime() - Date.parse(chat.deleted_at) >= deletedChatRetentionMs;
}

function findLastMessage(
  messages: AnonymousChatMessage[],
  predicate: (message: AnonymousChatMessage) => boolean,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) return index;
  }
  return -1;
}

export class AnonymousChatVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("Anonymous chat transcript version conflict");
    this.name = "AnonymousChatVersionConflictError";
  }
}

export class AnonymousChatDeletedError extends Error {
  constructor() {
    super("Anonymous chat is in the recycling bin");
    this.name = "AnonymousChatDeletedError";
  }
}

function mutateChat(
  chat: AnonymousChat,
  expectedVersion: number | undefined,
  update: (current: AnonymousChat) => AnonymousChat | null,
) {
  const next = localApplicationTransaction((database) => {
    const current = chatFromRow(database.prepare(
      `SELECT id,user_id,project_id,tabular_review_id,title,created_at,updated_at,
              deleted_at,transcript_version,messages_json
       FROM local_chats WHERE user_id = ? AND id = ?`,
    ).get(chat.user_id, chat.id) as ChatRow | undefined);
    if (!current || current.deleted_at !== null) throw new AnonymousChatDeletedError();
    if (expectedVersion !== undefined &&
        current.transcript_version !== expectedVersion) {
      throw new AnonymousChatVersionConflictError(current.transcript_version);
    }
    const value = update(current);
    if (!value) return null;
    const parsed = chatSchema.parse(value);
    const changed = database.prepare(
      `UPDATE local_chats SET project_id=?,tabular_review_id=?,title=?,updated_at=?,
              deleted_at=?,transcript_version=?,messages_json=?
       WHERE user_id=? AND id=? AND transcript_version=?`,
    ).run(
      parsed.project_id, parsed.tabular_review_id, parsed.title,
      parsed.updated_at, parsed.deleted_at, parsed.transcript_version,
      JSON.stringify(parsed.messages), parsed.user_id, parsed.id,
      current.transcript_version,
    ).changes;
    if (!changed) {
      const version = database.prepare(
        "SELECT transcript_version FROM local_chats WHERE user_id=? AND id=?",
      ).get(parsed.user_id, parsed.id) as { transcript_version: number } | undefined;
      throw new AnonymousChatVersionConflictError(version?.transcript_version ?? 0);
    }
    return parsed;
  });
  if (next) Object.assign(chat, next);
  return next;
}

function permanentlyRemove(chat: AnonymousChat) {
  abortChatTurnForDeletion(chat.id);
  return localApplicationTransaction((database) => database.prepare(
    "DELETE FROM local_chats WHERE user_id=? AND id=?",
  ).run(chat.user_id, chat.id).changes > 0);
}

export function createAnonymousChat(
  userId: string,
  projectId: string | null = null,
  tabularReviewId: string | null = null,
): AnonymousChat {
  if (!validId(userId) ||
      (projectId !== null && !validId(projectId)) ||
      (tabularReviewId !== null && !validId(tabularReviewId)) ||
      (projectId !== null && tabularReviewId !== null)) {
    throw new Error("Invalid anonymous chat context");
  }
  const now = new Date().toISOString();
  const chat: AnonymousChat = {
    id: randomUUID(), user_id: userId, project_id: projectId,
    tabular_review_id: tabularReviewId, title: null, created_at: now,
    updated_at: now, deleted_at: null, transcript_version: 0, messages: [],
  };
  localApplicationTransaction((database) => database.prepare(
    `INSERT INTO local_chats
      (id,user_id,project_id,tabular_review_id,title,created_at,updated_at,
       deleted_at,transcript_version,messages_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    chat.id, chat.user_id, chat.project_id, chat.tabular_review_id, chat.title,
    chat.created_at, chat.updated_at, chat.deleted_at, chat.transcript_version,
    "[]",
  ));
  return chat;
}

function listChatsByDeletion(userId: string, deleted: boolean) {
  if (!validId(userId)) return [];
  purgeExpiredAnonymousChats(userId);
  const rows = localApplicationDatabase().prepare(
    `SELECT id,user_id,project_id,tabular_review_id,title,created_at,updated_at,
            deleted_at,transcript_version,messages_json
     FROM local_chats
     WHERE user_id=? AND deleted_at IS ${deleted ? "NOT NULL" : "NULL"}
     ORDER BY ${deleted
       ? "deleted_at DESC, id"
       : "updated_at DESC, created_at DESC, id"}`,
  ).all(userId) as ChatRow[];
  return rows.flatMap((row) => chatFromRow(row) ?? []);
}

export function listAnonymousChats(userId: string) {
  return listChatsByDeletion(userId, false);
}

export function listAnonymousProjectChats(userId: string, projectId: string) {
  if (!validId(projectId)) return [];
  return listAnonymousChats(userId).filter((chat) => chat.project_id === projectId);
}

export function getAnonymousChat(userId: string, chatId: string) {
  const chat = readChat(userId, chatId);
  if (!chat) return null;
  if (deletedChatExpired(chat, new Date())) {
    permanentlyRemove(chat);
    return null;
  }
  return chat.deleted_at === null ? chat : null;
}

export function listDeletedAnonymousChats(userId: string) {
  return listChatsByDeletion(userId, true);
}

export function getDeletedAnonymousChat(userId: string, chatId: string) {
  const chat = readChat(userId, chatId);
  if (!chat || chat.deleted_at === null) return null;
  if (deletedChatExpired(chat, new Date())) {
    permanentlyRemove(chat);
    return null;
  }
  return chat;
}

export function appendAnonymousMessage(
  chat: AnonymousChat,
  message: Omit<AnonymousChatMessage, "id" | "chat_id" | "created_at">,
  expectedVersion?: number,
) {
  let row!: AnonymousChatMessage;
  mutateChat(chat, expectedVersion, (current) => {
    row = { ...message, id: randomUUID(), chat_id: current.id,
      created_at: new Date().toISOString() };
    return { ...current, messages: [...current.messages, row],
      updated_at: row.created_at,
      transcript_version: current.transcript_version + 1 };
  });
  return row;
}

export function commitAnonymousChatTurn(
  chat: AnonymousChat,
  commit: ChatTurnCommit,
) {
  if (!commit.userMessage && !commit.assistantMessage) {
    throw new Error("Chat turn commit is empty");
  }
  return mutateChat(chat, commit.expectedVersion, (current) => {
    const messages = [...current.messages];
    const now = new Date().toISOString();
    if (commit.userMessage) {
      messages.push({
        id: commit.userMessage.id,
        chat_id: current.id,
        ...(commit.userMessage.turnId
          ? { turn_id: commit.userMessage.turnId }
          : {}),
        role: "user",
        content: commit.userMessage.content,
        ...(commit.userMessage.files !== undefined
          ? { files: commit.userMessage.files }
          : {}),
        ...(commit.userMessage.workflow !== undefined
          ? { workflow: commit.userMessage.workflow }
          : {}),
        created_at: now,
      });
    }
    if (commit.assistantMessage) {
      const index = messages.findIndex(
        (message) =>
          message.id === commit.assistantMessage!.id &&
          message.role === "assistant",
      );
      const assistant: AnonymousChatMessage = {
        ...(index >= 0 ? messages[index] : {
          id: commit.assistantMessage.id,
          chat_id: current.id,
          role: "assistant" as const,
          created_at: now,
        }),
        ...(commit.assistantMessage.turnId
          ? { turn_id: commit.assistantMessage.turnId }
          : {}),
        content: commit.assistantMessage.content,
        citations: commit.assistantMessage.citations,
      };
      if (index >= 0) messages[index] = assistant;
      else messages.push(assistant);
    }
    return {
      ...current,
      messages,
      updated_at: now,
      transcript_version: current.transcript_version + 1,
    };
  })!;
}

export function appendAnonymousAssistantEvents(
  chat: AnonymousChat,
  events: unknown[],
  citations?: unknown[],
  expectedVersion?: number,
  turnId?: string,
) {
  return !!mutateChat(chat, expectedVersion, (current) => {
    const index = findLastMessage(current.messages, (message) =>
      message.role === "assistant" && (!turnId || message.turn_id === turnId));
    if (index < 0) return null;
    const message = current.messages[index];
    const messages = [...current.messages];
    messages[index] = { ...message,
      content: [...(Array.isArray(message.content) ? message.content : []), ...events],
      citations: [...(Array.isArray(message.citations) ? message.citations : []),
        ...(citations ?? [])] };
    return { ...current, messages, updated_at: new Date().toISOString(),
      transcript_version: current.transcript_version + 1 };
  });
}

export function appendAnonymousAssistantEvent(
  chat: AnonymousChat,
  messageId: string,
  event: Record<string, unknown>,
) {
  return !!mutateChat(chat, undefined, (current) => {
    const index = current.messages.findIndex(
      (message) => message.id === messageId && message.role === "assistant");
    if (index < 0) return null;
    const message = current.messages[index];
    const messages = [...current.messages];
    messages[index] = { ...message,
      content: [...(Array.isArray(message.content) ? message.content : []), event] };
    return { ...current, messages, updated_at: new Date().toISOString(),
      transcript_version: current.transcript_version + 1 };
  });
}

export function upsertAnonymousSubagentEvent(
  chat: AnonymousChat,
  event: Record<string, unknown> & { type: "subagent_run"; id: string },
  turnId: string,
) {
  return !!mutateChat(chat, undefined, (current) => {
    const index = findLastMessage(current.messages, (message) =>
      message.role === "assistant" && message.turn_id === turnId);
    if (index < 0) {
      const createdAt = new Date().toISOString();
      return { ...current, messages: [...current.messages, {
        id: randomUUID(), chat_id: current.id, turn_id: turnId,
        role: "assistant", content: [event], created_at: createdAt,
      }], updated_at: createdAt,
      transcript_version: current.transcript_version + 1 };
    }
    const message = current.messages[index];
    const content = Array.isArray(message.content) ? [...message.content] : [];
    const eventIndex = content.findIndex((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const candidate = value as Record<string, unknown>;
      return candidate.type === "subagent_run" && candidate.id === event.id;
    });
    if (eventIndex < 0) content.push(event);
    else content[eventIndex] = event;
    const messages = [...current.messages];
    messages[index] = { ...message, content };
    return { ...current, messages, updated_at: new Date().toISOString(),
      transcript_version: current.transcript_version + 1 };
  });
}

export function resetAnonymousAssistantEvents(chat: AnonymousChat, turnId: string) {
  return !!mutateChat(chat, undefined, (current) => {
    const index = findLastMessage(current.messages, (message) =>
      message.role === "assistant" && message.turn_id === turnId);
    if (index < 0) return null;
    const message = current.messages[index];
    const content = Array.isArray(message.content)
      ? message.content.filter((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false;
          const event = value as Record<string, unknown>;
          return event.type === "subagent_run" && event.status === "interrupted" &&
            Boolean(event.resume) && typeof event.resume === "object" &&
            !Array.isArray(event.resume);
        })
      : [];
    const messages = [...current.messages];
    messages[index] = { ...message, content, citations: [] };
    return { ...current, messages, updated_at: new Date().toISOString(),
      transcript_version: current.transcript_version + 1 };
  });
}

export function updateAnonymousChatTitle(chat: AnonymousChat, title: string) {
  mutateChat(chat, undefined, (current) => ({
    ...current, title, updated_at: new Date().toISOString(),
  }));
}

export function updateAnonymousChatProject(chat: AnonymousChat, projectId: string | null) {
  if (projectId !== null && !validId(projectId)) {
    throw new Error("Invalid anonymous chat project ID");
  }
  mutateChat(chat, undefined, (current) => ({
    ...current, project_id: projectId, updated_at: new Date().toISOString(),
  }));
}

export function deleteAnonymousChat(userId: string, chatId: string) {
  const chat = readChat(userId, chatId);
  if (!chat || chat.deleted_at !== null) return false;
  abortChatTurnForDeletion(chat.id);
  const now = new Date().toISOString();
  return !!mutateChat(chat, undefined, (current) => ({
    ...current, deleted_at: now, updated_at: now,
    transcript_version: current.transcript_version + 1,
  }));
}

export function restoreAnonymousChat(userId: string, chatId: string) {
  const chat = readChat(userId, chatId);
  if (!chat || chat.deleted_at === null) return false;
  if (deletedChatExpired(chat, new Date())) {
    permanentlyRemove(chat);
    return false;
  }
  const now = new Date().toISOString();
  const restored = localApplicationTransaction((database) => database.prepare(
    `UPDATE local_chats SET deleted_at=NULL,updated_at=?,transcript_version=transcript_version+1
     WHERE user_id=? AND id=? AND deleted_at IS NOT NULL`,
  ).run(now, userId, chatId).changes > 0);
  return restored;
}

export function permanentlyDeleteAnonymousChat(userId: string, chatId: string) {
  const chat = readChat(userId, chatId);
  return !!chat?.deleted_at && permanentlyRemove(chat);
}

export function purgeExpiredAnonymousChats(userId: string, now = new Date()) {
  if (!validId(userId)) return 0;
  const cutoff = new Date(now.getTime() - deletedChatRetentionMs).toISOString();
  const ids = localApplicationTransaction((database) => {
    const rows = database.prepare(
      "SELECT id FROM local_chats WHERE user_id=? AND deleted_at IS NOT NULL AND deleted_at<=?",
    ).all(userId, cutoff) as { id: string }[];
    database.prepare(
      "DELETE FROM local_chats WHERE user_id=? AND deleted_at IS NOT NULL AND deleted_at<=?",
    ).run(userId, cutoff);
    return rows.map((row) => row.id);
  });
  ids.forEach(abortChatTurnForDeletion);
  return ids.length;
}

export function deleteAnonymousProjectChats(userId: string, projectId: string) {
  const ids = localApplicationTransaction((database) => {
    const rows = database.prepare(
      "SELECT id FROM local_chats WHERE user_id=? AND project_id=?",
    ).all(userId, projectId) as { id: string }[];
    database.prepare("DELETE FROM local_chats WHERE user_id=? AND project_id=?")
      .run(userId, projectId);
    return rows.map((row) => row.id);
  });
  ids.forEach(abortChatTurnForDeletion);
}
