import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const CHAT_ID = "10000000-0000-4000-8000-000000000001";
const CONTINUATION_ID = "20000000-0000-4000-8000-000000000001";
const COMPATIBILITY_KEY = "a".repeat(64);
let dataHome = "";

async function loadStore() {
  vi.resetModules();
  return import("../anonymousProviderSessionStore");
}

beforeEach(async () => {
  dataHome = await mkdtemp(path.join(os.tmpdir(), "beaver-codex-session-"));
  vi.stubEnv("OPEN_LEGAL_DATA_HOME", dataHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataHome, { recursive: true, force: true });
});

describe("anonymous Codex provider sessions", () => {
  it("survives reload and is destructively claimed at one transcript version", async () => {
    let store = await loadStore();
    store.writeAnonymousCodexSession({
      userId: USER_ID,
      chatId: CHAT_ID,
      projectId: null,
      continuationId: CONTINUATION_ID,
      compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });

    store = await loadStore();
    expect(store.readAnonymousCodexSession(USER_ID, CHAT_ID)).toMatchObject({
      continuation_id: CONTINUATION_ID,
      transcript_version: 2,
    });
    const claimed = store.claimAnonymousCodexSession({
      userId: USER_ID,
      chatId: CHAT_ID,
      projectId: null,
      compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });
    expect(claimed?.continuation_id).toBe(CONTINUATION_ID);
    expect(store.readAnonymousCodexSession(USER_ID, CHAT_ID)).toBeNull();
  });

  it("removes stale, cross-owner, and corrupt pointers instead of resuming them", async () => {
    const store = await loadStore();
    store.writeAnonymousCodexSession({
      userId: USER_ID,
      chatId: CHAT_ID,
      projectId: null,
      continuationId: CONTINUATION_ID,
      compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 2,
    });
    expect(
      store.claimAnonymousCodexSession({
        userId: OTHER_USER_ID,
        chatId: CHAT_ID,
        projectId: null,
        compatibilityKey: COMPATIBILITY_KEY,
        transcriptVersion: 2,
      }),
    ).toBeNull();
    expect(store.readAnonymousCodexSession(USER_ID, CHAT_ID)).toBeNull();

    const filename = path.join(
      dataHome,
      "apps",
      "mike",
      "provider-sessions",
      "codex",
      `${CHAT_ID}.json`,
    );
    await writeFile(filename, '{"schema_version":1,"provider":"codex"}');
    expect(
      store.claimAnonymousCodexSession({
        userId: USER_ID,
        chatId: CHAT_ID,
        projectId: null,
        compatibilityKey: COMPATIBILITY_KEY,
        transcriptVersion: 2,
      }),
    ).toBeNull();
    expect(store.readAnonymousCodexSession(USER_ID, CHAT_ID)).toBeNull();
  });

  it("removes the sidecar with its canonical chat", async () => {
    vi.resetModules();
    const [store, chats] = await Promise.all([
      import("../anonymousProviderSessionStore"),
      import("../anonymousChatStore"),
    ]);
    const chat = chats.createAnonymousChat(USER_ID);
    store.writeAnonymousCodexSession({
      userId: USER_ID,
      chatId: chat.id,
      projectId: null,
      continuationId: CONTINUATION_ID,
      compatibilityKey: COMPATIBILITY_KEY,
      transcriptVersion: 0,
    });

    expect(chats.deleteAnonymousChat(USER_ID, chat.id)).toBe(true);
    expect(store.readAnonymousCodexSession(USER_ID, chat.id)).toBeNull();
  });
});
