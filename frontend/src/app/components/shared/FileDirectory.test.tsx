import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const listDirectory = vi.hoisted(() => vi.fn());
const listProjects = vi.hoisted(() => vi.fn());
vi.mock("@/app/lib/beaverApi", () => ({
    directoryResource: () => ({ list: listDirectory }),
    listProjects,
}));

describe("FileDirectory folders", () => {
    it("starts collapsed, expands explicitly, and reveals search results", async () => {
        const folder = {
            id: "folder", user_id: "user", library_kind: "file",
            name: "Folder", parent_folder_id: null, created_at: "", updated_at: "",
        };
        listDirectory.mockImplementation(async (options) => ({
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

        const files = screen.getByRole("tab", { name: "Files" });
        fireEvent.keyDown(files, { key: "ArrowRight" });
        expect(screen.getByRole("tab", { name: "Templates" }))
            .toHaveAttribute("aria-selected", "true");

        expect(screen.queryByText("Inside.pdf")).not.toBeInTheDocument();
        fireEvent.click(await screen.findByText("Folder"));
        expect(await screen.findByText("Inside.pdf")).toBeVisible();

        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "inside" },
        });
        expect(await screen.findByText("Inside.pdf")).toBeVisible();
    });

    it("does not carry a project search into that project's files", async () => {
        listDirectory.mockResolvedValue({ items: [], next_cursor: null });
        listProjects.mockResolvedValue({
            items: [{ id: "project-1", name: "Matter A" }], next_cursor: null,
        });
        render(<FileDirectory selectedDocuments={[]} onChange={vi.fn()} showTabs />);

        fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "Matter A" },
        });
        fireEvent.click(await screen.findByRole("button", { name: "Matter A" }));

        await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
    });

    it("can limit selection to documents accepted by the caller", async () => {
        const research = { ...document, id: "research", folder_id: null, filename: "Notes.research.md", file_type: "markdown" };
        listDirectory.mockResolvedValue({ items: [], next_cursor: null });
        render(<FileDirectory documents={[document, research]} selectedDocuments={[]} onChange={vi.fn()} showTabs
            documentFilter={(item) => item.filename.endsWith(".research.md")} />);
        expect(await screen.findByText("Notes")).toBeVisible();
        expect(screen.queryByText("Inside.pdf")).not.toBeInTheDocument();
    });
});
