import {
  appendAnonymousAssistantEvent,
  createAnonymousChat,
  deleteAnonymousChat,
  getAnonymousChat,
  listAnonymousChats,
  listDeletedAnonymousChats,
  permanentlyDeleteAnonymousChat,
  restoreAnonymousChat,
  updateAnonymousChatProject,
  updateAnonymousChatTitle,
  type AnonymousChat,
} from "./anonymousChatStore";
import {
  ChatStoreError,
  normalizeChatTitle,
  patchChatEditEvents,
  type ChatMessageRecord,
  type ChatRecord,
  type CreateChatStore,
} from "./chatStore";
import { legalKnowledgeGraphStore } from "./legalKnowledgeGraphStore";
import { localTrackedEditStatuses } from "./localDocumentStore";
import { visibleAnonymousMessages } from "./chat/anonymousTranscript";

const missing = (detail: string) => new ChatStoreError(404, detail);
const record = ({ messages: _messages, ...chat }: AnonymousChat) =>
  chat as ChatRecord;

async function messages(chat: AnonymousChat) {
  const documentIds = new Set<string>();
  for (const message of chat.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const event of message.content as Record<string, unknown>[]) {
      if (event.type === "doc_edited" && typeof event.document_id === "string") {
        documentIds.add(event.document_id);
      }
    }
  }
  const rows = documentIds.size
    ? await localTrackedEditStatuses(chat.user_id, documentIds) : [];
  return patchChatEditEvents(
    visibleAnonymousMessages(chat.messages) as ChatMessageRecord[],
    rows.map((row) => [row.editId, row.status] as const),
    rows.map((row) => [row.versionId, row.versionNumber] as const),
  );
}

export const createLocalChatStore: CreateChatStore = (tabular) => ({
  async list(scope, options) {
    if (options.projectId && !legalKnowledgeGraphStore()
        .getMatter(scope.userId, options.projectId)) throw missing("Project not found");
    if (options.tabularReviewId && !await tabular.detail(
      scope, options.tabularReviewId,
    )) throw missing("Review not found");
    const rows = listAnonymousChats(scope.userId)
      .filter((chat) => options.projectId
        ? chat.project_id === options.projectId
        : options.tabularReviewId
          ? chat.tabular_review_id === options.tabularReviewId
          : chat.project_id === null && chat.tabular_review_id === null);
    return (options.limit ? rows.slice(0, options.limit) : rows)
      .map((chat) => ({ ...record(chat),
        ...(options.projectId ? { creator_display_name: null } : {}) }));
  },

  async deleted(scope) {
    return listDeletedAnonymousChats(scope.userId).map(record);
  },

  async create(scope, input) {
    if (input.projectId && !legalKnowledgeGraphStore()
        .getMatter(scope.userId, input.projectId)) throw missing("Project not found");
    if (input.tabularReviewId && !await tabular.detail(
      scope, input.tabularReviewId,
    )) throw missing("Review not found");
    return record(createAnonymousChat(
      scope.userId, input.projectId, input.tabularReviewId,
    ));
  },

  async get(scope, chatId) {
    const chat = getAnonymousChat(scope.userId, chatId);
    return chat ? record(chat) : null;
  },

  async detail(scope, chatId) {
    const chat = getAnonymousChat(scope.userId, chatId);
    return chat ? { chat: record(chat), messages: await messages(chat) } : null;
  },

  async transcript(scope, chatId) {
    return getAnonymousChat(scope.userId, chatId)?.messages ?? null;
  },

  async appendAssistantEvent(scope, chatId, messageId, event) {
    const chat = getAnonymousChat(scope.userId, chatId);
    return chat ? appendAnonymousAssistantEvent(chat, messageId, event) : false;
  },

  async update(scope, chatId, input) {
    const chat = getAnonymousChat(scope.userId, chatId);
    if (!chat) return null;
    if (input.projectId && !legalKnowledgeGraphStore()
        .getMatter(scope.userId, input.projectId)) throw missing("Project not found");
    if (input.title !== undefined) updateAnonymousChatTitle(chat, input.title);
    if (input.projectId !== undefined) updateAnonymousChatProject(chat, input.projectId);
    return record(chat);
  },

  async trash(scope, chatId) {
    return deleteAnonymousChat(scope.userId, chatId);
  },
  async restore(scope, chatId) {
    return restoreAnonymousChat(scope.userId, chatId);
  },
  async remove(scope, chatId) {
    return permanentlyDeleteAnonymousChat(scope.userId, chatId);
  },

  async generateTitle(scope, chatId, message) {
    const chat = getAnonymousChat(scope.userId, chatId);
    if (!chat) return null;
    const title = normalizeChatTitle(message);
    updateAnonymousChatTitle(chat, title);
    return title;
  },
});
