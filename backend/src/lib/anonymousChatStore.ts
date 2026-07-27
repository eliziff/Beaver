import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { legalDataHome } from "./legalDataPath";
import { abortAnonymousTurnForDeletion } from "./anonymousChatTurns";
import { deleteAnonymousProviderSessions } from "./anonymousProviderSessionStore";

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
  title: string | null;
  created_at: string;
  updated_at: string;
  transcript_version: number;
  messages: AnonymousChatMessage[];
};

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const messageSchema = z
  .object({
    id: idSchema,
    chat_id: idSchema,
    turn_id: idSchema.optional(),
    role: z.enum(["user", "assistant"]),
    content: z.unknown(),
    files: z.unknown().optional(),
    workflow: z.unknown().optional(),
    citations: z.unknown().optional(),
    created_at: z.string().datetime(),
  })
  .strict();
const chatSchema = z
  .object({
    id: idSchema,
    user_id: idSchema,
    project_id: idSchema.nullable(),
    title: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    transcript_version: z.number().int().nonnegative(),
    messages: z.array(messageSchema),
  })
  .strict();
const storedChatSchema = z
  .object({ version: z.literal(2), chat: chatSchema })
  .strict();

const chatDirectory = path.join(legalDataHome(), "apps", "mike", "chats");
const chats = new Map<string, AnonymousChat>();

function chatPath(chatId: string) {
  return path.join(chatDirectory, `${chatId}.json`);
}

function validId(value: string) {
  return idSchema.safeParse(value).success;
}

function readChat(userId: string, chatId: string): AnonymousChat | null {
  if (!validId(userId) || !validId(chatId)) return null;
  const cached = chats.get(chatId);
  if (cached) return cached.user_id === userId ? cached : null;

  try {
    const raw = JSON.parse(readFileSync(chatPath(chatId), "utf8"));
    const parsed = storedChatSchema.safeParse(raw);
    const chat = parsed.success ? parsed.data.chat : null;
    if (
      !chat ||
      chat.id !== chatId ||
      chat.user_id !== userId ||
      chat.messages.some((message) => message.chat_id !== chatId)
    ) {
      return null;
    }
    const hydrated = chat as AnonymousChat;
    chats.set(hydrated.id, hydrated);
    return hydrated;
  } catch {
    return null;
  }
}

function writeChat(chat: AnonymousChat) {
  const parsed = storedChatSchema.safeParse({ version: 2, chat });
  if (!parsed.success) throw new Error("Invalid anonymous chat");

  mkdirSync(chatDirectory, { recursive: true });
  const temporaryPath = path.join(
    chatDirectory,
    `.${chat.id}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify({ version: 2, chat }), {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, chatPath(chat.id));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  const canonical = chats.get(chat.id);
  if (canonical && canonical !== chat) {
    Object.assign(canonical, chat);
  } else if (!canonical) {
    chats.set(chat.id, chat);
  }
}

export function createAnonymousChat(
  userId: string,
  projectId: string | null = null,
): AnonymousChat {
  if (!validId(userId) || (projectId !== null && !validId(projectId))) {
    throw new Error("Invalid anonymous chat owner or project ID");
  }
  const now = new Date().toISOString();
  const chat: AnonymousChat = {
    id: randomUUID(),
    user_id: userId,
    project_id: projectId,
    title: null,
    created_at: now,
    updated_at: now,
    transcript_version: 0,
    messages: [],
  };
  writeChat(chat);
  return chat;
}

export function listAnonymousChats(userId: string): AnonymousChat[] {
  if (!validId(userId)) return [];
  let chatIds: string[];
  try {
    chatIds = readdirSync(chatDirectory)
      .filter((filename) => filename.endsWith(".json"))
      .map((filename) => filename.slice(0, -5))
      .filter(validId);
  } catch {
    return [];
  }
  return chatIds
    .map((chatId) => readChat(userId, chatId))
    .filter((chat): chat is AnonymousChat => chat !== null)
    .sort(
      (a, b) =>
        b.updated_at.localeCompare(a.updated_at) ||
        b.created_at.localeCompare(a.created_at) ||
        a.id.localeCompare(b.id),
    );
}

export function listAnonymousProjectChats(
  userId: string,
  projectId: string,
): AnonymousChat[] {
  if (!validId(projectId)) return [];
  return listAnonymousChats(userId).filter(
    (chat) => chat.project_id === projectId,
  );
}

export function getAnonymousChat(
  userId: string,
  chatId: string,
): AnonymousChat | null {
  return readChat(userId, chatId);
}

export function appendAnonymousMessage(
  chat: AnonymousChat,
  message: Omit<AnonymousChatMessage, "id" | "chat_id" | "created_at">,
  expectedVersion?: number,
) {
  const currentChat = assertTranscriptVersion(chat, expectedVersion);
  const row: AnonymousChatMessage = {
    ...message,
    id: randomUUID(),
    chat_id: currentChat.id,
    created_at: new Date().toISOString(),
  };
  const next = {
    ...currentChat,
    messages: [...currentChat.messages, row],
    updated_at: row.created_at,
    transcript_version: currentChat.transcript_version + 1,
  };
  writeChat(next);
  Object.assign(currentChat, next);
  if (chat !== currentChat) Object.assign(chat, next);
  return row;
}

export function appendAnonymousAssistantEvents(
  chat: AnonymousChat,
  events: unknown[],
  citations?: unknown[],
  expectedVersion?: number,
  turnId?: string,
) {
  const currentChat = assertTranscriptVersion(chat, expectedVersion);
  let index = -1;
  for (
    let current = currentChat.messages.length - 1;
    current >= 0;
    current -= 1
  ) {
    if (
      currentChat.messages[current].role === "assistant" &&
      (!turnId || currentChat.messages[current].turn_id === turnId)
    ) {
      index = current;
      break;
    }
  }
  if (index < 0) return false;

  const current = currentChat.messages[index];
  const nextMessage = {
    ...current,
    content: [
      ...(Array.isArray(current.content) ? current.content : []),
      ...events,
    ],
    citations: [
      ...(Array.isArray(current.citations) ? current.citations : []),
      ...(citations ?? []),
    ],
  };
  const next = {
    ...currentChat,
    messages: currentChat.messages.map((message, currentIndex) =>
      currentIndex === index ? nextMessage : message,
    ),
    updated_at: new Date().toISOString(),
    transcript_version: currentChat.transcript_version + 1,
  };
  writeChat(next);
  Object.assign(currentChat, next);
  if (chat !== currentChat) Object.assign(chat, next);
  return true;
}

export function resetAnonymousAssistantEvents(
  chat: AnonymousChat,
  turnId: string,
) {
  const currentChat = assertTranscriptVersion(chat, undefined);
  let index = -1;
  for (
    let current = currentChat.messages.length - 1;
    current >= 0;
    current -= 1
  ) {
    const message = currentChat.messages[current];
    if (message.role === "assistant" && message.turn_id === turnId) {
      index = current;
      break;
    }
  }
  if (index < 0) return false;
  const next = {
    ...currentChat,
    messages: currentChat.messages.map((message, currentIndex) =>
      currentIndex === index
        ? { ...message, content: [], citations: [] }
        : message,
    ),
    updated_at: new Date().toISOString(),
    transcript_version: currentChat.transcript_version + 1,
  };
  writeChat(next);
  Object.assign(currentChat, next);
  if (chat !== currentChat) Object.assign(chat, next);
  return true;
}

export class AnonymousChatVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("Anonymous chat transcript version conflict");
    this.name = "AnonymousChatVersionConflictError";
  }
}

function assertTranscriptVersion(
  chat: AnonymousChat,
  expectedVersion: number | undefined,
) {
  const current = chats.get(chat.id) ?? chat;
  if (
    expectedVersion !== undefined &&
    current.transcript_version !== expectedVersion
  ) {
    throw new AnonymousChatVersionConflictError(current.transcript_version);
  }
  return current;
}

export function updateAnonymousChatTitle(chat: AnonymousChat, title: string) {
  const current = chats.get(chat.id) ?? chat;
  const next = {
    ...current,
    title,
    updated_at: new Date().toISOString(),
  };
  writeChat(next);
  Object.assign(current, next);
  if (chat !== current) Object.assign(chat, next);
}

export function deleteAnonymousChat(userId: string, chatId: string): boolean {
  const chat = getAnonymousChat(userId, chatId);
  if (!chat) return false;
  abortAnonymousTurnForDeletion(chat.id);
  rmSync(chatPath(chat.id), { force: true });
  deleteAnonymousProviderSessions(chat.id);
  chats.delete(chat.id);
  return true;
}

export function deleteAnonymousProjectChats(
  userId: string,
  projectId: string,
) {
  for (const chat of listAnonymousProjectChats(userId, projectId)) {
    abortAnonymousTurnForDeletion(chat.id);
    rmSync(chatPath(chat.id), { force: true });
    deleteAnonymousProviderSessions(chat.id);
    chats.delete(chat.id);
  }
}
