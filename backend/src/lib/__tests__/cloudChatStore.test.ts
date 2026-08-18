import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TabularStore } from "../tabularStore";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("../access", () => ({
  cloudScope: (identity: { userId: string; userEmail?: string }) => ({
    ...identity,
    userEmail: identity.userEmail ?? "",
    db: { rpc },
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
vi.mock("../llm", () => ({ completeText: vi.fn() }));
vi.mock("../userSettings", () => ({ getUserModelSettings: vi.fn() }));

import { createCloudChatStore } from "../cloudChatStore";

const scope = { userId: "owner", userEmail: "owner@example.test" };
const chatId = "10000000-0000-4000-8000-000000000001";

describe("cloud chat atomic commit adapter", () => {
  beforeEach(() => rpc.mockReset());

  it("maps committed and conflict RPC outcomes without a read-before-write", async () => {
    const store = createCloudChatStore({} as TabularStore);
    rpc
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
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "commit_chat_turn", expect.objectContaining({
      p_actor_user_id: "owner",
      p_actor_user_email: "owner@example.test",
      p_chat_id: chatId,
      p_expected_version: 7,
    }));
  });

  it("appends an event atomically at the locked current revision", async () => {
    const store = createCloudChatStore({} as TabularStore);
    rpc.mockResolvedValue({
      data: { status: "committed", current_version: 9 }, error: null,
    });
    const event = { type: "compaction", status: "completed" };

    await expect(store.appendAssistantEvent(
      scope, chatId, "20000000-0000-4000-8000-000000000001", event,
    )).resolves.toEqual({ status: "committed", currentVersion: 9 });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("commit_chat_turn", expect.objectContaining({
      p_expected_version: null,
      p_user_message: null,
      p_assistant_message: null,
      p_append_event: {
        message_id: "20000000-0000-4000-8000-000000000001",
        event,
      },
    }));
  });
});
