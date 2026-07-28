import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { DocTable, type DocTableFolder } from "./DocTable";

vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "local-user" } }),
}));

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

function Harness({ selectionFirst = true }: { selectionFirst?: boolean }) {
    const [documents, setDocuments] = useState([document]);
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
                uploadDocument: vi.fn(),
                refreshCollection: vi.fn(),
                createFolder: vi.fn(),
                renameFolder: vi.fn(),
                deleteFolder: vi.fn(),
                moveFolder: vi.fn(),
                moveDocument: vi.fn(),
                renameDocument: vi.fn(),
            }}
            selectionFirst={selectionFirst}
        />
    );
}

function documentRow() {
    return screen
        .getAllByText("Brief.pdf")
        .find((element) => element.closest("[data-document-row]"))!
        .closest("[data-document-row]") as HTMLElement;
}

describe("DocTable Library interactions", () => {
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
});
