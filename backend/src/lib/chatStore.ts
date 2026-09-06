import { visibleChatMessages, type VisibleChatMessage } from "./chat/chatTranscript";
import type { AssistantEvent } from "./chat/assistantEvents";
import { abortChatTurnForDeletion } from "./chatTurns";
import type { ResearchSelection } from "./researchSelection";

export type ChatScope = { userId: string; userEmail?: string };
export type ChatRecord = Record<string, unknown> & {
  id: string; user_id: string; project_id: string | null;
  tabular_review_id: string | null; research_file_id?: string | null;
  research_selection?: ResearchSelection | null; title: string | null;
  model: string | null; reasoning_effort: string | null;
  transcript_version: number;
  search_hit?: { message_id: string | null; snippet: string }; };
export type ChatMessageRecord = Record<string, unknown> & {
  id: string; chat_id: string; turn_id?: string; role: "user" | "assistant";
  content: string | AssistantEvent[]; files?: unknown; workflow?: unknown; citations?: unknown;
};

export type ChatCommitResult = { status: "missing" }
  | { status: "conflict"; currentVersion: number }
  | { status: "committed"; currentVersion: number };

export type ChatTurnCommit = { expectedVersion: number;
  userMessage?: { id: string; turnId?: string; content: string; files?: unknown; workflow?: unknown };
  assistantMessage?: { id: string; turnId?: string; content: AssistantEvent[]; citations?: unknown[] } };

export class ChatStoreError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export type ChatListOptions = { projectId?: string; tabularReviewId?: string; limit?: number; offset?: number;
  search?: string; searchScope?: "all" | "titles" | "transcripts";
  searchContext?: "assistant" | "reviews" | "all";
  createdFrom?: string; createdTo?: string; sort?: "newest" | "oldest" };
export type ChatCreateInput = { projectId: string | null; tabularReviewId: string | null;
  researchFileId?: string | null; researchSelection?: ResearchSelection | null };
export type ChatUpdateInput = {
  draft?: Record<string, unknown> | null;
  title?: string;
  projectId?: string | null;
  researchFileId?: string | null;
  researchSelection?: ResearchSelection | null;
  model?: string | null;
  reasoningEffort?: string | null;
};
export type ChatDetail = { chat: ChatRecord; messages: ChatMessageRecord[] };
export type ChatStore = {
  list(scope: ChatScope, options: ChatListOptions): Promise<ChatRecord[]>; deleted(scope: ChatScope): Promise<ChatRecord[]>;
  create(scope: ChatScope, input: ChatCreateInput): Promise<ChatRecord>; get(scope: ChatScope, id: string): Promise<ChatRecord | null>;
  detail(scope: ChatScope, id: string): Promise<{ chat: ChatRecord; messages: VisibleChatMessage[] } | null>;
  transcript(scope: ChatScope, id: string): Promise<ChatMessageRecord[] | null>;
  commitTurn(scope: ChatScope, id: string, commit: ChatTurnCommit): Promise<ChatCommitResult>;
  appendAssistantEvent(scope: ChatScope, id: string, messageId: string, event: AssistantEvent): Promise<ChatCommitResult>;
  update(scope: ChatScope, id: string, input: ChatUpdateInput): Promise<ChatRecord | null>;
  trash(scope: ChatScope, id: string): Promise<boolean>; restore(scope: ChatScope, id: string): Promise<boolean>;
  remove(scope: ChatScope, id: string): Promise<boolean>; deleteAll(scope: ChatScope): Promise<number>;
  generateTitle(scope: ChatScope, id: string, message: string): Promise<string | null>;
};

export type ChatMutation = { kind: "turn"; turn: ChatTurnCommit }
  | { kind: "append"; messageId: string; event: AssistantEvent };

export type ChatRepository = {
  list(options: ChatListOptions): Promise<ChatRecord[]>; deleted(): Promise<ChatRecord[]>;
  purge(cutoff: string): Promise<string[]>; create(input: ChatCreateInput): Promise<ChatRecord>;
  read(chatId: string, messages?: boolean, deleted?: boolean): Promise<ChatDetail | null>;
  owns(chatId: string): Promise<boolean>; commit(chatId: string, mutation: ChatMutation): Promise<ChatCommitResult>;
  update(chatId: string, input: ChatUpdateInput): Promise<ChatRecord | null>;
  trash(chatId: string, at: string): Promise<boolean>; restore(chatId: string, cutoff: string, at: string): Promise<boolean>;
  remove(chatId: string): Promise<boolean>; removeAll(): Promise<string[]>;
  decorate(messages: ChatMessageRecord[]): Promise<ChatMessageRecord[]>;
};

export type CreateChatRepository = (scope: ChatScope) => ChatRepository;
type GenerateChatTitle = (scope: ChatScope, message: string) => Promise<string>;
export type ChatContexts = { project(scope: ChatScope, id: string): Promise<boolean>;
  review(scope: ChatScope, id: string): Promise<boolean>;
  research?(scope: ChatScope, id: string): Promise<boolean> };

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const missing = (detail: string) => new ChatStoreError(404, detail);

async function requireContext(contexts: ChatContexts, scope: ChatScope, input: {
  projectId?: string | null; tabularReviewId?: string | null; researchFileId?: string | null;
}) {
  if (input.projectId && !await contexts.project(scope, input.projectId))
    throw missing("Project not found");
  if (input.tabularReviewId && !await contexts.review(scope, input.tabularReviewId))
    throw missing("Review not found");
  if (input.researchFileId && !await contexts.research?.(scope, input.researchFileId))
    throw missing("Research workspace not found");
}

const retentionCutoff = () => new Date(Date.now() - RETENTION_MS).toISOString();
export function createChatStore(repositoryFor: CreateChatRepository,
  generate: GenerateChatTitle, contexts: ChatContexts,
  cancel?: (scope: ChatScope, chatId: string) => Promise<unknown>): ChatStore {
  const abort = async (scope: ChatScope, chatId: string) => {
    abortChatTurnForDeletion(chatId);
    await cancel?.(scope, chatId);
  };
  const purge = async (scope: ChatScope, repository: ChatRepository) =>
    await Promise.all((await repository.purge(retentionCutoff())).map((id) => abort(scope, id)));
  return {
    async list(scope, options) {
      const repository = repositoryFor(scope);
      await requireContext(contexts, scope, options); await purge(scope, repository);
      return repository.list(options);
    },
    async deleted(scope) {
      const repository = repositoryFor(scope); await purge(scope, repository);
      return repository.deleted();
    },
    async create(scope, input) {
      const repository = repositoryFor(scope); await requireContext(contexts, scope, input);
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
      await requireContext(contexts, scope, input);
      return repository.update(chatId, input);
    },
    async trash(scope, chatId) {
      const removed = await repositoryFor(scope).trash(chatId, new Date().toISOString());
      if (removed) await abort(scope, chatId); return removed;
    },
    async restore(scope, chatId) {
      const repository = repositoryFor(scope), cutoff = retentionCutoff();
      await purge(scope, repository);
      return repository.restore(chatId, cutoff, new Date().toISOString());
    },
    async remove(scope, chatId) {
      const removed = await repositoryFor(scope).remove(chatId);
      if (removed) await abort(scope, chatId); return removed;
    },
    async deleteAll(scope) {
      const ids = await repositoryFor(scope).removeAll();
      await Promise.all(ids.map((id) => abort(scope, id))); return ids.length;
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
  const patch = <T extends { version_id: string; edit_id?: string }>(row: T) => {
    const versionId = row.version_id, editId = row.edit_id;
    return { ...row,
      ...(versionId && versionById.has(versionId)
        ? { version_number: versionById.get(versionId) ?? null } : {}),
      ...(editId && statusById.has(editId) ? { status: statusById.get(editId) } : {}) };
  };
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((event) => {
          if (event.type !== "document_artifact" || event.action !== "edited") return event;
          return { ...patch(event), annotations: event.annotations?.map(patch) };
        })
      : message.content,
  }));
}
