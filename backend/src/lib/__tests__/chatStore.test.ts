import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStore, type ChatRepository } from "../chatStore";
import { beginChatTurn, chatTurnWasDeleted, finishChatTurn } from "../chatTurns";

const chatId = "10000000-0000-4000-8000-000000000001";
const scope = { userId: "owner" };

afterEach(() => finishChatTurn(chatId));

describe("shared chat lifecycle", () => {
  it("aborts a live turn only after trash commits", async () => {
    const trash = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const repository = { trash } as unknown as ChatRepository;
    const store = createChatStore(() => repository, async (_scope, message) => message);
    const controller = new AbortController();
    expect(beginChatTurn(chatId, controller)).toBe(true);

    await expect(store.trash(scope, chatId)).resolves.toBe(false);
    expect(controller.signal.aborted).toBe(false);
    await expect(store.trash(scope, chatId)).resolves.toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(chatTurnWasDeleted(chatId)).toBe(true);
  });
});
