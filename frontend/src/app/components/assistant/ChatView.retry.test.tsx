import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "./ChatView";
import { createAssistantSessionState } from "@/app/lib/assistantSession";

const mocks = vi.hoisted(() => ({
    clearDraft: vi.fn(),
    getChat: vi.fn(),
    streamChat: vi.fn(),
    loadChats: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
    useNavigate: () => vi.fn(),
}));
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));
vi.mock("@/app/lib/beaverApi", () => ({
    getChat: mocks.getChat,
    streamChat: mocks.streamChat,
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: mocks.loadChats,
        saveChat: vi.fn(),
        stagePendingChatMessage: vi.fn(),
    }),
}));
vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AssistantMessage", () => ({ AssistantMessage: () => null }));
vi.mock("./AskInputPopup", () => ({ AskInputPopup: () => null }));
vi.mock("./AssistantSidePanel", () => ({ AssistantSidePanel: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./ChatInput", async () => {
    const React = await import("react");
    return {
        ChatInput: React.forwardRef(function MockChatInput(
            props: { restoreDraft?: { content: string } | null },
            ref,
        ) {
            React.useImperativeHandle(ref, () => ({
                addDoc: vi.fn(),
                clearDraft: mocks.clearDraft,
                startWorkflowDocumentSelection: vi.fn(),
            }));
            return props.restoreDraft ? (
                <div data-testid="restored-draft">
                    {props.restoreDraft.content}
                </div>
            ) : null;
        }),
    };
});

function streamResponse(events: unknown[], done = true) {
    return new Response(
        [
            ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
            ...(done ? ["data: [DONE]\n\n"] : []),
        ].join(""),
        {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
        },
    );
}

function Harness() {
    const chat = useAssistantChat({ chatId: "chat-1" });
    return (
        <>
            <button
                type="button"
                onClick={() =>
                    void chat.actions.handleChat({
                        role: "user",
                        content: "Create it once",
                    })
                }
            >
                Start
            </button>
            <ChatView
                chatId="chat-1"
                session={chat.state}
                handleChat={chat.actions.handleChat}
                cancel={chat.actions.cancel}
                onRejectedTurnRestored={chat.actions.clearRejectedTurn}
                onRetryRejectedTurn={() => void chat.actions.retryRejectedTurn()}
            />
        </>
    );
}

describe("ChatView rejected normal turn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadChats.mockResolvedValue(undefined);
        mocks.getChat.mockRejectedValue(new Error("initial load unavailable"));
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        );
        Object.defineProperty(HTMLElement.prototype, "scrollTo", {
            configurable: true,
            value: vi.fn(),
        });
    });

    it("retries the original turn ID instead of submitting the restored draft as new", async () => {
        const user = userEvent.setup();
        mocks.streamChat
            .mockResolvedValueOnce(
                streamResponse(
                    [
                        {
                            type: "chat_id",
                            chatId: "chat-1",
                            transcriptVersion: 1,
                        },
                    ],
                    false,
                ),
            )
            .mockResolvedValueOnce(
                streamResponse([
                    {
                        type: "chat_id",
                        chatId: "chat-1",
                        transcriptVersion: 2,
                    },
                    { type: "transcript_version", transcriptVersion: 3 },
                ]),
            );

        render(<Harness />);
        await user.click(screen.getByRole("button", { name: "Start" }));
        expect(
            (await screen.findByText("Response interrupted")).closest(
                '[role="alertdialog"]',
            ),
        ).toHaveClass("border-red-200", "bg-red-50");
        expect(screen.getByTestId("restored-draft")).toHaveTextContent(
            "Create it once",
        );
        const firstTurnId =
            mocks.streamChat.mock.calls[0][0].current_turn.turn_id;

        await user.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(mocks.streamChat).toHaveBeenCalledTimes(2));

        expect(mocks.streamChat.mock.calls[1][0].current_turn.turn_id).toBe(
            firstTurnId,
        );
        expect(mocks.clearDraft).toHaveBeenCalledOnce();
    });

    it("announces response progress and only reports successful completion", async () => {
        const handleChat = vi.fn().mockResolvedValue(null);
        const cancel = vi.fn();
        const { rerender } = render(
            <ChatView
                chatId="chat-1"
                session={createAssistantSessionState({ chatId: "chat-1" })}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        const status = screen.getByRole("status");
        expect(status).toBeEmptyDOMElement();

        rerender(
            <ChatView
                chatId="chat-1"
                session={{ ...createAssistantSessionState({ chatId: "chat-1", messages: [
                    { id: "user-1", role: "user", content: "Question" },
                    { id: "assistant-1", role: "assistant", content: "" },
                ] }), run: { id: "run-1", status: "running", chatId: "chat-1" } }}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        await waitFor(() =>
            expect(status).toHaveTextContent("Assistant is responding."),
        );

        rerender(
            <ChatView
                chatId="chat-1"
                session={createAssistantSessionState({ chatId: "chat-1", messages: [
                    { id: "user-1", role: "user", content: "Question" },
                    { id: "assistant-1", role: "assistant", content: "Answer" },
                ] })}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        await waitFor(() =>
            expect(status).toHaveTextContent("Response ready."),
        );

        rerender(
            <ChatView
                chatId="chat-1"
                session={{ ...createAssistantSessionState({ chatId: "chat-1", messages: [
                    { id: "user-1", role: "user", content: "Question" },
                    { id: "assistant-1", role: "assistant", content: "" },
                    { id: "user-2", role: "user", content: "Another question" },
                    { id: "assistant-2", role: "assistant", content: "" },
                ] }), run: { id: "run-2", status: "running", chatId: "chat-1" } }}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        await waitFor(() =>
            expect(status).toHaveTextContent("Assistant is responding."),
        );

        rerender(
            <ChatView
                chatId="chat-1"
                session={createAssistantSessionState({ chatId: "chat-1", messages: [
                    { id: "user-1", role: "user", content: "Question" },
                    { id: "assistant-1", role: "assistant", content: "" },
                    { id: "user-2", role: "user", content: "Another question" },
                    {
                        id: "assistant-2",
                        role: "assistant",
                        content: [{ type: "error", message: "Provider unavailable." }],
                    },
                ] })}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        await waitFor(() => expect(status).toBeEmptyDOMElement());

        rerender(
            <ChatView
                chatId="chat-1"
                session={createAssistantSessionState({ chatId: "chat-1", messages: [
                    { id: "user-1", role: "user", content: "Question" },
                    {
                        id: "assistant-1",
                        role: "assistant",
                        content: [
                            { type: "content", text: "Partial answer" },
                            { type: "turn_status", status: "cancelled" },
                        ],
                    },
                ] })}
                handleChat={handleChat}
                cancel={cancel}
            />,
        );
        expect(screen.getByText("Response stopped")).toBeVisible();
    });
});
