import type { TabularStore } from "./tabularStore";
import { visibleChatMessages } from "./chat/chatTranscript";
import { abortChatTurnForDeletion } from "./chatTurns";

export type ChatScope = { userId: string; userEmail?: string };
export type ChatRecord = Record<string, unknown> & {
  id: string; user_id: string; project_id: string | null;
  tabular_review_id: string | null; title: string | null; transcript_version: number; };
export type ChatMessageRecord = Record<string, unknown> & {
  id: string; chat_id: string; turn_id?: string; role: "user" | "assistant";
  content: unknown; files?: unknown; workflow?: unknown; citations?: unknown;
};

export type ChatCommitResult =
  | { status: "missing" }
  | { status: "conflict"; currentVersion: number }
  | { status: "committed"; currentVersion: number };

export type ChatTurnCommit = {
  expectedVersion: number;
  userMessage?: {
    id: string; turnId?: string; content: string; files?: unknown; workflow?: unknown;
  };
  assistantMessage?: {
    id: string; turnId?: string; content: unknown[]; citations?: unknown[];
  };
};

export class ChatStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type ChatListOptions = { projectId?: string; tabularReviewId?: string; limit?: number };
export type ChatCreateInput = { projectId: string | null; tabularReviewId: string | null };
export type ChatUpdateInput = { title?: string; projectId?: string | null };
export type ChatDetail = { chat: ChatRecord; messages: ChatMessageRecord[] };
export type ChatStore = {
  list(scope: ChatScope, options: ChatListOptions): Promise<ChatRecord[]>;
  deleted(scope: ChatScope): Promise<ChatRecord[]>;
  create(scope: ChatScope, input: ChatCreateInput): Promise<ChatRecord>;
  get(scope: ChatScope, chatId: string): Promise<ChatRecord | null>;
  detail(scope: ChatScope, chatId: string): Promise<ChatDetail | null>;
  transcript(scope: ChatScope, chatId: string): Promise<ChatMessageRecord[] | null>;
  commitTurn(scope: ChatScope, chatId: string, commit: ChatTurnCommit): Promise<ChatCommitResult>;
  appendAssistantEvent(scope: ChatScope, chatId: string, messageId: string,
    event: Record<string, unknown>): Promise<ChatCommitResult>;
  update(scope: ChatScope, chatId: string, input: ChatUpdateInput): Promise<ChatRecord | null>;
  trash(scope: ChatScope, chatId: string): Promise<boolean>;
  restore(scope: ChatScope, chatId: string): Promise<boolean>;
  remove(scope: ChatScope, chatId: string): Promise<boolean>;
  generateTitle(scope: ChatScope, chatId: string, message: string): Promise<string | null>;
};

export type CreateChatStore = (tabular: TabularStore) => ChatStore;

export type ChatMutation = { kind: "turn"; turn: ChatTurnCommit }
  | { kind: "append"; messageId: string; event: Record<string, unknown> };

export type ChatRepository = {
  context(kind: "project" | "review", id: string): Promise<boolean>;
  list(options: ChatListOptions): Promise<ChatRecord[]>;
  deleted(): Promise<ChatRecord[]>;
  purge(cutoff: string): Promise<string[]>;
  create(input: ChatCreateInput): Promise<ChatRecord>;
  read(chatId: string, messages?: boolean, deleted?: boolean): Promise<ChatDetail | null>;
  owns(chatId: string): Promise<boolean>;
  commit(chatId: string, mutation: ChatMutation): Promise<ChatCommitResult>;
  update(chatId: string, input: ChatUpdateInput): Promise<ChatRecord | null>;
  trash(chatId: string, at: string): Promise<boolean>;
  restore(chatId: string, cutoff: string, at: string): Promise<boolean>;
  remove(chatId: string): Promise<boolean>;
  decorate(messages: ChatMessageRecord[]): Promise<ChatMessageRecord[]>;
};

export type CreateChatRepository = (scope: ChatScope) => ChatRepository;
type GenerateChatTitle = (scope: ChatScope, message: string) => Promise<string>;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const missing = (detail: string) => new ChatStoreError(404, detail);

async function requireContext(repository: ChatRepository, input: {
  projectId?: string | null; tabularReviewId?: string | null;
}) {
  if (input.projectId && !await repository.context("project", input.projectId))
    throw missing("Project not found");
  if (input.tabularReviewId && !await repository.context("review", input.tabularReviewId))
    throw missing("Review not found");
}

const retentionCutoff = () => new Date(Date.now() - RETENTION_MS).toISOString();
async function purge(repository: ChatRepository) {
  (await repository.purge(retentionCutoff())).forEach(abortChatTurnForDeletion);
}

export function createChatStore(repositoryFor: CreateChatRepository,
  generate: GenerateChatTitle): ChatStore {
  return {
    async list(scope, options) {
      const repository = repositoryFor(scope);
      await requireContext(repository, options); await purge(repository);
      return repository.list(options);
    },
    async deleted(scope) {
      const repository = repositoryFor(scope); await purge(repository);
      return repository.deleted();
    },
    async create(scope, input) {
      const repository = repositoryFor(scope); await requireContext(repository, input);
      return repository.create(input);
    },
    async get(scope, chatId) { return (await repositoryFor(scope).read(chatId))?.chat ?? null; },
    async detail(scope, chatId) {
      const repository = repositoryFor(scope), detail = await repository.read(chatId, true);
      return detail && { chat: detail.chat,
        messages: visibleChatMessages(await repository.decorate(detail.messages)) };
    },
    async transcript(scope, chatId) {
      return (await repositoryFor(scope).read(chatId, true))?.messages ?? null; },
    async commitTurn(scope, chatId, turn) {
      if (!turn.userMessage && !turn.assistantMessage)
        throw new Error("Chat turn commit is empty");
      return repositoryFor(scope).commit(chatId, { kind: "turn", turn });
    },
    async appendAssistantEvent(scope, chatId, messageId, event) {
      return repositoryFor(scope).commit(chatId, { kind: "append", messageId, event }); },
    async update(scope, chatId, input) {
      const repository = repositoryFor(scope);
      await requireContext(repository, { projectId: input.projectId });
      return repository.update(chatId, input);
    },
    async trash(scope, chatId) {
      const removed = await repositoryFor(scope).trash(chatId, new Date().toISOString());
      if (removed) abortChatTurnForDeletion(chatId); return removed;
    },
    async restore(scope, chatId) {
      const repository = repositoryFor(scope), cutoff = retentionCutoff();
      await purge(repository);
      return repository.restore(chatId, cutoff, new Date().toISOString());
    },
    async remove(scope, chatId) {
      const removed = await repositoryFor(scope).remove(chatId);
      if (removed) abortChatTurnForDeletion(chatId); return removed;
    },
    async generateTitle(scope, chatId, message) {
      const repository = repositoryFor(scope);
      if (!await repository.owns(chatId)) return null;
      const title = normalizeChatTitle(await generate(scope, message));
      return await repository.update(chatId, { title }) ? title : null;
    },
  };
}

export function normalizeChatTitle(raw: string) {
  const title = raw.trim().replace(/^["'`]+|["'`.,:;!?]+$/gu, "").trim();
  return (title || "Misc. Query").slice(0, 80);
}

export function patchChatEditEvents(messages: ChatMessageRecord[], statuses:
  Iterable<readonly [string, "pending" | "accepted" | "rejected"]>,
  versions: Iterable<readonly [string, number | null]>) {
  const statusById = new Map(statuses);
  const versionById = new Map(versions);
  const patch = (row: Record<string, unknown>) => {
    const versionId = typeof row.version_id === "string" ? row.version_id : null;
    const editId = typeof row.edit_id === "string" ? row.edit_id : null;
    return { ...row,
      ...(versionId && versionById.has(versionId)
        ? { version_number: versionById.get(versionId) ?? null } : {}),
      ...(editId && statusById.has(editId) ? { status: statusById.get(editId) } : {}) };
  };
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((event) => {
          const row = event as Record<string, unknown>;
          if (row.type !== "doc_edited") return event;
          return { ...patch(row), annotations: Array.isArray(row.annotations)
            ? row.annotations.map((annotation) =>
                patch(annotation as Record<string, unknown>)) : row.annotations };
        })
      : message.content,
  }));
}
