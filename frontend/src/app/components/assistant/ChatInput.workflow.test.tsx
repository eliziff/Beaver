import { Profiler, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "../shared/types";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

const selectedDocument: Document = {
    id: "document-1",
    project_id: null,
    filename: "Lease.docx",
    file_type: "docx",
    storage_path: "unused",
    pdf_storage_path: null,
    size_bytes: 100,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-27T00:00:00Z",
};

vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: (props: {
        open: boolean;
        onClose: () => void;
        onSelect: (documents: Document[]) => void;
        primaryLabel?: string;
    }) =>
        props.open ? (
            <button
                type="button"
                onClick={() => {
                    props.onSelect([selectedDocument]);
                    props.onClose();
                }}
            >
                {props.primaryLabel}
            </button>
        ) : null,
}));
vi.mock("./AssistantWorkflowModal", () => ({
    AssistantWorkflowModal: () => null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));
vi.mock("./ModelToggle", () => ({
    ModelToggle: () => null,
    ReasoningEffortToggle: () => null,
}));
vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["gpt-5.2", vi.fn()],
    useSelectedReasoningEffort: () => ["high", vi.fn()],
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));

function WorkflowHarness({ onSubmit }: { onSubmit: ReturnType<typeof vi.fn> }) {
    const inputRef = useRef<ChatInputHandle>(null);
    return (
        <>
            <button
                type="button"
                onClick={() => inputRef.current?.addDoc(selectedDocument)}
            >
                Attach Lease
            </button>
            <button
                type="button"
                onClick={() =>
                    inputRef.current?.startWorkflowDocumentSelection(
                        {
                            id: "builtin-extract-key-terms",
                            title: "Extract Key Terms",
                        },
                        "extract key terms",
                    )
                }
            >
                Extract key terms
            </button>
            <ChatInput
                ref={inputRef}
                onSubmit={onSubmit}
                onCancel={() => undefined}
                isLoading={false}
            />
        </>
    );
}

describe("ChatInput workflow document selection", () => {
    it("does not rerender for each typed character", async () => {
        const user = userEvent.setup();
        let commits = 0;
        render(
            <Profiler id="chat-input" onRender={() => commits++}>
                <WorkflowHarness onSubmit={vi.fn()} />
            </Profiler>,
        );

        commits = 0;
        const textbox = screen.getByRole("textbox");
        expect(textbox.className).toContain("[field-sizing:content]");
        await user.type(textbox, "test");
        expect(commits).toBe(1);

        commits = 0;
        await user.click(screen.getByRole("button", { name: "Attach Lease" }));
        expect(commits).toBe(1);
    });

    it("restores a draft and cancels a loading response", async () => {
        const onCancel = vi.fn();
        const onDraftRestored = vi.fn();
        render(
            <ChatInput
                onSubmit={vi.fn()}
                onCancel={onCancel}
                isLoading
                restoreDraft={{ role: "user", content: "restored" }}
                onDraftRestored={onDraftRestored}
            />,
        );

        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("restored"));
        expect(onDraftRestored).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("attaches the selected document and offers one format-neutral action", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        render(<WorkflowHarness onSubmit={onSubmit} />);

        await user.click(
            screen.getByRole("button", { name: "Extract key terms" }),
        );
        expect(
            screen.getByRole("button", { name: "Use document" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/Open PDF|Open DOCX|Open text/iu),
        ).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Use document" }));
        await user.type(screen.getByRole("textbox"), "{Enter}");

        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
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
                model: "gpt-5.2",
                reasoningEffort: "high",
            }),
        );
    });

    it("reuses an attached document without reopening selection", async () => {
        const user = userEvent.setup();
        const onSubmit = vi.fn();
        render(<WorkflowHarness onSubmit={onSubmit} />);

        await user.click(screen.getByRole("button", { name: "Attach Lease" }));
        await user.click(
            screen.getByRole("button", { name: "Extract key terms" }),
        );

        expect(
            screen.queryByRole("button", { name: "Use document" }),
        ).toBeNull();
        await user.type(screen.getByRole("textbox"), "{Enter}");
        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({
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
        );
    });
});
