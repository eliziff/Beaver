import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import {
    DocTable,
    type DocTableFolder,
    type DocTableSelectionActions,
} from "./DocTable";
import { CHAT_DOCUMENT_DRAG_TYPE } from "./documentTree";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "local-user" } }),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));

const sidePanelRender = vi.hoisted(() => vi.fn());
vi.mock("@/app/components/shared/DocumentSidePanel", () => ({
    DocumentSidePanel: ({ doc }: { doc: Document | null }) => {
        sidePanelRender();
        return doc ? (
            <div data-testid="document-view">{doc.filename}</div>
        ) : null;
    },
}));

const document: Document = {
    id: "document-1",
    user_id: "local-user",
    filename: "Brief.pdf",
    file_type: "pdf",
    storage_path: "brief.pdf",
    pdf_storage_path: "brief.pdf",
    size_bytes: 10,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-27T00:00:00.000Z",
};

const wordDocument: Document = {
    ...document,
    id: "document-2",
    filename: "Submissions.docx",
    file_type: "docx",
    storage_path: "submissions.docx",
    pdf_storage_path: null,
};

function Harness({
    selectionFirst = true,
    initialDocuments = [document],
    initialFolders = [],
    onActions,
    uploadDocument = async () => document,
    moveDocument = async () => document,
    renameDocument = async (_documentId, filename) => ({
        ...document,
        filename,
    }),
    search = "",
}: {
    selectionFirst?: boolean;
    initialDocuments?: Document[];
    initialFolders?: DocTableFolder[];
    onActions?: (actions: DocTableSelectionActions | null) => void;
    uploadDocument?: (file: File) => Promise<Document>;
    moveDocument?: (
        documentId: string,
        folderId: string | null,
    ) => Promise<Document>;
    renameDocument?: (
        documentId: string,
        filename: string,
    ) => Promise<Document>;
    search?: string;
}) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [folders, setFolders] = useState<DocTableFolder[]>(initialFolders);

    return (
        <DocTable
            scopeKey="library"
            documents={documents}
            setDocuments={setDocuments}
            folders={folders}
            setFolders={setFolders}
            loading={false}
            search={search}
            operations={{
                uploadDocument,
                refreshCollection: vi.fn(),
                createFolder: vi.fn(),
                renameFolder: vi.fn(),
                deleteFolder: vi.fn(),
                moveFolder: vi.fn(),
                moveDocument,
                renameDocument,
            }}
            selectionFirst={selectionFirst}
            onSelectionActionsChange={onActions}
        />
    );
}

function documentRow() {
    return rowFor("Brief.pdf");
}

function rowFor(filename: string) {
    return screen
        .getAllByText(filename)
        .find((element) => element.closest("[data-document-row]"))!
        .closest("[data-document-row]") as HTMLElement;
}

function rects(elements: HTMLElement[]) {
    return elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
    });
}

describe("DocTable Library interactions", () => {
    it("drags every document in a folder and its descendants to chat", () => {
        const folders = [
            { id: "folder-1", name: "Research", parent_folder_id: null },
            { id: "folder-2", name: "Cases", parent_folder_id: "folder-1" },
        ] as DocTableFolder[];
        render(<Harness
            initialFolders={folders}
            initialDocuments={[
                { ...document, folder_id: "folder-1" },
                { ...wordDocument, id: "nested-doc", folder_id: "folder-2" },
            ]}
        />);
        const values = new Map<string, string>();
        const dataTransfer = {
            setData: (type: string, value: string) => values.set(type, value),
            effectAllowed: "none",
        };

        fireEvent.dragStart(screen.getByText("Research").closest("[draggable]")!, {
            dataTransfer,
        });

        expect(JSON.parse(values.get(CHAT_DOCUMENT_DRAG_TYPE)!)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: document.id }),
                expect.objectContaining({ id: "nested-doc" }),
            ]),
        );
    });

    it("avoids empty-state and version-picker rerenders", () => {
        sidePanelRender.mockClear();
        render(<Harness />);
        const renders = sidePanelRender.mock.calls.length;
        expect(renders).toBe(1);
        const select = screen.getByRole("combobox", { name: "More actions" });
        const option = within(select).getByRole("option", {
            name: "Upload new version",
        }) as HTMLOptionElement;

        fireEvent.change(select, { target: { value: option.value } });

        expect(sidePanelRender).toHaveBeenCalledTimes(renders);
    });

    it("uploads files dropped on the empty collection", async () => {
        const latestUpload = vi.fn(async () => wordDocument);
        render(<Harness initialDocuments={[]} uploadDocument={latestUpload} />);
        const file = new File(["brief"], "Brief.pdf", {
            type: "application/pdf",
        });
        const dataTransfer = { types: ["Files"], files: [file] };
        const dropTarget = screen.getByText(/Drop PDF, Word/).parentElement!;
        fireEvent.dragOver(dropTarget, { dataTransfer });
        fireEvent.drop(dropTarget, {
            dataTransfer,
        });

        await waitFor(() => expect(latestUpload).toHaveBeenCalledWith(file));
    });

    it("keeps version-file drag feedback on its document row", () => {
        render(<Harness />);
        const row = documentRow();
        const dataTransfer = { types: ["Files"], files: [] };

        fireEvent.dragOver(row, { dataTransfer });
        expect(row).toHaveClass("bg-red-50", "ring-red-200");
        fireEvent.dragLeave(row, { relatedTarget: window.document.body });
        expect(row).not.toHaveClass("bg-red-50", "ring-red-200");
    });

    it("keeps inline rename geometry without per-keystroke commits", async () => {
        const commits = vi.fn();
        const renameDocument = vi.fn(async (_id: string, filename: string) => ({
            ...document,
            filename,
        }));
        const { container } = render(
            <Profiler id="doc-table" onRender={commits}>
                <Harness renameDocument={renameDocument} />
            </Profiler>,
        );
        const row = documentRow();
        const select = within(row).getByRole("combobox", {
            name: "More actions",
        });
        const rename = within(select).getByRole("option", {
            name: "Rename document",
        }) as HTMLOptionElement;
        fireEvent.change(select, { target: { value: rename.value } });
        const input = screen.getByDisplayValue("Brief.pdf");
        const nodeCount = container.querySelectorAll("*").length;

        commits.mockClear();
        fireEvent.change(input, { target: { value: "Renamed.pdf" } });
        expect(commits).not.toHaveBeenCalled();
        expect(container.querySelectorAll("*")).toHaveLength(nodeCount);
        expect(input.closest("[data-document-row]")).toBe(row);
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() =>
            expect(renameDocument).toHaveBeenCalledWith(
                document.id,
                "Renamed.pdf",
            ),
        );
        expect(renameDocument).toHaveBeenCalledTimes(1);
    });

    it("keeps internal document moves on the root drop target", async () => {
        const commits = vi.fn();
        const moveDocument = vi.fn(async () => ({
            ...document,
            folder_id: null,
        }));
        const { container } = render(
            <Profiler id="doc-table" onRender={commits}>
                <Harness
                    initialDocuments={[{ ...document, folder_id: "folder-1" }]}
                    moveDocument={moveDocument}
                    search="Brief"
                />
            </Profiler>,
        );
        const rootDropTarget = documentRow().parentElement!;
        expect(rootDropTarget).toHaveClass("flex-1", "flex-col");
        const rootDropSpacer = rootDropTarget.querySelector(
            ".min-h-16",
        ) as HTMLElement;
        const dataTransfer = {
            types: ["application/mike-doc"],
            files: [],
            getData: (type: string) =>
                type === "application/mike-doc" ? document.id : "",
        };

        fireEvent.dragOver(rootDropSpacer, { dataTransfer });
        expect(container.querySelector(".border-red-400")).not.toBeNull();
        commits.mockClear();
        fireEvent.dragEnd(documentRow());
        expect(commits).toHaveBeenCalledTimes(1);
        expect(container.querySelector(".border-red-400")).toBeNull();
        commits.mockClear();
        fireEvent.dragOver(rootDropSpacer, { dataTransfer });
        expect(commits).toHaveBeenCalledTimes(1);
        fireEvent.drop(rootDropSpacer, { dataTransfer });

        await waitFor(() =>
            expect(moveDocument).toHaveBeenCalledWith(document.id, null),
        );
    });

    it("delegates a document drop to the containing folder row", async () => {
        const moveDocument = vi.fn(async () => ({
            ...document,
            folder_id: "folder-1",
        }));
        const folder = {
            id: "folder-1",
            name: "Research",
            parent_folder_id: null,
        } as DocTableFolder;
        render(
            <Harness
                initialFolders={[folder]}
                moveDocument={moveDocument}
            />,
        );
        const target = screen.getByText("Research");
        const row = target.closest("[data-tree-drop-folder]")!;
        const dataTransfer = {
            types: ["application/mike-doc"],
            files: [],
            getData: (type: string) =>
                type === "application/mike-doc" ? document.id : "",
        };

        fireEvent.dragOver(target, { dataTransfer });
        expect(row).toHaveClass("bg-red-50", "ring-red-200");
        fireEvent.drop(target, { dataTransfer });

        await waitFor(() =>
            expect(moveDocument).toHaveBeenCalledWith(document.id, folder.id),
        );
    });

    it("selects on click without opening and keeps View visible", () => {
        render(<Harness />);
        const row = documentRow();
        const view = screen.getByRole("button", {
            name: "View Brief.pdf",
        });

        fireEvent.click(row);

        expect(row).toHaveAttribute("aria-selected", "true");
        expect(row).toHaveClass("bg-app-surface-active");
        expect(view).toBeVisible();
        expect(screen.queryByTestId("document-view")).not.toBeInTheDocument();
    });

    it("opens on double-click", () => {
        render(<Harness />);
        const row = documentRow();

        fireEvent.doubleClick(row);

        expect(row).toHaveAttribute("aria-selected", "true");
        expect(screen.getByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("opens from the visible View action", () => {
        render(<Harness />);

        fireEvent.click(
            screen.getByRole("button", { name: "View Brief.pdf" }),
        );

        expect(documentRow()).toHaveAttribute("aria-selected", "true");
        expect(screen.getByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("opens the selected row with Enter", () => {
        render(<Harness />);
        const row = documentRow();
        fireEvent.click(row);

        fireEvent.keyDown(row, { key: "Enter" });

        expect(screen.getByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("uses Space only to toggle selection", () => {
        render(<Harness />);
        const row = documentRow();

        fireEvent.keyDown(row, { key: " " });
        expect(row).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByTestId("document-view")).not.toBeInTheDocument();

        fireEvent.keyDown(row, { key: " " });
        expect(row).toHaveAttribute("aria-selected", "false");
        expect(screen.queryByTestId("document-view")).not.toBeInTheDocument();
    });

    it("preserves the shared table's default click-to-open behavior", () => {
        render(<Harness selectionFirst={false} />);

        fireEvent.click(documentRow());

        expect(
            screen.queryByRole("button", { name: "View Brief.pdf" }),
        ).not.toBeInTheDocument();
        expect(screen.getByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("exposes one selected DOCX to the toolbar without row or header controls", async () => {
        let actions: DocTableSelectionActions | null = null;
        render(
            <Harness
                initialDocuments={[document, wordDocument]}
                onActions={(next) => {
                    actions = next;
                }}
            />,
        );

        expect(
            screen.queryByRole("button", { name: "Automation" }),
        ).toBeNull();
        expect(
            within(rowFor("Brief.pdf")).queryByRole("button", {
                name: "Automation",
            }),
        ).toBeNull();
        expect(
            within(rowFor("Submissions.docx")).queryByRole("button", {
                name: "Automation",
            }),
        ).toBeNull();

        fireEvent.click(rowFor("Submissions.docx"));
        await waitFor(() =>
            expect(actions?.automationDocument).toBe(wordDocument),
        );

        fireEvent.click(
            within(rowFor("Brief.pdf")).getByRole("checkbox"),
        );
        await waitFor(() =>
            expect(actions?.automationDocument).toBeNull(),
        );

        fireEvent.click(rowFor("Submissions.docx"));
        await waitFor(() =>
            expect(actions?.automationDocument).toBe(wordDocument),
        );

        fireEvent.click(rowFor("Brief.pdf"));
        await waitFor(() =>
            expect(actions?.automationDocument).toBe(document),
        );
    });

    it.each([1440, 390])(
        "keeps row and lead-cell geometry fixed at %ipx",
        (viewportWidth) => {
            Object.defineProperty(window, "innerWidth", {
                configurable: true,
                value: viewportWidth,
            });
            render(<Harness />);

            const row = documentRow();
            const leadCell = row.firstElementChild as HTMLElement;
            const elements = [
                row,
                ...Array.from(row.children),
            ] as HTMLElement[];
            const stickyWidth = Math.max(180, viewportWidth - 112);

            elements.forEach((element, index) => {
                const width =
                    element === row
                        ? viewportWidth
                        : element === leadCell
                          ? stickyWidth
                          : 32;
                vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
                    x: index === 0 ? 0 : stickyWidth + (index - 1) * 32,
                    y: 44,
                    width,
                    height: 44,
                    top: 44,
                    right: width,
                    bottom: 88,
                    left: index === 0 ? 0 : stickyWidth + (index - 1) * 32,
                    toJSON: () => ({}),
                });
            });

            const nodes = [...row.children];
            const before = rects(elements);

            fireEvent.mouseEnter(row);
            fireEvent.focus(row);
            fireEvent.click(row);

            expect(documentRow()).toBe(row);
            expect([...row.children]).toEqual(nodes);
            expect(rects(elements)).toEqual(before);
            expect(row).toHaveClass(
                "h-11",
                "min-h-11",
                "w-full",
                "bg-app-surface-active",
            );
            expect(leadCell).not.toHaveClass("sticky");
            expect(`${row.className} ${leadCell.className}`).not.toMatch(
                /\b(?:animate-|duration-|scale-|shadow|transition|translate-)/,
            );
        },
    );
});

describe("structural parse state", () => {
    const parseState = (
        status: NonNullable<Document["parse_state"]>["status"],
        extra: Partial<NonNullable<Document["parse_state"]>> = {},
    ): Document["parse_state"] => ({
        status,
        error: null,
        attempts: 1,
        queued_at: "2026-07-30T00:00:00.000Z",
        updated_at: "2026-07-30T00:00:00.000Z",
        completed_at: null,
        engine_status: null,
        page_count: null,
        diagnostic_count: null,
        structural_repair_available: false,
        ...extra,
    });

    function ParseHarness({
        state,
        retryPdfParse,
    }: {
        state: Document["parse_state"];
        retryPdfParse?: (documentId: string) => Promise<unknown>;
    }) {
        const [documents, setDocuments] = useState([
            { ...document, parse_state: state },
        ]);
        const [folders, setFolders] = useState<DocTableFolder[]>([]);
        return (
            <DocTable
                scopeKey="library"
                documents={documents}
                setDocuments={setDocuments}
                folders={folders}
                setFolders={setFolders}
                loading={false}
                search=""
                operations={{
                    uploadDocument: async () => document,
                    refreshCollection: vi.fn(),
                    createFolder: vi.fn(),
                    renameFolder: vi.fn(),
                    deleteFolder: vi.fn(),
                    moveFolder: vi.fn(),
                    moveDocument: async () => document,
                    renameDocument: async () => document,
                    retryPdfParse,
                }}
                selectionFirst
            />
        );
    }

    it("shows no chip for a clean ready parse or a missing parse lane", () => {
        const ready = render(<ParseHarness state={parseState("ready")} />);
        expect(screen.queryByText("Parsing")).toBeNull();
        expect(screen.queryByText("Degraded")).toBeNull();
        expect(screen.queryByText("Parse failed")).toBeNull();
        ready.unmount();
        render(<ParseHarness state={null} />);
        expect(screen.queryByText("Parse failed")).toBeNull();
    });

    it("labels queued and degraded parses", () => {
        const queued = render(<ParseHarness state={parseState("queued")} />);
        expect(screen.getByText("Parsing")).toBeInTheDocument();
        queued.unmount();
        render(
            <ParseHarness
                state={parseState("degraded", { diagnostic_count: 7 })}
            />,
        );
        expect(screen.getByText("Degraded")).toBeInTheDocument();
        expect(screen.getByText("Degraded")).toHaveAttribute(
            "title",
            expect.stringContaining("7 diagnostics"),
        );
    });

    it("offers retry for a failed parse and requeues through the operation", async () => {
        const retryPdfParse = vi.fn(async () => ({ status: "queued" }));
        render(
            <ParseHarness
                state={parseState("failed", { error: "engine exploded" })}
                retryPdfParse={retryPdfParse}
            />,
        );
        expect(screen.getByText("Parse failed")).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("button", {
                name: "Retry structural parse for Brief.pdf",
            }),
        );
        await waitFor(() =>
            expect(retryPdfParse).toHaveBeenCalledWith("document-1"),
        );
    });
});
