import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "./useAssistantChat";
import { setJurisdictionPreference } from "@/app/components/assistant/jurisdictionPreferences";
import { setReadSubagentPreferences } from "@/app/components/assistant/readSubagentPreferences";

const mocks = vi.hoisted(() => ({
  getChat: vi.fn(),
  stopChat: vi.fn(),
  streamChat: vi.fn(),
  loadChats: vi.fn(),
  saveChat: vi.fn(),
  stagePendingChatMessage: vi.fn(),
  peekPendingChatMessage: vi.fn(),
  claimPendingChatMessage: vi.fn(),
  generateChatTitle: vi.fn(),
  renameChat: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/lib/beaverApi", () => ({
  getChat: mocks.getChat,
  stopChat: mocks.stopChat,
  streamChat: mocks.streamChat,
  generateChatTitle: mocks.generateChatTitle,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
  useChatHistoryContext: () => ({
    replaceChatId: vi.fn(),
    loadChats: mocks.loadChats,
    saveChat: mocks.saveChat,
    stagePendingChatMessage: mocks.stagePendingChatMessage,
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
  vi.clearAllMocks();
  localStorage.clear();
  mocks.loadChats.mockResolvedValue(undefined);
  mocks.generateChatTitle.mockResolvedValue({ title: "Generated title" });
  mocks.renameChat.mockResolvedValue(undefined);
  mocks.stopChat.mockResolvedValue({ stopped: true });
  mocks.peekPendingChatMessage.mockReturnValue(null);
  mocks.claimPendingChatMessage.mockReturnValue(null);
});

describe("useAssistantChat local transcript boundary", () => {
  it("stages a new message only after chat creation succeeds", async () => {
    const message = { role: "user" as const, content: "Draft this" };
    mocks.saveChat.mockResolvedValue("chat-new");
    const { result } = renderHook(() => useAssistantChat());

    await act(async () => {
      expect(await result.current.handleNewChat(message)).toBe("chat-new");
    });

    expect(mocks.stagePendingChatMessage).toHaveBeenCalledWith(
      "chat-new",
      message,
    );
  });

  it("does not stage a message when chat creation fails", async () => {
    mocks.saveChat.mockResolvedValue(null);
    const { result } = renderHook(() => useAssistantChat());

    await act(async () => {
      expect(
        await result.current.handleNewChat({
          role: "user",
          content: "Draft this",
        }),
      ).toBeNull();
    });

    expect(mocks.stagePendingChatMessage).not.toHaveBeenCalled();
  });

  it("sends the standing jurisdiction preference with the turn", async () => {
    setJurisdictionPreference({
      mode: "presume",
      jurisdictions: ["ca-ab", "us-ny"],
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
    setReadSubagentPreferences({ mode: "beaver" });
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
              filename: "Lease.docx",
              document_id: "document-1",
            },
          ],
          workflow: {
            id: "builtin-extract-key-terms",
            title: "Extract Key Terms",
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
        chat: { id: "chat-1", transcript_version: 1, turn_in_progress: true },
        messages: [{ role: "user", content: "Accepted elsewhere" }],
      })
      .mockResolvedValueOnce({
        chat: { id: "chat-1", transcript_version: 2, turn_in_progress: false },
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
    localStorage.setItem("mike.selectedModel", "codex:gpt-5.6-terra");
    localStorage.setItem("mike.reasoningEffort", "high");
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
        model: "codex:gpt-5.6-terra",
        reasoning_effort: "high",
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
    let renders = 0;
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
      return useAssistantChat({
        chatId: "chat-1",
        initialMessages: [
          {
            role: "assistant",
            content: "",
            events: [{ type: "ask_inputs", items: [] }],
          },
        ],
      });
    });
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
    expect(result.current.messages.at(-1)?.events).toEqual([
      { type: "ask_inputs", items: [] },
      response,
      { type: "error", message: "Provider unavailable." },
    ]);
    expect(renders).toBe(2);
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
        { type: "citations", status: "final", citations: [] },
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

    expect(result.current.messages.at(-1)?.events).toEqual([
      { type: "content", text: expected },
    ]);
  });

  it("reconciles a live local DOCX redline into the original Mike event", async () => {
    const annotation = {
      kind: "edit" as const,
      edit_id: "edit-1",
      document_id: "document-1",
      version_id: "version-2",
      version_number: 2,
      change_id: "7",
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
        { type: "tool_call_start", name: "library_revise_docx" },
        { type: "doc_edited_start", filename: "Draft.docx" },
        {
          type: "doc_edited",
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

    const edited = result.current.messages
      .at(-1)
      ?.events?.find((event) => event.type === "doc_edited");
    expect(edited).toEqual({
      type: "doc_edited",
      filename: "Draft.docx",
      document_id: "document-1",
      version_id: "version-2",
      version_number: 2,
      download_url:
        "/single-documents/document-1/file?version_id=version-2",
      edit_mode: "manual",
      annotations: [annotation],
      isStreaming: false,
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
        { type: "doc_created_start", filename: "Draft.docx" },
        {
          type: "doc_created",
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

    expect(
      result.current.messages
        .at(-1)
        ?.events?.find((event) => event.type === "doc_created"),
    ).toEqual({
      type: "doc_created",
      filename: "Draft.docx",
      document_id: "document-1",
      version_id: "version-1",
      version_number: 1,
      download_url:
        "/single-documents/document-1/file?version_id=version-1",
      isStreaming: false,
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
        { type: "tool_call_start", name: "read_document" },
        { type: "content_delta", text: "al errors." },
        { type: "reasoning_delta", text: "**Checking**\n\n- source" },
        { type: "reasoning_block_end" },
        {
          type: "content_delta",
          text: "\n\nI found a **matching editable Word copy**.",
        },
        { type: "tool_call_start", name: "edit_document" },
        { type: "content_delta", text: "\n\nCorrected safely" },
        { type: "content_final", text: expected },
        { type: "citations", status: "final", citations: [] },
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

    const contentEvents = result.current.messages
      .at(-1)
      ?.events?.filter((event) => event.type === "content");
    expect(contentEvents).toEqual([{ type: "content", text: expected }]);
    expect(contentEvents?.[0].text).not.toContain("typographic\n\nal");
    expect(contentEvents?.[0].text).not.toContain("errors.I");
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

    expect(
      result.current.messages
        .at(-1)
        ?.events?.filter((event) => event.type === "content"),
    ).toEqual([
      {
        type: "content",
        text: `${linked}The analysis continues.`,
      },
    ]);
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
          tool: "toa_job_status",
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

    expect(result.current.messages.at(-1)?.events).toContainEqual(
      expect.objectContaining({
        type: "automation_run",
        id: "call-1",
        stage: "Build",
        status: "complete",
        outputs: [{ name: "Book.pdf", url: "/download/book" }],
      }),
    );
  });

  it("detaches on unmount without stopping or aborting the backend turn", async () => {
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

    expect(requestSignal?.aborted).toBe(false);
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
                  const error = new Error("Stream aborted.");
                  error.name = "AbortError";
                  controller.error(error);
                },
                { once: true },
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    );
    mocks.getChat.mockResolvedValue({
      chat: { id: "chat-1", transcript_version: 2 },
      messages: [
        { role: "user", content: "Stop after this sentence" },
        {
          role: "assistant",
          content: "",
          events: [
            { type: "content", text: expected },
            { type: "content", text: "Cancelled by user." },
          ],
        },
      ],
    });
    const { result } = renderHook(() =>
      useAssistantChat({ chatId: "chat-1" }),
    );

    let pending!: Promise<string | null>;
    act(() => {
      pending = result.current.handleChat({
        role: "user",
        content: "Stop after this sentence",
      });
    });
    await vi.waitFor(() => {
      expect(result.current.messages.at(-1)?.events).toEqual([
        expect.objectContaining({ type: "content", text: expected }),
      ]);
    });

    act(() => result.current.cancel());
    await act(async () => {
      await pending;
    });

    expect(mocks.stopChat).toHaveBeenCalledWith("chat-1");
    expect(requestSignal?.aborted).toBe(true);
    expect(result.current.messages.at(-1)?.events).toEqual([
      { type: "content", text: expected },
      { type: "content", text: "Cancelled by user." },
    ]);
  });
});
