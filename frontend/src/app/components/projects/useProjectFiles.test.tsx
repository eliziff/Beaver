import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/app/components/shared/types";
import { deleteProjectFolder } from "@/app/lib/beaverApi";
import { useProjectFiles } from "./useProjectFiles";

let project: Project;
vi.mock("@/app/lib/beaverApi", () => ({
    createProjectFolder: vi.fn(),
    deleteProjectFolder: vi.fn(),
    moveDocumentToFolder: vi.fn(),
    moveSubfolderToFolder: vi.fn(),
    removeProjectDocument: vi.fn(),
    renameProjectDocument: vi.fn(),
    renameProjectFolder: vi.fn(),
    uploadProjectDocument: vi.fn(),
}));
vi.mock("./ProjectWorkspace", () => ({
    useProjectWorkspace: () => ({
        projectId: "project-1",
        project,
        setProject: (update: (current: Project) => Project) => {
            project = update(project);
        },
        refreshProject: vi.fn(),
    }),
}));

describe("useProjectFiles", () => {
    beforeEach(() => {
        project = {
            id: "project-1",
            user_id: "user-1",
            name: "Matter",
            cm_number: null,
            practice: null,
            notes: null,
            metadata: null,
            created_at: "2026-07-29T00:00:00.000Z",
            updated_at: "2026-07-29T00:00:00.000Z",
            folders: [
                {
                    id: "parent",
                    project_id: "project-1",
                    user_id: "user-1",
                    name: "Parent",
                    parent_folder_id: null,
                    created_at: "2026-07-29T00:00:00.000Z",
                    updated_at: "2026-07-29T00:00:00.000Z",
                },
                {
                    id: "child",
                    project_id: "project-1",
                    user_id: "user-1",
                    name: "Child",
                    parent_folder_id: "parent",
                    created_at: "2026-07-29T00:00:00.000Z",
                    updated_at: "2026-07-29T00:00:00.000Z",
                },
            ],
            documents: [
                {
                    id: "document-1",
                    project_id: "project-1",
                    filename: "Brief.pdf",
                    file_type: "pdf",
                    folder_id: "child",
                    storage_path: null,
                    pdf_storage_path: null,
                    size_bytes: 1,
                    page_count: 1,
                    structure_tree: null,
                    status: "ready",
                    created_at: "2026-07-29T00:00:00.000Z",
                },
            ],
        };
    });

    it("removes a folder subtree and its documents", async () => {
        const { result } = renderHook(() => useProjectFiles());
        await act(() => result.current.deleteFolder("parent"));

        expect(deleteProjectFolder).toHaveBeenCalledWith(
            "project-1",
            "parent",
        );
        expect(project.folders).toEqual([]);
        expect(project.documents).toEqual([]);
    });
});
