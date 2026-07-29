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

vi.mock("./useDirectoryData", () => ({
    useDirectoryData: () => ({
        loadingTabs: { files: false, templates: false, projects: false },
        standaloneDocuments: [document],
        templateDocuments: [],
        fileFolders: [
            {
                id: "folder",
                user_id: "user",
                library_kind: "file",
                name: "Folder",
                parent_folder_id: null,
                created_at: "",
                updated_at: "",
            },
        ],
        templateFolders: [],
        projects: [],
        loadTab: vi.fn(),
    }),
}));

describe("FileDirectory folders", () => {
    it("starts collapsed, expands explicitly, and reveals search results", () => {
        render(
            <FileDirectory
                selectedDocuments={[]}
                onChange={vi.fn()}
                showTabs
            />,
        );

        expect(screen.getByText("Inside.pdf")).not.toBeVisible();
        fireEvent.click(screen.getByText("Folder"));
        expect(screen.getByText("Inside.pdf")).toBeVisible();

        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "inside" },
        });
        expect(screen.getByText("Inside.pdf")).toBeVisible();
    });
});
