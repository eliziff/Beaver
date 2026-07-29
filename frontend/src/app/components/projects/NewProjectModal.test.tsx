import { Profiler } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Project } from "../shared/types";
import { NewProjectModal } from "./NewProjectModal";

const mocks = vi.hoisted(() => ({
    addDocumentToProject: vi.fn(),
    createProject: vi.fn(),
    uploadProjectDocument: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => mocks);
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
    fireEvent.click(screen.getByRole("option", { name: "Litigation" }));
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
    expect(onCreated).toHaveBeenCalledWith({
        ...project,
        document_count: 0,
    });
    expect(onClose).toHaveBeenCalledOnce();
});

it("does not advance with a blank project name", () => {
    render(
        <NewProjectModal
            open
            onClose={vi.fn()}
            onCreated={vi.fn()}
        />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByRole("dialog", { name: "Details" })).toBeVisible();
    expect(screen.queryByText("Document picker")).not.toBeInTheDocument();
    expect(mocks.createProject).not.toHaveBeenCalled();
});

it("resets by unmounting when closed", () => {
    const props = {
        onClose: vi.fn(),
        onCreated: vi.fn(),
    };
    const { rerender } = render(<NewProjectModal open {...props} />);

    fireEvent.change(screen.getByLabelText("Project name"), {
        target: { value: "Temporary" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Document picker")).toBeVisible();

    rerender(<NewProjectModal open={false} {...props} />);
    rerender(<NewProjectModal open {...props} />);

    expect(screen.getByRole("dialog", { name: "Details" })).toBeVisible();
    expect(screen.getByLabelText("Project name")).toHaveValue("");
});
