import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat as useAssistantSession } from "./useAssistantChat";
import {
  readAssistantPreferences,
  updateAssistantPreferences,
} from "@/app/components/assistant/assistantPreferences";

function useAssistantChat(options: Parameters<typeof useAssistantSession>[0]) {
  const { state, actions, chatLoad } = useAssistantSession(options);
  return {
    ...state,
    messages: state.messages.map((message) => message.role === "user" ? message : {
      ...message,
      content: message.blocks.filter(({ role }) => role === "assistant").map(({ text }) => text).join("\n\n"),
    }),
    ...actions,
    chatLoad,
    isResponseLoading: state.run !== null,
  };
}

const mocks = vi.hoisted(() => ({
  compactChat: vi.fn(),
  getChat: vi.fn(),
  stopChat: vi.fn(),
  steerChat: vi.fn(),
  streamChat: vi.fn(),
  loadChats: vi.fn(),
  peekPendingChatMessage: vi.fn(),
  claimPendingChatMessage: vi.fn(),
  generateChatTitle: vi.fn(),
  renameChat: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));
vi.mock("@/app/lib/beaverApi", () => ({
  compactChat: mocks.compactChat,
  getChat: mocks.getChat,
  stopChat: mocks.stopChat,
  steerChat: mocks.steerChat,
  streamChat: mocks.streamChat,
  generateChatTitle: mocks.generateChatTitle,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    replaceChatId: vi.fn(),
    loadChats: mocks.loadChats,
    peekPendingChatMessage: mocks.peekPendingChatMessage,
    claimPendingChatMessage: mocks.claimPendingChatMessage,
    renameChat: mocks.renameChat,
  }),
}));

function streamResponse(events: unknown[]) {
  const body = [
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function byteSplitStreamResponse(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    [
      ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      "data: [DONE]\n\n",
    ].join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.loadChats.mockResolvedValue(undefined);
  mocks.generateChatTitle.mockResolvedValue({ title: "Generated title" });
  mocks.renameChat.mockResolvedValue(undefined);
  mocks.stopChat.mockResolvedValue({ stopped: true });
  mocks.steerChat.mockResolvedValue({ steered: true });
  mocks.compactChat.mockResolvedValue({ compacted: true });
  mocks.getChat.mockRejectedValue(new Error("initial load unavailable"));
  mocks.peekPendingChatMessage.mockReturnValue(null);
  mocks.claimPendingChatMessage.mockReturnValue(null);
});

describe("useAssistantChat local transcript boundary", () => {
  it("loads one transcript and resumes an active turn from the server version", async () => {
    mocks.getChat
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 4, turn_in_progress: true },
        messages: [{ id: "user-1", role: "user", content: "Research this" }],
      })
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 5, turn_in_progress: false },
        messages: [
          { id: "user-1", role: "user", content: "Research this" },
          { id: "assistant-1", role: "assistant", content: "Finished" },
        ],
      });

    const { result } = renderHook(() => useAssistantChat({ chatId: "chat-1" }));

    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe("Finished"));
    expect(result.current.transcriptVersion).toBe(5);
    expect(result.current.run).toBeNull();
    expect(mocks.getChat).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale transcript when the selected chat changes", async () => {
    let resolveFirst!: (value: unknown) => void;
    let resolveSecond!: (value: unknown) => void;
    mocks.getChat
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const { result, rerender } = renderHook(
      ({ chatId }) => useAssistantChat({ chatId }),
      { initialProps: { chatId: "chat-1" } },
    );
    rerender({ chatId: "chat-2" });
    await act(async () => resolveSecond({
      chat: { id: "chat-2", transcript_version: 2, turn_in_progress: false },
      messages: [{ id: "assistant-2", role: "assistant", content: "New selection" }],
    }));
    await act(async () => resolveFirst({
      chat: { id: "chat-1", transcript_version: 9, turn_in_progress: false },
      messages: [{ id: "assistant-1", role: "assistant", content: "Stale selection" }],
    }));

    expect(result.current.chatId).toBe("chat-2");
    expect(result.current.messages.at(-1)?.content).toBe("New selection");
    expect(result.current.transcriptVersion).toBe(2);
  });

  it("handles chat commands without invoking a model", async () => {
    const { result } = renderHook(() => useAssistantChat({ chatId: "chat-1" }));

    await act(async () => {
      await result.current.handleChat({ role: "user", content: "/help" });
    });
    expect(result.current.messages.map(({ role, content }) => ({ role, content })))
      .toEqual([
        { role: "user", content: "/help" },
        { role: "assistant", content: expect.stringContaining("/compact") },
      ]);

    await act(async () => {
      await result.current.handleChat({ role: "user", content: "/compact" });
    });
    expect(mocks.compactChat).toHaveBeenCalledWith("chat-1", expect.any(String));
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it("sends the standing jurisdiction preference with the turn", async () => {
    updateAssistantPreferences({ jurisdiction: {
      mode: "presume", jurisdictions: ["ca-ab", "us-ny"],
    } });
    mocks.streamChat.mockResolvedValueOnce(
      streamResponse([
        { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Research this issue",
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        jurisdiction_preference: {
          mode: "presume",
          jurisdictions: [
            "Alberta, Canada",
            "New York, United States",
          ],
        },
      }),
    );
  });

  it("sends the selected subagent mode with the turn", async () => {
    updateAssistantPreferences({
      readSubagents: { ...readAssistantPreferences().readSubagents, mode: "beaver" },
    });
    mocks.streamChat.mockResolvedValueOnce(
      streamResponse([
        { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Compare these sources",
        editMode: "auto",
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        subagent_mode: "beaver",
        edit_mode: "auto",
      }),
    );
  });

  it("replaces browser fetch errors with recovery guidance", async () => {
    mocks.streamChat.mockRejectedValueOnce(new TypeError("fetch failed"));
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Draft this",
      });
    });

    expect(result.current.messages.at(-1)?.error).toBe(
      "Unable to get a response. Check the local service or provider connection, then try again.",
    );
  });

  it("uses a concise fallback for an empty stream error", async () => {
    mocks.streamChat.mockResolvedValueOnce(
      streamResponse([
        { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
        { type: "error", message: "", retryable: false },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Draft this",
      });
    });

    expect(result.current.messages.at(-1)?.error).toBe(
      "Unable to get a response. Try again.",
    );
  });

  it("claims and submits a staged route handoff once", async () => {
    const message = { role: "user" as const, content: "Draft this" };
    mocks.peekPendingChatMessage.mockReturnValue(message);
    mocks.claimPendingChatMessage.mockReturnValue(message);
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );

    renderHook(() => useAssistantChat({ chatId: "chat-1" }));

    await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(1));
    expect(mocks.claimPendingChatMessage).toHaveBeenCalledOnce();
    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: "chat-1",
        current_turn: expect.objectContaining({ content: "Draft this" }),
      }),
    );
  });

  it("posts only the current turn and advances the server transcript version", async () => {
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 4, turn_in_progress: false },
      messages: [],
    });
    mocks.streamChat
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 5,
          },
          { type: "transcript_version", transcriptVersion: 6 },
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 7,
          },
          { type: "transcript_version", transcriptVersion: 8 },
        ]),
      );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "First current turn",
      });
    });
    expect(mocks.streamChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_id: "chat-1",
        expected_version: 4,
        current_turn: {
          kind: "message",
          turn_id: expect.any(String),
          content: "First current turn",
          files: undefined,
          workflow: undefined,
        },
      }),
    );
    expect(mocks.streamChat.mock.calls[0][0].messages).toBeUndefined();

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Second current turn",
      });
    });
    expect(mocks.streamChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expected_version: 6,
        current_turn: expect.objectContaining({
          content: "Second current turn",
        }),
      }),
    );
  });

  it("sends the durable project ID on every project chat turn", async () => {
    mocks.streamChat
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 1,
          },
          { type: "transcript_version", transcriptVersion: 2 },
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 3,
          },
          { type: "transcript_version", transcriptVersion: 4 },
        ]),
      );
    const { result } = renderHook(() =>
      useAssistantChat({
        chatId: "chat-1",
        projectId: "project-1",
      }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "First project turn",
      });
      await result.current.handleChat({
        role: "user",
        content: "Second project turn",
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledTimes(2);
    expect(mocks.streamChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        project_id: "project-1",
        chat_id: "chat-1",
        current_turn: expect.objectContaining({
          content: "First project turn",
        }),
      }),
    );
    expect(mocks.streamChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        project_id: "project-1",
        chat_id: "chat-1",
        current_turn: expect.objectContaining({
          content: "Second project turn",
        }),
      }),
    );
  });

  it("sends selected documents with the first workflow turn", async () => {
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "extract key terms",
        files: [
          {
            filename: "Lease.docx",
            document_id: "document-1",
          },
        ],
        workflow: {
          id: "builtin-extract-key-terms",
          title: "Extract Key Terms",
        },
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: "chat-1",
        current_turn: expect.objectContaining({
          kind: "message",
          content: "extract key terms",
          files: [
            {
              document_id: "document-1",
            },
          ],
          workflow: {
            id: "builtin-extract-key-terms",
          },
        }),
      }),
    );
  });

  it("reloads on a conflict and never replays the rejected turn", async () => {
    mocks.streamChat.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "chat_version_conflict",
          current_version: 3,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    mocks.getChat
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 0, turn_in_progress: false },
        messages: [],
      })
      .mockResolvedValue({
      chat: {
        id: "chat-1",
        user_id: "user-1",
        project_id: null,
        title: "Latest",
        created_at: "2026-07-27T00:00:00Z",
        transcript_version: 3,
      },
      messages: [
        { id: "user-latest", role: "user", content: "Other window" },
        { id: "assistant-latest", role: "assistant", content: "Latest answer" },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Rejected stale turn",
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(mocks.getChat).toHaveBeenCalledWith("chat-1");
    expect(result.current.rejectedTurn?.message).toMatchObject({
      role: "user",
      content: "Rejected stale turn",
    });
    expect(result.current.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Other window" },
      {
        role: "assistant",
        content: "Latest answer",
      },
    ]);
  });

  it("refreshes an in-progress turn and keeps the rejected draft", async () => {
    mocks.streamChat
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "chat_turn_in_progress",
            current_version: 1,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 3,
          },
          { type: "transcript_version", transcriptVersion: 4 },
        ]),
      );
    mocks.getChat
      .mockRejectedValueOnce(new Error("initial load unavailable"))
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 1, turn_in_progress: true },
        messages: [{ id: "user-accepted", role: "user", content: "Accepted elsewhere" }],
      })
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 2, turn_in_progress: false },
        messages: [
          { id: "user-accepted", role: "user", content: "Accepted elsewhere" },
          { id: "assistant-accepted", role: "assistant", content: "Completed elsewhere" },
        ],
      });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await waitFor(() => expect(result.current.chatLoad.status).toBe("error"));
    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Keep this draft",
      });
    });
    await vi.waitFor(() => {
      expect(result.current.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "Accepted elsewhere" },
        { role: "assistant", content: "Completed elsewhere" },
      ]);
    });
    expect(result.current.rejectedTurn?.message).toMatchObject({
      content: "Keep this draft",
    });

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Send after refresh",
      });
    });
    expect(mocks.streamChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ expected_version: 2 }),
    );
  });

  it("keeps structured ask-input selections for an exact retry", async () => {
    localStorage.setItem("beaver.selectedModel", "codex:gpt-5.6-terra");
    localStorage.setItem("beaver.reasoningEffort", "high");
    mocks.streamChat
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "chat_version_conflict",
            current_version: 2,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 3,
          },
          { type: "transcript_version", transcriptVersion: 4 },
        ]),
      );
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 2 },
      messages: [
        { id: "assistant-question", role: "assistant", content: [{ type: "ask_inputs", items: [] }] },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));
    const response = {
      type: "ask_inputs_response" as const,
      responses: [
        {
          id: "forum",
          kind: "choice" as const,
          answer: "Ontario",
        },
      ],
    };

    await act(async () => {
      await result.current.handleChat(
        { role: "user", content: "Ontario" },
        { askInputsResponse: response },
      );
    });
    expect(
      result.current.rejectedTurn?.options?.askInputsResponse,
    ).toEqual(response);

    await act(async () => {
      await result.current.retryRejectedTurn();
    });
    expect(mocks.streamChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "codex:gpt-5.6-terra",
        reasoning_effort: "high",
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          responses: response.responses,
        },
      }),
    );
  });

  it("keeps structured selections when the provider fails after accepting them", async () => {
    let renders = 0;
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 1, turn_in_progress: false },
      messages: [{ id: "assistant-question", role: "assistant", content: [{ type: "ask_inputs", items: [] }] }],
    });
    mocks.streamChat
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 2,
          },
          { type: "error", message: "Provider unavailable." },
          { type: "transcript_version", transcriptVersion: 3 },
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          {
            type: "chat_id",
            chatId: "chat-1",
            transcriptVersion: 3,
          },
          { type: "transcript_version", transcriptVersion: 4 },
        ]),
      );
    const { result } = renderHook(() => {
      renders += 1;
      return useAssistantChat({ chatId: "chat-1" });
    });
    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));
    const response = {
      type: "ask_inputs_response" as const,
      responses: [
        {
          id: "forum",
          kind: "choice" as const,
          answer: "Ontario",
        },
      ],
    };

    await act(async () => {
      await result.current.handleChat(
        { role: "user", content: "Ontario" },
        { askInputsResponse: response },
      );
    });
    expect(result.current.messages.at(-1)?.error).toBe(
      "Unable to get a response. Try again.",
    );
    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      error: "Unable to get a response. Try again.",
    });
    expect(renders).toBeGreaterThanOrEqual(2);
    expect(
      result.current.rejectedTurn?.options?.askInputsResponse,
    ).toEqual(response);

    await act(async () => {
      await result.current.retryRejectedTurn();
    });
    expect(mocks.streamChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expected_version: 3,
        current_turn: {
          kind: "ask_inputs_response",
          responses: response.responses,
        },
      }),
    );
  });

  it("does not offer retry after a committed local mutation", async () => {
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 1, turn_in_progress: false },
      messages: [{ id: "assistant-question", role: "assistant", content: [{ type: "ask_inputs", items: [] }] }],
    });
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 2,
        },
        {
          type: "error",
          message: "Provider unavailable.",
          retryable: false,
        },
        { type: "transcript_version", transcriptVersion: 4 },
      ]),
    );
    const { result } = renderHook(() => useAssistantChat({ chatId: "chat-1" }));
    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));

    await act(async () => {
      await result.current.handleChat(
        { role: "user", content: "Ontario" },
        {
          askInputsResponse: {
            type: "ask_inputs_response",
            responses: [
              {
                id: "forum",
                kind: "choice",
                answer: "Ontario",
              },
            ],
          },
        },
      );
    });

    expect(result.current.messages.at(-1)?.error).toBe(
      "Unable to get a response. Try again.",
    );
    expect(result.current.rejectedTurn).toBeNull();
    await act(async () => {
      expect(await result.current.retryRejectedTurn()).toBeNull();
    });
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it("does not restore retry when the server blocks a post-mutation replay", async () => {
    const detail =
      "The prior continuation changed local data before it stopped. Review that result before sending a new instruction.";
    mocks.streamChat.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "chat_retry_blocked_after_mutation",
          current_version: 4,
          detail,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 4 },
      messages: [{ id: "assistant-created", role: "assistant", content: "The draft was created." }],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await waitFor(() => expect(result.current.chatLoad.status).toBe("loaded"));
    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Ontario",
      });
    });

    expect(result.current.rejectedTurn).toMatchObject({
      detail,
      retryable: false,
    });
    expect(result.current.messages.at(-1)?.error).toBeUndefined();
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
  });

  it("retracts same-response narrative when a structured question pauses", async () => {
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        { type: "content_delta", text: "Text emitted before the tool call." },
        { type: "reasoning_delta", text: "Transient reasoning" },
        { type: "content_reset" },
        {
          type: "ask_inputs",
          items: [
            {
              id: "forum",
              kind: "choice",
              question: "Which forum?",
              options: [{ value: "Ontario" }],
            },
          ],
        },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Ask first",
      });
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "",
      activities: [expect.objectContaining({
        tool: "ask_inputs",
        status: "running",
      })],
    });
  });

  it("rejects a clean but truncated local SSE response", async () => {
    mocks.streamChat.mockResolvedValue(
      new Response(
        'data: {"type":"chat_id","chatId":"chat-1","transcriptVersion":1}\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Do not lose this",
      });
    });

    expect(result.current.rejectedTurn?.message.content).toBe(
      "Do not lose this",
    );
    expect(mocks.loadChats).not.toHaveBeenCalled();
    expect(result.current.messages.at(-1)?.error).toBe(
      "Unable to get a response. Try again.",
    );
  });

  it("accepts canonical completion when the local stream loses its terminal frame", async () => {
    mocks.streamChat.mockResolvedValueOnce(
      new Response(
        [
          'data: {"type":"chat_id","chatId":"chat-1","transcriptVersion":1}\n\n',
          'data: {"type":"content_delta","text":"Created."}\n\n',
          'data: {"type":"transcript_version","transcriptVersion":3}\n\n',
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    mocks.getChat
      .mockRejectedValueOnce(new Error("initial load unavailable"))
      .mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 3 },
      messages: [
        { id: "user-create", role: "user", content: "Create it once" },
        { id: "assistant-create", role: "assistant", content: "Created." },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await waitFor(() => expect(result.current.chatLoad.status).toBe("error"));
    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Create it once",
      });
    });
    const firstTurnId =
      mocks.streamChat.mock.calls[0][0].current_turn?.turn_id;
    expect(firstTurnId).toEqual(expect.any(String));
    expect(result.current.rejectedTurn).toBeNull();
    expect(mocks.streamChat).toHaveBeenCalledTimes(1);
    expect(result.current.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "Create it once" },
      { role: "assistant", content: "Created." },
    ]);
  });

  it("concatenates every streamed character through the final period", async () => {
    const expected =
      "It will need local-law review before use because tenancy rules vary by jurisdiction.";
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "content_delta",
          text: "It will need local-law re",
        },
        {
          type: "content_delta",
          text: "view before use because tenancy rules vary by jurisdiction",
        },
        { type: "content_delta", text: "." },
        { type: "citations", citations: [] },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Draft a lease",
      });
    });

    expect(result.current.messages.at(-1)?.content).toBe(expected);
  });

  it("reconciles a live local DOCX redline into the original Mike event", async () => {
    const annotation = {
      edit_id: "edit-1",
      document_id: "document-1",
      version_id: "version-2",
      version_number: 2,
      del_w_id: "8",
      ins_w_id: "9",
      deleted_text: "Original",
      inserted_text: "Revised",
      diff: [
        { kind: "delete" as const, text: "Original" },
        { kind: "insert" as const, text: "Revised" },
      ],
      context_before: "",
      context_after: " provision.",
      status: "pending" as const,
    };
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "tool_activity",
          id: "edit-1",
          tool: "Edit",
          status: "running",
          label: "Editing Draft.docx",
        },
        {
          type: "tool_activity",
          id: "edit-1",
          tool: "Edit",
          status: "completed",
          label: "Edited Draft.docx",
        },
        {
          type: "document_artifact",
          action: "edited",
          filename: "Draft.docx",
          document_id: "document-1",
          version_id: "version-2",
          version_number: 2,
          download_url:
            "/single-documents/document-1/file?version_id=version-2",
          edit_mode: "manual",
          annotations: [annotation],
        },
        {
          type: "content_final",
          text: "The tracked revision is ready.",
        },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Revise the draft.",
      });
    });

    const lastEdited = result.current.messages.at(-1);
    const edited = lastEdited?.role === "assistant"
      ? lastEdited.artifacts.find((artifact) => artifact.type === "edited")
      : undefined;
    expect(edited).toMatchObject({
      type: "edited",
      filename: "Draft.docx",
      documentId: "document-1",
      versionId: "version-2",
      versionNumber: 2,
      downloadUrl:
        "/single-documents/document-1/file?version_id=version-2",
      editMode: "manual",
      annotations: [expect.objectContaining({
        edit_id: annotation.edit_id,
        deleted_text: "Original",
        inserted_text: "Revised",
      })],
    });
  });

  it("reconciles a local Word draft into the original Mike document card", async () => {
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "document_artifact",
          action: "created",
          filename: "Draft.docx",
          document_id: "document-1",
          version_id: "version-1",
          version_number: 1,
          download_url:
            "/single-documents/document-1/file?version_id=version-1",
        },
        { type: "content_final", text: "The Word draft is ready." },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Create the draft.",
      });
    });

    const lastCreated = result.current.messages.at(-1);
    expect(lastCreated?.role === "assistant"
      ? lastCreated.artifacts.find((artifact) => artifact.type === "created")
      : undefined).toMatchObject({
      type: "created",
      filename: "Draft.docx",
      documentId: "document-1",
      versionId: "version-1",
      versionNumber: 1,
      downloadUrl:
        "/single-documents/document-1/file?version_id=version-1",
    });
  });

  it("preserves exact UTF-8 and Markdown across mid-word tool races and final reconciliation", async () => {
    const expected =
      "I’ll prepare a corrected editable version, fixing clear typographical errors.\n\n" +
      "I found a **matching editable Word copy**.\n\nCorrected safely.";
    mocks.streamChat.mockResolvedValue(
      byteSplitStreamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "content_delta",
          text: "I’ll prepare a corrected editable version, fixing clear typographic",
        },
        {
          type: "tool_activity",
          id: "read-1",
          tool: "read_document",
          status: "completed",
          label: "Reading document",
        },
        { type: "content_delta", text: "al errors." },
        { type: "reasoning_delta", text: "**Checking**\n\n- source" },
        { type: "reasoning_block_end" },
        {
          type: "content_delta",
          text: "\n\nI found a **matching editable Word copy**.",
        },
        {
          type: "tool_activity",
          id: "edit-1",
          tool: "edit_document",
          status: "completed",
          label: "Editing document",
        },
        { type: "content_delta", text: "\n\nCorrected safely" },
        { type: "content_final", text: expected },
        { type: "citations", citations: [] },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Correct the editable copy",
      });
    });

    const content = result.current.messages.at(-1)?.content;
    expect(content).toBe(expected);
    expect(content).not.toContain("typographic\n\nal");
    expect(content).not.toContain("errors.I");
  });

  it("continues one live response after a linked content snapshot", async () => {
    const linked =
      "See [2024 SCC 6 at para. 12](https://www.canlii.org/en/ca/scc/doc/2024/2024scc6/2024scc6.html#par12).\n";
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "content_delta",
          text: "See 2024 SCC 6 at para. 12.\n",
        },
        { type: "content_snapshot", text: linked },
        { type: "content_delta", text: "The analysis continues." },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Research this",
      });
    });

    expect(result.current.messages.at(-1)?.content).toBe(
      `${linked}The analysis continues.`,
    );
  });

  it("keeps streamed Automation receipts intact", async () => {
    mocks.streamChat.mockResolvedValue(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        {
          type: "automation_run",
          id: "call-1",
          tool: "create_table_of_authorities",
          job_id: "a".repeat(32),
          stage: "Build",
          status: "complete",
          progress: 100,
          counts: [{ label: "Outputs", value: 1 }],
          outputs: [{ name: "Book.pdf", url: "/download/book" }],
          app_url: "/table-of-authorities?job=abc",
        },
        { type: "content_final", text: "The book is ready." },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Build the book",
      });
    });

    const automationMessage = result.current.messages.at(-1);
    expect(automationMessage?.role === "assistant" ? automationMessage.automations : []).toContainEqual(
      expect.objectContaining({
        type: "automation_run",
        id: "call-1",
        stage: "Build",
        status: "complete",
        outputs: [{ name: "Book.pdf", url: "/download/book" }],
      }),
    );
  });

  it("aborts the browser reader on unmount without stopping the backend turn", async () => {
    let releaseResponse!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(
      (payload: { signal?: AbortSignal }) => {
        requestSignal = payload.signal;
        return new Promise<Response>((resolve) => {
          releaseResponse = resolve;
        });
      },
    );
    const { result, unmount } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    let pending!: Promise<string | null>;
    act(() => {
      pending = result.current.handleChat({
        role: "user",
        content: "Keep working",
      });
    });
    await vi.waitFor(() => expect(mocks.streamChat).toHaveBeenCalledOnce());

    unmount();

    expect(requestSignal?.aborted).toBe(true);
    expect(mocks.stopChat).not.toHaveBeenCalled();

    releaseResponse(
      streamResponse([
        {
          type: "chat_id",
          chatId: "chat-1",
          transcriptVersion: 1,
        },
        { type: "transcript_version", transcriptVersion: 2 },
      ]),
    );
    await pending;
  });

  it("steers the active turn without starting another stream", async () => {
    let releaseResponse!: (response: Response) => void;
    mocks.streamChat.mockImplementation(
      () => new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      }),
    );
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    let pending!: Promise<string | null>;
    act(() => {
      pending = result.current.handleChat({ role: "user", content: "Draft a memo" });
    });
    await vi.waitFor(() => expect(result.current.isResponseLoading).toBe(true));
    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Focus on remedies",
      });
    });

    expect(mocks.streamChat).toHaveBeenCalledOnce();
    expect(mocks.steerChat).toHaveBeenCalledWith(
      "chat-1",
      expect.any(String),
      "Focus on remedies",
    );
    const steered = result.current.messages.at(-1);
    expect(steered?.role === "assistant" ? steered.blocks : []).toContainEqual(
      expect.objectContaining({ role: "user", text: "Focus on remedies" }),
    );

    releaseResponse(streamResponse([
      { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
      { type: "transcript_version", transcriptVersion: 2 },
    ]));
    await act(async () => { await pending; });
  });

  it("keeps assistant text on both sides of a steering message", async () => {
    mocks.streamChat.mockResolvedValueOnce(streamResponse([
      { type: "chat_id", chatId: "chat-1", transcriptVersion: 1 },
      { type: "content_delta", text: "Initial answer." },
      {
        type: "steering",
        id: "22222222-2222-4222-8222-222222222222",
        text: "Focus on remedies",
      },
      { type: "content_delta", text: "Revised answer." },
      { type: "content_final", text: "Revised answer." },
      { type: "transcript_version", transcriptVersion: 2 },
    ]));
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await act(async () => {
      await result.current.handleChat({ role: "user", content: "Draft a memo" });
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      content: "Initial answer.\n\nRevised answer.",
      blocks: [
        expect.objectContaining({ role: "assistant", text: "Initial answer." }),
        {
          id: "steering:22222222-2222-4222-8222-222222222222",
          role: "user",
          text: "Focus on remedies",
        },
        expect.objectContaining({ role: "assistant", text: "Revised answer." }),
      ],
    });
  });

  it("uses the stop endpoint and preserves the exact partial suffix once", async () => {
    const expected =
      "It will need local-law review before use because tenancy rules vary by jurisdiction.";
    let requestSignal: AbortSignal | undefined;
    mocks.streamChat.mockImplementation(
      async (payload: { signal?: AbortSignal }) => {
        requestSignal = payload.signal;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"type":"chat_id","chatId":"chat-1","transcriptVersion":1}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "content_delta",
                    text: expected,
                  })}\n\n`,
                ),
              );
              payload.signal?.addEventListener(
                "abort",
                () => {
                  controller.error(new Error("NetworkError"));
                },
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    mocks.getChat
      .mockRejectedValueOnce(new Error("initial load unavailable"))
      .mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 2 },
      messages: [
        { id: "user-stop", role: "user", content: "Stop after this sentence" },
        {
          id: "assistant-stop",
          role: "assistant",
          content: [
            { type: "content", text: expected },
            { type: "turn_status", status: "cancelled" },
          ],
        },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    await waitFor(() => expect(result.current.chatLoad.status).toBe("error"));

    let pending!: Promise<string | null>;
    act(() => {
      pending = result.current.handleChat({
        role: "user",
        content: "Stop after this sentence",
      });
    });
    await vi.waitFor(() => {
      expect(result.current.messages.at(-1)?.content).toBe(expected);
    });

    act(() => result.current.cancel());
    await act(async () => {
      await pending;
    });

    expect(mocks.stopChat).toHaveBeenCalledWith("chat-1");
    expect(requestSignal?.aborted).toBe(true);
    expect(result.current.messages.at(-1)?.content).toBe(expected);
    expect(result.current.messages.at(-1)?.turnStatus).toBe("cancelled");
    expect(result.current.rejectedTurn).toBeNull();
  });
});
