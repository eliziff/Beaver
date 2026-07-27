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
  dataHome = await mkdtemp(path.join(os.tmpdir(), "mike-chat-store-"));
  process.env.OPEN_LEGAL_DATA_HOME = dataHome;
});

afterEach(async () => {
  delete process.env.OPEN_LEGAL_DATA_HOME;
  vi.useRealTimers();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous chat store", () => {
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
