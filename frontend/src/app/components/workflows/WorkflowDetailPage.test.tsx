import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowDetailPage } from "./WorkflowDetailPage";

const mocks = vi.hoisted(() => ({
    getWorkflow: vi.fn(),
    listWorkflowShares: vi.fn(),
    shareWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    deleteWorkflow: vi.fn(),
    deleteWorkflowShare: vi.fn(),
    getWorkflow: mocks.getWorkflow,
    listWorkflowShares: mocks.listWorkflowShares,
    lookupUserByEmail: vi.fn(),
    shareWorkflow: mocks.shareWorkflow,
    updateWorkflow: mocks.updateWorkflow,
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: null }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: null }),
}));
vi.mock("@/app/components/workflows/UseWorkflowModal", () => ({
    UseWorkflowModal: () => null,
}));
vi.mock("@/app/components/workflows/NewWorkflowModal", () => ({
    NewWorkflowModal: () => null,
}));
vi.mock("@/app/components/modals/PeopleModal", () => ({
    PeopleModal: ({
        open,
        onSharedWithChange,
    }: {
        open: boolean;
        onSharedWithChange: (emails: string[]) => Promise<void>;
    }) =>
        open ? (
            <button
                onClick={() =>
                    void onSharedWithChange(["member@example.test"])
                }
            >
                Add member
            </button>
        ) : null,
}));
vi.mock("@/app/components/tabular/AddColumnModal", () => ({
    AddColumnModal: () => null,
}));

const columns = [
    { index: 0, name: "Party", prompt: "Extract the party.", format: "text" },
    { index: 1, name: "Counterparty", prompt: "Extract it.", format: "text" },
] satisfies NonNullable<Workflow["columns_config"]>;

const workflow: Workflow = {
    id: "workflow-1",
    user_id: "user-1",
    metadata: {
        title: "Contract review",
        description: null,
        type: "tabular",
        contributors: [],
        language: "English",
        version: "1.0.0",
        practice: "General Transactions",
        jurisdictions: ["Canada"],
    },
    skill_md: null,
    columns_config: columns,
    is_system: false,
    created_at: "2026-07-28T00:00:00.000Z",
};

mocks.getWorkflow.mockResolvedValue(workflow);
mocks.listWorkflowShares.mockResolvedValue([]);
mocks.updateWorkflow.mockResolvedValue(workflow);

it("keeps one delete control mounted while column selection changes", async () => {
    let commits = 0;
    render(
        <Profiler id="workflow-detail" onRender={() => commits++}>
            <WorkflowDetailPage id={workflow.id} workflowType="tabular" />
        </Profiler>,
    );

    await screen.findByText("Party");
    expect(commits).toBe(2);
    const deleteButton = screen.getByRole("button", {
        name: "Delete selected",
    });
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveClass("invisible", "w-28");

    fireEvent.click(screen.getAllByRole("checkbox")[1]);

    expect(
        screen.getByRole("button", { name: "Delete selected" }),
    ).toBe(deleteButton);
    expect(deleteButton).toBeEnabled();
    expect(deleteButton).not.toHaveClass("invisible");

    fireEvent.click(deleteButton);

    await waitFor(() =>
        expect(mocks.updateWorkflow).toHaveBeenCalledWith(workflow.id, {
            columns_config: [{ ...columns[1], index: 0 }],
        }),
    );
    expect(screen.queryByText("Party")).not.toBeInTheDocument();
    expect(screen.getByText("Counterparty")).toBeInTheDocument();
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).toHaveClass("invisible");
});

it("updates workflow sharing without refetching the saved roster", async () => {
    render(<WorkflowDetailPage id={workflow.id} workflowType="tabular" />);
    await screen.findByText("Party");

    fireEvent.click(
        screen.getByRole("button", { name: "Open workflow people" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() =>
        expect(mocks.shareWorkflow).toHaveBeenCalledWith(workflow.id, {
            emails: ["member@example.test"],
            allow_edit: false,
        }),
    );
    expect(mocks.listWorkflowShares).toHaveBeenCalledTimes(1);
});

it("does not rerender the workflow for every prompt keystroke", async () => {
    mocks.getWorkflow.mockResolvedValueOnce({
        ...workflow,
        metadata: { ...workflow.metadata, type: "assistant" },
        skill_md: "Review the agreement.",
    });
    mocks.updateWorkflow.mockClear();
    let commits = 0;
    render(
        <Profiler id="workflow-detail" onRender={() => commits++}>
            <WorkflowDetailPage id={workflow.id} workflowType="assistant" />
        </Profiler>,
    );

    const prompt = await screen.findByRole("textbox", {
        name: "Workflow prompt",
    });
    fireEvent.change(prompt, { target: { value: "Review this agreement." } });
    const firstChangeCommits = commits;
    fireEvent.change(prompt, { target: { value: "Review this agreement well." } });
    expect(commits).toBe(firstChangeCommits);

    fireEvent.blur(prompt);
    await waitFor(() =>
        expect(mocks.updateWorkflow).toHaveBeenCalledWith(workflow.id, {
            skill_md: "Review this agreement well.",
        }),
    );
});
