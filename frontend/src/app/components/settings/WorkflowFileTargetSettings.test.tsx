import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowFileTargetSettings } from "./WorkflowFileTargetSettings";

const mocks = vi.hoisted(() => ({
    update: vi.fn(), list: vi.fn(), projects: vi.fn(),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { workflowFileTargets: { "court-records": null, authorities: null } },
        updateProfile: mocks.update,
    }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    directoryResource: () => ({ list: mocks.list }),
    listProjects: mocks.projects,
    getLibraryFolder: vi.fn(), getProject: vi.fn(), getProjectFolder: vi.fn(),
}));

describe("workflow file locations", () => {
    beforeEach(() => {
        mocks.update.mockReset().mockResolvedValue(true);
        mocks.list.mockReset().mockResolvedValue({
            items: [{ kind: "folder", folder: {
                id: "folder-1", name: "Filed material", parent_folder_id: null,
            } }], next_cursor: null,
        });
        mocks.projects.mockReset().mockResolvedValue({
            items: [{ id: "project-1", name: "Smith v Jones", cm_number: null }],
            next_cursor: null,
        });
    });

    it("saves an exact Library folder", async () => {
        render(<WorkflowFileTargetSettings />);
        fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]);
        fireEvent.click(await screen.findByRole("button", { name: /Filed material/u }));
        fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
            workflowFileTargets: {
                "court-records": { kind: "library", folderId: "folder-1" },
                authorities: null,
            },
        }));
    });

    it("saves an exact Project folder", async () => {
        render(<WorkflowFileTargetSettings />);
        fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[1]);
        fireEvent.click(screen.getByRole("button", { name: "Project" }));
        fireEvent.click(await screen.findByRole("button", { name: "Smith v Jones" }));
        fireEvent.click(await screen.findByRole("button", { name: /Filed material/u }));
        fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({
            workflowFileTargets: {
                "court-records": null,
                authorities: { kind: "project", projectId: "project-1", folderId: "folder-1" },
            },
        }));
    });
});
