import { Profiler } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { NewWorkflowModal } from "./NewWorkflowModal";

const mocks = vi.hoisted(() => ({
    createWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("@/app/lib/beaverApi", () => mocks);

const createdWorkflow = {
    id: "workflow-1",
    user_id: "user-1",
    metadata: {
        title: "Mars review",
        description: null,
        type: "assistant",
        contributors: [],
        language: "Klingon",
        version: null,
        practice: "Space law",
        jurisdictions: ["Mars", "Moon"],
    },
    skill_md: "# Skill",
    columns_config: null,
    is_system: false,
    created_at: "2026-07-29T00:00:00.000Z",
} satisfies Workflow;

beforeEach(() => {
    mocks.createWorkflow.mockReset();
    mocks.updateWorkflow.mockReset();
    mocks.createWorkflow.mockResolvedValue(createdWorkflow);
});

it("creates an assistant workflow from custom values and markdown", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    let commits = 0;
    const { container } = render(
        <Profiler id="new-workflow" onRender={() => commits++}>
            <NewWorkflowModal
                open
                onClose={onClose}
                onCreated={onCreated}
            />
        </Profiler>,
    );

    const initialCommits = commits;
    fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Mars review" },
    });
    fireEvent.change(screen.getByLabelText("Language"), {
        target: { value: "Klingon" },
    });
    fireEvent.change(screen.getByLabelText("Practice area"), {
        target: { value: "Space law" },
    });
    fireEvent.change(screen.getByLabelText("Jurisdiction"), {
        target: { value: "Mars, Moon" },
    });
    expect(commits).toBe(initialCommits);

    const markdown = new File(["# Skill"], "skill.md", {
        type: "text/markdown",
    });
    Object.defineProperty(markdown, "text", {
        value: vi.fn().mockResolvedValue("# Skill"),
    });
    fireEvent.change(container.querySelector('input[type="file"]')!, {
        target: { files: [markdown] },
    });
    await screen.findByText("skill.md");
    fireEvent.click(
        screen.getByRole("button", { name: "Create workflow" }),
    );

    await waitFor(() =>
        expect(mocks.createWorkflow).toHaveBeenCalledWith({
            metadata: {
                title: "Mars review",
                type: "assistant",
                language: "Klingon",
                practice: "Space law",
                jurisdictions: ["Mars", "Moon"],
            },
            skill_md: "# Skill",
        }),
    );
    expect(onCreated).toHaveBeenCalledWith(createdWorkflow);
    expect(onClose).toHaveBeenCalledOnce();
});

it("creates a tabular workflow from the native form values", async () => {
    render(
        <NewWorkflowModal
            open
            onClose={vi.fn()}
            onCreated={vi.fn()}
        />,
    );

    fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "Disclosure table" },
    });
    fireEvent.change(screen.getByLabelText("Language"), {
        target: { value: "French" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tabular" }));
    fireEvent.click(
        screen.getByRole("button", { name: "Create workflow" }),
    );

    await waitFor(() =>
        expect(mocks.createWorkflow).toHaveBeenCalledWith({
            metadata: {
                title: "Disclosure table",
                type: "tabular",
                language: "French",
                practice: "General Transactions",
                jurisdictions: ["General"],
            },
        }),
    );
});
