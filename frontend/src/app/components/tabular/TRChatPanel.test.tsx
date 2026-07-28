import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TRChatPanel } from "./TRChatPanel";

const api = vi.hoisted(() => ({
    getChats: vi.fn(),
    getMessages: vi.fn(),
    streamChat: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    deleteTabularChat: vi.fn(),
    getTabularChats: api.getChats,
    getTabularChatMessages: api.getMessages,
    mapTRMessages: (messages: unknown[]) => messages,
    renameTabularChat: vi.fn(),
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
vi.mock("../assistant/ModelToggle", () => ({
    ModelToggle: () => null,
    ReasoningEffortToggle: () => null,
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
            initialChatId="chat-1"
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

it("renders a useful two-line composer", async () => {
    render(
        <TRChatPanel
            reviewId="review-1"
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    expect(
        await screen.findByPlaceholderText("How can I help?"),
    ).toHaveAttribute("rows", "2");
});

it("renders streamed content before the response closes", async () => {
    const encoder = new TextEncoder();
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
    render(
        <TRChatPanel
            reviewId="review-1"
            initialChatId="chat-1"
            onCitationClick={vi.fn()}
            onClose={vi.fn()}
        />,
    );

    await screen.findByText("Latest question");
    const input = screen.getByPlaceholderText("How can I help?");
    const actionButton = input.nextElementSibling?.querySelector("button");
    fireEvent.change(input, { target: { value: "New question" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.streamChat).toHaveBeenCalledOnce());

    await act(async () => {
        emit('{"type":"content_delta","text":"Live answer"}');
    });
    expect(await screen.findByText("Live answer")).toBeInTheDocument();
    expect(screen.getByText("Earlier question")).toBeInTheDocument();
    expect(actionButton).toBeEnabled();

    await act(async () => {
        emit(
            '{"type":"reasoning_delta","text":"Checking"}',
            '{"type":"reasoning_block_end"}',
            '{"type":"citations","citations":[]}',
            "[DONE]",
        );
        streamController.close();
    });
    await waitFor(() => expect(actionButton).toBeDisabled());
});
