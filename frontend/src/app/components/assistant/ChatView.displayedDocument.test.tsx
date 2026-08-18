import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Document, Message } from "../shared/types";
import { ChatView, type ChatViewHandle } from "./ChatView";
import { createAssistantSessionState } from "@/app/lib/assistantSession";

const session = (messages: Message[] = [], running = false) => ({
    ...createAssistantSessionState({ messages }),
    ...(running && { run: { id: "run-1", status: "running" as const } }),
});

vi.stubGlobal(
    "ResizeObserver",
    class {
        observe() {}
        disconnect() {}
    },
);

vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AskInputPopup", () => ({ AskInputPopup: () => null }));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("./AssistantSidePanel", () => ({ AssistantSidePanel: () => null }));
vi.mock("./AssistantMessage", () => ({
    AssistantMessage: ({
        onOpenDocument,
    }: {
        onOpenDocument: (document: {
            documentId: string;
            filename: string;
            versionId: string | null;
            versionNumber: number | null;
        }) => void;
    }) => (
        <button
            type="button"
            onClick={() =>
                onOpenDocument({
                    documentId: "document-1",
                    filename: "Lease.docx",
                    versionId: "version-1",
                    versionNumber: 1,
                })
            }
        >
            Open Lease
        </button>
    ),
}));
vi.mock("./ChatInput", () => ({
    ChatInput: React.forwardRef(function MockChatInput(
        {
            onSubmit,
        }: {
            onSubmit: (message: Message) => void;
        },
        _ref,
    ) {
        return (
            <button
                type="button"
                onClick={() =>
                    onSubmit({
                        role: "user",
                        content: "extract key terms",
                        workflow: {
                            id: "builtin-extract-key-terms",
                            title: "Extract Key Terms",
                        },
                    })
                }
            >
                Run workflow
            </button>
        );
    }),
}));

describe("ChatView displayed document context", () => {
    it("keeps one scroll listener while streaming messages update", async () => {
        const addEventListener = vi.spyOn(
            HTMLElement.prototype,
            "addEventListener",
        );
        const removeEventListener = vi.spyOn(
            HTMLElement.prototype,
            "removeEventListener",
        );
        const { container, rerender, unmount } = render(
            <ChatView
                session={session([
                    { role: "assistant", content: "First", events: [] },
                ], true)}
                handleChat={vi.fn()}
                cancel={vi.fn()}
            />,
        );
        const scroller = container.querySelector(
            ".overflow-y-auto",
        ) as HTMLElement;
        Object.defineProperties(scroller, {
            scrollHeight: { configurable: true, value: 1000 },
            clientHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, value: 0 },
        });
        addEventListener.mockClear();
        removeEventListener.mockClear();

        rerender(
            <ChatView
                session={session([
                    {
                        role: "assistant",
                        content: "First streaming delta",
                        events: [],
                    },
                ], true)}
                handleChat={vi.fn()}
                cancel={vi.fn()}
            />,
        );
        act(() => scroller.dispatchEvent(new Event("scroll")));

        await waitFor(() =>
            expect(
                container.querySelector("button.cursor-pointer.rounded-full"),
            ).not.toBeNull(),
        );
        expect(addEventListener).not.toHaveBeenCalledWith(
            "scroll",
            expect.any(Function),
        );
        expect(removeEventListener).not.toHaveBeenCalledWith(
            "scroll",
            expect.any(Function),
        );

        unmount();
        expect(removeEventListener).toHaveBeenCalledWith(
            "scroll",
            expect.any(Function),
        );
    });

    it("attaches the active document to a workflow turn", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn();
        render(
            <ChatView
                session={session([{ role: "assistant", content: "", events: [] }])}
                handleChat={handleChat}
                cancel={vi.fn()}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Open Lease" }));
        await user.click(screen.getByRole("button", { name: "Run workflow" }));

        expect(handleChat).toHaveBeenCalledWith({
            role: "user",
            content: "extract key terms",
            workflow: {
                id: "builtin-extract-key-terms",
                title: "Extract Key Terms",
            },
            files: [
                {
                    filename: "Lease.docx",
                    document_id: "document-1",
                },
            ],
        });
    });

    it("keeps project document context separate from attachments", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn();
        const onActiveDocumentChange = vi.fn();
        const ref = React.createRef<ChatViewHandle>();
        render(
            <ChatView
                ref={ref}
                session={session()}
                handleChat={handleChat}
                cancel={vi.fn()}
                useDisplayedDocumentContext
                onActiveDocumentChange={onActiveDocumentChange}
            />,
        );

        act(() =>
            ref.current?.openDocument({
                id: "document-1",
                filename: "Lease.docx",
                current_version_id: "version-1",
                active_version_number: 1,
            } as Document),
        );
        await waitFor(() =>
            expect(onActiveDocumentChange).toHaveBeenLastCalledWith(
                "document-1",
            ),
        );
        await user.click(screen.getByRole("button", { name: "Run workflow" }));

        expect(handleChat).toHaveBeenCalledWith(
            {
                role: "user",
                content: "extract key terms",
                workflow: {
                    id: "builtin-extract-key-terms",
                    title: "Extract Key Terms",
                },
            },
            {
                displayedDoc: {
                    filename: "Lease.docx",
                    documentId: "document-1",
                },
            },
        );

        act(() => ref.current?.closeDocument("document-1"));
        await waitFor(() =>
            expect(onActiveDocumentChange).toHaveBeenLastCalledWith(null),
        );
    });
});
