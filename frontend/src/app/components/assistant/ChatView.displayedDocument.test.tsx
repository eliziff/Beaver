import React from "react";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { Document } from "@/app/lib/api/documents";
import type { Message } from "@/app/lib/api/chat";
import { ChatView, type ChatViewHandle } from "./ChatView";
import { createAssistantSessionState } from "@/app/lib/assistantSession";
import { newResearchState, type ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "../legal/SourcesWorkspace";
const render = (ui: React.ReactNode, options?: Parameters<typeof rtlRender>[1]) => rtlRender(ui, { wrapper: MemoryRouter, ...options });

const dockMocks = vi.hoisted(() => ({
    addDocument: vi.fn(),
    startWorkflow: vi.fn(),
}));

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
vi.mock("./AssistantSidePanel", () => {
    return { AssistantSidePanel: ({ researchRefreshKey }: { researchRefreshKey?: string | null }) =>
        <output aria-label="Research refresh key">{researchRefreshKey ?? "none"}</output> };
});
vi.mock("../workflows/ContextualWorkflowPicker", () => ({
    ContextualWorkflowLauncher: () => null,
    ContextualWorkflowPicker: ({ onAssistantSelect, onRun, initialWorkflowId, documents = [] }: {
        onAssistantSelect: (selection: unknown, documents: Document[]) => void;
        onRun?: (message: Message, document: Document) => void;
        initialWorkflowId?: string;
        documents?: Document[];
    }) => {
        return (
        <>
            <output aria-label="Opened workflow">{initialWorkflowId ?? "none"}</output>
            <output aria-label="Workflow documents">{documents.map(({ filename }) =>
                filename).join(", ") || "none"}</output>
            <button type="button" onClick={() => onRun?.({ role: "user", content: "Fix supras",
                files: documents.map(({ id, filename }) => ({ document_id: id, filename })),
                editMode: "manual" }, documents[0])}>Run document operation</button>
            <button type="button" onClick={() => onAssistantSelect({ workflow: {
                id: "drafting", metadata: { title: "Drafting" },
            }, variant: { id: "builtin-proofread", label: "Proofread",
                execution: "assistant" } }, documents)}>
                Proofread
            </button>
            <button type="button" onClick={() => onAssistantSelect({ workflow: {
                id: "drafting", metadata: { title: "Drafting" },
            }, variant: { id: "builtin-draft-from-template", label: "Draft from template",
                execution: "assistant" } }, documents)}>
                Draft from template
            </button>
        </>
        );
    },
}));
vi.mock("@/app/components/library/LibraryWorkspace", () => ({
    LibraryWorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
    LibraryCollectionPage: ({ kind, onOpenInChat, onOpenWorkflows }: {
        kind: string; onOpenInChat: (documents: Document[]) => void;
        onOpenWorkflows?: (documents: Document[]) => void;
    }) => {
        const [query, setQuery] = React.useState("");
        const documents = [{ id: "template-1", filename: "Pleading.docx" } as Document];
        return <><input aria-label="Library query" value={query}
            onChange={(event) => setQuery(event.target.value)} /><button type="button"
            data-library-kind={kind}
            onClick={() => onOpenInChat(documents)}>
            Use Pleading template
        </button>{onOpenWorkflows && <button type="button"
            onClick={() => onOpenWorkflows(documents)}>
            Use Pleading in workflows
        </button>}</>;
    },
}));
vi.mock("@/app/components/legal/LegalLibrary", () => ({
    LegalLibraryPage: ({ onOpenSource, researchRefreshKey }: {
        onOpenSource?: (tab: unknown) => void;
        researchRefreshKey?: string | null;
    }) => {
        const [query, setQuery] = React.useState("");
        return <><input aria-label="Sources query" value={query}
            onChange={(event) => setQuery(event.target.value)} />
            <output aria-label="Sources refresh key">{researchRefreshKey ?? "none"}</output>
            <button type="button" onClick={() => onOpenSource?.({
                kind: "legal", id: "legal:a2aj:2024-scc-1", provider: "a2aj",
                sourceId: "2024-scc-1", citation: "2024 SCC 1", name: "Example v Test",
                dataset: "SCC", docType: "cases", language: "en",
                researchFileId: "research-1", researchSourceId: "saved-1",
            })}>View source</button></>;
    },
}));
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
            onOpenWorkflows,
        }: {
            onSubmit: (message: Message) => void;
            onOpenWorkflows?: (initialWorkflowId?: string, documents?: Document[]) => void;
        },
        ref,
    ) {
        React.useImperativeHandle(ref, () => ({
            addDoc: dockMocks.addDocument,
            clearDraft: vi.fn(),
            startWorkflowDocumentSelection: dockMocks.startWorkflow,
        }));
        return (<>
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
                Workflows
            </button>
            {onOpenWorkflows && <button type="button"
                onClick={() => onOpenWorkflows()}>
                Browse workflows
            </button>}
            {onOpenWorkflows && <button type="button"
                onClick={() => onOpenWorkflows(undefined,
                    [{ id: "lease", filename: "Lease.docx" } as Document])}>
                Browse workflows with Lease
            </button>}
            {onOpenWorkflows && <button type="button"
                onClick={() => onOpenWorkflows("court-records")}>
                Open Court Records workflow
            </button>}
        </>);
    }),
}));

describe("ChatView displayed document context", () => {
    it("submits an assistant intent once after its workspace and chat are ready in StrictMode", async () => {
        const handleChat = vi.fn().mockResolvedValue(null), onIntentSent = vi.fn();
        const file = { document: { id: "research-1", filename: "Appeal.research.md" }, state: newResearchState(), versionId: "v1", workingRevision: 1 } as ResearchFile;
        const selection = { target: "sources" as const, members: [{ sourceId: "source-1", evidenceIds: ["exact-passage"] }] };
        const intent = { id: "organize-1", text: "Organize the selected sources and passages" };
        const view = (ready: boolean) => <React.StrictMode><SourcesWorkspaceProvider file={file} selection={selection}>
            <ChatView session={session()} ready={ready} initialIntent={intent} onIntentSent={onIntentSent}
                handleChat={handleChat} cancel={vi.fn()} />
        </SourcesWorkspaceProvider></React.StrictMode>;
        const { rerender } = render(view(false));
        expect(handleChat).not.toHaveBeenCalled();
        rerender(view(true));
        await waitFor(() => expect(handleChat).toHaveBeenCalledWith({ role: "user", content: intent.text,
            research_file_id: "research-1", research_selection: selection }));
        rerender(view(true));
        expect(handleChat).toHaveBeenCalledTimes(1);
        expect(onIntentSent).toHaveBeenCalledTimes(1);
    });
    it("opens supplied project files in the existing assistant dock", async () => {
        const user = userEvent.setup();
        render(
            <ChatView
                session={session()}
                handleChat={vi.fn()}
                cancel={vi.fn()}
                projectFiles={<p>Project explorer content</p>}
                projectFileActions={<button type="button">Upload project files</button>}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Expand assistant dock" }));
        expect(screen.getByRole("tab", { name: "Project files" }))
            .toHaveAttribute("aria-selected", "true");
        expect(screen.getByText("Project explorer content")).toBeVisible();
        const upload = screen.getByRole("button", { name: "Upload project files" });
        expect(screen.getByRole("tablist", { name: "Assistant panels" }))
            .not.toContainElement(upload);
        expect(upload.closest("[data-tabs-rail]")).not.toBeNull();
    });

    it("attaches initial documents once through the chat input", async () => {
        const initialDocuments = [{ id: "document-1", filename: "Brief.docx" } as Document];
        dockMocks.addDocument.mockClear();
        const { rerender } = render(<ChatView session={session()} handleChat={vi.fn()}
            cancel={vi.fn()} initialDocuments={initialDocuments} />);

        await waitFor(() => expect(dockMocks.addDocument).toHaveBeenCalledWith(initialDocuments[0]));
        rerender(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()}
            initialDocuments={[...initialDocuments]} />);
        expect(dockMocks.addDocument).toHaveBeenCalledTimes(1);
    });

    it("restores a project workflow launch without sending a fake turn", async () => {
        const initialDocuments = [{ id: "document-1", filename: "Brief.docx" } as Document];
        const handleChat = vi.fn();
        dockMocks.addDocument.mockClear();
        dockMocks.startWorkflow.mockClear();
        const view = <ChatView session={session()} handleChat={handleChat} cancel={vi.fn()}
            initialDocuments={initialDocuments} initialWorkflow={{
                workflow: { id: "drafting", variant_id: "proofread", title: "Drafting" },
                documentTab: "files",
            }} />;
        const { rerender } = render(view);

        await waitFor(() => expect(dockMocks.startWorkflow).toHaveBeenCalledWith(
            expect.objectContaining({ id: "drafting", variant_id: "proofread" }),
            undefined, { initialDocumentTab: "files", openDocumentPicker: false },
        ));
        expect(screen.getByRole("tab", { name: "Workflows" }))
            .toHaveAttribute("aria-selected", "true");
        expect(handleChat).not.toHaveBeenCalled();
        rerender(view);
        expect(dockMocks.startWorkflow).toHaveBeenCalledTimes(1);
    });

    it("keeps the dock open when a workflow is selected", async () => {
        const user = userEvent.setup();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows with Lease" }));
        expect(screen.getByRole("status", { name: "Workflow documents" }))
            .toHaveTextContent("Lease.docx");
        await user.click(screen.getByRole("button", { name: "Proofread" }));

        expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Collapse assistant dock" })).toBeVisible();
    });

    it("opens the selected document and runs the operation in the current chat", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn(() => new Promise<string | null>(() => {}));
        render(<ChatView session={session()} handleChat={handleChat} cancel={vi.fn()} />);
        await user.click(screen.getByRole("button", { name: "Browse workflows with Lease" }));
        await user.click(screen.getByRole("button", { name: "Run document operation" }));
        expect(handleChat).toHaveBeenCalledWith(expect.objectContaining({ editMode: "manual",
            files: [expect.objectContaining({ filename: "Lease.docx" })] }));
        expect(screen.getByRole("tab", { name: "Sources" })).toHaveAttribute("aria-selected", "true");
    });

    it("opens a newly requested workflow in the existing dock", async () => {
        const user = userEvent.setup();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        expect(screen.getByRole("status", { name: "Opened workflow" })).toHaveTextContent("none");
        await user.click(screen.getByRole("button", { name: "Open Court Records workflow" }));

        expect(screen.getByRole("status", { name: "Opened workflow" }))
            .toHaveTextContent("court-records");
    });

    it("starts a workflow selected directly from the dock", async () => {
        const user = userEvent.setup();
        dockMocks.startWorkflow.mockClear();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()}
            projectFiles={<p>Project files</p>} />);

        await user.click(screen.getByRole("button", { name: "Expand assistant dock" }));
        await user.click(screen.getByRole("tab", { name: "Workflows" }));
        await user.click(screen.getByRole("button", { name: "Proofread" }));

        expect(dockMocks.startWorkflow).toHaveBeenCalledWith(
            expect.objectContaining({ id: "drafting" }), undefined,
            { initialDocumentTab: "files", openDocumentPicker: false },
        );
    });

    it("keeps Library and Sources state mounted while switching dock tabs", async () => {
        const user = userEvent.setup();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("tab", { name: "Library" }));
        await user.type(screen.getByRole("textbox", { name: "Library query" }), "pleading");
        await user.click(screen.getByRole("tab", { name: "Sources" }));
        await user.type(screen.getByRole("textbox", { name: "Sources query" }), "appeal");
        await user.click(screen.getByRole("tab", { name: "Workflows" }));
        await user.click(screen.getByRole("tab", { name: "Library" }));

        expect(screen.getByRole("textbox", { name: "Library query" })).toHaveValue("pleading");
        await user.click(screen.getByRole("tab", { name: "Sources" }));
        expect(screen.getByRole("textbox", { name: "Sources query" })).toHaveValue("appeal");
    });

    it("opens an embedded search result in the reader without leaving chat", async () => {
        const user = userEvent.setup();
        render(<ChatView chatId="chat-1" session={session()} handleChat={vi.fn()}
            cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("tab", { name: "Sources" }));
        await user.click(screen.getByRole("button", { name: "View source" }));

        await waitFor(() => expect(screen.queryByRole("textbox", { name: "Sources query" }))
            .not.toBeInTheDocument());
        expect(screen.getByRole("tab", { name: "Sources" }))
            .toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("button", { name: "Workflows" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open as" })).not.toBeInTheDocument();
    });

    it("offers research views only when an ordinary chat has legal evidence", () => {
        const props = { chatId: "chat-1", handleChat: vi.fn(), cancel: vi.fn() };
        const { rerender } = render(<ChatView {...props} session={session()} />, { wrapper: MemoryRouter });
        expect(screen.queryByRole("button", { name: "Open as" })).not.toBeInTheDocument();

        const withLegalEvidence = createAssistantSessionState({ messages: [{
            id: "assistant-1", role: "assistant", turn_complete: true,
            content: [{ type: "tool_activity", id: "search-1", tool: "search_sources",
                label: "Searched sources", status: "completed", citations: [{
                    kind: "a2aj", ref: 1, citation: "2024 SCC 1", dataset: "SCC", quotes: [],
                }] }],
        }] });
        rerender(<ChatView {...props} session={withLegalEvidence} />);
        expect(screen.getByRole("button", { name: "Open as" })).toBeInTheDocument();

        rerender(<ChatView {...props} session={withLegalEvidence}
            features={{ researchSave: false }} />);
        expect(screen.queryByRole("button", { name: "Open as" })).not.toBeInTheDocument();
    });

    it("signals either open Workspace once a completed assistant turn settles", async () => {
        const user = userEvent.setup(), complete = createAssistantSessionState({ messages: [{
            id: "assistant-1", role: "assistant", content: "Done", turn_complete: true,
        }] });
        const props = { chatId: "chat-1", handleChat: vi.fn(), cancel: vi.fn() };
        const { rerender } = render(<ChatView {...props} session={complete} />);
        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("tab", { name: "Sources" }));
        expect(screen.getByLabelText("Sources refresh key")).toHaveTextContent("assistant-1");

        rerender(<ChatView {...props} session={{ ...complete,
            run: { id: "retry-1", status: "running" } }} />);
        expect(screen.getByLabelText("Sources refresh key")).toHaveTextContent("none");
        rerender(<ChatView {...props} session={complete} />);
        expect(screen.getByLabelText("Sources refresh key")).toHaveTextContent("assistant-1");

        await user.click(screen.getByRole("button", { name: "View source" }));
        expect(screen.getByLabelText("Research refresh key")).toHaveTextContent("assistant-1");
    });

    it("moves an embedded Library selection into the mounted workflow dock", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn();
        dockMocks.addDocument.mockClear();
        dockMocks.startWorkflow.mockClear();
        render(<ChatView chatId="chat-1" session={session()} handleChat={handleChat}
            cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("tab", { name: "Library" }));
        await user.click(screen.getByRole("button", { name: "Use Pleading in workflows" }));

        expect(screen.getByRole("tab", { name: "Workflows" }))
            .toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("status", { name: "Workflow documents" }))
            .toHaveTextContent("Pleading.docx");
        expect(dockMocks.addDocument).toHaveBeenCalledWith(
            expect.objectContaining({ id: "template-1", filename: "Pleading.docx" }),
        );
        dockMocks.addDocument.mockClear();
        expect(handleChat).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Proofread" }));
        expect(dockMocks.addDocument).not.toHaveBeenCalled();
        expect(dockMocks.startWorkflow).toHaveBeenCalledOnce();
    });

    it("keeps the workflow dock open when template drafting is selected", async () => {
        const user = userEvent.setup();
        dockMocks.startWorkflow.mockClear();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("button", { name: "Draft from template" }));

        expect(screen.getByRole("tab", { name: "Workflows" }))
            .toHaveAttribute("aria-selected", "true");
        expect(dockMocks.startWorkflow).toHaveBeenCalledWith(
            expect.objectContaining({ id: "drafting" }), undefined,
            { initialDocumentTab: "templates", openDocumentPicker: true },
        );
        expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
    });

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
        await user.click(screen.getByRole("button", { name: "Workflows" }));

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

    it("sends the active workspace and exact selected passages with the next turn", async () => {
        const user = userEvent.setup();
        const handleChat = vi.fn();
        const file = { document: { id: "research-1", filename: "Appeal research.research.md" }, state: newResearchState(), versionId: "v1", workingRevision: 1 } as ResearchFile;
        const selection = { target: "passages" as const, sourceIds: ["source-1"], evidenceIds: ["original-evidence"] };
        render(<SourcesWorkspaceProvider file={file} selection={selection}><ChatView session={session()} handleChat={handleChat} cancel={vi.fn()} /></SourcesWorkspaceProvider>);
        await user.click(screen.getByRole("button", { name: "Workflows" }));

        expect(handleChat).toHaveBeenCalledWith(expect.objectContaining({ research_file_id: "research-1", research_selection: selection }));
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
        await user.click(screen.getByRole("button", { name: "Workflows" }));

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
