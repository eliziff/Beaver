import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "./types";
import { FileDirectory } from "./FileDirectory";

const document: Document = {
    id: "inside",
    project_id: null,
    folder_id: "folder",
    filename: "Inside.pdf",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 1,
    page_count: 1,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-29T00:00:00Z",
};

const getLibrary = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/beaverApi", () => ({
    getLibrary,
    getProjectDirectory: vi.fn(),
    listProjects: vi.fn(),
}));

describe("FileDirectory folders", () => {
    it("starts collapsed, expands explicitly, and reveals search results", async () => {
        const folder = {
            id: "folder", user_id: "user", library_kind: "file",
            name: "Folder", parent_folder_id: null, created_at: "", updated_at: "",
        };
        getLibrary.mockImplementation(async (_kind, options) => ({
            items: options.q
                ? [{ kind: "document", document }]
                : options.parent_id
                    ? [{ kind: "document", document }]
                    : [{ kind: "folder", folder }],
            next_cursor: null,
        }));
        render(
            <FileDirectory
                selectedDocuments={[]}
                onChange={vi.fn()}
                showTabs
            />,
        );

        expect(screen.queryByText("Inside.pdf")).not.toBeInTheDocument();
        fireEvent.click(await screen.findByText("Folder"));
        expect(await screen.findByText("Inside.pdf")).toBeVisible();

        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "inside" },
        });
        expect(await screen.findByText("Inside.pdf")).toBeVisible();
    });
});
