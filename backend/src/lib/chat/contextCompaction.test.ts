import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ChatStore } from "../chatStore";

const llm = vi.hoisted(() => ({ streamChatWithTools: vi.fn() }));
vi.mock("../llm", () => ({ streamChatWithTools: llm.streamChatWithTools }));

import { compactChatContext, planContextCheckpoint } from "./contextCompaction";
import { projectChatTranscript } from "./chatTranscript";

const rows = (): ChatMessageRecord[] => [
  { id: "u1", role: "user", content: "Review the agreement." },
  {
    id: "a1",
    role: "assistant",
    content: [{ type: "content", text: "I reviewed section 8. " }],
  },
  { id: "u2", role: "user", content: "Now revise the remedy." },
];

function store(messages: ChatMessageRecord[]) {
  return {
    transcript: vi.fn(async () => messages),
    appendAssistantEvent: vi.fn(async (_scope, _chatId, messageId, event) => {
      const message = messages.find(({ id }) => id === messageId);
      if (!message) return false;
      message.content = [...(Array.isArray(message.content) ? message.content : []), event];
      return true;
    }),
  } as unknown as ChatStore;
}

describe("durable context checkpoints", () => {
  it("attaches a successful summary to an assistant boundary and keeps the recent tail", async () => {
    const messages = rows();
    const chats = store(messages);
    llm.streamChatWithTools.mockResolvedValueOnce({ fullText: "Section 8 was reviewed." });

    const result = await compactChatContext({
      store: chats,
      scope: { userId: "local" },
      chatId: "chat",
      model: "gemini-3-flash-preview",
      force: true,
    });

    expect(planContextCheckpoint(rows())?.messageId).toBe("a1");
    expect(chats.appendAssistantEvent).toHaveBeenCalledWith(
      { userId: "local" },
      "chat",
      "a1",
      expect.objectContaining({
        type: "context_checkpoint",
        summary: "Section 8 was reviewed.",
      }),
    );
    expect(result.messages).toEqual([
      {
        role: "assistant",
        content: "[Conversation checkpoint]\nSection 8 was reviewed.",
      },
      { role: "user", content: "Now revise the remedy." },
    ]);
  });

  it("does not activate a checkpoint when summarization fails", async () => {
    const chats = store(rows());
    const onStatus = vi.fn();
    llm.streamChatWithTools.mockRejectedValueOnce(new Error("provider failed"));

    await expect(compactChatContext({
      store: chats,
      scope: { userId: "local" },
      chatId: "chat",
      model: "gemini-3-flash-preview",
      force: true,
      onStatus,
    })).rejects.toThrow("provider failed");
    expect(chats.appendAssistantEvent).not.toHaveBeenCalled();
    expect(onStatus.mock.calls).toEqual([["running"], ["failed"]]);
  });

  it("round-trips Claude's native compaction block without exposing it", () => {
    const messages = rows();
    (messages[1].content as Record<string, unknown>[]).push({
      type: "context_checkpoint",
      schema_version: 1,
      summary: "Native summary",
      keep_current: true,
      provider: "claude",
    });
    (messages[1].content as Record<string, unknown>[]).push({
      type: "content",
      text: "Continued after compaction.",
    });

    expect(projectChatTranscript(messages)).toEqual([
      {
        role: "assistant",
        content: "[Conversation checkpoint]\nNative summary",
        contextCheckpoint: { provider: "claude", content: "Native summary" },
      },
      { role: "assistant", content: "Continued after compaction." },
      { role: "user", content: "Now revise the remedy." },
    ]);
    expect(projectChatTranscript(messages, "gemini")).toEqual([
      { role: "user", content: "Review the agreement." },
      { role: "assistant", content: "I reviewed section 8. Continued after compaction." },
      { role: "user", content: "Now revise the remedy." },
    ]);
  });
});
