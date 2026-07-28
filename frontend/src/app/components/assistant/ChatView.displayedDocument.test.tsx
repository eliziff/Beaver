import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../shared/types";
import { ChatView } from "./ChatView";

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
});
