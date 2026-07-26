import { randomUUID } from "node:crypto";

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

const chats = new Map<string, AnonymousChat>();

export function createAnonymousChat(
  userId: string,
  projectId: string | null = null,
): AnonymousChat {
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
  chats.set(chat.id, chat);
  return chat;
}

export function listAnonymousChats(userId: string): AnonymousChat[] {
  return [...chats.values()]
    .filter((chat) => chat.user_id === userId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function getAnonymousChat(
  userId: string,
  chatId: string,
): AnonymousChat | null {
  const chat = chats.get(chatId);
  return chat?.user_id === userId ? chat : null;
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
  chat.messages.push(row);
  chat.updated_at = row.created_at;
  return row;
}

export function updateAnonymousChatTitle(chat: AnonymousChat, title: string) {
  chat.title = title;
  chat.updated_at = new Date().toISOString();
}

export function deleteAnonymousChat(userId: string, chatId: string): boolean {
  const chat = getAnonymousChat(userId, chatId);
  return chat ? chats.delete(chat.id) : false;
}
