import { Profiler } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Project } from "../shared/types";
import { NewProjectModal } from "./NewProjectModal";

const mocks = vi.hoisted(() => ({
    addDocumentToProject: vi.fn(),
    createProject: vi.fn(),
    uploadDocument: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => ({
    ...mocks,
    directoryResource: () => ({ uploadDocument: mocks.uploadDocument }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({
        user: { id: "user-1", email: "owner@example.test" },
    }),
}));
vi.mock("../shared/FileDirectory", () => ({
    FileDirectory: () => <div>Document picker</div>,
}));

const project: Project = {
    id: "project-1",
    user_id: "user-1",
    name: "Appeal",
    cm_number: "CM-42",
    practice: "Litigation",
    shared_with: [],
    created_at: "2026-07-29T00:00:00.000Z",
    updated_at: "2026-07-29T00:00:00.000Z",
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProject.mockResolvedValue(project);
});

it("uses native form values without rerendering for ordinary typing", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    let commits = 0;
    render(
        <Profiler id="new-project" onRender={() => commits++}>
            <NewProjectModal
                open
                onClose={onClose}
                onCreated={onCreated}
            />
        </Profiler>,
    );

    const initialCommits = commits;
    fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "  Appeal  " },
    });
    fireEvent.change(screen.getByLabelText("CM number"), {
        target: { value: "  CM-42  " },
    });
    expect(commits).toBe(initialCommits);

    fireEvent.click(screen.getByRole("button", { name: "Practice" }));
    fireEvent.click(screen.getByRole("button", { name: "Litigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Document picker")).toBeVisible();
    fireEvent.click(
        screen.getByRole("button", { name: "Create project" }),
    );

    await waitFor(() =>
        expect(mocks.createProject).toHaveBeenCalledWith(
            "Appeal",
            "CM-42",
            "Litigation",
            [],
        ),
    );
    expect(onCreated).toHaveBeenCalledWith(project);
    expect(onClose).toHaveBeenCalledOnce();
});
