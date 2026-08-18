import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabularStore } from "../tabularStore";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), chat: vi.fn(), from: vi.fn(), completeText: vi.fn(), settings: vi.fn(),
}));

vi.mock("../access", () => ({
  cloudScope: (identity: { userId: string; userEmail?: string }) => ({
    ...identity,
    userEmail: identity.userEmail ?? "",
    chat: mocks.chat,
    db: { rpc: mocks.rpc, from: mocks.from },
  }),
  cloudData: async (operation: string, query: PromiseLike<{
    data: unknown;
    error: Error | null;
  }>) => {
    const result = await query;
    if (result.error) throw new Error(operation, { cause: result.error });
    return result.data;
  },
}));
vi.mock("../llm", () => ({ completeText: mocks.completeText }));
vi.mock("../userSettings", () => ({ getUserModelSettings: mocks.settings }));

import { createCloudChatStore } from "../cloudChatStore";

const scope = { userId: "owner", userEmail: "owner@example.test" };
const chatId = "10000000-0000-4000-8000-000000000001";

describe("cloud chat atomic commit adapter", () => {
  beforeEach(() => Object.values(mocks).forEach((mock) => mock.mockReset()));

  it("maps committed and conflict RPC outcomes without a read-before-write", async () => {
    const store = createCloudChatStore({} as TabularStore);
    mocks.rpc
      .mockResolvedValueOnce({
        data: { status: "committed", current_version: 8 }, error: null,
      })
      .mockResolvedValueOnce({
        data: { status: "conflict", current_version: 8 }, error: null,
      });
    const turn = {
      expectedVersion: 7,
      userMessage: { id: crypto.randomUUID(), content: "Question" },
    };

    await expect(store.commitTurn(scope, chatId, turn)).resolves.toEqual({
      status: "committed", currentVersion: 8,
    });
    await expect(store.commitTurn(scope, chatId, turn)).resolves.toEqual({
      status: "conflict", currentVersion: 8,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "commit_chat_turn", expect.objectContaining({
      p_actor_user_id: "owner",
      p_actor_user_email: "owner@example.test",
      p_chat_id: chatId,
      p_expected_version: 7,
    }));
  });

  it("appends an event atomically at the locked current revision", async () => {
    const store = createCloudChatStore({} as TabularStore);
    mocks.rpc.mockResolvedValue({
      data: { status: "committed", current_version: 9 }, error: null,
    });
    const event = { type: "compaction", status: "completed" };

    await expect(store.appendAssistantEvent(
      scope, chatId, "20000000-0000-4000-8000-000000000001", event,
    )).resolves.toEqual({ status: "committed", currentVersion: 9 });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith("commit_chat_turn", expect.objectContaining({
      p_expected_version: null,
      p_user_message: null,
      p_assistant_message: null,
      p_append_event: {
        message_id: "20000000-0000-4000-8000-000000000001",
        event,
      },
    }));
  });

  it("requires ownership and re-scopes the title write to the owner", async () => {
    const store = createCloudChatStore({} as TabularStore);
    mocks.chat.mockResolvedValueOnce(null);
    await expect(store.generateTitle(scope, chatId, "Question")).resolves.toBeNull();
    expect(mocks.chat).toHaveBeenCalledWith(chatId, true);
    expect(mocks.completeText).not.toHaveBeenCalled();

    const chain: Record<string, ReturnType<typeof vi.fn>> = {};
    chain.eq = vi.fn(() => chain); chain.is = vi.fn(() => chain);
    chain.select = vi.fn(() => chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: {
      id: chatId, user_id: "owner", project_id: null, tabular_review_id: null,
      title: "Topic", transcript_version: 0,
    }, error: null });
    const update = vi.fn(() => chain);
    mocks.from.mockReturnValue({ update });
    mocks.chat.mockResolvedValue({ row: { id: chatId } });
    mocks.settings.mockResolvedValue({ title_model: "test", api_keys: {} });
    mocks.completeText.mockResolvedValue('"Topic."');

    await expect(store.generateTitle(scope, chatId, "Question")).resolves.toBe("Topic");
    expect(update).toHaveBeenCalledWith({ title: "Topic" });
    expect(chain.eq).toHaveBeenCalledWith("id", chatId);
    expect(chain.eq).toHaveBeenCalledWith("user_id", "owner");
    expect(chain.is).toHaveBeenCalledWith("deleted_at", null);
  });
});
