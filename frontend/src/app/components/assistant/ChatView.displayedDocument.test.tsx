import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Document, Message } from "../shared/types";
import { ChatView, type ChatViewHandle } from "./ChatView";
import { createAssistantSessionState } from "@/app/lib/assistantSession";

const dockMocks = vi.hoisted(() => ({
    addDocument: vi.fn(),
    selectWorkflow: vi.fn(),
    sidePanelModuleLoaded: vi.fn(),
}));
const idle = vi.hoisted(() => ({ callback: null as (() => void) | null }));

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
vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => {
    idle.callback = () => callback({ didTimeout: false, timeRemaining: () => 50 });
    return 1;
}));
vi.stubGlobal("cancelIdleCallback", vi.fn());

vi.mock("@/app/contexts/SidebarContext", () => ({
    useSidebar: () => ({ setSidebarOpen: vi.fn() }),
}));
vi.mock("./UserMessage", () => ({ UserMessage: () => null }));
vi.mock("./AskInputPopup", () => ({ AskInputPopup: () => null }));
vi.mock("./AssistantSidePanel", () => {
    dockMocks.sidePanelModuleLoaded();
    return { AssistantSidePanel: () => null };
});
vi.mock("./AssistantWorkflowDock", () => ({
    AssistantWorkflowDock: ({ onSelect, initialWorkflowId }: {
        onSelect: (selection: unknown) => void; initialWorkflowId?: string;
    }) => {
        const [openedId] = React.useState(initialWorkflowId);
        return (
        <>
            <output aria-label="Opened workflow">{openedId ?? "none"}</output>
            <button type="button" onClick={() => onSelect({ workflow: {
                id: "drafting", metadata: { title: "Drafting" },
            }, variant: { id: "builtin-proofread", execution: "assistant" } })}>
                Proofread
            </button>
            <button type="button" onClick={() => onSelect({ workflow: {
                id: "templates", metadata: { title: "Templates" },
            }, variant: { id: "builtin-draft-from-template", execution: "assistant" } })}>
                Draft from template
            </button>
        </>
        );
    },
}));
vi.mock("@/app/components/library/LibraryWorkspace", () => ({
    LibraryWorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
    LibraryCollectionPage: ({ kind, onOpenInChat }: {
        kind: string; onOpenInChat: (documents: Document[]) => void;
    }) => {
        const [query, setQuery] = React.useState("");
        return <><input aria-label="Library query" value={query}
            onChange={(event) => setQuery(event.target.value)} /><button type="button"
            data-library-kind={kind}
            onClick={() => onOpenInChat([{ id: "template-1", filename: "Pleading.docx" } as Document])}>
            Use Pleading template
        </button></>;
    },
}));
vi.mock("@/app/components/legal/LegalLibrary", () => ({
    LegalLibraryPage: () => {
        const [query, setQuery] = React.useState("");
        return <input aria-label="Sources query" value={query}
            onChange={(event) => setQuery(event.target.value)} />;
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
            onOpenWorkflows?: (onSelect: (selection: unknown) => void) => void;
        },
        ref,
    ) {
        React.useImperativeHandle(ref, () => ({
            addDoc: dockMocks.addDocument,
            clearDraft: vi.fn(),
            startWorkflowDocumentSelection: vi.fn(),
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
                onClick={() => onOpenWorkflows(dockMocks.selectWorkflow)}>
                Browse workflows
            </button>}
            {onOpenWorkflows && <button type="button"
                onClick={() => onOpenWorkflows(dockMocks.selectWorkflow, "court-records")}>
                Open Court Records workflow
            </button>}
        </>);
    }),
}));

describe("ChatView displayed document context", () => {
    it("defers the reader panel module until browser idle", async () => {
        dockMocks.sidePanelModuleLoaded.mockClear();
        idle.callback = null;
        render(<ChatView session={session([{
            role: "assistant", content: "", events: [],
        }])} handleChat={vi.fn()} cancel={vi.fn()} />);

        expect(dockMocks.sidePanelModuleLoaded).not.toHaveBeenCalled();
        await waitFor(() => expect(window.requestIdleCallback).toHaveBeenCalled());
        act(() => idle.callback?.());
        await waitFor(() => expect(dockMocks.sidePanelModuleLoaded).toHaveBeenCalledOnce());
    });

    it("opens supplied project files in the existing assistant dock", () => {
        render(
            <ChatView
                session={session()}
                handleChat={vi.fn()}
                cancel={vi.fn()}
                projectFiles={<p>Project explorer content</p>}
                projectFileActions={<button type="button">Upload project files</button>}
            />,
        );

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

    it("keeps the dock open when a workflow is selected", async () => {
        const user = userEvent.setup();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("button", { name: "Proofread" }));

        expect(screen.getByRole("complementary", { name: "Assistant dock" })).toBeVisible();
        expect(screen.getByRole("button", { name: "Collapse assistant dock" })).toBeVisible();
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

    it("keeps template drafting selected while templates attach in the dock", async () => {
        const user = userEvent.setup();
        dockMocks.addDocument.mockClear(); dockMocks.selectWorkflow.mockClear();
        render(<ChatView session={session()} handleChat={vi.fn()} cancel={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: "Browse workflows" }));
        await user.click(screen.getByRole("button", { name: "Draft from template" }));

        expect(screen.getByRole("tab", { name: "Library" }))
            .toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("button", { name: "Use Pleading template" }))
            .toHaveAttribute("data-library-kind", "templates");
        expect(dockMocks.selectWorkflow).toHaveBeenCalledWith(expect.objectContaining({
            workflow: expect.objectContaining({ id: "templates" }),
        }));

        await user.click(screen.getByRole("button", { name: "Use Pleading template" }));
        expect(dockMocks.addDocument).toHaveBeenCalledWith(expect.objectContaining({
            id: "template-1",
        }));
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
