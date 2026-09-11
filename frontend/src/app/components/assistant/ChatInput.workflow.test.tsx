import { Profiler, useRef } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { CHAT_DOCUMENT_DRAG_TYPE } from "../documents/documentTree";
import { updateAssistantPreferences } from "./assistantPreferences";

const selectedDocument: Document = {
    id: "document-1",
    project_id: null,
    filename: "Lease.docx",
    file_type: "docx",
    pdf_storage_path: null,
    size_bytes: 100,
    page_count: 1,
    created_at: "2026-07-27T00:00:00Z",
};
const selectedTemplate: Document = {
    ...selectedDocument,
    id: "template-1",
    filename: "Pleading.docx",
    library_kind: "template",
};

vi.mock("../modals/AddDocumentsModal", () => ({
    AddDocumentsModal: (props: {
        open: boolean;
        onClose: () => void;
        onSelect: (documents: Document[]) => void;
        primaryLabel?: string;
        initialTab?: string;
    }) =>
        props.open ? (
            <button
                type="button"
                data-initial-tab={props.initialTab}
                onClick={() => {
                    props.onSelect([selectedDocument]);
                    props.onClose();
                }}
            >
                {props.primaryLabel}
            </button>
        ) : null,
}));
vi.mock("../workflows/WorkflowPickerModal", () => ({
    WorkflowPickerModal: ({ open, onSelect, onClose }: {
        open: boolean;
        onSelect: (selection: {
            workflow: { id: string; metadata: { title: string } };
            variant: { id: string; label: string; execution: "assistant" };
        }) => void;
        onClose: () => void;
    }) => open ? <button type="button" onClick={async () => {
        onClose();
        await onSelect({ workflow: { id: "drafting", metadata: { title: "Drafting" } },
            variant: { id: "builtin-draft-from-template", label: "Draft from template",
                execution: "assistant" } });
    }}>Choose template workflow</button> : null,
}));
vi.mock("../popups/ApiKeyMissingPopup", () => ({
    ApiKeyMissingPopup: () => null,
}));
vi.mock("./ModelToggle", () => ({
    ModelToggle: () => null,
    ReasoningEffortToggle: () => null,
    ModelEffortToggle: () => null,
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
            <button type="button" onClick={() => inputRef.current?.addDoc(selectedTemplate)}>
                Attach template
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

function chatInput(props: Partial<React.ComponentProps<typeof ChatInput>> = {}) {
    return <ChatInput onSubmit={vi.fn()} onCancel={vi.fn()} isLoading={false} {...props} />;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("opens the loaded draft immediately and keeps it cleared after sending", () => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const onSubmit = vi.fn();
    const draft = { role: "user" as const, content: "Ready to continue", documents: [selectedDocument] };
    const view = render(chatInput({ draftChatId: "loaded-draft-send", initialDraft: draft, onSubmit }));
    expect(screen.getByRole("textbox")).toHaveValue(draft.content);
    expect(screen.getByText(selectedDocument.filename)).toBeVisible();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ content: draft.content }));
    view.unmount();
    render(chatInput({ draftChatId: "loaded-draft-send", initialDraft: draft, onSubmit }));
    expect(screen.getByRole("textbox")).toHaveValue("");
});

it("restores the page's loaded draft before exposing the ready composer", () => {
    const props = { draftChatId: "late-page-draft", onSubmit: vi.fn(), onCancel: vi.fn(), isLoading: false };
    const view = render(chatInput({ ...props, initialDraft: null }));
    view.rerender(chatInput({
        ...props,
        initialDraft: { role: "user", content: "Loaded with the conversation" },
    }));
    expect(screen.getByRole("textbox")).toHaveValue("Loaded with the conversation");
});

it("does not duplicate a saved interrupted request when restoring it again", async () => {
    const draft = { role: "user" as const, content: "A request to recover", turnId: "interrupted-turn" };
    const props = { draftChatId: "interrupted-saved-draft", initialDraft: draft,
        onSubmit: vi.fn(), onCancel: vi.fn(), isLoading: false };
    const view = render(chatInput({ ...props, restoreDraft: draft }));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getByRole("textbox")).toHaveValue(draft.content);
    view.rerender(chatInput({ ...props, restoreDraft: { ...draft } }));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(screen.getByRole("textbox")).toHaveValue(draft.content);
});

it("opens and reopens a saved draft without writing it, then saves actual edits", async () => {
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "PATCH") {
            writes.push(JSON.parse(String(init.body)).draft);
            return Response.json({});
        }
        return Response.json({ chat: { id: "draft-read-only", draft: {
            role: "user", content: "Unsent question", documents: [selectedDocument],
            workflow: { id: "drafting", title: "Drafting" }, model: "gpt-5.2", reasoningEffort: "high",
        } }, messages: [] });
    }));
    const input = <ChatInput draftChatId="draft-read-only" onSubmit={vi.fn()} onCancel={vi.fn()} isLoading={false} />;
    const view = render(input);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Unsent question"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(writes).toEqual([]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited question" } });
    await waitFor(() => expect(writes).toEqual([expect.objectContaining({ content: "Edited question" })]));
    view.unmount();
    render(input);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Edited question"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(writes).toHaveLength(1);
});

it("keeps a failed draft in the composer and retries inline without a dialog", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValue(undefined);
    render(chatInput({ onDraftChange: save }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this question" } });
    const retry = await screen.findByRole("button", { name: "Retry saving" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("Keep this question");
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saving" })).toBeNull());
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ content: "Keep this question" }));
});

describe("ChatInput workflow document selection", () => {
    it("opens the shared workflow dock with the current context", async () => {
        const onOpenWorkflows = vi.fn();
        render(chatInput({ onOpenWorkflows }));

        await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
        expect(onOpenWorkflows).toHaveBeenCalledWith(undefined, []);
    });

    it("does not let the closing workflow modal cancel its document handoff", async () => {
        render(chatInput());

        await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
        await userEvent.click(screen.getByRole("button", { name: "Choose template workflow" }));

        expect(screen.getByRole("button", { name: "Use document" }))
            .toHaveAttribute("data-initial-tab", "templates");
    });

    it("uses an attached template without asking for it again", async () => {
        render(<WorkflowHarness onSubmit={vi.fn()} />);

        await userEvent.click(screen.getByRole("button", { name: "Attach template" }));
        await userEvent.click(screen.getByRole("button", { name: "Workflows" }));
        await userEvent.click(screen.getByRole("button", { name: "Choose template workflow" }));

        expect(screen.queryByRole("button", { name: "Use document" })).toBeNull();
        expect(screen.getByText("Draft from template")).toBeVisible();
    });

    it("hides Auto Mode until enabled and preserves the selected mode", async () => {
        const initial = render(<WorkflowHarness onSubmit={vi.fn()} />);
        expect(screen.queryByRole("group", { name: "Editing mode" })).toBeNull();
        initial.unmount();

        updateAssistantPreferences({ showAutoMode: true });
        const onSubmit = vi.fn();
        const enabled = render(<WorkflowHarness onSubmit={onSubmit} />);
        const mode = screen.getByRole("group", { name: "Editing mode" });
        expect(within(mode).getByRole("button", { name: "Manual" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
        await userEvent.click(within(mode).getByRole("button", { name: "Auto" }));
        await userEvent.type(screen.getByRole("textbox"), "Revise it");
        await userEvent.click(screen.getByRole("button", { name: "Send message" }));
        expect(onSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ editMode: "auto" }),
        );
        enabled.unmount();
        render(<WorkflowHarness onSubmit={vi.fn()} />);
        expect(screen.getByRole("button", { name: "Auto" })).toHaveAttribute(
            "aria-pressed",
            "true",
        );
    });

    it("attaches a Library drag without uploading it again", async () => {
        const onSubmit = vi.fn();
        const { container } = render(<WorkflowHarness onSubmit={onSubmit} />);
        const dataTransfer = {
            types: [CHAT_DOCUMENT_DRAG_TYPE],
            files: [],
            dropEffect: "none",
            getData: () => JSON.stringify([selectedDocument]),
        };
        const dropTarget = container.querySelector(".chat-input-container")!;

        fireEvent.dragOver(dropTarget, { dataTransfer });
        fireEvent.drop(dropTarget, { dataTransfer });
        await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Review it");
        await userEvent.click(screen.getByRole("button", { name: "Send message" }));

        expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
            files: [{ filename: "Lease.docx", document_id: "document-1" }],
        }));
    });

    it("does not rerender for each typed character", async () => {
        const user = userEvent.setup();
        let commits = 0;
        render(
            <Profiler id="chat-input" onRender={() => commits++}>
                <WorkflowHarness onSubmit={vi.fn()} />
            </Profiler>,
        );

        commits = 0;
        const textbox = screen.getByRole("textbox", { name: "Message" });
        await user.type(textbox, "test");
        expect(commits).toBe(1);

        commits = 0;
        await user.click(screen.getByRole("button", { name: "Attach Lease" }));
        expect(commits).toBe(1);
    });

    it("restores a draft and cancels a loading response", async () => {
        const onCancel = vi.fn();
        const onDraftRestored = vi.fn();
        render(chatInput({
            onCancel,
            isLoading: true,
            restoreDraft: { role: "user", content: "restored" },
            onDraftRestored,
        }));

        await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("restored"));
        expect(onDraftRestored).toHaveBeenCalledOnce();
        await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
        expect(onCancel).toHaveBeenCalledOnce();
    });
    it("preserves the latest unsent text when navigation unmounts the composer", async () => {
        const save = vi.fn().mockResolvedValue(undefined), submit = vi.fn();
        const { unmount } = render(chatInput({ onSubmit: submit, onCancel: () => { }, onDraftChange: save }));
        await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "An unfinished question");
        unmount();
        expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ content: "An unfinished question" }));
        expect(submit).not.toHaveBeenCalled();
    });

    it("replaces send with stop while a response is live", async () => {
        const onCancel = vi.fn();
        render(chatInput({ onCancel, isLoading: true }));

        expect(
            screen.queryByRole("button", { name: "Send message" }),
        ).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Stop response" }));
        expect(onCancel).toHaveBeenCalledOnce();
    });

    it("hides context usage when the display preference is off", () => {
        updateAssistantPreferences({ showContextUsage: false });
        render(chatInput({ contextUsage: { usedTokens: 25, windowTokens: 100, compacting: false } }));

        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("navigates prompt history and restores the unsent draft", async () => {
        const user = userEvent.setup();
        render(chatInput({ promptHistory: ["first prompt", "second prompt"] }));
        const textbox = screen.getByRole("textbox", {
            name: "Message",
        }) as HTMLTextAreaElement;
        await user.type(textbox, "draft");

        await user.keyboard("{ArrowUp}");
        expect(textbox).toHaveValue("second prompt");
        await user.keyboard("{ArrowUp}");
        expect(textbox).toHaveValue("first prompt");
        await user.keyboard("{ArrowDown}{ArrowDown}");
        expect(textbox).toHaveValue("draft");

        fireEvent.change(textbox, { target: { value: "line one\nline two" } });
        textbox.setSelectionRange(10, 10);
        fireEvent.keyDown(textbox, { key: "ArrowUp" });
        expect(textbox).toHaveValue("line one\nline two");
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
