import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { ChatView } from "./ChatView";

const mocks = vi.hoisted(() => ({
    clearDraft: vi.fn(),
    streamChat: vi.fn(),
    loadChats: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));
vi.mock("@/app/lib/mikeApi", () => ({
    getChat: vi.fn(),
    streamChat: mocks.streamChat,
    streamProjectChat: vi.fn(),
}));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({
        replaceChatId: vi.fn(),
        loadChats: mocks.loadChats,
        setCurrentChatId: vi.fn(),
        saveChat: vi.fn(),
        setNewChatMessages: vi.fn(),
    }),
}));
vi.mock("@/app/hooks/useGenerateChatTitle", () => ({
    useGenerateChatTitle: () => ({ generate: vi.fn() }),
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
                    void chat.handleChat({
                        role: "user",
                        content: "Create it once",
                    })
                }
            >
                Start
            </button>
            <ChatView
                chatId="chat-1"
                messages={chat.messages}
                isResponseLoading={chat.isResponseLoading}
                handleChat={chat.handleChat}
                cancel={chat.cancel}
                rejectedTurn={chat.rejectedTurn}
                onRejectedTurnRestored={chat.clearRejectedTurn}
                onRetryRejectedTurn={() => void chat.retryRejectedTurn()}
            />
        </>
    );
}

describe("ChatView rejected normal turn", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadChats.mockResolvedValue(undefined);
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
        await screen.findByText("Response interrupted");
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
});
