import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const CONTINUATION_ID = "20000000-0000-4000-8000-000000000001";
const COMPATIBILITY_KEY = "a".repeat(64);
const scope = { userId: USER_ID };
let dataHome = "";

async function closeDatabase() {
  (await import("../localApplicationDatabase")).closeLocalApplicationDatabase();
}

async function loadStores() {
  const [sessions, { createLocalChatStore }] = await Promise.all([
    import("../localProviderSessionStore"),
    import("../localChatStore"),
  ]);
  return [
    sessions,
    createLocalChatStore({ detail: async () => null } as never),
  ] as const;
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

describe("local Codex provider sessions", () => {
  it("survives reopen and is destructively claimed at one transcript version", async () => {
    let [store, chats] = await loadStores();
    const chat = await chats.create(scope, { projectId: null, tabularReviewId: null });
    store.writeLocalCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });

    await closeDatabase();
    vi.resetModules();
    [store, chats] = await loadStores();
    expect(store.readLocalCodexSession(USER_ID, chat.id)).toMatchObject({
      continuation_id: CONTINUATION_ID, transcript_version: 2,
    });
    expect(store.claimLocalCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      compatibilityKey: COMPATIBILITY_KEY, transcriptVersion: 2,
    })?.continuation_id).toBe(CONTINUATION_ID);
    expect(store.readLocalCodexSession(USER_ID, chat.id)).toBeNull();
  });

  it("destructively rejects a stale or cross-owner claim", async () => {
    const [store, chats] = await loadStores();
    const chat = await chats.create(scope, { projectId: null, tabularReviewId: null });
    store.writeLocalCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });
    expect(store.claimLocalCodexSession({
      userId: OTHER_USER_ID, chatId: chat.id, projectId: null,
      compatibilityKey: COMPATIBILITY_KEY, transcriptVersion: 2,
    })).toBeNull();
    expect(store.readLocalCodexSession(USER_ID, chat.id)).toBeNull();
  });

  it("retains a session in trash and deletes it with its chat", async () => {
    const [store, chats] = await loadStores();
    const chat = await chats.create(scope, { projectId: null, tabularReviewId: null });
    store.writeLocalCodexSession({
      userId: USER_ID, chatId: chat.id, projectId: null,
      continuationId: CONTINUATION_ID, compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 0,
    });

    await expect(chats.trash(scope, chat.id)).resolves.toBe(true);
    expect(store.readLocalCodexSession(USER_ID, chat.id)).not.toBeNull();
    await expect(chats.remove(scope, chat.id)).resolves.toBe(true);
    expect(store.readLocalCodexSession(USER_ID, chat.id)).toBeNull();
  });
});
