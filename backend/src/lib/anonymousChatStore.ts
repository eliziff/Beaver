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

export type AnonymousChatMessage = {
  id: string;
  chat_id: string;
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
  messages: AnonymousChatMessage[];
};

const idSchema = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu);
const messageSchema = z
  .object({
    id: idSchema,
    chat_id: idSchema,
    role: z.enum(["user", "assistant"]),
    content: z.unknown(),
    files: z.unknown().optional(),
    workflow: z.unknown().optional(),
    citations: z.unknown().optional(),
    created_at: z.string().datetime(),
  })
  .strict();
const storedChatSchema = z
  .object({
    version: z.literal(1),
    chat: z
      .object({
        id: idSchema,
        user_id: idSchema,
        project_id: idSchema.nullable(),
        title: z.string().nullable(),
        created_at: z.string().datetime(),
        updated_at: z.string().datetime(),
        messages: z.array(messageSchema),
      })
      .strict(),
  })
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
    const parsed = storedChatSchema.safeParse(
      JSON.parse(readFileSync(chatPath(chatId), "utf8")),
    );
    if (
      !parsed.success ||
      parsed.data.chat.id !== chatId ||
      parsed.data.chat.user_id !== userId ||
      parsed.data.chat.messages.some((message) => message.chat_id !== chatId)
    ) {
      return null;
    }
    const chat = parsed.data.chat as AnonymousChat;
    chats.set(chat.id, chat);
    return chat;
  } catch {
    return null;
  }
}

function writeChat(chat: AnonymousChat) {
  const parsed = storedChatSchema.safeParse({ version: 1, chat });
  if (!parsed.success) throw new Error("Invalid anonymous chat");

  mkdirSync(chatDirectory, { recursive: true });
  const temporaryPath = path.join(
    chatDirectory,
    `.${chat.id}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporaryPath, JSON.stringify({ version: 1, chat }), {
      encoding: "utf8",
      flag: "wx",
    });
    renameSync(temporaryPath, chatPath(chat.id));
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  chats.set(chat.id, chat);
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

export function getAnonymousChat(
  userId: string,
  chatId: string,
): AnonymousChat | null {
  return readChat(userId, chatId);
}

export function appendAnonymousMessage(
  chat: AnonymousChat,
  message: Omit<AnonymousChatMessage, "id" | "chat_id" | "created_at">,
) {
  const row: AnonymousChatMessage = {
    ...message,
    id: randomUUID(),
    chat_id: chat.id,
    created_at: new Date().toISOString(),
  };
  const next = {
    ...chat,
    messages: [...chat.messages, row],
    updated_at: row.created_at,
  };
  writeChat(next);
  Object.assign(chat, next);
  return row;
}

export function updateAnonymousChatTitle(chat: AnonymousChat, title: string) {
  const next = {
    ...chat,
    title,
    updated_at: new Date().toISOString(),
  };
  writeChat(next);
  Object.assign(chat, next);
}

export function deleteAnonymousChat(userId: string, chatId: string): boolean {
  const chat = getAnonymousChat(userId, chatId);
  if (!chat) return false;
  rmSync(chatPath(chat.id), { force: true });
  chats.delete(chat.id);
  return true;
}
