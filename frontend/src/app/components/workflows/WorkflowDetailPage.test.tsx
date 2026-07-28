import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Workflow } from "../shared/types";
import { WorkflowDetailPage } from "./WorkflowDetailPage";

const mocks = vi.hoisted(() => ({
    getWorkflow: vi.fn(),
    updateWorkflow: vi.fn(),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/lib/beaverApi", () => ({
    deleteWorkflow: vi.fn(),
    deleteWorkflowShare: vi.fn(),
    getWorkflow: mocks.getWorkflow,
    listWorkflowShares: vi.fn(async () => []),
    lookupUserByEmail: vi.fn(),
    shareWorkflow: vi.fn(),
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
vi.mock("@/app/components/workflows/OpenSourceWorkflowModal", () => ({
    OpenSourceWorkflowModal: () => null,
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
mocks.updateWorkflow.mockResolvedValue(workflow);

it("keeps one delete control mounted while column selection changes", async () => {
    render(
        <WorkflowDetailPage id={workflow.id} workflowType="tabular" />,
    );

    await screen.findByText("Party");
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
