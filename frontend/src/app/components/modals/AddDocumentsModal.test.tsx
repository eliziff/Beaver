import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Document } from "../shared/types";
import { AddDocumentsModal } from "./AddDocumentsModal";

const api = vi.hoisted(() => ({
    addDocumentToProject: vi.fn(),
    getLibrary: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    uploadProjectDocument: vi.fn(),
    uploadStandaloneDocument: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => api);

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
        storage_path: null,
        pdf_storage_path: null,
        size_bytes: 1024,
        page_count: 1,
        structure_tree: null,
        status: "ready",
        created_at: "2026-07-28T00:00:00Z",
    };
}

describe("AddDocumentsModal project mode", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses supplied project documents without fetching", async () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        const available = makeDocument("available", "Available.pdf");

        render(
            <AddDocumentsModal
                open
                onClose={onClose}
                onSelect={onSelect}
                breadcrumb={["Project", "Add Documents"]}
                projectId="project-1"
                documents={[available]}
                showTabs={false}
            />,
        );

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
        expect(api.getProject).not.toHaveBeenCalled();
        expect(api.getLibrary).not.toHaveBeenCalled();
        expect(api.listProjects).not.toHaveBeenCalled();
        expect(api.addDocumentToProject).not.toHaveBeenCalled();
    });

    it("keeps project upload, empty, search, and Escape behavior in the shared modal", async () => {
        const onClose = vi.fn();
        const uploaded = makeDocument("uploaded", "Uploaded.pdf");
        api.uploadProjectDocument.mockResolvedValueOnce(uploaded);

        render(
            <AddDocumentsModal
                open
                onClose={onClose}
                onSelect={vi.fn()}
                breadcrumb={["Project", "Add Documents"]}
                projectId="project-1"
                documents={[]}
                showTabs={false}
            />,
        );

        expect(screen.getByText("No documents available")).toBeInTheDocument();
        fireEvent.change(screen.getByRole("searchbox"), {
            target: { value: "missing" },
        });
        expect(screen.getByText("No matches found")).toBeInTheDocument();

        const file = new File(["pdf"], "Uploaded.pdf", {
            type: "application/pdf",
        });
        fireEvent.change(
            document.querySelector('input[type="file"]') as HTMLInputElement,
            { target: { files: [file] } },
        );

        await waitFor(() =>
            expect(api.uploadProjectDocument).toHaveBeenCalledWith(
                "project-1",
                file,
            ),
        );
        expect(api.uploadStandaloneDocument).not.toHaveBeenCalled();

        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(onClose).toHaveBeenCalledOnce();
    });
});
