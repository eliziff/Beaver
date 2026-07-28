import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import {
    DocTable,
    type DocTableFolder,
    type DocTableSelectionActions,
} from "./DocTable";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "local-user" } }),
}));
vi.mock("@/app/lib/authMode", () => ({ isAnonymousMode: true }));

vi.mock("@/app/components/shared/DocumentSidePanel", () => ({
    DocumentSidePanel: ({ doc }: { doc: Document | null }) =>
        doc ? <div data-testid="document-view">{doc.filename}</div> : null,
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
    onActions,
    uploadDocument = async () => document,
    moveDocument = async () => document,
    search = "",
}: {
    selectionFirst?: boolean;
    initialDocuments?: Document[];
    onActions?: (actions: DocTableSelectionActions | null) => void;
    uploadDocument?: (file: File) => Promise<Document>;
    moveDocument?: (
        documentId: string,
        folderId: string | null,
    ) => Promise<Document>;
    search?: string;
}) {
    const [documents, setDocuments] = useState(initialDocuments);
    const [folders, setFolders] = useState<DocTableFolder[]>([]);

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
                renameDocument: vi.fn(),
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
    it("keeps collection drop listeners mounted and uses the latest uploader", async () => {
        const addListener = vi.spyOn(window, "addEventListener");
        const removeListener = vi.spyOn(window, "removeEventListener");
        const firstUpload = vi.fn(async () => document);
        const latestUpload = vi.fn(async () => wordDocument);
        const { rerender, unmount } = render(
            <Harness uploadDocument={firstUpload} />,
        );
        const dragEvents = ["dragenter", "dragover", "dragleave", "drop"];
        const registrations = (spy: typeof addListener, type: string) =>
            spy.mock.calls.filter(([eventType]) => eventType === type).length;

        rerender(<Harness uploadDocument={latestUpload} />);

        for (const event of dragEvents) {
            expect(registrations(addListener, event)).toBe(1);
            expect(registrations(removeListener, event)).toBe(0);
        }

        const file = new File(["brief"], "Brief.pdf", {
            type: "application/pdf",
        });
        const dataTransfer = { types: ["Files"], files: [file] };
        fireEvent.dragEnter(window, { dataTransfer });
        expect(screen.getByText("Drop files here to upload")).toBeVisible();
        fireEvent.drop(window, {
            dataTransfer,
        });

        await waitFor(() => expect(latestUpload).toHaveBeenCalledWith(file));
        expect(
            screen.queryByText("Drop files here to upload"),
        ).not.toBeInTheDocument();
        expect(firstUpload).not.toHaveBeenCalled();
        for (const event of dragEvents) {
            expect(registrations(addListener, event)).toBe(1);
        }

        unmount();
        for (const event of dragEvents) {
            expect(registrations(removeListener, event)).toBe(1);
        }
    });

    it("keeps internal document moves on the root drop target", async () => {
        const moveDocument = vi.fn(async () => ({
            ...document,
            folder_id: null,
        }));
        render(
            <Harness
                initialDocuments={[{ ...document, folder_id: "folder-1" }]}
                moveDocument={moveDocument}
                search="Brief"
            />,
        );
        const rootDropTarget = documentRow().parentElement!.parentElement!;
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
        fireEvent.drop(rootDropSpacer, { dataTransfer });

        await waitFor(() =>
            expect(moveDocument).toHaveBeenCalledWith(document.id, null),
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
        "keeps row and sticky-cell geometry fixed at %ipx",
        (viewportWidth) => {
            Object.defineProperty(window, "innerWidth", {
                configurable: true,
                value: viewportWidth,
            });
            render(<Harness />);

            const row = documentRow();
            const stickyCell = row.querySelector(
                ":scope > .sticky",
            ) as HTMLElement;
            const elements = [
                row,
                ...Array.from(row.children),
            ] as HTMLElement[];
            const stickyWidth = Math.max(180, viewportWidth - 112);

            elements.forEach((element, index) => {
                const width =
                    element === row
                        ? viewportWidth
                        : element === stickyCell
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
            expect(stickyCell).toHaveClass("bg-inherit");
            expect(`${row.className} ${stickyCell.className}`).not.toMatch(
                /\b(?:animate-|duration-|scale-|shadow|transition|translate-)/,
            );
        },
    );
});
