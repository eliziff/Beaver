import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";

vi.mock("react-router-dom", () => ({
    useLocation: () => ({ pathname: "/assistant" }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: null }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    createChat: vi.fn(),
    deleteChat: vi.fn(),
    listChats: vi.fn(),
    renameChat: vi.fn(),
}));

describe("ChatHistoryProvider pending message handoff", () => {
    it("is scoped, one-shot, and does not invalidate consumers", async () => {
        const onRender = vi.fn();
        const message = { role: "user" as const, content: "Draft this" };
        let results: unknown[] = [];

        function Probe() {
            const history = useChatHistoryContext();
            return (
                <>
                    <span>stable:{history.chats?.length ?? "loading"}</span>
                    <button
                        onClick={() => {
                            history.stagePendingChatMessage("chat-a", message);
                            results = [
                                history.peekPendingChatMessage("chat-b"),
                                history.claimPendingChatMessage("chat-b"),
                                history.peekPendingChatMessage("chat-a"),
                                history.claimPendingChatMessage("chat-a"),
                                history.claimPendingChatMessage("chat-a"),
                            ];
                        }}
                    >
                        Exercise handoff
                    </button>
                </>
            );
        }

        render(
            <ChatHistoryProvider>
                <Profiler id="history-consumer" onRender={onRender}>
                    <Probe />
                </Profiler>
            </ChatHistoryProvider>,
        );
        await waitFor(() => expect(screen.getByText("stable:0")).toBeVisible());
        const settledRenders = onRender.mock.calls.length;

        fireEvent.click(screen.getByRole("button", { name: "Exercise handoff" }));
        expect(results).toEqual([null, null, message, message, null]);
        expect(onRender).toHaveBeenCalledTimes(settledRenders);
    });
});
