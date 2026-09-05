import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowFileTargetSettings } from "./WorkflowFileTargetSettings";

const mocks = vi.hoisted(() => ({
    update: vi.fn(), list: vi.fn(), projects: vi.fn(), create: vi.fn(), directory: vi.fn(),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({
        profile: { workflowFileTargets: { "court-records": null, authorities: null } },
        updateProfile: mocks.update,
    }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    directoryResource: (scope: unknown) => { mocks.directory(scope); return { list: mocks.list, createFolder: mocks.create }; },
    listProjects: mocks.projects,
    getLibraryFolder: vi.fn(), getProject: vi.fn(), getProjectFolder: vi.fn(),
}));

describe("workflow file locations", () => {
    beforeEach(() => {
        mocks.update.mockReset().mockResolvedValue(true);
        mocks.directory.mockClear();
        mocks.create.mockReset().mockImplementation(async (name, parent_folder_id) => ({ id: "new-folder", name, parent_folder_id }));
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

    it.each(["Library", "Project"])("creates a nested %s folder and saves that destination", async (kind) => {
        render(<WorkflowFileTargetSettings />);
        fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]);
        if (kind === "Project") {
            fireEvent.click(screen.getByRole("button", { name: "Project" }));
            fireEvent.click(await screen.findByRole("button", { name: "Smith v Jones" }));
        }
        expect(mocks.directory).toHaveBeenLastCalledWith(kind === "Library" ? { library: "files" } : { projectId: "project-1" });
        fireEvent.click(await screen.findByRole("button", { name: "Open Filed material" }));
        fireEvent.click(screen.getByRole("button", { name: "New folder" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "  Decisions  " } });
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
        await waitFor(() => expect(mocks.create).toHaveBeenCalledWith("Decisions", "folder-1"));
        await screen.findByText("Decisions");
        fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
        await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ workflowFileTargets: {
            "court-records": kind === "Library" ? { kind: "library", folderId: "new-folder" }
                : { kind: "project", projectId: "project-1", folderId: "new-folder" }, authorities: null,
        } }));
    });

    it("keeps failed folder creation editable and Escape cancels only the inline editor", async () => {
        mocks.create.mockRejectedValueOnce(new Error("Folder name already exists"));
        render(<WorkflowFileTargetSettings />);
        fireEvent.click(screen.getAllByRole("button", { name: "Choose folder" })[0]);
        fireEvent.click(screen.getByRole("button", { name: "New folder" }));
        const input = screen.getByRole("textbox", { name: "Folder name" });
        fireEvent.change(input, { target: { value: "Decisions" } });
        fireEvent.keyDown(input, { key: "Enter" });
        expect(await screen.findByRole("alert")).toHaveTextContent("Folder name already exists");
        expect(input).toHaveValue("Decisions");
        fireEvent.keyDown(input, { key: "Escape" });
        expect(screen.queryByRole("textbox", { name: "Folder name" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "New folder" })).toHaveFocus();
        expect(screen.getByRole("button", { name: "Use folder" })).toBeVisible();
        expect(mocks.update).not.toHaveBeenCalled();
    });
});
