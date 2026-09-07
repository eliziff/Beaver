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

  it("does not send steering after cancellation, including before its dispatch microtask", async () => {
    const controller = new AbortController(), steer = vi.fn().mockResolvedValue(undefined);
    beginChatTurn(chatId, controller);
    setChatTurnControl(chatId, controller, { steer });
    const pending = steerChatTurn(chatId, { id: "cancel", text: "fixture" });
    controller.abort();
    await expect(pending).resolves.toBe(false);
    await expect(steerChatTurn(chatId, { id: "late", text: "fixture" })).resolves.toBe(false);
    expect(steer).not.toHaveBeenCalled();
    finishChatTurn(chatId, controller);
    expect(beginChatTurn(chatId, controller)).toBe(false);
  });

  it.each(["cancel", "finish", "replace"] as const)(
    "releases a stalled steering wait on %s and ignores its late acknowledgement", async (end) => {
      let acknowledge!: () => void;
      const response = new Promise<void>(resolve => { acknowledge = resolve; });
      const controller = new AbortController(), steer = vi.fn(() => response);
      beginChatTurn(chatId, controller);
      setChatTurnControl(chatId, controller, { steer });
      const pending = steerChatTurn(chatId, { id: "old", text: "fixture" });
      await Promise.resolve();
      expect(steer).toHaveBeenCalledOnce();
      const successor = vi.fn().mockResolvedValue(undefined);
      if (end === "cancel") controller.abort();
      else if (end === "finish") finishChatTurn(chatId, controller);
      else setChatTurnControl(chatId, controller, { steer: successor });
      // The response is deliberately unresolved: no timeout or provider acknowledgement.
      await expect(pending).resolves.toBe(false);
      acknowledge();
      await expect(pending).resolves.toBe(false);
      if (end === "replace") {
        await expect(steerChatTurn(chatId, { id: "new", text: "fixture" })).resolves.toBe(true);
        expect(successor).toHaveBeenCalledOnce();
      }
    },
  );

  it("observes a late rejection without clearing or steering a replacement turn", async () => {
    let reject!: (error: Error) => void;
    const response = new Promise<void>((_resolve, fail) => { reject = fail; });
    const old = new AbortController();
    beginChatTurn(chatId, old);
    setChatTurnControl(chatId, old, { steer: () => response });
    const pending = steerChatTurn(chatId, { id: "old", text: "fixture" });
    await Promise.resolve();
    finishChatTurn(chatId, old);
    await expect(pending).resolves.toBe(false);
    const current = new AbortController(), steer = vi.fn().mockResolvedValue(undefined);
    expect(beginChatTurn(chatId, current)).toBe(true);
    setChatTurnControl(chatId, current, { steer });
    setChatTurnControl(chatId, old, null);
    finishChatTurn(chatId, old);
    reject(new Error("Late provider failure"));
    await expect(pending).resolves.toBe(false);
    await expect(steerChatTurn(chatId, { id: "current", text: "fixture" })).resolves.toBe(true);
    expect(steer).toHaveBeenCalledOnce();
  });

  it.each(["throw", "reject"] as const)("preserves an active provider's %s error", async (kind) => {
    const controller = new AbortController(), error = new Error("Provider unavailable");
    beginChatTurn(chatId, controller);
    setChatTurnControl(chatId, controller, { steer: () => {
      if (kind === "throw") throw error;
      return Promise.reject(error);
    } });
    await expect(steerChatTurn(chatId, { id: "message", text: "fixture" })).rejects.toBe(error);
  });

});
