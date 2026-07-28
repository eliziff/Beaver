import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Document, Message } from "../shared/types";
import { ChatView, type ChatViewHandle } from "./ChatView";

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
    it("attaches the active document to a workflow turn", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn();
        render(
            <ChatView
                messages={[{ role: "assistant", content: "", events: [] }]}
                isResponseLoading={false}
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
                messages={[]}
                isResponseLoading={false}
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
