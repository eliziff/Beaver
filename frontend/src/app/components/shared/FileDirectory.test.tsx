import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { FileDirectory } from "./FileDirectory";
import { useState } from "react";

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
vi.mock("@/app/lib/api/documents", () => ({
  directoryResource: () => ({ list: listDirectory })
}));
vi.mock("@/app/lib/api/projects", () => ({
  listProjects
}));

describe("FileDirectory folders", () => {
    it("creates beside a folder's files and preserves the name for a failed-create retry", async () => {
        listDirectory.mockImplementation(async ({ parent_id }) => ({
            items: parent_id ? [{ kind: "document", document }] : [{ kind: "folder", folder: {
                id: "folder", name: "Research", parent_folder_id: null,
            } }], next_cursor: null,
        }));
        const created = { ...document, id: "created", filename: "Appeal.research.md", file_type: "md" };
        const onCreate = vi.fn().mockRejectedValueOnce(new Error("Connection interrupted"))
            .mockResolvedValue(created);
        function Directory() {
            const [naming, setNaming] = useState(false), [selected, setSelected] = useState<Document[]>([]);
            return <><button onClick={() => setNaming(true)}>New workspace</button>
                <FileDirectory selectedDocuments={selected} onChange={setSelected} showTabs multiple={false}
                    newDocument={naming ? { label: "Workspace name", filename: "Workspace.research.md",
                        onCreate, onCancel: () => setNaming(false) } : undefined} /></>;
        }
        render(<Directory />);
        fireEvent.click(await screen.findByRole("button", { name: "Research" }));
        await screen.findByLabelText("Select Inside.pdf");
        fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
        const name = screen.getByRole("textbox", { name: "Workspace name" });
        fireEvent.change(name, { target: { value: "Appeal" } });
        fireEvent.keyDown(name, { key: "Enter" });
        expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
        expect(name).toHaveValue("Appeal");
        fireEvent.keyDown(name, { key: "Enter" });
        expect(await screen.findByLabelText("Select Appeal")).toBeChecked();
        expect(onCreate).toHaveBeenLastCalledWith("Appeal", { library: "files" }, "folder");
        expect(screen.getByLabelText("Select Inside.pdf")).toBeVisible();
    });
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

    it("clears hidden selections when changing directory scope", async () => {
        const onChange = vi.fn();
        const onLocationChange = vi.fn();
        listDirectory.mockResolvedValue({
            items: [{ kind: "document", document: { ...document, folder_id: null } }],
            next_cursor: null,
        });
        listProjects.mockResolvedValue({
            items: [{ id: "project-1", name: "Matter A" }], next_cursor: null,
        });
        render(<FileDirectory selectedDocuments={[document]} onChange={onChange}
            onLocationChange={onLocationChange} showTabs />);

        fireEvent.click(screen.getByRole("tab", { name: "Projects" }));
        fireEvent.click(await screen.findByRole("button", { name: "Matter A" }));
        fireEvent.click(await screen.findByRole("button", { name: /Projects/ }));
        fireEvent.click(screen.getByRole("tab", { name: "Files" }));

        expect(onChange).toHaveBeenCalledTimes(4);
        expect(onChange).toHaveBeenNthCalledWith(1, []);
        expect(onChange).toHaveBeenNthCalledWith(2, []);
        expect(onChange).toHaveBeenNthCalledWith(3, []);
        expect(onChange).toHaveBeenNthCalledWith(4, []);
        expect(onLocationChange.mock.calls.map(([location]) => location)).toEqual([
            { library: "files" }, { projectId: null }, { projectId: "project-1" },
            { projectId: null }, { library: "files" },
        ]);
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
