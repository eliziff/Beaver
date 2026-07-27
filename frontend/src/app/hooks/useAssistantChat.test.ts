import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "./useAssistantChat";

const mocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  streamChat: vi.fn(),
  streamProjectChat: vi.fn(),
  loadChats: vi.fn(),
  setCurrentChatId: vi.fn(),
  generateTitle: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/lib/mikeApi", () => ({
  getChat: mocks.getChat,
  streamChat: mocks.streamChat,
  streamProjectChat: mocks.streamProjectChat,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    replaceChatId: vi.fn(),
    loadChats: mocks.loadChats,
    setCurrentChatId: mocks.setCurrentChatId,
    saveChat: vi.fn(),
    setNewChatMessages: vi.fn(),
  }),
}));
vi.mock("./useGenerateChatTitle", () => ({
  useGenerateChatTitle: () => ({ generate: mocks.generateTitle }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadChats.mockResolvedValue(undefined);
  mocks.generateTitle.mockResolvedValue(undefined);
});

describe("useAssistantChat local transcript boundary", () => {
  it("posts only the current turn and advances the server transcript version", async () => {
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
    act(() => result.current.setTranscriptVersion(4));

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
    mocks.getChat.mockResolvedValue({
      chat: {
        id: "chat-1",
        user_id: "user-1",
        project_id: null,
        title: "Latest",
        created_at: "2026-07-27T00:00:00Z",
        transcript_version: 3,
      },
      messages: [
        { role: "user", content: "Other window" },
        { role: "assistant", content: "Latest answer" },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

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
    expect(result.current.messages).toEqual([
      { role: "user", content: "Other window" },
      {
        role: "assistant",
        content: "Latest answer",
        error:
          "This conversation changed in another window. Review the latest messages; your draft has been restored.",
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
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 1 },
        messages: [{ role: "user", content: "Accepted elsewhere" }],
      })
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 2 },
        messages: [
          { role: "user", content: "Accepted elsewhere" },
          { role: "assistant", content: "Completed elsewhere" },
        ],
      });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Keep this draft",
      });
    });
    await vi.waitFor(() => {
      expect(result.current.messages).toEqual([
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
        { role: "assistant", content: "", events: [{ type: "ask_inputs" }] },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );
    const response = {
      type: "ask_inputs_response" as const,
      responses: [
        {
          id: "forum",
          kind: "choice" as const,
          question: "Forum?",
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
        expected_version: 2,
        current_turn: {
          kind: "ask_inputs_response",
          content: "Ontario",
          files: undefined,
          responses: response.responses,
        },
      }),
    );
  });

  it("keeps structured selections when the provider fails after accepting them", async () => {
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
    const { result } = renderHook(() =>
      useAssistantChat({
        chatId: "chat-1",
        initialMessages: [
          {
            role: "assistant",
            content: "",
            events: [{ type: "ask_inputs", items: [] }],
          },
        ],
      }),
    );
    act(() => result.current.setTranscriptVersion(1));
    const response = {
      type: "ask_inputs_response" as const,
      responses: [
        {
          id: "forum",
          kind: "choice" as const,
          question: "Forum?",
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
      "Provider unavailable.",
    );
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
          content: "Ontario",
          files: undefined,
          responses: response.responses,
        },
      }),
    );
  });

  it("does not offer retry after a committed local mutation", async () => {
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
    const { result } = renderHook(() =>
      useAssistantChat({
        chatId: "chat-1",
        initialMessages: [
          {
            role: "assistant",
            content: "",
            events: [{ type: "ask_inputs", items: [] }],
          },
        ],
      }),
    );

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
                question: "Forum?",
                answer: "Ontario",
              },
            ],
          },
        },
      );
    });

    expect(result.current.messages.at(-1)?.error).toBe(
      "Provider unavailable.",
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
      messages: [{ role: "assistant", content: "The draft was created." }],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Ontario",
      });
    });

    expect(result.current.rejectedTurn).toBeNull();
    expect(result.current.messages.at(-1)?.error).toBe(detail);
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
        { type: "tool_call_start", name: "ask_inputs" },
        { type: "content_reset" },
        {
          type: "ask_inputs",
          items: [
            {
              id: "forum",
              kind: "choice",
              question: "Which forum?",
              options: [{ value: "Ontario" }],
              allow_other: false,
              other_label: "Other",
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
      events: [
        {
          type: "ask_inputs",
          items: [
            {
              id: "forum",
              question: "Which forum?",
            },
          ],
        },
      ],
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
      "Chat stream ended before completion.",
    );
  });

  it("reuses the normal-turn identity when retrying a completed truncated stream", async () => {
    mocks.streamChat
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"type":"chat_id","chatId":"chat-1","transcriptVersion":1}\n\n',
            'data: {"type":"content_delta","text":"Created."}\n\n',
            'data: {"type":"transcript_version","transcriptVersion":3}\n\n',
          ].join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "chat_turn_already_completed",
            current_version: 3,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      );
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 3 },
      messages: [
        { role: "user", content: "Create it once" },
        { role: "assistant", content: "Created." },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    await act(async () => {
      await result.current.handleChat({
        role: "user",
        content: "Create it once",
      });
    });
    const firstTurnId =
      mocks.streamChat.mock.calls[0][0].current_turn?.turn_id;
    expect(firstTurnId).toEqual(expect.any(String));
    expect(result.current.rejectedTurn?.options?.turnId).toBe(firstTurnId);

    await act(async () => {
      await result.current.retryRejectedTurn();
    });

    expect(mocks.streamChat.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        expected_version: 3,
        current_turn: expect.objectContaining({ turn_id: firstTurnId }),
      }),
    );
    expect(result.current.rejectedTurn).toBeNull();
    expect(result.current.messages).toEqual([
      { role: "user", content: "Create it once" },
      { role: "assistant", content: "Created." },
    ]);
  });
});
