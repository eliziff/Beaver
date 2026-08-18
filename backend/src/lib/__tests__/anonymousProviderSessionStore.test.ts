import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const CONTINUATION_ID = "20000000-0000-4000-8000-000000000001";
const COMPATIBILITY_KEY = "a".repeat(64);
let dataHome = "";

async function closeDatabase() {
  (await import("../localApplicationDatabase")).closeLocalApplicationDatabase();
}

async function loadStores() {
  return Promise.all([
    import("../anonymousProviderSessionStore"),
    import("../anonymousChatStore"),
  ]);
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-codex-session-"));
  vi.stubEnv("MIKE_LOCAL_DATA_DIR", dataHome);
});

afterEach(async () => {
  await closeDatabase();
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous Codex provider sessions", () => {
  it("survives reopen and is destructively claimed at one transcript version", async () => {
    let [store, chats] = await loadStores();
    const chat = chats.createAnonymousChat(USER_ID);
    store.writeAnonymousCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });

    await closeDatabase();
    vi.resetModules();
    [store, chats] = await loadStores();
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).toMatchObject({
      continuation_id: CONTINUATION_ID, transcript_version: 2,
    });
    expect(store.claimAnonymousCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      compatibilityKey: COMPATIBILITY_KEY, transcriptVersion: 2,
    })?.continuation_id).toBe(CONTINUATION_ID);
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).toBeNull();
  });

  it("destructively rejects a stale or cross-owner claim", async () => {
    const [store, chats] = await loadStores();
    const chat = chats.createAnonymousChat(USER_ID);
    store.writeAnonymousCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });
    expect(store.claimAnonymousCodexSession({
      userId: OTHER_USER_ID, chatId: chat.id, projectId: null,
      compatibilityKey: COMPATIBILITY_KEY, transcriptVersion: 2,
    })).toBeNull();
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).toBeNull();
  });

  it("retains a session in trash and deletes it with its chat", async () => {
    const [store, chats] = await loadStores();
    const chat = chats.createAnonymousChat(USER_ID);
    store.writeAnonymousCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 0,
    });

    expect(chats.deleteAnonymousChat(USER_ID, chat.id)).toBe(true);
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).not.toBeNull();
    expect(chats.permanentlyDeleteAnonymousChat(USER_ID, chat.id)).toBe(true);
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).toBeNull();
  });
});
