import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataHome: string;
const owner = "00000000-0000-0000-0000-000000000001";
const otherOwner = "00000000-0000-0000-0000-000000000002";

async function loadStore() {
  vi.resetModules();
  return import("../anonymousChatStore");
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-chat-store-"));
  process.env.OPEN_LEGAL_DATA_HOME = dataHome;
});

afterEach(async () => {
  delete process.env.OPEN_LEGAL_DATA_HOME;
  vi.useRealTimers();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous chat store", () => {
  it("upgrades legacy v2 files without losing their transcript", async () => {
    const chatsDirectory = path.join(dataHome, "apps", "mike", "chats");
    const chatId = randomUUID();
    const messageId = randomUUID();
    await mkdir(chatsDirectory, { recursive: true });
    await writeFile(
      path.join(chatsDirectory, `${chatId}.json`),
      JSON.stringify({
        version: 2,
        chat: {
          id: chatId,
          user_id: owner,
          project_id: null,
          title: "Legacy",
          created_at: "2026-07-01T00:00:00.000Z",
          updated_at: "2026-07-01T00:00:01.000Z",
          transcript_version: 1,
          messages: [
            {
              id: messageId,
              chat_id: chatId,
              role: "user",
              content: "Keep me",
              created_at: "2026-07-01T00:00:01.000Z",
            },
          ],
        },
      }),
      "utf8",
    );

    const store = await loadStore();
    expect(store.getAnonymousChat(owner, chatId)).toMatchObject({
      deleted_at: null,
      title: "Legacy",
      messages: [{ id: messageId, content: "Keep me" }],
    });
    expect(
      JSON.parse(
        await readFile(path.join(chatsDirectory, `${chatId}.json`), "utf8"),
      ),
    ).toMatchObject({
      version: 3,
      chat: { deleted_at: null, messages: [{ id: messageId }] },
    });
  });

  it("recovers chats and ordered messages after a module reload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    const firstStore = await loadStore();
    const chat = firstStore.createAnonymousChat(owner);
    firstStore.appendAnonymousMessage(chat, {
      role: "user",
      content: "Question",
    });
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    firstStore.appendAnonymousMessage(chat, {
      role: "assistant",
      content: "Answer",
    });

    const secondStore = await loadStore();
    expect(
      secondStore.getAnonymousChat(owner, chat.id)?.messages,
    ).toMatchObject([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]);
    expect(
      secondStore.getAnonymousChat(owner, chat.id)?.transcript_version,
    ).toBe(2);
  });

  it("atomically rejects a stale transcript version without changing bytes", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    store.appendAnonymousMessage(
      chat,
      { role: "user", content: "First" },
      0,
    );
    const chatFile = path.join(
      dataHome,
      "apps",
      "mike",
      "chats",
      `${chat.id}.json`,
    );
    const acceptedBytes = await readFile(chatFile, "utf8");

    expect(() =>
      store.appendAnonymousMessage(
        chat,
        { role: "user", content: "Duplicate" },
        0,
      ),
    ).toThrow(store.AnonymousChatVersionConflictError);
    expect(await readFile(chatFile, "utf8")).toBe(acceptedBytes);
    expect(chat.transcript_version).toBe(1);
    expect(chat.messages).toHaveLength(1);
  });

  it("keeps one canonical in-process chat identity across commits", async () => {
    const store = await loadStore();
    const firstReference = store.createAnonymousChat(owner);
    store.appendAnonymousMessage(
      firstReference,
      { role: "user", content: "First" },
      0,
    );
    const secondReference = store.getAnonymousChat(owner, firstReference.id)!;
    store.appendAnonymousMessage(firstReference, {
      role: "assistant",
      content: "Answer",
    });
    const chatFile = path.join(
      dataHome,
      "apps",
      "mike",
      "chats",
      `${firstReference.id}.json`,
    );
    const committedBytes = await readFile(chatFile, "utf8");

    expect(secondReference).toBe(firstReference);
    expect(() =>
      store.appendAnonymousMessage(
        secondReference,
        { role: "user", content: "Stale overwrite" },
        1,
      ),
    ).toThrow(store.AnonymousChatVersionConflictError);
    expect(await readFile(chatFile, "utf8")).toBe(committedBytes);
    expect(firstReference.transcript_version).toBe(2);
    expect(firstReference.messages).toHaveLength(2);
  });

  it("orders chats by their latest durable update and persists titles", async () => {
    vi.useFakeTimers();
    const store = await loadStore();
    vi.setSystemTime("2026-07-26T12:00:00.000Z");
    const first = store.createAnonymousChat(owner);
    vi.setSystemTime("2026-07-26T12:00:01.000Z");
    const second = store.createAnonymousChat(owner);
    vi.setSystemTime("2026-07-26T12:00:02.000Z");
    store.updateAnonymousChatTitle(first, "Updated");

    const reloaded = await loadStore();
    expect(reloaded.listAnonymousChats(owner).map((chat) => chat.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(reloaded.getAnonymousChat(owner, first.id)?.title).toBe("Updated");
  });

  it("does not let one owner read or delete another owner's chat", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);

    expect(store.getAnonymousChat(otherOwner, chat.id)).toBeNull();
    expect(store.deleteAnonymousChat(otherOwner, chat.id)).toBe(false);
    expect(store.getAnonymousChat(owner, chat.id)?.id).toBe(chat.id);
  });

  it("soft-deletes content, aborts its turn, retains provider state, and rejects stale writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-27T12:00:00.000Z");
    const store = await loadStore();
    const sessions = await import("../anonymousProviderSessionStore");
    const turns = await import("../chatTurns");
    const chat = store.createAnonymousChat(owner);
    store.appendAnonymousMessage(chat, {
      role: "user",
      content: "Retain me",
    });
    sessions.writeAnonymousCodexSession({
      userId: owner,
      chatId: chat.id,
      projectId: null,
      continuationId: randomUUID(),
      compatibilityKey: "a".repeat(64),
      transcriptVersion: chat.transcript_version,
    });
    const controller = new AbortController();
    expect(turns.beginChatTurn(chat.id, controller)).toBe(true);

    expect(store.deleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(store.getAnonymousChat(owner, chat.id)).toBeNull();
    expect(store.listAnonymousChats(owner)).toEqual([]);
    expect(store.getDeletedAnonymousChat(owner, chat.id)).toMatchObject({
      deleted_at: "2026-07-27T12:00:00.000Z",
      messages: [{ content: "Retain me" }],
    });
    expect(store.listDeletedAnonymousChats(owner)).toHaveLength(1);
    expect(
      sessions.readAnonymousCodexSession(owner, chat.id),
    ).not.toBeNull();

    const chatFile = path.join(
      dataHome,
      "apps",
      "mike",
      "chats",
      `${chat.id}.json`,
    );
    const deletedBytes = await readFile(chatFile, "utf8");
    expect(() =>
      store.appendAnonymousMessage(chat, {
        role: "assistant",
        content: "Late write",
      }),
    ).toThrow(store.AnonymousChatDeletedError);
    expect(await readFile(chatFile, "utf8")).toBe(deletedBytes);
    expect(store.deleteAnonymousChat(owner, chat.id)).toBe(false);
    expect(store.getDeletedAnonymousChat(otherOwner, chat.id)).toBeNull();
  });

  it("restores before expiry without admitting a pre-delete stale write", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-01T00:00:00.000Z");
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    const staleVersion = chat.transcript_version;
    expect(store.deleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(chat.transcript_version).toBe(staleVersion + 1);

    vi.setSystemTime("2026-07-30T23:59:59.999Z");
    expect(store.restoreAnonymousChat(owner, chat.id)).toBe(true);
    expect(store.getAnonymousChat(owner, chat.id)).toMatchObject({
      deleted_at: null,
      updated_at: "2026-07-30T23:59:59.999Z",
      transcript_version: staleVersion + 2,
    });
    expect(store.listDeletedAnonymousChats(owner)).toEqual([]);

    const chatFile = path.join(
      dataHome,
      "apps",
      "mike",
      "chats",
      `${chat.id}.json`,
    );
    const restoredBytes = await readFile(chatFile, "utf8");
    expect(() =>
      store.appendAnonymousMessage(
        chat,
        { role: "assistant", content: "Stale completion" },
        staleVersion,
      ),
    ).toThrow(store.AnonymousChatVersionConflictError);
    expect(await readFile(chatFile, "utf8")).toBe(restoredBytes);
  });

  it("lazily purges at exactly 30 days and removes provider state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-01T00:00:00.000Z");
    const store = await loadStore();
    const sessions = await import("../anonymousProviderSessionStore");
    const chat = store.createAnonymousChat(owner);
    sessions.writeAnonymousCodexSession({
      userId: owner,
      chatId: chat.id,
      projectId: null,
      continuationId: randomUUID(),
      compatibilityKey: "b".repeat(64),
      transcriptVersion: 0,
    });
    store.deleteAnonymousChat(owner, chat.id);

    expect(
      store.purgeExpiredAnonymousChats(
        owner,
        new Date("2026-07-30T23:59:59.999Z"),
      ),
    ).toBe(0);
    vi.setSystemTime("2026-07-31T00:00:00.000Z");
    expect(store.listDeletedAnonymousChats(owner)).toEqual([]);
    expect(sessions.readAnonymousCodexSession(owner, chat.id)).toBeNull();
    await expect(
      readFile(
        path.join(
          dataHome,
          "apps",
          "mike",
          "chats",
          `${chat.id}.json`,
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("permanently deletes only chats already in the recycling bin", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);

    expect(store.permanentlyDeleteAnonymousChat(owner, chat.id)).toBe(false);
    expect(store.deleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(store.permanentlyDeleteAnonymousChat(otherOwner, chat.id)).toBe(
      false,
    );
    expect(store.permanentlyDeleteAnonymousChat(owner, chat.id)).toBe(true);
    expect(store.getDeletedAnonymousChat(owner, chat.id)).toBeNull();
  });

  it("ignores corrupt and schema-invalid chat files", async () => {
    const chatsDirectory = path.join(dataHome, "apps", "mike", "chats");
    await mkdir(chatsDirectory, { recursive: true });
    const corruptId = randomUUID();
    const invalidId = randomUUID();
    await writeFile(
      path.join(chatsDirectory, `${corruptId}.json`),
      "{",
      "utf8",
    );
    await writeFile(
      path.join(chatsDirectory, `${invalidId}.json`),
      JSON.stringify({ version: 1, chat: { id: invalidId, user_id: owner } }),
      "utf8",
    );

    const store = await loadStore();
    expect(store.listAnonymousChats(owner)).toEqual([]);
    expect(store.getAnonymousChat(owner, corruptId)).toBeNull();
    expect(store.getAnonymousChat(owner, invalidId)).toBeNull();
  });

  it("ignores an interrupted temporary write", async () => {
    const store = await loadStore();
    const chat = store.createAnonymousChat(owner);
    const chatFile = path.join(
      dataHome,
      "apps",
      "mike",
      "chats",
      `${chat.id}.json`,
    );
    const interrupted = `${chatFile}.${randomUUID()}.tmp`;
    await writeFile(interrupted, await readFile(chatFile));
    await rm(chatFile);

    const reloaded = await loadStore();
    expect(reloaded.listAnonymousChats(owner)).toEqual([]);
    expect(reloaded.getAnonymousChat(owner, chat.id)).toBeNull();
  });
});
