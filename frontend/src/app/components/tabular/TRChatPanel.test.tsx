import { Profiler, useState } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRChatPanel } from "./TRChatPanel";

const api = vi.hoisted(() => ({
    getChats: vi.fn(),
    getMessages: vi.fn(),
    streamChat: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    getTabularChats: api.getChats,
    getTabularChatMessages: api.getMessages,
    getModelCatalog: () => Promise.resolve({ models: [], source: "unavailable" }),
    mapTRMessages: (messages: unknown[]) => messages,
    streamTabularChat: api.streamChat,
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: {},
    }),
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["codex:gpt-5.6-terra", vi.fn()],
    useSelectedReasoningEffort: () => ["high", vi.fn()],
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(120);
    api.streamChat.mockReset();
    api.getChats.mockReset();
    api.getMessages.mockReset();
    api.getChats.mockResolvedValue([]);
    api.getMessages.mockResolvedValue([
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Latest question" },
        { role: "assistant", content: "Latest answer" },
    ]);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it("renders loaded messages and positions the latest question before paint", async () => {
    const { container } = render(
        <TRChatPanel
            reviewId="review-1"
            chatId="chat-1"
            onChatIdChange={vi.fn()}
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    await screen.findByText("Latest question");

    expect(
        (
            container.querySelector(
                ".flex-1.overflow-y-auto",
            ) as HTMLElement
        ).scrollTop,
    ).toBe(76);
    expect(container.querySelector('[style*="opacity"]')).toBeNull();
});

it("searches chat history and loads the selected chat", async () => {
    api.getChats.mockResolvedValue([
        {
            id: "chat-1",
            title: "Current advice",
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
        },
        {
            id: "chat-2",
            title: "Lease terms",
            created_at: "2026-01-02",
            updated_at: "2026-01-02",
        },
    ]);
    api.getMessages.mockImplementation(
        async (_reviewId: string, chatId: string) => [
            { role: "user", content: `Question for ${chatId}` },
        ],
    );
    const onChatIdChange = vi.fn();
    function ControlledPanel() {
        const [chatId, setChatId] = useState<string | null>("chat-1");
        return (
            <TRChatPanel
                reviewId="review-1"
                chatId={chatId}
                onChatIdChange={(next) => {
                    onChatIdChange(next);
                    setChatId(next);
                }}
                onCitationClick={vi.fn()}
                onClose={vi.fn()}
            />
        );
    }
    render(<ControlledPanel />);

    await screen.findByText("Question for chat-1");
    fireEvent.click(screen.getByTitle("Chat history"));
    const historyDialog = screen.getByRole("dialog");
    fireEvent.change(await screen.findByPlaceholderText("Search chats"), {
        target: { value: "lease" },
    });
    expect(
        within(historyDialog).queryByRole("button", {
            name: "Current advice",
        }),
    ).not.toBeInTheDocument();
    fireEvent.click(
        within(historyDialog).getByRole("button", { name: "Lease terms" }),
    );

    expect(await screen.findByText("Question for chat-2")).toBeInTheDocument();
    expect(onChatIdChange).toHaveBeenCalledWith("chat-2");
    expect(api.getMessages).toHaveBeenLastCalledWith("review-1", "chat-2");

    fireEvent.click(screen.getByTitle("New chat"));
    expect(onChatIdChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByText("Question for chat-2")).not.toBeInTheDocument();
});

it("renders streamed content before the response closes", async () => {
    const encoder = new TextEncoder();
    const onCitationClick = vi.fn();
    const onChatIdChange = vi.fn();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
        },
    });
    const emit = (...data: string[]) =>
        streamController.enqueue(
            encoder.encode(data.map((value) => `data: ${value}\n\n`).join("")),
        );
    api.streamChat.mockResolvedValue(new Response(body));
    let commits = 0;
    function ControlledPanel() {
        const [chatId, setChatId] = useState<string | null>("chat-1");
        return (
            <TRChatPanel
                reviewId="review-1"
                chatId={chatId}
                onChatIdChange={(next) => {
                    onChatIdChange(next);
                    setChatId(next);
                }}
                onCitationClick={onCitationClick}
                onClose={vi.fn()}
            />
        );
    }
    render(
        <Profiler id="chat" onRender={() => commits++}>
            <ControlledPanel />
        </Profiler>,
    );

    await screen.findByText("Latest question");
    const input = screen.getByPlaceholderText("How can I help?");
    fireEvent.change(input, { target: { value: "New question" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledOnce());
    expect(api.streamChat).toHaveBeenCalledWith(
        "review-1",
        expect.arrayContaining([
            expect.objectContaining({
                role: "user",
                content: "New question",
            }),
        ]),
        "chat-1",
        expect.anything(),
        expect.objectContaining({
            model: "codex:gpt-5.6-terra",
            reasoningEffort: "high",
        }),
    );

    await act(async () => {
        emit('{"type":"content_delta","text":"Live answer [1]"}');
    });
    expect(await screen.findByText(/Live answer/)).toBeInTheDocument();
    expect(screen.getByText("Earlier question")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop response" })).toBeEnabled();

    const beforeChatId = commits;
    await act(async () => {
        emit('{"type":"chat_id","chatId":"chat-2"}');
    });
    expect(commits - beforeChatId).toBe(1);
    expect(api.getMessages).toHaveBeenCalledTimes(1);
    await act(async () => {
        emit(
            '{"type":"reasoning_delta","text":"Checking"}',
            '{"type":"reasoning_block_end"}',
            '{"type":"citations","citations":[{"type":"tabular_citation","ref":1,"col_index":2,"row_index":3,"col_name":"Term","doc_name":"Lease.pdf","quote":"five years"}]}',
            "[DONE]",
        );
        streamController.close();
    });
    fireEvent.click(await screen.findByRole("button", { name: "Lease.pdf" }));
    expect(onCitationClick).toHaveBeenCalledWith(2, 3);
    expect(onChatIdChange).toHaveBeenCalledOnce();
    expect(onChatIdChange).toHaveBeenCalledWith("chat-2");
    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled(),
    );
});

it("preserves partial content when a tabular response is stopped", async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    api.streamChat.mockImplementation(
        async (
            _reviewId: string,
            _messages: unknown[],
            _chatId: string,
            signal: AbortSignal,
        ) =>
            new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        streamController = controller;
                        signal.addEventListener(
                            "abort",
                            () =>
                                controller.error(
                                    new DOMException("Aborted", "AbortError"),
                                ),
                            { once: true },
                        );
                    },
                }),
            ),
    );
    render(
        <TRChatPanel
            reviewId="review-1"
            chatId="chat-1"
            onChatIdChange={vi.fn()}
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    await screen.findByText("Latest question");
    const input = screen.getByPlaceholderText("How can I help?");
    fireEvent.change(input, { target: { value: "Stop this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledOnce());
    await act(async () => {
        streamController.enqueue(
            encoder.encode(
                'data: {"type":"content_delta","text":"Keep this"}\n\n',
            ),
        );
    });
    expect(await screen.findByText("Keep this")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));

    await waitFor(() =>
        expect(
            screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled(),
    );
    expect(screen.getByText("Keep this")).toBeInTheDocument();
});

it("shows a terminal message when tabular chat fails", async () => {
    api.streamChat.mockRejectedValue(new Error("offline"));
    render(
        <TRChatPanel
            reviewId="review-1"
            onChatIdChange={vi.fn()}
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    const input = await screen.findByPlaceholderText("How can I help?");
    fireEvent.change(input, { target: { value: "Try this" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
        await screen.findByText("An error occurred. Please try again."),
    ).toBeInTheDocument();
});
