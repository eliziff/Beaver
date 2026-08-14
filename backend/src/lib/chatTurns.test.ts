import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginChatTurn,
  finishChatTurn,
  setChatTurnControl,
  steerChatTurn,
} from "./chatTurns";

describe("chat turn control", () => {
  const chatId = "chat-1";
  afterEach(() => finishChatTurn(chatId));

  it("routes steering only to the provider controlling the active turn", async () => {
    const controller = new AbortController();
    const steer = vi.fn().mockResolvedValue(undefined);
    expect(beginChatTurn(chatId, controller)).toBe(true);
    setChatTurnControl(chatId, controller, { steer });

    const message = { id: "message-1", text: "Focus on the termination clause." };
    await expect(steerChatTurn(chatId, message)).resolves.toBe(true);
    expect(steer).toHaveBeenCalledWith(message);

    setChatTurnControl(chatId, new AbortController(), null);
    await expect(steerChatTurn(chatId, message)).resolves.toBe(true);
    expect(steer).toHaveBeenCalledTimes(2);

    finishChatTurn(chatId, controller);
    await expect(steerChatTurn(chatId, message)).resolves.toBe(false);
  });
});
