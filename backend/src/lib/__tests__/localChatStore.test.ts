import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataHome: string;
const owner = "00000000-0000-0000-0000-000000000001";
const otherOwner = "00000000-0000-0000-0000-000000000002";
const scope = (userId = owner) => ({ userId });

async function closeDatabase() {
  (await import("../sqliteDatabase")).closeSqliteDatabase();
}

async function loadStore() {
  const [{ createChatStore }, { sqliteChatRepository }, { generateChatTitle }] = await Promise.all([
    import("../chatStore"), import("../sqliteChatRepository"), import("../chatTitle"),
  ]);
  return createChatStore(sqliteChatRepository, generateChatTitle, {
    project: async () => false, review: async () => false,
  });
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

describe("local chat store", () => {
  it("reopens ordered messages from application.sqlite", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    let store = await loadStore();
    const chat = await store.create(scope(), { projectId: null, tabularReviewId: null });
    await store.commitTurn(scope(), chat.id, {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "Question" },
    });
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    await store.commitTurn(scope(), chat.id, {
      expectedVersion: 1,
      assistantMessage: {
        id: randomUUID(),
        content: [{ type: "content", text: "Answer" }],
      },
    });

    store = await reopenStore();
    expect(await store.transcript(scope(), chat.id)).toMatchObject([
      { role: "user", content: "Question" },
      { role: "assistant", content: [{ type: "content", text: "Answer" }] },
    ]);
    expect(await store.get(scope(), chat.id)).toMatchObject({ transcript_version: 2 });
  });

  it("atomically rejects two writers at the same transcript version", async () => {
    const store = await loadStore();
    const chat = await store.create(scope(), { projectId: null, tabularReviewId: null });
    const commit = (content: string) => store.commitTurn(scope(), chat.id, {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), content },
    });

    await expect(commit("First")).resolves.toMatchObject({ status: "committed" });
    await expect(commit("Duplicate")).resolves.toMatchObject({
      status: "conflict", currentVersion: 1,
    });
    await expect(store.transcript(scope(), chat.id)).resolves.toHaveLength(1);
  });

  it("commits a turn once and rejects empty commits", async () => {
    const store = await loadStore();
    const chat = await store.create(scope(), { projectId: null, tabularReviewId: null });
    const commit = {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), turnId: randomUUID(), content: "One question" },
    };

    await expect(store.commitTurn(scope(), chat.id, commit)).resolves.toMatchObject({
      status: "committed", currentVersion: 1,
    });
    await expect(store.commitTurn(scope(), chat.id, commit)).resolves.toMatchObject({
      status: "conflict", currentVersion: 1,
    });
    await expect(store.commitTurn(scope(), chat.id, { expectedVersion: 1 }))
      .rejects.toThrow("Chat turn commit is empty");
  });

  it("orders active chats, persists titles, and isolates owners", async () => {
    vi.useFakeTimers();
    const store = await loadStore();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    const first = await store.create(scope(), { projectId: null, tabularReviewId: null });
    await store.commitTurn(scope(), first.id, {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "First" },
    });
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    const second = await store.create(scope(), { projectId: null, tabularReviewId: null });
    await store.commitTurn(scope(), second.id, {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "Second" },
    });
    vi.setSystemTime("2026-07-26T12:00:02.000Z");
    await store.update(scope(), first.id, { title: "Updated" });

    expect((await store.list(scope(), {})).map(({ id }) => id)).toEqual([first.id, second.id]);
    await expect(store.get(scope(), first.id)).resolves.toMatchObject({ title: "Updated" });
    await expect(store.get(scope(otherOwner), first.id)).resolves.toBeNull();
    await expect(store.trash(scope(otherOwner), first.id)).resolves.toBe(false);
  });

  it("retains provider state in trash and cascades it on permanent delete", async () => {
    const store = await loadStore();
    const sessions = await import("../sqliteProviderSessionStore");
    const chat = await store.create(scope(), { projectId: null, tabularReviewId: null });
    sessions.writeProviderSession({
      userId: owner, chatId: chat.id, projectId: null,
      continuationId: randomUUID(), compatibilityKey: "a".repeat(64),
      transcriptVersion: 0,
    });

    await expect(store.trash(scope(), chat.id)).resolves.toBe(true);
    expect(sessions.readProviderSession(owner, chat.id)).not.toBeNull();
    await expect(store.commitTurn(scope(), chat.id, {
      expectedVersion: 0,
      userMessage: { id: randomUUID(), content: "stale" },
    })).resolves.toEqual({ status: "missing" });
    await expect(store.remove(scope(), chat.id)).resolves.toBe(true);
    expect(sessions.readProviderSession(owner, chat.id)).toBeNull();
  });

  it("restores before expiry and purges at exactly thirty days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-01T00:00:00.000Z");
    const store = await loadStore();
    const restored = await store.create(scope(), { projectId: null, tabularReviewId: null });
    await store.trash(scope(), restored.id);
    vi.setSystemTime("2026-07-30T23:59:59.999Z");
    await expect(store.restore(scope(), restored.id)).resolves.toBe(true);

    const expired = await store.create(scope(), { projectId: null, tabularReviewId: null });
    await store.trash(scope(), expired.id);
    vi.setSystemTime("2026-08-29T23:59:59.998Z");
    await expect(store.deleted(scope())).resolves.toHaveLength(1);
    vi.setSystemTime("2026-08-29T23:59:59.999Z");
    await expect(store.deleted(scope())).resolves.toHaveLength(0);
    await expect(store.get(scope(), expired.id)).resolves.toBeNull();
  });
});
