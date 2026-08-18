import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataHome: string;
const owner = "00000000-0000-0000-0000-000000000001";
const otherOwner = "00000000-0000-0000-0000-000000000002";

async function closeDatabase() {
  (await import("../localApplicationDatabase")).closeLocalApplicationDatabase();
}

async function loadStore() {
  return import("../anonymousChatStore");
}

async function reopenStore() {
  await closeDatabase();
  vi.resetModules();
  return loadStore();
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-chat-store-"));
  process.env.MIKE_LOCAL_DATA_DIR = dataHome;
});

afterEach(async () => {
  await closeDatabase();
  delete process.env.MIKE_LOCAL_DATA_DIR;
  vi.useRealTimers();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous chat store", () => {
  it("reopens ordered messages from application.sqlite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    let store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    store.appendAnonymousMessage(chat, { role: "user", content: "Question" });
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    store.appendAnonymousMessage(chat, { role: "assistant", content: "Answer" });

    store = await reopenStore();
    expect(store.getAnonymousChat(owner, chat.id)?.messages).toMatchObject([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
    expect(store.getAnonymousChat(owner, chat.id)?.transcript_version).toBe(2);
  });

  it("atomically rejects two writers at the same transcript version", async () => {
    const store = await loadStore();
    const created = store.createAnonymousChat(owner);
    const first = store.getAnonymousChat(owner, created.id)!;
    const second = store.getAnonymousChat(owner, created.id)!;

    store.appendAnonymousMessage(first, { role: "user", content: "First" }, 0);
    expect(() => store.appendAnonymousMessage(
      second, { role: "user", content: "Duplicate" }, 0,
    )).toThrow(store.AnonymousChatVersionConflictError);
    expect(store.getAnonymousChat(owner, created.id)?.messages).toHaveLength(1);
  });

  it("commits a turn once when the same expected version is retried", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    const messageId = randomUUID();
    const commit = {
      expectedVersion: 0,
      userMessage: {
        id: messageId,
        turnId: randomUUID(),
        content: "One durable question",
      },
    };

    const committed = store.commitAnonymousChatTurn(chat, commit);
    expect(committed.transcript_version).toBe(1);
    expect(() => store.commitAnonymousChatTurn(chat, commit))
      .toThrow(store.AnonymousChatVersionConflictError);
    expect(store.getAnonymousChat(owner, chat.id)).toMatchObject({
      transcript_version: 1,
      messages: [{ id: messageId, role: "user", content: "One durable question" }],
    });
  });

  it("rejects an empty turn without advancing the transcript", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);

    expect(() => store.commitAnonymousChatTurn(chat, { expectedVersion: 0 }))
      .toThrow("Chat turn commit is empty");
    expect(store.getAnonymousChat(owner, chat.id)).toMatchObject({
      transcript_version: 0,
      messages: [],
    });
  });

  it("replaces durable reader progress by run ID and retains checkpoints on reset", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    const turnId = randomUUID();
    store.appendAnonymousMessage(chat, {
      turn_id: turnId, role: "user", content: "Research this",
    });
    store.upsertAnonymousSubagentEvent(chat, {
      type: "subagent_run", id: "agent-1", status: "running",
    }, turnId);
    store.upsertAnonymousSubagentEvent(chat, {
      type: "subagent_run", id: "agent-1", status: "interrupted",
      resume: { continuation_id: randomUUID() },
    }, turnId);
    store.appendAnonymousAssistantEvents(chat, [
      { type: "content", text: "Discard this" },
    ], [], undefined, turnId);

    expect(store.resetAnonymousAssistantEvents(chat, turnId)).toBe(true);
    expect(store.getAnonymousChat(owner, chat.id)?.messages
      .find((message) => message.role === "assistant")?.content).toEqual([
        expect.objectContaining({
          type: "subagent_run", id: "agent-1", status: "interrupted",
        }),
      ]);
  });

  it("orders active chats, persists titles, and isolates owners", async () => {
    vi.useFakeTimers();
    const store = await loadStore();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    const first = store.createAnonymousChat(owner);
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    const second = store.createAnonymousChat(owner);
    vi.setSystemTime("2026-07-26T12:00:02.000Z");
    store.updateAnonymousChatTitle(first, "Updated");

    expect(store.listAnonymousChats(owner).map((chat) => chat.id))
      .toEqual([first.id, second.id]);
    expect(store.getAnonymousChat(owner, first.id)?.title).toBe("Updated");
    expect(store.getAnonymousChat(otherOwner, first.id)).toBeNull();
    expect(store.deleteAnonymousChat(otherOwner, first.id)).toBe(false);
  });

  it("retains provider state in trash and cascades it on permanent delete", async () => {
    const chats = await loadStore();
    const sessions = await import("../anonymousProviderSessionStore");
    const chat = chats.createAnonymousChat(owner);
    sessions.writeAnonymousCodexSession({
      userId: owner, chatId: chat.id, projectId: null,
      continuationId: randomUUID(), compatibilityKey: "a".repeat(64),
      transcriptVersion: 0,
    });

    expect(chats.deleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(sessions.readAnonymousCodexSession(owner, chat.id)).not.toBeNull();
    expect(() => chats.appendAnonymousMessage(chat, {
      role: "user", content: "stale",
    })).toThrow(chats.AnonymousChatDeletedError);
    expect(chats.permanentlyDeleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(sessions.readAnonymousCodexSession(owner, chat.id)).toBeNull();
  });

  it("restores before expiry and purges at exactly thirty days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-01T00:00:00.000Z");
    const store = await loadStore();
    const restored = store.createAnonymousChat(owner);
    store.deleteAnonymousChat(owner, restored.id);
    vi.setSystemTime("2026-07-30T23:59:59.999Z");
    expect(store.restoreAnonymousChat(owner, restored.id)).toBe(true);

    const expired = store.createAnonymousChat(owner);
    store.deleteAnonymousChat(owner, expired.id);
    vi.setSystemTime("2026-08-29T23:59:59.998Z");
    expect(store.purgeExpiredAnonymousChats(owner)).toBe(0);
    vi.setSystemTime("2026-08-29T23:59:59.999Z");
    expect(store.purgeExpiredAnonymousChats(owner)).toBe(1);
    expect(store.getDeletedAnonymousChat(owner, expired.id)).toBeNull();
  });
});
