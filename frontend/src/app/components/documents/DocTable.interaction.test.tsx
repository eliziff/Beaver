import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { newResearchState, type ResearchFile } from "@/app/lib/researchFiles";
import { SourcesWorkspaceProvider } from "@/app/components/legal/SourcesWorkspace";
import {
    DocTable,
    type DocTableFolder,
} from "./DocTable";
import { DirectoryActions, type DocumentSelectionActions } from "./UploadAction";
import { CHAT_DOCUMENT_DRAG_TYPE } from "./documentTree";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "local-user" } }),
}));
vi.mock("@/app/lib/authMode", () => ({ isLocalMode: true }));

const { listVersions, uploadVersion, researchDirectory } = vi.hoisted(() => ({
    listVersions: vi.fn(), uploadVersion: vi.fn(), researchDirectory: vi.fn(),
}));
vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  listDocumentVersions: listVersions,
  directoryResource: () => ({ list: researchDirectory }),
  uploadDocumentVersion: uploadVersion
}));
const researchApi = vi.hoisted(() => ({ act: vi.fn(), getFile: vi.fn() }));
vi.mock("@/app/lib/api/researchFiles", async (original) => ({
  ...await original<typeof import("@/app/lib/api/researchFiles")>(),
  actOnResearchFile: researchApi.act,
  getResearchFile: researchApi.getFile,
}));

const sidePanelRender = vi.hoisted(() => vi.fn());
vi.mock("@/app/components/shared/DocumentSidePanel", () => ({
    preloadDocumentViewer: vi.fn(() => Promise.resolve()),
    DocumentSidePanel: (props: { doc: Document | null; versionsError?: boolean;
        currentVersionId?: string | null;
        onLoadVersions: (id: string, force?: boolean) => Promise<unknown> | void }) => {
        const { doc } = props;
        sidePanelRender(props);
        return doc ? (
            <div data-testid="document-view">{doc.filename}{props.currentVersionId && <span>Current {props.currentVersionId}</span>}</div>
        ) : null;
    },
}));

const document: Document = {
    id: "document-1",
    user_id: "local-user",
    project_id: null,
    filename: "Brief.pdf",
    file_type: "pdf",
    storage_path: "brief.pdf",
    pdf_storage_path: "brief.pdf",
    size_bytes: 10,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-27T00:00:00.000Z",
    current_version_id: "version-1",
    current_working_revision: 7,
};

const wordDocument: Document = {
    ...document,
    id: "document-2",
    filename: "Submissions.docx",
    file_type: "docx",
    storage_path: "submissions.docx",
    pdf_storage_path: null,
};
const DEFAULT_DOCUMENTS = [document];
const NO_FOLDERS: DocTableFolder[] = [];

function Harness({
    selectionFirst = true,
    initialDocuments = DEFAULT_DOCUMENTS,
    initialFolders = NO_FOLDERS,
    onCreateFolderActionChange,
    uploadDocument = async () => document,
    uploadDocuments = (files) => Promise.all(files.map((file) => uploadDocument(file))),
    refreshCollection = vi.fn(),
    moveDocument = async () => document,
    moveFolder = vi.fn(),
    renameDocument = async (_documentId, filename) => ({
        ...document,
        filename,
    }),
    onOpenWorkflows,
    onOpenInChat,
    list,
    search = "",
    workspaceFile,
}: {
    selectionFirst?: boolean;
    initialDocuments?: Document[];
    initialFolders?: DocTableFolder[];
    onCreateFolderActionChange?: (action: (() => void) | null) => void;
    uploadDocument?: (file: File) => Promise<Document>;
    uploadDocuments?: (files: File[]) => Promise<Document[]>;
    refreshCollection?: () => Promise<void> | void;
    moveDocument?: (
        documentId: string,
        folderId: string | null,
    ) => Promise<Document>;
    moveFolder?: (folderId: string, parentFolderId: string | null) => Promise<DocTableFolder>;
    renameDocument?: (
        documentId: string,
        filename: string,
    ) => Promise<Document>;
    onOpenWorkflows?: (documents: Document[]) => void;
    onOpenInChat?: (documents: Document[]) => void;
    list?: (options: { parent_id?: string | null; cursor?: string | null }) => Promise<{
        items: Array<{ kind: "document"; document: Document } | { kind: "folder"; folder: DocTableFolder }>;
        next_cursor: string | null;
    }>;
    search?: string;
    workspaceFile?: ResearchFile | null;
}) {
    const [selection, setSelection] = useState<DocumentSelectionActions | null>(null);
    const operations = useRef({
        list: list ?? (async ({ parent_id }: { parent_id?: string | null }) => ({
            items: initialFolders
                .filter((folder) => (folder.parent_folder_id ?? null) === (parent_id ?? null))
                .map((folder) => ({ kind: "folder" as const, folder })),
            next_cursor: null,
        })),
        uploadDocument,
        uploadDocuments,
        refreshCollection: async () => { await refreshCollection(); },
        refreshDocumentParseStates: vi.fn(),
        createFolder: vi.fn(),
        renameFolder: vi.fn(),
        deleteFolder: vi.fn(),
        moveFolder,
        moveDocument,
        renameDocument,
    }).current;
    const table = (
        <DocTable
            scopeKey="library"
            documents={initialDocuments}
            folders={initialFolders}
            loading={false}
            search={search}
            operations={operations}
            selectionFirst={selectionFirst}
            onCreateFolderActionChange={onCreateFolderActionChange}
            onSelectionActionsChange={setSelection}
            onOpenInChat={onOpenInChat}
            onOpenWorkflows={onOpenWorkflows}
        />);
    return (
        <><DirectoryActions actions={null} onCreateFolder={null} selection={selection}
            onOpenWorkflows={onOpenWorkflows} />
        {workspaceFile
            ? <SourcesWorkspaceProvider file={workspaceFile ?? undefined}>{table}</SourcesWorkspaceProvider>
            : table}</>
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
    it("does not present a partially loaded folder as chat documents", () => {
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

        expect(values.has(CHAT_DOCUMENT_DRAG_TYPE)).toBe(false);
    });

    it("resolves every descendant before opening a folder in chat", async () => {
        const research = { id: "folder-1", name: "Research", parent_folder_id: null } as DocTableFolder;
        const cases = { id: "folder-2", name: "Cases", parent_folder_id: "folder-1" } as DocTableFolder;
        const inside = { ...document, id: "inside", folder_id: "folder-1" };
        const nested = { ...wordDocument, id: "nested", folder_id: "folder-2" };
        const list = vi.fn(async ({ parent_id, cursor }: { parent_id?: string | null; cursor?: string | null }) => {
            if (parent_id === "folder-1" && !cursor) return { items: [
                { kind: "document" as const, document: inside },
                { kind: "folder" as const, folder: cases },
            ], next_cursor: "page-2" };
            if (parent_id === "folder-1") return { items: [], next_cursor: null };
            if (parent_id === "folder-2") return { items: [
                { kind: "document" as const, document: nested },
            ], next_cursor: null };
            return { items: [], next_cursor: null };
        });
        const openChat = vi.fn();
        render(<Harness initialDocuments={[]} initialFolders={[research]}
            list={list} onOpenInChat={openChat} />);

        fireEvent.click(within(screen.getByText("Research").closest("[data-tree-drop-folder]")!)
            .getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Open in new chat" }));

        await waitFor(() => expect(openChat).toHaveBeenCalledWith([inside, nested]));
        expect(list).toHaveBeenCalledTimes(3);
    });

    it("avoids empty-state and version-picker rerenders", () => {
        sidePanelRender.mockClear();
        render(<Harness />);
        const renders = sidePanelRender.mock.calls.length;
        expect(renders).toBe(1);
        fireEvent.click(within(documentRow()).getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", {
            name: "Upload new version",
        }));

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

    it("refreshes successful siblings and warns when a batch upload is partial", async () => {
        const refreshCollection = vi.fn();
        render(<Harness initialDocuments={[]}
            uploadDocuments={vi.fn().mockRejectedValue(new Error("one failed"))}
            refreshCollection={refreshCollection} />);
        const file = new File(["brief"], "Brief.pdf", { type: "application/pdf" });
        const dropTarget = screen.getByText(/Drop PDF, Word/).parentElement!;

        fireEvent.drop(dropTarget, { dataTransfer: { types: ["Files"], files: [file] } });

        expect(await screen.findByText(/Some files could not be uploaded/)).toBeVisible();
        expect(refreshCollection).toHaveBeenCalled();
    });

    it("creates the first folder from an empty collection", async () => {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
            configurable: true,
            value: vi.fn(),
        });
        let createFolder: (() => void) | null = null;
        render(
            <Harness
                initialDocuments={[]}
                onCreateFolderActionChange={(action) => {
                    createFolder = action;
                }}
            />,
        );
        await waitFor(() => expect(createFolder).not.toBeNull());

        act(() => createFolder?.());

        expect(screen.getByPlaceholderText("Folder name")).toBeVisible();
    });

    it("refreshes once after a partial chained version drop", async () => {
        const files = ["one", "two", "three"].map((name) => new File([name], `${name}.pdf`));
        uploadVersion.mockReset()
            .mockResolvedValueOnce({ id: "version-2", working_revision: 8 })
            .mockResolvedValueOnce({ id: "version-3", working_revision: 9 })
            .mockRejectedValueOnce(new Error("third failed"));
        listVersions.mockReset().mockResolvedValue({
            current_version_id: "version-3", versions: [{ id: "version-3" }],
        });
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "View Brief.pdf" }));
        const row = documentRow(), dataTransfer = { types: ["Files"], files };

        fireEvent.drop(row, { dataTransfer });

        await waitFor(() => expect(uploadVersion).toHaveBeenCalledTimes(3));
        expect(uploadVersion.mock.calls.map(([, , id, revision]) =>
            [id, revision])).toEqual([
            ["version-1", 7], ["version-2", 8],
            ["version-3", 9],
        ]);
        expect(await screen.findByText("Current version-3")).toBeVisible();
        expect(listVersions).toHaveBeenCalledTimes(1);
        error.mockRestore();
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
        fireEvent.click(within(row).getByRole("button", {
            name: "More actions",
        }));
        fireEvent.click(screen.getByRole("menuitem", {
            name: "Rename document",
        }));
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

    it("moves selected documents with the destination picker", async () => {
        const moveDocument = vi.fn(async (id: string, folderId: string | null) => ({
            ...(id === document.id ? document : wordDocument), folder_id: folderId,
        }));
        const target = { id: "filed", name: "Filed", parent_folder_id: null } as DocTableFolder;
        render(<Harness initialDocuments={[document, wordDocument]}
            initialFolders={[target]} moveDocument={moveDocument} />);
        fireEvent.click(within(rowFor(document.filename)).getByRole("checkbox"));
        fireEvent.click(within(rowFor(wordDocument.filename)).getByRole("checkbox"));
        const header = screen.getByRole("group", { name: "Document actions" });
        fireEvent.click(within(header).getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
        fireEvent.click(await screen.findByRole("button", { name: "Open Filed" }));
        fireEvent.click(screen.getByRole("button", { name: "Move here" }));

        await waitFor(() => expect(moveDocument).toHaveBeenCalledTimes(2));
        expect(moveDocument).toHaveBeenCalledWith(document.id, target.id);
        expect(moveDocument).toHaveBeenCalledWith(wordDocument.id, target.id);
    });

    it("includes the collection root as a move destination", async () => {
        const moveDocument = vi.fn(async () => ({ ...document, folder_id: null }));
        render(<Harness initialDocuments={[{ ...document, folder_id: "research" }]}
            moveDocument={moveDocument} search="Brief" />);
        fireEvent.click(within(documentRow()).getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
        expect(screen.getByText("Destination: Project")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Move here" }));
        await waitFor(() => expect(moveDocument).toHaveBeenCalledWith(document.id, null));
    });

    it("moves a folder with the same destination picker", async () => {
        const source = { id: "research", name: "Research", parent_folder_id: null } as DocTableFolder;
        const target = { id: "filed", name: "Filed", parent_folder_id: null } as DocTableFolder;
        const moveFolder = vi.fn(async () => source);
        render(<Harness initialFolders={[source, target]} moveFolder={moveFolder} />);
        const sourceRow = screen.getByText("Research").closest("[data-tree-drop-folder]")!;
        fireEvent.click(within(sourceRow as HTMLElement)
            .getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Move…" }));
        fireEvent.click(await screen.findByRole("button", { name: "Open Filed" }));
        fireEvent.click(screen.getByRole("button", { name: "Move here" }));

        await waitFor(() => expect(moveFolder).toHaveBeenCalledWith(source.id, target.id));
    });

    it("selects on click without opening and keeps View visible", () => {
        render(<Harness />);
        const row = documentRow();
        const view = screen.getByRole("button", {
            name: "View Brief.pdf",
        });

        fireEvent.click(row);

        expect(row).toHaveAttribute("aria-selected", "true");
        expect(view).toBeVisible();
        expect(screen.queryByTestId("document-view")).not.toBeInTheDocument();
    });

    it("opens on double-click", async () => {
        render(<Harness />);
        const row = documentRow();

        fireEvent.doubleClick(row);

        expect(row).toHaveAttribute("aria-selected", "true");
        expect(await screen.findByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("opens from the visible View action", async () => {
        render(<Harness />);

        fireEvent.click(
            screen.getByRole("button", { name: "View Brief.pdf" }),
        );

        expect(documentRow()).toHaveAttribute("aria-selected", "true");
        expect(await screen.findByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("surfaces a version-history load failure to the document panel", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        listVersions.mockRejectedValueOnce(new Error("offline"));
        render(<Harness />);
        fireEvent.click(screen.getByRole("button", { name: "View Brief.pdf" }));
        const load = sidePanelRender.mock.calls.at(-1)?.[0].onLoadVersions;
        await act(async () => load("document-1", true));
        await waitFor(() => expect(sidePanelRender.mock.calls.at(-1)?.[0].versionsError).toBe(true));
        error.mockRestore();
    });

    it("opens the selected row with Enter", async () => {
        render(<Harness />);
        const row = documentRow();
        fireEvent.click(row);

        fireEvent.keyDown(row, { key: "Enter" });

        expect(await screen.findByTestId("document-view")).toHaveTextContent(
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

    it("preserves the shared table's default click-to-open behavior", async () => {
        render(<Harness selectionFirst={false} />);

        fireEvent.click(documentRow());

        expect(
            screen.queryByRole("button", { name: "View Brief.pdf" }),
        ).not.toBeInTheDocument();
        expect(await screen.findByTestId("document-view")).toHaveTextContent(
            "Brief.pdf",
        );
    });

    it("keeps table headings and selection actions in stable places", async () => {
        render(
            <Harness
                initialDocuments={[document, wordDocument]}
            />,
        );

        expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled();
        expect(screen.getByText("Name")).toBeVisible();
        expect(
            within(rowFor("Brief.pdf")).queryByRole("button", {
                name: "Workflows",
            }),
        ).toBeNull();
        expect(
            within(rowFor("Submissions.docx")).queryByRole("button", {
                name: "Workflows",
            }),
        ).toBeNull();

        fireEvent.click(rowFor("Submissions.docx"));
        await waitFor(() => expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled());
        expect(screen.getByText("Name")).toBeVisible();

        fireEvent.click(
            within(rowFor("Brief.pdf")).getByRole("checkbox"),
        );
        expect(screen.getAllByRole("button", { name: "Workflows" })).toHaveLength(1);

        fireEvent.click(rowFor("Submissions.docx"));
        expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled();

        fireEvent.click(rowFor("Brief.pdf"));
        expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled();
    });

    it("hands the full selection to an existing workflow dock", async () => {
        const onOpenWorkflows = vi.fn();
        render(<Harness initialDocuments={[document, wordDocument]}
            onOpenWorkflows={onOpenWorkflows} />);
        fireEvent.click(rowFor("Brief.pdf"));
        fireEvent.click(within(rowFor("Submissions.docx")).getByRole("checkbox"));

        await waitFor(() => expect(screen.getByRole("button", { name: "Workflows" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Workflows" }));

        expect(onOpenWorkflows).toHaveBeenCalledWith([document, wordDocument]);
        expect(screen.queryByRole("dialog", { name: "Workflows" })).toBeNull();
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
        ...extra,
    });

    function ParseHarness({
        state,
        retryPdfParse,
        refreshDocumentParseStates = vi.fn(),
    }: {
        state: Document["parse_state"];
        retryPdfParse?: (documentId: string) => Promise<unknown>;
        refreshDocumentParseStates?: () => Promise<unknown> | unknown;
    }) {
        return (
            <DocTable
                scopeKey="library"
                documents={[{ ...document, parse_state: state }]}
                folders={[]}
                loading={false}
                search=""
                operations={{
                    list: async () => ({ items: [], next_cursor: null }),
                    uploadDocument: async () => document,
                    uploadDocuments: async () => [document],
                    refreshCollection: vi.fn(),
                    refreshDocumentParseStates,
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
        expect(screen.queryByText("Preparing")).toBeNull();
        expect(screen.queryByText("Degraded")).toBeNull();
        expect(screen.queryByText("Parse failed")).toBeNull();
        ready.unmount();
        render(<ParseHarness state={null} />);
        expect(screen.queryByText("Parse failed")).toBeNull();
    });

    it("shows active OCR and only surfaces completed OCR when action is needed", () => {
        const queued = render(<ParseHarness state={parseState("queued")} />);
        expect(screen.getByText("Queued")).toBeInTheDocument();
        queued.unmount();
        const ocr = render(
            <ParseHarness state={parseState("parsing", { phase: "ocr", pages: [5] })} />,
        );
        expect(screen.getByText("OCR page 5")).toBeInTheDocument();
        ocr.unmount();
        const ready = render(
            <ParseHarness state={parseState("ready", { phase: "ocr", pages: [5] })} />,
        );
        expect(screen.queryByText(/OCR/u)).toBeNull();
        ready.unmount();
        render(<ParseHarness state={parseState("degraded", { phase: "ocr" })} />);
        expect(screen.getByText("OCR · Degraded")).toBeInTheDocument();
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

    it("refreshes a visible collection while preparation is active", async () => {
        vi.useFakeTimers();
        const refreshDocumentParseStates = vi.fn();
        const view = render(
            <ParseHarness state={parseState("queued")}
                refreshDocumentParseStates={refreshDocumentParseStates} />,
        );
        await vi.advanceTimersByTimeAsync(500);
        expect(refreshDocumentParseStates).toHaveBeenCalledTimes(1);
        view.unmount();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(refreshDocumentParseStates).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});

describe("research-scoped Library actions", () => {
    const workspace = (): ResearchFile => ({ document: { id: "research-1", filename: "Contract research.research.md", file_type: "md" },
        versionId: "v1", workingRevision: 1, state: { ...newResearchState(),
            labels: { "label-1": { id: "label-1", name: "Contract", parentId: null,
                color: "#aabbaa", order: 0, scope: "source" } }, sources: {
            "source-1": { id: "source-1", collected: true, labelIds: ["label-1"],
      note: "", passages: null,
                reference: { provider: "library", kind: "document", id: "document-1", versionId: "version-1" } },
        } } } as ResearchFile);

    it("does not expose research labels or perform research writes merely by opening Library", () => {
        researchApi.act.mockClear(); researchDirectory.mockClear();
        render(<Harness workspaceFile={workspace()} />);
        expect(within(documentRow()).queryByText("Contract")).not.toBeInTheDocument();
        expect(within(documentRow()).queryByText(/in \d+ workspace/)).not.toBeInTheDocument();
        fireEvent.click(within(documentRow()).getByRole("button", { name: "More actions" }));
        expect(screen.queryByRole("menuitem", { name: "Label" })).not.toBeInTheDocument();
        expect(screen.getByRole("menuitem", { name: "Add to research…" })).toBeVisible();
        expect(researchApi.act).not.toHaveBeenCalled();
        expect(researchDirectory).not.toHaveBeenCalled();
    });

    it("adds a pinned document only to the research set explicitly chosen by the user", async () => {
        researchApi.act.mockClear();
        researchDirectory.mockResolvedValue({ items: [{ kind: "document", document: workspace().document }], next_cursor: null });
        researchApi.getFile.mockResolvedValue(workspace());
        researchApi.act.mockResolvedValue({ ...workspace(), sourceId: "source-1" });
        render(<Harness />);
        fireEvent.click(within(documentRow()).getByRole("button", { name: "More actions" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Add to research…" }));
        const choice = await screen.findByRole("radio", { name: "Select Contract research" });
        expect(researchApi.act).not.toHaveBeenCalled();
        fireEvent.click(choice);
        await screen.findByLabelText("Destination source label");
        fireEvent.change(screen.getByLabelText("Destination source label"), { target: { value: "label-1" } });
        fireEvent.click(screen.getByRole("button", { name: "Add", exact: true }));
        await waitFor(() => expect(researchApi.act).toHaveBeenCalledWith("research-1", "v1", 1,
            expect.objectContaining({ type: "source", reference: expect.objectContaining({
                provider: "library", kind: "document", id: "document-1", versionId: "version-1" }) })));
        expect(researchApi.act).toHaveBeenCalledTimes(1);
    });
});
