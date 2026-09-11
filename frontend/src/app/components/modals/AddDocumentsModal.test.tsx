import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "@/app/lib/api/documents";
import { AddDocumentsModal } from "./AddDocumentsModal";

const api = vi.hoisted(() => ({
    addDocumentToProject: vi.fn(),
    listDirectory: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    listProjects: vi.fn(),
    uploadDocument: vi.fn(),
    uploadDirectory: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/lib/api/documents", async (original) => ({
  ...await original<typeof import("@/app/lib/api/documents")>(),
  addDocumentToProject: api.addDocumentToProject,
  uploadStandaloneDocument: api.uploadStandaloneDocument,
  directoryResource: () => ({
        list: api.listDirectory,
        uploadDocument: api.uploadDocument,
        uploadDirectory: api.uploadDirectory,
    })
}));
vi.mock("@/app/lib/api/projects", async (original) => ({
  ...await original<typeof import("@/app/lib/api/projects")>(),
  listProjects: api.listProjects
}));

function makeDocument(
    id: string,
    filename: string,
    projectId = "project-1",
): Document {
    return {
        id,
        project_id: projectId,
        filename,
        file_type: "pdf",
        pdf_storage_path: null,
        size_bytes: 1024,
        page_count: 1,
        created_at: "2026-07-28T00:00:00Z",
    };
}

function projectPicker(props: Partial<React.ComponentProps<typeof AddDocumentsModal>> = {}) {
    return <AddDocumentsModal open onClose={vi.fn()} onSelect={vi.fn()}
        breadcrumb={["Project", "Add Documents"]} projectId="project-1"
        documents={[]} showTabs={false} {...props} />;
}

describe("AddDocumentsModal project mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        api.uploadDocument.mockReset();
        api.uploadDirectory.mockReset();
        api.uploadStandaloneDocument.mockReset();
    });

    it("uses supplied project documents without fetching", async () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        const available = makeDocument("available", "Available.pdf");

        render(projectPicker({ onClose, onSelect, documents: [available] }));

        expect(screen.queryByText("Files")).not.toBeInTheDocument();

        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "available" },
        });
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Select Available.pdf" }),
        );
        expect(screen.getByText("1 selected")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        await waitFor(() =>
            expect(onSelect).toHaveBeenCalledWith(
                [available],
                "project-1",
            ),
        );
        expect(onClose).toHaveBeenCalledOnce();
        expect(api.addDocumentToProject).not.toHaveBeenCalled();
    });

    it("keeps successful uploads and reports failed files without closing", async () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        const uploaded = makeDocument("uploaded", "Uploaded.pdf");
        api.uploadDocument
            .mockResolvedValueOnce(uploaded)
            .mockRejectedValueOnce(new Error("fetch failed"));

        render(projectPicker({ onClose, onSelect }));

        const uploadedFile = new File(["pdf"], "Uploaded.pdf", {
            type: "application/pdf",
        });
        const failedFile = new File(["pdf"], "Failed.pdf", {
            type: "application/pdf",
        });
        fireEvent.change(
            document.querySelector('input[type="file"]') as HTMLInputElement,
            { target: { files: [uploadedFile, failedFile] } },
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to upload Failed.pdf. Check your connection and try again.",
        );
        expect(screen.getByRole("checkbox", { name: "Select Uploaded.pdf" })).toBeChecked();
        expect(onSelect).toHaveBeenCalledWith([uploaded], "project-1");
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() =>
            expect(onSelect).toHaveBeenCalledWith(
                [uploaded],
                "project-1",
            ),
        );
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("offers files and folders through one upload control", async () => {
        const uploaded = makeDocument("folder-file", "Folder file.pdf");
        api.uploadDirectory.mockResolvedValueOnce([uploaded]);
        const onSelect = vi.fn();

        render(projectPicker({ onSelect }));

        expect(screen.getAllByRole("button", { name: "Upload" })).toHaveLength(1);
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Folder" }));
        const file = new File(["pdf"], "Folder file.pdf", { type: "application/pdf" });
        fireEvent.change(screen.getByLabelText("Upload folder"), {
            target: { files: [file] },
        });

        await waitFor(() => expect(api.uploadDirectory).toHaveBeenCalledWith([file]));
        expect(await screen.findByRole("checkbox", { name: "Select Folder file.pdf" }))
            .toBeChecked();
        expect(onSelect).toHaveBeenCalledWith([uploaded], "project-1");
    });

    it("keeps partial project assignments open and retries only failures", async () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        const first = makeDocument("first", "First.pdf", "project-2");
        const second = makeDocument("second", "Second.pdf", "project-2");
        const assignedFirst = { ...first, project_id: "project-1" };
        const assignedSecond = { ...second, project_id: "project-1" };
        api.addDocumentToProject
            .mockResolvedValueOnce(assignedFirst)
            .mockRejectedValueOnce(new Error("fetch failed"))
            .mockResolvedValueOnce(assignedSecond);

        render(projectPicker({ onClose, onSelect, documents: [first, second] }));

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Select First.pdf" }),
        );
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Select Second.pdf" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to add Second.pdf. Check your connection and try again.",
        );
        expect(onSelect).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
        await waitFor(() =>
            expect(api.addDocumentToProject).toHaveBeenCalledTimes(3),
        );
        expect(api.addDocumentToProject.mock.calls).toEqual([
            ["project-1", "first"],
            ["project-1", "second"],
            ["project-1", "second"],
        ]);
        expect(onSelect).toHaveBeenCalledWith(
            [assignedFirst, assignedSecond],
            "project-1",
        );
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("retains the open directory state when a kept modal is reopened", async () => {
        const props = {
            onClose: vi.fn(),
            onSelect: vi.fn(),
            breadcrumb: ["Add documents"],
            documents: [] as Document[],
            keepMounted: true,
        };
        const view = render(<AddDocumentsModal {...props} open />);
        await screen.findByText("No files available");
        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "affidavit" },
        });
        await screen.findByText("No matches found");

        view.rerender(<AddDocumentsModal {...props} open={false} />);
        view.rerender(<AddDocumentsModal {...props} open />);

        expect(screen.getByRole("searchbox")).toHaveValue("affidavit");
    });

    it("opens a kept picker on a newly requested source tab", async () => {
        const props = {
            onClose: vi.fn(), onSelect: vi.fn(), breadcrumb: ["Add documents"],
            keepMounted: true,
        };
        const view = render(<AddDocumentsModal {...props} open initialTab="files" />);
        expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
        await screen.findByText("No files available");

        view.rerender(<AddDocumentsModal {...props} open={false} initialTab="templates" />);
        view.rerender(<AddDocumentsModal {...props} open initialTab="templates" />);

        expect(screen.getByRole("tab", { name: "Templates" }))
            .toHaveAttribute("aria-selected", "true");
        await screen.findByText("No files available");
    });
});

it("filters existing documents and uploaded files to the requested extension", async () => {
    const select = vi.fn();
    render(<AddDocumentsModal open onClose={vi.fn()} onSelect={select}
        breadcrumb={["Choose document"]} accept=".docx" multiple={false}
        documents={[makeDocument("word", "Draft.DOCX"), makeDocument("pdf", "Source.pdf")]} />);
    expect(await screen.findByRole("radio", { name: "Select Draft.DOCX" })).toBeVisible();
    expect(screen.queryByRole("radio", { name: "Select Source.pdf" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Upload files"), {
        target: { files: [new File(["pdf"], "Source.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose .docx files.");
    expect(api.uploadStandaloneDocument).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Select Draft.DOCX" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm", exact: true }));
    await waitFor(() => expect(select).toHaveBeenCalledWith([expect.objectContaining({ id: "word" })], "project-1"));
});
