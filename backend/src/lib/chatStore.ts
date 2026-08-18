import type { TabularStore } from "./tabularStore";

export type ChatScope = { userId: string; userEmail?: string };
export type ChatRecord = Record<string, unknown> & {
  id: string;
  user_id: string;
  project_id: string | null;
  tabular_review_id: string | null;
  title: string | null;
  transcript_version: number;
};
export type ChatMessageRecord = Record<string, unknown> & {
  id: string;
  chat_id: string;
  turn_id?: string;
  role: "user" | "assistant";
  content: unknown;
  files?: unknown;
  workflow?: unknown;
  citations?: unknown;
};

export type ChatCommitResult =
  | { status: "missing" }
  | { status: "conflict"; currentVersion: number }
  | { status: "committed"; currentVersion: number };

export type ChatTurnCommit = {
  expectedVersion: number;
  userMessage?: {
    id: string;
    turnId?: string;
    content: string;
    files?: unknown;
    workflow?: unknown;
  };
  assistantMessage?: {
    id: string;
    turnId?: string;
    content: unknown[];
    citations?: unknown[];
  };
};

export class ChatStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type ChatStore = {
  list(scope: ChatScope, options: {
    projectId?: string;
    tabularReviewId?: string;
    limit?: number;
  }): Promise<ChatRecord[]>;
  deleted(scope: ChatScope): Promise<ChatRecord[]>;
  create(scope: ChatScope, input: {
    projectId: string | null;
    tabularReviewId: string | null;
  }): Promise<ChatRecord>;
  get(scope: ChatScope, chatId: string): Promise<ChatRecord | null>;
  detail(scope: ChatScope, chatId: string): Promise<{
    chat: ChatRecord;
    messages: ChatMessageRecord[];
  } | null>;
  /** Canonical rows, including provider-only checkpoint events. */
  transcript(scope: ChatScope, chatId: string): Promise<ChatMessageRecord[] | null>;
  /** Atomically compare the transcript version, write a turn snapshot, and advance it. */
  commitTurn(
    scope: ChatScope,
    chatId: string,
    commit: ChatTurnCommit,
  ): Promise<ChatCommitResult>;
  appendAssistantEvent(
    scope: ChatScope,
    chatId: string,
    messageId: string,
    event: Record<string, unknown>,
  ): Promise<ChatCommitResult>;
  update(scope: ChatScope, chatId: string, input: {
    title?: string;
    projectId?: string | null;
  }): Promise<ChatRecord | null>;
  trash(scope: ChatScope, chatId: string): Promise<boolean>;
  restore(scope: ChatScope, chatId: string): Promise<boolean>;
  remove(scope: ChatScope, chatId: string): Promise<boolean>;
  generateTitle(scope: ChatScope, chatId: string,
    message: string): Promise<string | null>;
};

export type CreateChatStore = (tabular: TabularStore) => ChatStore;

export function normalizeChatTitle(raw: string) {
  const title = raw.trim().replace(/^["'`]+|["'`.,:;!?]+$/gu, "").trim();
  return (title || "Misc. Query").slice(0, 80);
}

export function patchChatEditEvents(
  messages: ChatMessageRecord[],
  statuses: Iterable<readonly [string, "pending" | "accepted" | "rejected"]>,
  versions: Iterable<readonly [string, number | null]>,
) {
  const statusById = new Map(statuses);
  const versionById = new Map(versions);
  const patch = (row: Record<string, unknown>) => {
    const version = typeof row.version_id === "string" &&
      versionById.has(row.version_id)
      ? { version_number: versionById.get(row.version_id) ?? null } : {};
    return typeof row.edit_id === "string" && statusById.has(row.edit_id)
      ? { ...row, ...version, status: statusById.get(row.edit_id) }
      : { ...row, ...version };
  };
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((event) => {
          const row = event as Record<string, unknown>;
          return row.type === "doc_edited"
            ? { ...patch(row), annotations: Array.isArray(row.annotations)
                ? row.annotations.map((annotation) =>
                    patch(annotation as Record<string, unknown>))
                : row.annotations }
            : event;
        })
      : message.content,
  }));
}
