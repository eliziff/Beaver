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

    it("keeps successful uploads and reports failed files without closing", async () => {
        const onClose = vi.fn();
        const onSelect = vi.fn();
        const uploaded = makeDocument("uploaded", "Uploaded.pdf");
        api.uploadProjectDocument
            .mockResolvedValueOnce(uploaded)
            .mockRejectedValueOnce(new Error("fetch failed"));

        render(
            <AddDocumentsModal
                open
                onClose={onClose}
                onSelect={onSelect}
                breadcrumb={["Project", "Add Documents"]}
                projectId="project-1"
                documents={[]}
                showTabs={false}
            />,
        );

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
            "Unable to upload Failed.pdf. Check the file and your connection, then try again.",
        );
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

        render(
            <AddDocumentsModal
                open
                onClose={onClose}
                onSelect={onSelect}
                breadcrumb={["Project", "Add Documents"]}
                projectId="project-1"
                documents={[first, second]}
                showTabs={false}
            />,
        );

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Select First.pdf" }),
        );
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Select Second.pdf" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Unable to add Second.pdf to this project. Check your connection and try again.",
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
});
